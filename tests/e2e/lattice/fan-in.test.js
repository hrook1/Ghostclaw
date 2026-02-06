/**
 * Fan-In Topology Test - Many sources to one recipient
 *
 * ON-CHAIN MODE: Uses real USDC deposits on Sepolia testnet
 *
 *    B → A
 *    C → A
 *    D → A
 *    E → A
 *    ... (N sources)
 *
 * Tests:
 * - Concurrent UTXO creation for single wallet
 * - Multiple transactions converging
 * - Wallet receiving from many sources simultaneously
 *
 * Budget: $0.03 USDC per source wallet, $0.005 per transfer
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { createFanInTopology } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { ApiClient } from '../lib/api-client.js';
import {
  setupOnChainFixture,
  ON_CHAIN_CONFIG,
  describeOnChain,
  testOnChain
} from './on-chain-fixture.js';

// Use describeOnChain to skip if FUNDER_PRIVATE_KEY not set
describeOnChain('Lattice: Fan-In Topology (On-Chain)', () => {
  let apiClient;

  beforeAll(async () => {
    apiClient = new ApiClient();

    const health = await apiClient.checkHealth();
    if (!health.prover || !health.relayer) {
      throw new Error('Prover and Relayer must be available for on-chain tests');
    }
  });

  testOnChain('should handle fan-in from 5 sources', async () => {
    const NUM_SOURCES = 5;
    const AMOUNT_PER_TX = ON_CHAIN_CONFIG.AMOUNTS.FAN_IN_TRANSFER; // $0.005

    const testRunId = `fanin-5-onchain-${Date.now()}`;
    // Create NUM_SOURCES + 1 wallets (sources + 1 destination)
    const wallets = createTestWallets(NUM_SOURCES + 1, testRunId);
    const destWallet = wallets[0];
    const sourceWallets = wallets.slice(1);

    console.log('\n=== Fan-In Topology Test (5 sources, On-Chain) ===');

    // Setup on-chain fixture
    const fixture = await setupOnChainFixture(testRunId);

    // REAL ON-CHAIN DEPOSITS: Seed each source wallet
    console.log(`\nSeeding ${NUM_SOURCES} source wallets with real deposits...`);
    for (let i = 0; i < NUM_SOURCES; i++) {
      const seedResult = await fixture.seeder.seedWallet(
        sourceWallets[i],
        ON_CHAIN_CONFIG.USDC_PER_WALLET // $0.03 each
      );
      console.log(`  ${sourceWallets[i].walletId} seeded: index=${seedResult.leafIndex}`);

      // Small delay between deposits to avoid nonce issues
      if (i < NUM_SOURCES - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Sync merkle tree from chain
    console.log('\nSyncing Merkle tree from chain...');
    await fixture.onChainMerkle.sync();

    // Verify root matches contract
    const rootCheck = await fixture.onChainMerkle.verifyRoot();
    if (!rootCheck.matches) {
      throw new Error(`Merkle root mismatch: local=${rootCheck.local}, contract=${rootCheck.contract}`);
    }
    console.log(`Merkle tree synced: ${fixture.onChainMerkle.getLeafCount()} leaves`);

    // Create fan-in topology
    const topology = createFanInTopology(sourceWallets, destWallet, AMOUNT_PER_TX);

    console.log(`\nTopology: ${topology.edges.length} edges converging to ${destWallet.walletId}`);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 5, // All sources send in parallel
      // ON-CHAIN MODE
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    await orchestrator.initializeMerkleTree();
    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    // Verify results
    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    const failed = result.edges.filter(e => e.status === 'failed');

    console.log(`\nConfirmed: ${confirmed}/${NUM_SOURCES}`);
    if (failed.length > 0) {
      for (const edge of failed) {
        console.error(`  Failed: ${edge.from}→${edge.to}: ${edge.error}`);
      }
    }

    expect(failed.length).toBe(0);
    expect(confirmed).toBe(NUM_SOURCES);

    // Verify destination wallet received all
    const destBalance = destWallet.getBalance();
    const expectedBalance = BigInt(AMOUNT_PER_TX * NUM_SOURCES);
    console.log(`\n${destWallet.walletId} final balance: $${Number(destBalance) / 1e6}`);
    console.log(`Expected: $${Number(expectedBalance) / 1e6}`);
    expect(destBalance).toBe(expectedBalance);

    // Verify dest wallet has N UTXOs (one from each source)
    console.log(`${destWallet.walletId} UTXO count: ${destWallet.utxos.length}`);
    expect(destWallet.utxos.length).toBe(NUM_SOURCES);

    // Verify each source has only change remaining
    for (const source of sourceWallets) {
      const balance = source.getBalance();
      const expectedChange = BigInt(ON_CHAIN_CONFIG.USDC_PER_WALLET - AMOUNT_PER_TX);
      console.log(`${source.walletId}: $${Number(balance) / 1e6} (change)`);
      expect(balance).toBe(expectedChange);
    }

    // Verify balance tracking consistency
    expect(result.balanceVerification.final.allMatch).toBe(true);
    expect(result.balanceVerification.summary.inconsistent).toBe(0);

  }, 900000); // 15 minute timeout

  testOnChain('should handle fan-in from 3 sources (budget-friendly)', async () => {
    // Smaller scale test with 3 sources for faster execution
    const NUM_SOURCES = 3;
    const AMOUNT_PER_TX = ON_CHAIN_CONFIG.AMOUNTS.FAN_IN_TRANSFER; // $0.005

    const testRunId = `fanin-3-onchain-${Date.now()}`;
    const wallets = createTestWallets(NUM_SOURCES + 1, testRunId);
    const destWallet = wallets[0];
    const sourceWallets = wallets.slice(1);

    console.log('\n=== Fan-In Budget Test (3 sources, On-Chain) ===');

    const fixture = await setupOnChainFixture(testRunId);

    // Seed source wallets
    console.log(`Seeding ${NUM_SOURCES} source wallets...`);
    for (let i = 0; i < NUM_SOURCES; i++) {
      const seedResult = await fixture.seeder.seedWallet(
        sourceWallets[i],
        ON_CHAIN_CONFIG.USDC_PER_WALLET
      );
      console.log(`  ${sourceWallets[i].walletId}: index=${seedResult.leafIndex}`);
      if (i < NUM_SOURCES - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await fixture.onChainMerkle.sync();

    const topology = createFanInTopology(sourceWallets, destWallet, AMOUNT_PER_TX);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 3,
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    await orchestrator.initializeMerkleTree();
    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    expect(confirmed).toBe(NUM_SOURCES);

    // Verify destination received
    const destBalance = destWallet.getBalance();
    console.log(`\n${destWallet.walletId} received: $${Number(destBalance) / 1e6}`);
    expect(destBalance).toBe(BigInt(AMOUNT_PER_TX * NUM_SOURCES));

    // Verify balance consistency
    expect(result.balanceVerification.final.allMatch).toBe(true);

  }, 600000); // 10 minute timeout
});
