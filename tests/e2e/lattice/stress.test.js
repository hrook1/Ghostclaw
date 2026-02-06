/**
 * Stress Tests - High-volume concurrent operations
 *
 * ON-CHAIN MODE: Uses real USDC deposits on Sepolia testnet
 *
 * Tests:
 * - Rapid proof submissions
 * - Queue behavior under load
 * - Health check responsiveness
 * - Error handling under pressure
 *
 * Budget: $0.03 USDC per wallet, limited wallets due to cost constraints
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets, MerkleTree } from '../lib/wallet-simulator.js';
import { LatticeTopology } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { ApiClient } from '../lib/api-client.js';
import { MetricsCollector } from '../lib/metrics-collector.js';
import {
  setupOnChainFixture,
  ON_CHAIN_CONFIG,
  describeOnChain,
  testOnChain
} from './on-chain-fixture.js';

// Use describeOnChain to skip if FUNDER_PRIVATE_KEY not set
describeOnChain('Lattice: Stress Tests (On-Chain)', () => {
  let apiClient;

  beforeAll(async () => {
    apiClient = new ApiClient();

    const health = await apiClient.checkHealth();
    if (!health.prover) {
      console.warn('Prover not available, stress tests may fail');
    }
    if (!health.relayer) {
      console.warn('Relayer not available, stress tests may fail');
    }
  });

  testOnChain('should handle mixed interrelated operations', async () => {
    console.log('\n=== Mixed Interrelated Operations Test (On-Chain) ===');

    /*
     * Complex topology:
     *   A → B → D
     *   A → C → D
     *   D → E
     *
     * This creates a diamond followed by a chain
     *
     * Budget: $0.03 for A only (single seed), smaller transfer amounts
     */

    const testRunId = `stress-mixed-onchain-${Date.now()}`;
    const wallets = createTestWallets(5, testRunId);
    const [A, B, C, D, E] = wallets;

    // Setup on-chain fixture
    const fixture = await setupOnChainFixture(testRunId);

    // REAL ON-CHAIN DEPOSIT: Seed wallet A with $0.03
    console.log('Seeding wallet A...');
    const seedResult = await fixture.seeder.seedWallet(
      A,
      ON_CHAIN_CONFIG.USDC_PER_WALLET // $0.03
    );
    console.log(`Wallet A seeded at index ${seedResult.leafIndex}`);

    // Sync merkle tree
    await fixture.onChainMerkle.sync();

    console.log(`Wallet A seeded with $${ON_CHAIN_CONFIG.USDC_PER_WALLET / 1e6}`);

    // Create complex topology with budget-conscious amounts
    // A has $0.03, needs to fund: A→B ($0.01), A→C ($0.01), leaving $0.01 change
    // B gets $0.01, sends B→D ($0.005), keeps $0.005
    // C gets $0.01, sends C→D ($0.005), keeps $0.005
    // D gets $0.01 (from B+C), sends D→E ($0.007), keeps $0.003
    const topology = new LatticeTopology(wallets);

    // First layer: A fans out (SEQUENTIAL - single UTXO)
    const AB_AMOUNT = 10000; // $0.01
    const AC_AMOUNT = 10000; // $0.01
    const BD_AMOUNT = 5000;  // $0.005
    const CD_AMOUNT = 5000;  // $0.005
    const DE_AMOUNT = 7000;  // $0.007

    const abEdge = topology.addEdge(A.walletId, B.walletId, AB_AMOUNT);
    const acEdge = topology.addEdge(A.walletId, C.walletId, AC_AMOUNT, [abEdge]); // Sequential

    // Second layer: B and C converge to D
    const bdEdge = topology.addEdge(B.walletId, D.walletId, BD_AMOUNT, [abEdge]);
    const cdEdge = topology.addEdge(C.walletId, D.walletId, CD_AMOUNT, [acEdge]);

    // Third layer: D chains to E
    topology.addEdge(D.walletId, E.walletId, DE_AMOUNT, [bdEdge, cdEdge]);

    console.log(`\nTopology: ${topology.edges.length} edges`);
    console.log(topology.toString());

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
    const failed = result.edges.filter(e => e.status === 'failed');

    console.log(`\nConfirmed: ${confirmed}/5`);
    if (failed.length > 0) {
      for (const edge of failed) {
        console.error(`  ${edge.from}→${edge.to}: ${edge.error}`);
      }
    }

    expect(failed.length).toBe(0);
    expect(confirmed).toBe(5);

    // Verify final state
    const eBalance = E.getBalance();
    console.log(`\nWallet E final balance: $${Number(eBalance) / 1e6}`);
    expect(eBalance).toBe(BigInt(DE_AMOUNT));

    // Check execution order respected dependencies
    const edges = result.edges;
    const abComplete = edges.find(e => e.id === abEdge).endTime;
    const bdStart = edges.find(e => e.id === bdEdge).startTime;

    console.log(`\nDependency check: A→B completed before B→D started: ${abComplete < bdStart}`);
    expect(abComplete).toBeLessThan(bdStart);

    // Verify balance verification passed
    const balanceVerification = result.balanceVerification;
    console.log(`\nBalance verification summary:`);
    console.log(`  Total verifications: ${balanceVerification.summary.totalVerifications}`);
    console.log(`  Total wallet checks: ${balanceVerification.summary.totalWalletChecks}`);
    console.log(`  Inconsistent: ${balanceVerification.summary.inconsistent}`);
    console.log(`  Wrong amounts: ${balanceVerification.summary.wrongAmounts}`);

    // All local balances should be consistent (what UI would show)
    expect(balanceVerification.final.allMatch).toBe(true);
    expect(balanceVerification.summary.inconsistent).toBe(0);
    expect(balanceVerification.summary.wrongAmounts).toBe(0);

  }, 1200000); // 20 minute timeout

  testOnChain('should maintain health responsiveness under load', async () => {
    console.log('\n=== Health Check Under Load Test (On-Chain) ===');

    // Submit some proof requests to create load
    const testRunId = `stress-health-onchain-${Date.now()}`;
    const wallets = createTestWallets(4, testRunId);

    // Setup fixture
    const fixture = await setupOnChainFixture(testRunId);

    // Seed first 2 wallets
    console.log('Seeding 2 wallets for load generation...');
    for (let i = 0; i < 2; i++) {
      const seedResult = await fixture.seeder.seedWallet(
        wallets[i],
        ON_CHAIN_CONFIG.USDC_PER_WALLET
      );
      console.log(`  wallet-${i}: index=${seedResult.leafIndex}`);
      if (i < 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await fixture.onChainMerkle.sync();

    // Create simple topology: wallet-0 → wallet-2, wallet-1 → wallet-3
    const topology = new LatticeTopology(wallets);
    topology.addEdge(wallets[0].walletId, wallets[2].walletId, 5000);
    topology.addEdge(wallets[1].walletId, wallets[3].walletId, 5000);

    console.log('Submitting 2 proof requests to create load...');

    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      pollInterval: CONFIG.LATTICE.POLL_INTERVAL,
      maxConcurrent: 2, // Parallel - different source wallets
      onChainMode: true,
      onChainMerkle: fixture.onChainMerkle
    });

    // Start execution in background
    await orchestrator.initializeMerkleTree();
    const executionPromise = orchestrator.execute();

    // Perform health checks while proofs are generating
    const healthChecks = [];
    const checkInterval = 2000;
    const numChecks = 10;

    console.log(`Performing ${numChecks} health checks over ${(numChecks * checkInterval) / 1000}s...`);

    for (let i = 0; i < numChecks; i++) {
      const start = Date.now();
      try {
        const health = await apiClient.checkHealth();
        const responseTime = Date.now() - start;
        healthChecks.push({
          index: i,
          responseTime,
          proverOk: !!health.prover,
          relayerOk: !!health.relayer
        });
        console.log(`  Check ${i}: ${responseTime}ms (prover: ${health.prover ? 'OK' : 'FAIL'}, relayer: ${health.relayer ? 'OK' : 'FAIL'})`);
      } catch (error) {
        healthChecks.push({
          index: i,
          responseTime: Date.now() - start,
          error: error.message
        });
        console.log(`  Check ${i}: FAILED - ${error.message}`);
      }

      await new Promise(r => setTimeout(r, checkInterval));
    }

    // Wait for execution to complete
    const result = await executionPromise;
    console.log('\n' + orchestrator.getReport());

    // Analyze health check responsiveness
    const successfulChecks = healthChecks.filter(c => !c.error);
    const avgResponseTime = successfulChecks.length > 0
      ? successfulChecks.reduce((a, c) => a + c.responseTime, 0) / successfulChecks.length
      : 0;
    const maxResponseTime = successfulChecks.length > 0
      ? Math.max(...successfulChecks.map(c => c.responseTime))
      : 0;

    console.log(`\nHealth check results:`);
    console.log(`  Successful: ${successfulChecks.length}/${numChecks}`);
    console.log(`  Avg response: ${avgResponseTime.toFixed(0)}ms`);
    console.log(`  Max response: ${maxResponseTime}ms`);

    // Health checks should be responsive (< 5s even under load)
    expect(avgResponseTime).toBeLessThan(5000);
    expect(successfulChecks.length).toBeGreaterThanOrEqual(numChecks - 1); // Allow 1 failure

  }, 300000); // 5 minute timeout

  testOnChain('should report queue metrics accurately', async () => {
    console.log('\n=== Queue Metrics Accuracy Test (On-Chain) ===');

    const metrics = new MetricsCollector();

    // Take multiple queue snapshots
    const snapshots = [];
    for (let i = 0; i < 5; i++) {
      const status = await apiClient.getQueueStatus();
      snapshots.push(status);
      metrics.recordQueueSnapshot(status);
      console.log(`Snapshot ${i}: active=${status.activeJobs}, queued=${status.queuedJobs}, total=${status.totalTracked}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Verify queue status is consistent
    for (const snapshot of snapshots) {
      expect(typeof snapshot.activeJobs).toBe('number');
      expect(typeof snapshot.queuedJobs).toBe('number');
      expect(snapshot.activeJobs).toBeGreaterThanOrEqual(0);
      expect(snapshot.queuedJobs).toBeGreaterThanOrEqual(0);
    }

    // Verify metrics collection
    const summary = metrics.getSummary();
    console.log(`\nMetrics summary:`);
    console.log(`  Queue snapshots: ${summary.queue.snapshots}`);
    console.log(`  Max depth: ${summary.queue.maxDepth}`);
    console.log(`  Max active: ${summary.queue.maxActive}`);

    expect(summary.queue.snapshots).toBe(5);

  }, 30000);
});
