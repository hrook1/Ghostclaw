/**
 * Fan-Out Topology Test - One source to many recipients
 *
 * ON-CHAIN MODE: Uses real USDC deposits on Sepolia testnet
 *
 *    A → B
 *    A → C
 *    A → D
 *    A → E
 *    ... (N recipients)
 *
 * Tests:
 * - Queue depth under load
 * - Sequential proof handling from single source
 * - Single wallet UTXO selection with change notes
 *
 * Budget: $0.03 USDC for source wallet, $0.005 per transfer
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { createFanOutTopology } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { ApiClient } from '../lib/api-client.js';
import {
  setupOnChainFixture,
  ON_CHAIN_CONFIG,
  describeOnChain,
  testOnChain
} from './on-chain-fixture.js';

// Use describeOnChain to skip if FUNDER_PRIVATE_KEY not set
describeOnChain('Lattice: Fan-Out Topology (On-Chain)', () => {
  let apiClient;

  beforeAll(async () => {
    apiClient = new ApiClient();

    const health = await apiClient.checkHealth();
    if (!health.prover || !health.relayer) {
      throw new Error('Prover and Relayer must be available for on-chain tests');
    }
  });

  testOnChain('should handle fan-out to 5 recipients', async () => {
    const NUM_RECIPIENTS = 5;
    const AMOUNT_PER_TX = ON_CHAIN_CONFIG.AMOUNTS.FAN_OUT_TRANSFER; // $0.005

    const testRunId = `fanout-5-onchain-${Date.now()}`;
    const wallets = createTestWallets(NUM_RECIPIENTS + 1, testRunId);
    const [sourceWallet, ...destWallets] = wallets;

    console.log('\n=== Fan-Out Topology Test (5 recipients, On-Chain) ===');

    // Setup on-chain fixture
    const fixture = await setupOnChainFixture(testRunId);

    // REAL ON-CHAIN DEPOSIT: Seed source wallet with $0.03
    console.log('\nSeeding source wallet with real on-chain deposit...');
    const seedResult = await fixture.seeder.seedWallet(
      sourceWallet,
      ON_CHAIN_CONFIG.USDC_PER_WALLET // $0.03
    );
    console.log(`Source seeded: tx=${seedResult.txHash.slice(0, 18)}..., index=${seedResult.leafIndex}`);

    // Sync merkle tree from chain
    console.log('Syncing Merkle tree from chain...');
    await fixture.onChainMerkle.sync();

    // Verify root matches contract
    const rootCheck = await fixture.onChainMerkle.verifyRoot();
    if (!rootCheck.matches) {
      throw new Error(`Merkle root mismatch: local=${rootCheck.local}, contract=${rootCheck.contract}`);
    }
    console.log(`Merkle tree synced: ${fixture.onChainMerkle.getLeafCount()} leaves`);

    console.log(`Source wallet initial balance: $${Number(sourceWallet.getBalance()) / 1e6}`);

    // Create fan-out topology
    // Note: Since source has single UTXO, these must be SEQUENTIAL
    // Each send uses change from previous send
    const topology = createFanOutTopology(sourceWallet, destWallets, AMOUNT_PER_TX);

    console.log(`\nTopology: ${topology.edges.length} edges (sequential - single UTXO source)`);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 1, // MUST be sequential - single UTXO
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

    console.log(`\nConfirmed: ${confirmed}/${NUM_RECIPIENTS}`);
    if (failed.length > 0) {
      for (const edge of failed) {
        console.error(`  Failed: ${edge.from}→${edge.to}: ${edge.error}`);
      }
    }

    expect(failed.length).toBe(0);
    expect(confirmed).toBe(NUM_RECIPIENTS);

    // Verify each recipient got their amount
    for (const dest of destWallets) {
      const balance = dest.getBalance();
      console.log(`${dest.walletId}: $${Number(balance) / 1e6}`);
      expect(balance).toBe(BigInt(AMOUNT_PER_TX));
    }

    // Verify source has remaining change
    // Started with $0.03, sent 5 × $0.005 = $0.025, should have $0.005 left
    const sourceBalance = sourceWallet.getBalance();
    const expectedSourceRemaining = BigInt(ON_CHAIN_CONFIG.USDC_PER_WALLET - (AMOUNT_PER_TX * NUM_RECIPIENTS));
    console.log(`\nSource wallet remaining: $${Number(sourceBalance) / 1e6}`);
    console.log(`Expected: $${Number(expectedSourceRemaining) / 1e6}`);
    expect(sourceBalance).toBe(expectedSourceRemaining);

    // Verify balance consistency (what UI would show)
    expect(result.balanceVerification.final.allMatch).toBe(true);
    expect(result.balanceVerification.summary.inconsistent).toBe(0);

  }, 900000); // 15 minute timeout

  testOnChain('should handle fan-out to 3 recipients (budget-friendly)', async () => {
    // Smaller scale test with 3 recipients for faster execution
    const NUM_RECIPIENTS = 3;
    const AMOUNT_PER_TX = ON_CHAIN_CONFIG.AMOUNTS.FAN_OUT_TRANSFER; // $0.005

    const testRunId = `fanout-3-onchain-${Date.now()}`;
    const wallets = createTestWallets(NUM_RECIPIENTS + 1, testRunId);
    const [sourceWallet, ...destWallets] = wallets;

    console.log('\n=== Fan-Out Budget Test (3 recipients, On-Chain) ===');

    const fixture = await setupOnChainFixture(testRunId);

    // Seed source wallet
    console.log('Seeding source wallet...');
    const seedResult = await fixture.seeder.seedWallet(
      sourceWallet,
      ON_CHAIN_CONFIG.USDC_PER_WALLET
    );
    console.log(`Source seeded at index ${seedResult.leafIndex}`);

    await fixture.onChainMerkle.sync();

    const topology = createFanOutTopology(sourceWallet, destWallets, AMOUNT_PER_TX);

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 1, // Sequential
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    await orchestrator.initializeMerkleTree();
    const result = await orchestrator.execute();

    console.log('\n' + orchestrator.getReport());

    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    expect(confirmed).toBe(NUM_RECIPIENTS);

    // Verify each recipient received
    for (const dest of destWallets) {
      const balance = dest.getBalance();
      console.log(`${dest.walletId}: $${Number(balance) / 1e6}`);
      expect(balance).toBe(BigInt(AMOUNT_PER_TX));
    }

    // Verify balance consistency
    expect(result.balanceVerification.final.allMatch).toBe(true);

  }, 600000); // 10 minute timeout
});
