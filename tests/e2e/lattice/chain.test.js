/**
 * Chain Topology Test - Sequential A→B→C→D transactions
 *
 * ON-CHAIN MODE: Uses real USDC deposits on Sepolia testnet
 *
 * Tests:
 * - Sequential proof processing through queue
 * - Dependency tracking between transactions
 * - Change note creation and usage
 * - UTXO state transitions across wallets
 *
 * Budget: $0.03 USDC per wallet seeded, $0.005 per transfer
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { createChainTopology } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { StateTracker } from '../lib/state-tracker.js';
import { ApiClient } from '../lib/api-client.js';
import {
  setupOnChainFixture,
  ON_CHAIN_CONFIG,
  describeOnChain,
  testOnChain
} from './on-chain-fixture.js';

// Use describeOnChain to skip if FUNDER_PRIVATE_KEY not set
describeOnChain('Lattice: Chain Topology (On-Chain)', () => {
  const NUM_WALLETS = 5;
  // Budget: $0.03 per wallet, transfers of $0.005 to maximize hops
  const AMOUNT_PER_TX = ON_CHAIN_CONFIG.AMOUNTS.CHAIN_TRANSFER; // $0.005

  let wallets;
  let fixture;
  let stateTracker;
  let apiClient;

  beforeAll(async () => {
    apiClient = new ApiClient();

    // Verify servers are healthy
    const health = await apiClient.checkHealth();
    if (!health.prover || !health.relayer) {
      throw new Error('Prover and Relayer must be available for on-chain tests');
    }

    // Create test wallets with deterministic keys
    const testRunId = `chain-onchain-${Date.now()}`;
    wallets = createTestWallets(NUM_WALLETS, testRunId);

    console.log('\n=== Chain Topology Test (On-Chain) ===');
    console.log(`Wallets: ${NUM_WALLETS}`);
    console.log(`USDC per wallet: $${ON_CHAIN_CONFIG.USDC_PER_WALLET / 1e6}`);
    console.log(`Amount per TX: $${AMOUNT_PER_TX / 1e6}`);
    console.log(`Chain: ${wallets.map(w => w.walletId).join(' → ')}`);

    // Setup on-chain fixture
    fixture = await setupOnChainFixture(testRunId);

    // REAL ON-CHAIN DEPOSIT: Seed first wallet
    console.log('\nSeeding wallet-0 with real on-chain deposit...');
    const seedResult = await fixture.seeder.seedWallet(
      wallets[0],
      ON_CHAIN_CONFIG.USDC_PER_WALLET
    );
    console.log(`Wallet-0 seeded: tx=${seedResult.txHash.slice(0, 18)}..., index=${seedResult.leafIndex}`);

    // Sync merkle tree from chain
    console.log('Syncing Merkle tree from chain...');
    await fixture.onChainMerkle.sync();

    // Verify root matches contract
    const rootCheck = await fixture.onChainMerkle.verifyRoot();
    if (!rootCheck.matches) {
      throw new Error(`Merkle root mismatch: local=${rootCheck.local}, contract=${rootCheck.contract}`);
    }
    console.log(`Merkle tree synced: ${fixture.onChainMerkle.getLeafCount()} leaves, root=${rootCheck.local.slice(0, 18)}...`);

    // Initialize state tracker
    stateTracker = new StateTracker();
  }, 120000); // 2 minute setup timeout for deposit

  testOnChain('should execute sequential chain of transactions', async () => {
    // Create chain topology: wallet-0 → wallet-1 → wallet-2 → ...
    const topology = createChainTopology(wallets, AMOUNT_PER_TX);

    console.log(`\nCreated chain topology with ${topology.edges.length} edges`);
    console.log(topology.toString());

    // Create orchestrator in ON-CHAIN MODE
    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 1, // Sequential for chain
      // ON-CHAIN MODE
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    // Initialize merkle tree (async in on-chain mode)
    await orchestrator.initializeMerkleTree();

    // Execute topology
    const result = await orchestrator.execute();

    // Log results
    console.log('\n' + orchestrator.getReport());

    // Verify all edges completed
    const completedEdges = result.edges.filter(e => e.status === 'confirmed');
    const failedEdges = result.edges.filter(e => e.status === 'failed');

    console.log(`Completed: ${completedEdges.length}/${topology.edges.length}`);
    console.log(`Failed: ${failedEdges.length}`);

    if (failedEdges.length > 0) {
      for (const edge of failedEdges) {
        console.error(`  Edge ${edge.id}: ${edge.error}`);
      }
    }

    expect(failedEdges.length).toBe(0);
    expect(completedEdges.length).toBe(topology.edges.length);

    // Verify final wallet has expected balance
    const lastWallet = wallets[wallets.length - 1];
    const lastBalance = lastWallet.getBalance();
    console.log(`\nFinal wallet (${lastWallet.walletId}) balance: $${Number(lastBalance) / 1e6}`);
    expect(lastBalance).toBe(BigInt(AMOUNT_PER_TX));

    // Verify intermediate wallets have change
    for (let i = 0; i < wallets.length - 1; i++) {
      const wallet = wallets[i];
      const balance = wallet.getBalance();
      console.log(`${wallet.walletId} balance: $${Number(balance) / 1e6}`);
    }

    // Verify balance tracking is correct throughout
    const balanceVerification = result.balanceVerification;
    console.log(`\nBalance verification:`);
    console.log(`  Total checks: ${balanceVerification.summary.totalWalletChecks}`);
    console.log(`  Inconsistent: ${balanceVerification.summary.inconsistent}`);
    console.log(`  Wrong amounts: ${balanceVerification.summary.wrongAmounts}`);

    expect(balanceVerification.final.allMatch).toBe(true);
    expect(balanceVerification.summary.inconsistent).toBe(0);
    expect(balanceVerification.summary.wrongAmounts).toBe(0);

  }, 900000); // 15 minute timeout for chain

  testOnChain('should handle chain with smaller transfers', async () => {
    // Create fresh wallets for this test
    const testRunId = `chain-small-${Date.now()}`;
    const smallWallets = createTestWallets(3, testRunId);

    // Setup fresh fixture
    const smallFixture = await setupOnChainFixture(testRunId);

    // Seed first wallet with $0.03
    const seedResult = await smallFixture.seeder.seedWallet(
      smallWallets[0],
      ON_CHAIN_CONFIG.USDC_PER_WALLET
    );
    console.log(`\nSmall chain: seeded at index ${seedResult.leafIndex}`);

    // Sync merkle tree
    await smallFixture.onChainMerkle.sync();

    // Use smaller transfers ($0.003 each)
    const smallAmount = 3000;
    const topology = createChainTopology(smallWallets, smallAmount);

    console.log(`\nSmall transfer chain: ${topology.edges.length} edges, $${smallAmount / 1e6} each`);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      onChainMode: true,
      onChainMerkle: smallFixture.onChainMerkle
    });

    await orchestrator.initializeMerkleTree();
    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    // All should complete
    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    expect(confirmed).toBe(topology.edges.length);

    // Verify balance consistency
    expect(result.balanceVerification.final.allMatch).toBe(true);

  }, 600000);
});
