/**
 * Diamond Topology Test - DAG with parallel branches
 *
 * ON-CHAIN MODE: Uses real USDC deposits on Sepolia testnet
 *
 *      A
 *     / \
 *    B   C
 *     \ /
 *      D
 *
 * Tests:
 * - Parallel execution of independent branches
 * - Dependency resolution for DAG patterns
 * - Multiple inputs converging to single wallet
 *
 * Budget: $0.03 USDC for source wallet, $0.01 per branch split
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { createDiamondTopology, LatticeTopology } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { ApiClient } from '../lib/api-client.js';
import {
  setupOnChainFixture,
  ON_CHAIN_CONFIG,
  describeOnChain,
  testOnChain
} from './on-chain-fixture.js';

// Use describeOnChain to skip if FUNDER_PRIVATE_KEY not set
describeOnChain('Lattice: Diamond Topology (On-Chain)', () => {
  let apiClient;

  beforeAll(async () => {
    apiClient = new ApiClient();

    const health = await apiClient.checkHealth();
    if (!health.prover || !health.relayer) {
      throw new Error('Prover and Relayer must be available for on-chain tests');
    }
  });

  testOnChain('should execute diamond DAG with parallel branches', async () => {
    // Create 4 wallets for diamond pattern
    const testRunId = `diamond-onchain-${Date.now()}`;
    const wallets = createTestWallets(4, testRunId);
    const [A, B, C, D] = wallets;

    console.log('\n=== Diamond Topology Test (On-Chain) ===');
    console.log('Pattern: A→B, A→C (parallel), then B→D, C→D (converging)');

    // Setup on-chain fixture
    const fixture = await setupOnChainFixture(testRunId);

    // REAL ON-CHAIN DEPOSIT: Seed wallet A with $0.03
    console.log('\nSeeding wallet A with real on-chain deposit...');
    const seedResult = await fixture.seeder.seedWallet(
      A,
      ON_CHAIN_CONFIG.USDC_PER_WALLET // $0.03
    );
    console.log(`Wallet A seeded: tx=${seedResult.txHash.slice(0, 18)}..., index=${seedResult.leafIndex}`);

    // Sync merkle tree from chain
    console.log('Syncing Merkle tree from chain...');
    await fixture.onChainMerkle.sync();

    // Verify root matches contract
    const rootCheck = await fixture.onChainMerkle.verifyRoot();
    if (!rootCheck.matches) {
      throw new Error(`Merkle root mismatch: local=${rootCheck.local}, contract=${rootCheck.contract}`);
    }
    console.log(`Merkle tree synced: ${fixture.onChainMerkle.getLeafCount()} leaves`);

    // Budget-conscious amounts:
    // A→B: $0.01, A→C: $0.01 (sequential with change - need to use same UTXO)
    // B→D: $0.005, C→D: $0.005
    // Note: Since A has only 1 UTXO, A→B and A→C must be SEQUENTIAL (A→B creates change, then A→C uses change)
    const topology = createDiamondTopology(wallets, {
      ab: ON_CHAIN_CONFIG.AMOUNTS.DIAMOND_SPLIT,     // $0.01
      ac: ON_CHAIN_CONFIG.AMOUNTS.DIAMOND_SPLIT,     // $0.01
      bd: ON_CHAIN_CONFIG.AMOUNTS.DIAMOND_CONVERGE,  // $0.005
      cd: ON_CHAIN_CONFIG.AMOUNTS.DIAMOND_CONVERGE   // $0.005
    });

    console.log(`\nTopology: ${topology.edges.length} edges`);
    console.log(topology.toString());

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 1, // Sequential due to single UTXO source
      // ON-CHAIN MODE
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    // Initialize merkle tree (async in on-chain mode)
    await orchestrator.initializeMerkleTree();

    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    // Verify all edges completed
    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    const failed = result.edges.filter(e => e.status === 'failed');

    console.log(`\nConfirmed: ${confirmed}/${topology.edges.length}`);
    if (failed.length > 0) {
      for (const edge of failed) {
        console.error(`  Failed: ${edge.from}→${edge.to}: ${edge.error}`);
      }
    }

    expect(failed.length).toBe(0);
    expect(confirmed).toBe(4);

    // Verify wallet D received from both B and C
    const dBalance = D.getBalance();
    console.log(`\nWallet D final balance: $${Number(dBalance) / 1e6}`);
    // D should have $0.005 from B + $0.005 from C = $0.01
    expect(dBalance).toBe(BigInt(ON_CHAIN_CONFIG.AMOUNTS.DIAMOND_CONVERGE * 2));

    // Verify balance consistency throughout test
    expect(result.balanceVerification.final.allMatch).toBe(true);
    expect(result.balanceVerification.summary.inconsistent).toBe(0);

  }, 900000); // 15 minute timeout

  testOnChain('should handle deeper diamond (5 levels)', async () => {
    /*
     * Deeper diamond pattern:
     *        A
     *       /|\
     *      B C D
     *       \|/
     *        E
     *
     * Budget: Seed A with $0.03, split to 3 branches, converge to E
     */
    const testRunId = `deep-diamond-onchain-${Date.now()}`;
    const wallets = createTestWallets(5, testRunId);
    const [A, B, C, D, E] = wallets;

    console.log('\n=== Deep Diamond Topology Test (On-Chain) ===');

    // Setup on-chain fixture
    const fixture = await setupOnChainFixture(testRunId);

    // Seed A with $0.03
    console.log('Seeding wallet A...');
    const seedResult = await fixture.seeder.seedWallet(
      A,
      ON_CHAIN_CONFIG.USDC_PER_WALLET
    );
    console.log(`Wallet A seeded at index ${seedResult.leafIndex}`);

    // Sync merkle tree
    await fixture.onChainMerkle.sync();

    // Custom topology: A→B, A→C, A→D (sequential), then B→E, C→E, D→E (converging)
    // Amounts: $0.008 per branch (leaves change for fees), $0.003 to E from each
    const topology = new LatticeTopology(wallets);

    // First layer - A fans out to B, C, D (MUST BE SEQUENTIAL - single UTXO)
    const BRANCH_AMOUNT = 8000;   // $0.008 per branch
    const CONVERGE_AMOUNT = 3000; // $0.003 to E

    const abEdge = topology.addEdge(A.walletId, B.walletId, BRANCH_AMOUNT);
    const acEdge = topology.addEdge(A.walletId, C.walletId, BRANCH_AMOUNT, [abEdge]); // Depends on ab
    const adEdge = topology.addEdge(A.walletId, D.walletId, BRANCH_AMOUNT, [acEdge]); // Depends on ac

    // Second layer - B, C, D converge to E
    topology.addEdge(B.walletId, E.walletId, CONVERGE_AMOUNT, [abEdge]);
    topology.addEdge(C.walletId, E.walletId, CONVERGE_AMOUNT, [acEdge]);
    topology.addEdge(D.walletId, E.walletId, CONVERGE_AMOUNT, [adEdge]);

    console.log(`\nDeep diamond: ${topology.edges.length} edges`);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 1, // Sequential for single UTXO source
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    await orchestrator.initializeMerkleTree();
    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    expect(confirmed).toBe(6);

    // E should have 3 × $0.003 = $0.009
    const eBalance = E.getBalance();
    console.log(`\nWallet E final balance: $${Number(eBalance) / 1e6}`);
    expect(eBalance).toBe(BigInt(CONVERGE_AMOUNT * 3));

    // Verify balance consistency
    expect(result.balanceVerification.final.allMatch).toBe(true);

  }, 1200000); // 20 minute timeout
});
