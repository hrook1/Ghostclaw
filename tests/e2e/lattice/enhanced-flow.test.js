/**
 * Enhanced Flow Test - Complex interdependencies with Deposits, Sends, and Withdrawals
 *
 * Tests a realistic user scenario:
 * 1. Multiple wallets seeded with funds
 * 2. Complex send topology with interdependencies
 * 3. Final withdrawals to external addresses
 *
 * Topology:
 *   Wallet A (funded) → B, C (parallel fan-out)
 *   B → D, C → D (diamond convergence)
 *   D → E → F (chain)
 *   F → [withdraw to external]
 *
 *   Wallet G (funded) → H → I (separate chain)
 *   I → [withdraw to external]
 *
 * Total: 10 wallets, 8 sends, 2 withdrawals
 */

import { CONFIG, testIfProver } from '../setup.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { LatticeTopology, EdgeStatus } from '../lib/lattice-topology.js';
import { TestOrchestrator } from '../lib/test-orchestrator.js';
import { ApiClient } from '../lib/api-client.js';
import { MetricsCollector } from '../lib/metrics-collector.js';

// Withdrawal edge type (pseudo-address for withdraw operations)
const EXTERNAL_WITHDRAW = '__EXTERNAL_WITHDRAW__';

describe('Lattice: Enhanced Flow with Withdrawals', () => {
  const NUM_WALLETS = 10;
  const INITIAL_BALANCE_A = 1000000; // $1.00 USDC
  const INITIAL_BALANCE_G = 600000;  // $0.60 USDC

  let wallets;
  let apiClient;
  let metrics;

  beforeAll(async () => {
    apiClient = new ApiClient();
    metrics = new MetricsCollector();

    // Verify servers are healthy
    const health = await apiClient.checkHealth();
    console.log('\n=== Enhanced Flow Test ===');
    console.log('Prover:', health.prover ? 'OK' : 'NOT AVAILABLE');
    console.log('Relayer:', health.relayer ? 'OK' : 'NOT AVAILABLE');

    if (!health.prover || !health.relayer) {
      console.warn('⚠ Servers not fully available, tests may be skipped or fail');
    }

    // Create test wallets
    const testRunId = `enhanced-${Date.now()}`;
    wallets = createTestWallets(NUM_WALLETS, testRunId);

    // Name wallets A-J for clarity
    const walletNames = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    wallets.forEach((w, i) => {
      w.displayName = walletNames[i] || `W${i}`;
    });

    console.log(`\nWallets: ${wallets.map(w => w.displayName).join(', ')}`);

    // Seed Wallet A with $1.00
    wallets[0].addUTXO({
      commitment: '0x' + Buffer.from(Array(32).fill(1)).toString('hex'),
      amount: BigInt(INITIAL_BALANCE_A),
      owner: '0x' + wallets[0].ownerX,
      blinding: wallets[0].generateBlinding(),
      index: 0
    });
    console.log(`Wallet A seeded with $${INITIAL_BALANCE_A / 1e6}`);

    // Seed Wallet G with $0.60
    wallets[6].addUTXO({
      commitment: '0x' + Buffer.from(Array(32).fill(7)).toString('hex'),
      amount: BigInt(INITIAL_BALANCE_G),
      owner: '0x' + wallets[6].ownerX,
      blinding: wallets[6].generateBlinding(),
      index: 1
    });
    console.log(`Wallet G seeded with $${INITIAL_BALANCE_G / 1e6}`);
  });

  testIfProver('should execute complex topology with interdependencies', async () => {
    const [A, B, C, D, E, F, G, H, I, J] = wallets;

    // Create complex topology
    const topology = new LatticeTopology(wallets);

    // === Branch 1: A fans out, diamond converges, chain continues ===
    // A → B ($0.40), A → C ($0.40)  [parallel fan-out]
    const abEdge = topology.addEdge(A.walletId, B.walletId, 400000);  // $0.40
    const acEdge = topology.addEdge(A.walletId, C.walletId, 400000);  // $0.40

    // B → D, C → D [diamond convergence, depends on fan-out]
    const bdEdge = topology.addEdge(B.walletId, D.walletId, 200000, [abEdge]); // $0.20
    const cdEdge = topology.addEdge(C.walletId, D.walletId, 200000, [acEdge]); // $0.20

    // D → E → F [chain continues]
    const deEdge = topology.addEdge(D.walletId, E.walletId, 300000, [bdEdge, cdEdge]); // $0.30
    const efEdge = topology.addEdge(E.walletId, F.walletId, 250000, [deEdge]); // $0.25

    // === Branch 2: G → H → I (separate chain) ===
    const ghEdge = topology.addEdge(G.walletId, H.walletId, 400000);  // $0.40
    const hiEdge = topology.addEdge(H.walletId, I.walletId, 300000, [ghEdge]); // $0.30

    console.log('\n=== Topology ===');
    console.log('Branch 1 (Diamond + Chain):');
    console.log('  A → B ($0.40) ──┐');
    console.log('  A → C ($0.40) ──┼──→ D → E ($0.30) → F ($0.25)');
    console.log('  B → D ($0.20) ──┘');
    console.log('  C → D ($0.20) ──┘');
    console.log('\nBranch 2 (Chain):');
    console.log('  G → H ($0.40) → I ($0.30)');
    console.log(`\nTotal edges: ${topology.edges.length}`);
    console.log(topology.toString());

    // Create orchestrator with controlled concurrency
    // Note: maxConcurrent=2 to avoid overwhelming relayer with parallel txs
    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      maxConcurrent: 2,  // Limited parallelism for reliability
      pollInterval: 5000
    });

    // Execute topology
    const startTime = Date.now();
    const result = await orchestrator.execute();
    const totalTime = Date.now() - startTime;

    console.log('\n' + orchestrator.getReport());

    // Log results
    const confirmed = result.edges.filter(e => e.status === 'confirmed');
    const failed = result.edges.filter(e => e.status === 'failed');

    console.log('\n=== Results ===');
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`Confirmed: ${confirmed.length}/${topology.edges.length}`);
    console.log(`Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.log('\nFailed edges:');
      for (const edge of failed) {
        const fromName = wallets.find(w => w.walletId === edge.from)?.displayName || edge.from;
        const toName = wallets.find(w => w.walletId === edge.to)?.displayName || edge.to;
        console.log(`  ${fromName} → ${toName}: ${edge.error}`);
      }
    }

    // Log final balances
    console.log('\n=== Final Balances ===');
    for (const wallet of wallets) {
      const balance = wallet.getBalance();
      if (balance > 0n || wallet.displayName === 'A' || wallet.displayName === 'G') {
        console.log(`  ${wallet.displayName}: $${Number(balance) / 1e6} (${wallet.utxos.length} UTXOs)`);
      }
    }

    // Verify balance tracking
    console.log('\n=== Balance Verification ===');
    const balanceVerification = result.balanceVerification;
    console.log(`  Per-transaction checks: ${balanceVerification.summary.totalVerifications}`);
    console.log(`  Total wallet checks: ${balanceVerification.summary.totalWalletChecks}`);
    console.log(`  Inconsistencies: ${balanceVerification.summary.inconsistent}`);
    console.log(`  Wrong amounts: ${balanceVerification.summary.wrongAmounts}`);
    console.log(`  Final check passed: ${balanceVerification.final.allMatch}`);

    // Assertions
    expect(failed.length).toBe(0);
    expect(confirmed.length).toBe(topology.edges.length);
    expect(balanceVerification.final.allMatch).toBe(true);

    // Verify specific balances
    // A should have $0.20 change (started with $1.00, sent $0.80)
    expect(A.getBalance()).toBe(BigInt(200000));

    // F should have $0.25 (end of branch 1 chain)
    expect(F.getBalance()).toBe(BigInt(250000));

    // I should have $0.30 (end of branch 2 chain)
    expect(I.getBalance()).toBe(BigInt(300000));

    // D should have $0.10 change ($0.40 received - $0.30 sent)
    expect(D.getBalance()).toBe(BigInt(100000));

  }, 1800000); // 30 minute timeout for complex topology

  testIfProver('should execute withdrawals after send chain', async () => {
    // Create fresh wallets for withdrawal test
    const testRunId = `withdraw-${Date.now()}`;
    const withdrawWallets = createTestWallets(4, testRunId);
    const [W1, W2, W3, W4] = withdrawWallets;

    W1.displayName = 'Source';
    W2.displayName = 'Middle';
    W3.displayName = 'PreWithdraw';
    W4.displayName = 'Unused';

    // Seed W1 with $0.80
    W1.addUTXO({
      commitment: '0x' + Buffer.from(Array(32).fill(100)).toString('hex'),
      amount: BigInt(800000),
      owner: '0x' + W1.ownerX,
      blinding: W1.generateBlinding(),
      index: 100
    });

    console.log('\n=== Withdrawal Flow Test ===');
    console.log('Chain: Source ($0.80) → Middle ($0.60) → PreWithdraw ($0.50)');
    console.log('Then: PreWithdraw → Withdraw $0.40 to external address');

    // Step 1: Execute send chain
    const sendTopology = new LatticeTopology(withdrawWallets);
    const s1 = sendTopology.addEdge(W1.walletId, W2.walletId, 600000);  // $0.60
    const s2 = sendTopology.addEdge(W2.walletId, W3.walletId, 500000, [s1]); // $0.50

    const sendOrchestrator = new TestOrchestrator(sendTopology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      maxConcurrent: 1
    });

    console.log('\n--- Step 1: Send Chain ---');
    const sendResult = await sendOrchestrator.execute();

    const sendConfirmed = sendResult.edges.filter(e => e.status === 'confirmed').length;
    expect(sendConfirmed).toBe(2);

    console.log(`Send chain complete: ${sendConfirmed}/2 confirmed`);
    console.log(`PreWithdraw balance: $${Number(W3.getBalance()) / 1e6}`);

    // Step 2: Execute withdrawal
    console.log('\n--- Step 2: Withdrawal ---');
    const withdrawAmount = 400000; // $0.40
    const externalRecipient = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // Example address

    // Build withdrawal proof request
    const { selected, total } = W3.selectUTXOs(withdrawAmount);
    const changeAmount = total - BigInt(withdrawAmount);

    console.log(`Selected UTXOs: ${selected.length}, total: $${Number(total) / 1e6}`);
    console.log(`Withdraw: $${withdrawAmount / 1e6}, Change: $${Number(changeAmount) / 1e6}`);

    // Generate blindings for change output (if any)
    const outputNotes = [];
    let changeEncrypted = null;

    if (changeAmount > 0n) {
      const changeBlinding = W3.generateBlinding();
      outputNotes.push({
        amount: Number(changeAmount),
        ownerPubkey: '0x' + W3.ownerX,
        blinding: changeBlinding
      });

      changeEncrypted = await W3.encryptNote(
        changeAmount,
        W3.address,
        changeBlinding,
        W3.publicKey
      );
    }

    // Pre-compute output commitments for TxSig
    const outputCommitments = outputNotes.map(n =>
      W3.computeCommitment(n.amount, n.ownerPubkey, n.blinding)
    );

    // Sign inputs
    const nullifierSignatures = [];
    const txSignatures = [];

    for (const utxo of selected) {
      const inputComm = W3.computeCommitment(utxo.amount, utxo.owner, utxo.blinding);
      const nullifierSig = await W3.signCommitment(inputComm);
      nullifierSignatures.push(nullifierSig);

      const nullifier = W3.computeNullifier(nullifierSig);
      const nullifierBytes = Buffer.from(nullifier.slice(2), 'hex');
      const outCommsBytes = Buffer.concat(
        outputCommitments.map(c => Buffer.from(c.slice(2), 'hex'))
      );
      const txMsg = '0x' + Buffer.concat([nullifierBytes, outCommsBytes]).toString('hex');
      const txSig = await W3.signCommitment(txMsg);
      txSignatures.push(txSig);
    }

    // Build proof request
    const inputNotes = selected.map(utxo => ({
      amount: Number(utxo.amount),
      ownerPubkey: utxo.owner.startsWith('0x') ? utxo.owner : `0x${utxo.owner}`,
      blinding: utxo.blinding.startsWith('0x') ? utxo.blinding : `0x${utxo.blinding}`
    }));

    // Get current merkle root
    const currentRoot = await apiClient.getCurrentRoot();

    // Submit proof request
    console.log('Submitting withdrawal proof request...');
    const proofJob = await apiClient.submitProofRequest({
      inputNotes,
      outputNotes,
      nullifierSignatures,
      txSignatures,
      inputIndices: selected.map(u => u.index),
      oldRoot: currentRoot
    });

    console.log(`Proof job submitted: ${proofJob.jobId}`);

    // Wait for proof
    const proofResult = await apiClient.waitForProof(proofJob.jobId, {
      pollInterval: 5000,
      timeout: 300000,
      onStatus: (status) => {
        if (status.stageDescription) {
          console.log(`  Proof: ${status.stageDescription} (${status.progress || 0}%)`);
        }
      }
    });

    console.log('Proof complete!');

    // Build withdrawal payload
    const encryptedOutputs = changeEncrypted && proofResult.publicOutputs.outputCommitments.length > 0 ? [{
      commitment: proofResult.publicOutputs.outputCommitments[0],
      keyType: 0,
      ephemeralPubkey: changeEncrypted.ephemeralPubkey,
      nonce: changeEncrypted.nonce,
      ciphertext: changeEncrypted.ciphertext
    }] : [];

    // Submit withdrawal
    console.log(`Submitting withdrawal to relayer...`);
    console.log(`  Recipient: ${externalRecipient}`);
    console.log(`  Amount: $${withdrawAmount / 1e6}`);

    const withdrawResult = await apiClient.withdraw({
      recipient: externalRecipient,
      amount: withdrawAmount.toString(),
      proof: proofResult.proof,
      publicValues: proofResult.publicValuesRaw,
      encryptedOutputs
    });

    console.log(`\n✅ Withdrawal confirmed!`);
    console.log(`  TX Hash: ${withdrawResult.txHash}`);

    // Update local state
    W3.spendUTXOs(selected);
    if (changeAmount > 0n && proofResult.publicOutputs.outputCommitments.length > 0) {
      W3.addUTXO({
        commitment: proofResult.publicOutputs.outputCommitments[0],
        amount: changeAmount,
        owner: '0x' + W3.ownerX,
        blinding: outputNotes[0].blinding,
        index: 200
      });
    }

    // Verify final state
    const finalBalance = W3.getBalance();
    console.log(`\nPreWithdraw final balance: $${Number(finalBalance) / 1e6}`);
    console.log(`Expected: $${Number(changeAmount) / 1e6}`);

    expect(finalBalance).toBe(changeAmount);
    expect(withdrawResult.txHash).toBeDefined();
    expect(withdrawResult.txHash.startsWith('0x')).toBe(true);

  }, 900000); // 15 minute timeout

  testIfProver('should handle large-scale topology (12 wallets, 10 edges)', async () => {
    // Create larger wallet set
    const testRunId = `large-${Date.now()}`;
    const largeWallets = createTestWallets(12, testRunId);

    // Name for clarity
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
    largeWallets.forEach((w, i) => {
      w.displayName = names[i];
    });

    // Seed multiple starting wallets
    const seedIndices = [0, 3, 6]; // A, D, G
    const seedAmounts = [1500000, 1200000, 900000]; // $1.50, $1.20, $0.90

    seedIndices.forEach((idx, i) => {
      largeWallets[idx].addUTXO({
        commitment: '0x' + Buffer.from(Array(32).fill(200 + idx)).toString('hex'),
        amount: BigInt(seedAmounts[i]),
        owner: '0x' + largeWallets[idx].ownerX,
        blinding: largeWallets[idx].generateBlinding(),
        index: 200 + idx
      });
    });

    console.log('\n=== Large-Scale Topology Test ===');
    console.log('12 wallets, 3 seeded sources, complex interdependencies');
    console.log('\nSeeded wallets:');
    seedIndices.forEach((idx, i) => {
      console.log(`  ${names[idx]}: $${seedAmounts[i] / 1e6}`);
    });

    // Create complex topology
    const [A, B, C, D, E, F, G, H, I, J, K, L] = largeWallets;
    const topology = new LatticeTopology(largeWallets);

    // Branch 1: A fans out
    const ab = topology.addEdge(A.walletId, B.walletId, 500000);  // $0.50
    const ac = topology.addEdge(A.walletId, C.walletId, 500000);  // $0.50

    // Branch 2: D→E→F chain
    const de = topology.addEdge(D.walletId, E.walletId, 600000);  // $0.60
    const ef = topology.addEdge(E.walletId, F.walletId, 400000, [de]); // $0.40

    // Branch 3: G fans out
    const gh = topology.addEdge(G.walletId, H.walletId, 400000);  // $0.40
    const gi = topology.addEdge(G.walletId, I.walletId, 400000);  // $0.40

    // Convergence: B, F, H → J
    const bj = topology.addEdge(B.walletId, J.walletId, 300000, [ab]); // $0.30
    const fj = topology.addEdge(F.walletId, J.walletId, 300000, [ef]); // $0.30
    const hj = topology.addEdge(H.walletId, J.walletId, 300000, [gh]); // $0.30

    // Final chain: J→K
    topology.addEdge(J.walletId, K.walletId, 500000, [bj, fj, hj]); // $0.50

    console.log(`\nTotal edges: ${topology.edges.length}`);
    console.log('Dependencies:');
    console.log('  ab, ac (parallel from A)');
    console.log('  de (from D) → ef');
    console.log('  gh, gi (parallel from G)');
    console.log('  bj (depends on ab)');
    console.log('  fj (depends on ef)');
    console.log('  hj (depends on gh)');
    console.log('  jk (depends on bj, fj, hj)');

    // Execute with high concurrency
    const orchestrator = new TestOrchestrator(topology, {
      proverUrl: CONFIG.PROVER_SERVER,
      relayerUrl: CONFIG.RELAYER_SERVER,
      maxConcurrent: 6,  // Allow high parallelism
      pollInterval: 5000
    });

    const startTime = Date.now();
    const result = await orchestrator.execute();
    const totalTime = Date.now() - startTime;

    console.log('\n' + orchestrator.getReport());

    // Results
    const confirmed = result.edges.filter(e => e.status === 'confirmed').length;
    const failed = result.edges.filter(e => e.status === 'failed');

    console.log('\n=== Results ===');
    console.log(`Total time: ${(totalTime / 1000 / 60).toFixed(1)} minutes`);
    console.log(`Confirmed: ${confirmed}/${topology.edges.length}`);

    if (failed.length > 0) {
      console.log('\nFailed edges:');
      for (const edge of failed) {
        const fromName = largeWallets.find(w => w.walletId === edge.from)?.displayName;
        const toName = largeWallets.find(w => w.walletId === edge.to)?.displayName;
        console.log(`  ${fromName} → ${toName}: ${edge.error}`);
      }
    }

    // Final balances
    console.log('\n=== Final Balances ===');
    for (const wallet of largeWallets) {
      const balance = wallet.getBalance();
      if (balance > 0n) {
        console.log(`  ${wallet.displayName}: $${Number(balance) / 1e6} (${wallet.utxos.length} UTXOs)`);
      }
    }

    // Balance verification
    expect(result.balanceVerification.final.allMatch).toBe(true);
    expect(failed.length).toBe(0);

    // K should have $0.50 (end of convergence chain)
    expect(K.getBalance()).toBe(BigInt(500000));

  }, 2400000); // 40 minute timeout for large topology
});
