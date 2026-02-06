/**
 * Test Orchestrator - Execute lattice topologies with concurrency control
 *
 * Coordinates the execution of wallet transactions across a lattice topology:
 * 1. Identifies ready edges (dependencies satisfied)
 * 2. Builds and submits proof requests
 * 3. Polls for proof completion
 * 4. Submits proven transactions to relayer
 * 5. Updates UTXO state
 * 6. Collects metrics throughout
 */

import { ApiClient } from './api-client.js';
import { MetricsCollector } from './metrics-collector.js';
import { MerkleTree } from './wallet-simulator.js';
import { EdgeStatus } from './lattice-topology.js';

export class TestOrchestrator {
  constructor(topology, options = {}) {
    this.topology = topology;
    this.apiClient = new ApiClient(options.proverUrl, options.relayerUrl);
    this.metrics = new MetricsCollector();

    // Configuration
    this.pollInterval = options.pollInterval || 5000;  // 5s between polls
    this.maxConcurrent = options.maxConcurrent || 10;  // Max parallel edges
    this.proofTimeout = options.proofTimeout || 300000; // 5 min proof timeout
    this.verifyBalances = options.verifyBalances !== false; // Enable balance verification by default

    // ON-CHAIN MODE: Use real on-chain Merkle tree
    this.onChainMode = options.onChainMode || false;
    this.onChainMerkle = options.onChainMerkle || null;

    if (this.onChainMode && !this.onChainMerkle) {
      throw new Error('onChainMerkle is required when onChainMode is true');
    }

    // State tracking
    this.currentRoot = options.initialRoot || '0x' + '00'.repeat(32);
    this.nextIndex = options.initialIndex || 0;

    // Balance verification results
    this.balanceVerifications = [];

    // Queue monitoring
    this.queueMonitorInterval = null;

    // Merkle Tree for witness generation (local mode only)
    this.merkleTree = new MerkleTree();

    // Don't auto-initialize in constructor for on-chain mode
    // (must be called after onChainMerkle.sync())
    if (!this.onChainMode) {
      this.initializeMerkleTree();
    }
  }

  /**
   * Execute the entire topology
   * Returns when all edges are complete (confirmed or failed)
   */
  async execute() {
    const startTime = Date.now();
    console.log(`\n[Orchestrator] Starting execution of ${this.topology.edges.length} edges`);
    console.log(`[Orchestrator] Max concurrent: ${this.maxConcurrent}`);

    // Fetch current merkle root from contract
    // this.currentRoot = await this.apiClient.getCurrentRoot();
    console.log(`[Orchestrator] Using initialized merkle root: ${this.currentRoot.slice(0, 18)}...`);

    // Start queue monitoring
    this.startQueueMonitoring();

    try {
      while (!this.topology.isComplete()) {
        // Get edges ready to start
        const readyEdges = this.topology.getReadyEdges();
        const inProgressCount = this.topology.getInProgressEdges().length;

        // Start new edges up to maxConcurrent
        const slotsAvailable = this.maxConcurrent - inProgressCount;
        const toStart = readyEdges.slice(0, slotsAvailable);

        if (toStart.length > 0) {
          console.log(`[Orchestrator] Starting ${toStart.length} edges (${inProgressCount} in progress)`);
          const startPromises = toStart.map(edge => this.startEdge(edge));
          await Promise.all(startPromises);
        }

        // Poll in-progress edges
        const inProgressEdges = this.topology.getInProgressEdges();
        if (inProgressEdges.length > 0) {
          await this.pollEdges(inProgressEdges);
        }

        // Small delay before next iteration
        await new Promise(r => setTimeout(r, this.pollInterval));

        // Progress update
        const summary = this.topology.getSummary();
        console.log(`[Orchestrator] Progress: ${summary.byStatus.confirmed || 0}/${this.topology.edges.length} confirmed, ${inProgressEdges.length} in progress`);
      }

    } finally {
      this.stopQueueMonitoring();
    }

    const duration = Date.now() - startTime;
    console.log(`[Orchestrator] Execution complete in ${(duration / 1000).toFixed(1)}s`);

    // Run final balance verification
    let finalBalanceVerification = null;
    if (this.verifyBalances) {
      finalBalanceVerification = await this.verifyFinalBalances();
    }

    return {
      duration,
      edges: this.topology.edges,
      summary: this.topology.getSummary(),
      metrics: this.metrics.getSummary(),
      balanceVerification: {
        perTransaction: this.balanceVerifications,
        final: finalBalanceVerification,
        summary: this.getBalanceVerificationSummary()
      }
    };
  }

  /**
   * Initialize Merkle Tree from topology state or on-chain sync
   *
   * In on-chain mode: Uses pre-synced OnChainMerkle
   * In local mode: Rebuilds from wallet UTXOs
   */
  async initializeMerkleTree() {
    if (this.onChainMode) {
      // ON-CHAIN MODE: Use synced on-chain Merkle tree
      // The onChainMerkle should already be synced before calling this
      this.merkleTree = this.onChainMerkle.tree;
      this.currentRoot = this.onChainMerkle.root();
      this.nextIndex = this.onChainMerkle.getLeafCount();

      // Verify root matches contract
      const contractRoot = await this.onChainMerkle.getCurrentRoot();
      if (this.currentRoot.toLowerCase() !== contractRoot.toLowerCase()) {
        throw new Error(
          `[Orchestrator] Merkle root mismatch!\n` +
          `  Local:    ${this.currentRoot}\n` +
          `  Contract: ${contractRoot}`
        );
      }

      console.log(`[Orchestrator] On-chain Merkle Tree initialized: ${this.nextIndex} leaves, root: ${this.currentRoot.slice(0, 18)}...`);
      return;
    }

    // LOCAL MODE: Rebuild from wallet UTXOs (original behavior)
    let allUtxos = [];
    for (const wallet of this.topology.wallets.values()) {
      allUtxos.push(...wallet.utxos);
    }

    // Sort by index to rebuild tree accurately
    allUtxos.sort((a, b) => a.index - b.index);

    // Insert into tree
    for (const utxo of allUtxos) {
      this.merkleTree.insert(utxo.commitment);
    }

    console.log(`[Orchestrator] Initialized Merkle Tree with ${allUtxos.length} leaves. Root: ${this.merkleTree.root()}`);

    // If we have seeded UTXOs, update currentRoot to match local tree
    if (allUtxos.length > 0) {
      this.currentRoot = this.merkleTree.root();
    }
  }

  /**
   * Start a single edge (build and submit proof request)
   */
  async startEdge(edge) {
    const fromWallet = this.topology.getWallet(edge.from);
    const toWallet = this.topology.getWallet(edge.to);

    if (!fromWallet || !toWallet) {
      edge.status = EdgeStatus.FAILED;
      edge.error = `Wallet not found: ${!fromWallet ? edge.from : edge.to}`;
      this.metrics.recordError('wallet_not_found', { message: edge.error }, edge.id);
      return;
    }

    edge.startTime = Date.now();
    edge.status = EdgeStatus.PROVING;

    try {
      // Build transaction data
      const txData = await this.buildTransaction(fromWallet, toWallet, edge.amount);
      edge.txData = txData;

      // Submit proof request
      const proofJob = await this.apiClient.submitProofRequest(txData.proofRequest);
      edge.jobId = proofJob.jobId;
      edge.queuePosition = proofJob.queuePosition;

      console.log(`[Orchestrator] Edge ${edge.id} (${edge.from}→${edge.to}): Job ${edge.jobId} queued at position ${edge.queuePosition}`);

      this.metrics.recordProofSubmission(edge.id, edge.jobId, edge.queuePosition);

    } catch (error) {
      edge.status = EdgeStatus.FAILED;
      edge.error = error.message;
      console.error(`[Orchestrator] Edge ${edge.id} failed to start:`, error.message);
      this.metrics.recordError('proof_submission', error, edge.id);
    }
  }

  /**
   * Build transaction data for an edge
   */
  async buildTransaction(fromWallet, toWallet, amount) {
    // Select UTXOs from sender
    const { selected, total } = fromWallet.selectUTXOs(amount);
    const changeAmount = total - BigInt(amount);

    console.log(`[Orchestrator] Building tx: ${selected.length} inputs, total=${total}, amount=${amount}, change=${changeAmount}`);

    // Generate blindings
    const recipientBlinding = fromWallet.generateBlinding();
    const changeBlinding = changeAmount > 0n ? fromWallet.generateBlinding() : null;

    // Build output notes
    const outputNotes = [
      {
        amount: Number(amount),
        ownerPubkey: '0x' + toWallet.ownerX,
        blinding: recipientBlinding
      }
    ];

    if (changeAmount > 0n) {
      outputNotes.push({
        amount: Number(changeAmount),
        ownerPubkey: '0x' + fromWallet.ownerX,
        blinding: changeBlinding
      });
    }

    // Pre-compute output commitments for TxSig
    const outputCommitments = outputNotes.map(n =>
      fromWallet.computeCommitment(n.amount, n.ownerPubkey, n.blinding)
    );

    // Sign inputs (NullifierSig and TxSig)
    const nullifierSignatures = [];
    const txSignatures = [];
    const inputProofs = []; // NEW: Collect input proofs

    for (const utxo of selected) {
      // Compute input commitment
      const inputComm = fromWallet.computeCommitment(
        utxo.amount,
        utxo.owner,
        utxo.blinding
      );

      // NullifierSig = Sign(InputCommitment)
      const nullifierSig = await fromWallet.signCommitment(inputComm);
      nullifierSignatures.push(nullifierSig);

      // Derive nullifier (for TxSig computation)
      const nullifier = fromWallet.computeNullifier(nullifierSig);

      // TxSig = Sign(Hash(Nullifier || OutputCommitments))
      const nullifierBytes = Buffer.from(nullifier.slice(2), 'hex');
      const outCommsBytes = Buffer.concat(
        outputCommitments.map(c => Buffer.from(c.slice(2), 'hex'))
      );
      const txMsg = '0x' + Buffer.concat([nullifierBytes, outCommsBytes]).toString('hex');
      const txSig = await fromWallet.signCommitment(txMsg);
      txSignatures.push(txSig);

      // Generate Merkle Proof (on-chain or local tree)
      const proof = this.onChainMode
        ? this.onChainMerkle.generateProof(utxo.index)
        : this.merkleTree.generateProof(utxo.index);
      inputProofs.push(proof);
    }

    // Build input notes
    const inputNotes = selected.map(utxo => ({
      amount: Number(utxo.amount),
      ownerPubkey: utxo.owner.startsWith('0x') ? utxo.owner : `0x${utxo.owner}`,
      blinding: utxo.blinding.startsWith('0x') ? utxo.blinding : `0x${utxo.blinding}`
    }));

    // Build encrypted outputs
    const encryptedOutputs = [];

    // Recipient encrypted note
    const recipientEncrypted = await fromWallet.encryptNote(
      amount,
      toWallet.address,
      recipientBlinding,
      toWallet.publicKey
    );
    encryptedOutputs.push(recipientEncrypted);

    // Change encrypted note (if any)
    if (changeAmount > 0n) {
      const changeEncrypted = await fromWallet.encryptNote(
        changeAmount,
        fromWallet.address,
        changeBlinding,
        fromWallet.publicKey
      );
      encryptedOutputs.push(changeEncrypted);
    }

    const inputIndices = selected.map(u => u.index);
    console.log(`[Orchestrator] Building proof request with inputIndices:`, inputIndices);
    console.log(`[Orchestrator] Selected UTXOs:`, selected.map(u => ({ index: u.index, amount: u.amount.toString() })));
    console.log(`[Orchestrator] oldRoot:`, this.currentRoot);

    return {
      proofRequest: {
        inputNotes,
        outputNotes,
        nullifierSignatures,
        txSignatures,
        inputIndices,
        inputProofs, // NEW field
        oldRoot: this.currentRoot
      },
      encryptedOutputs,
      outputCommitments,
      selectedUTXOs: selected,
      recipientBlinding,
      changeBlinding,
      changeAmount
    };
  }

  /**
   * Poll edges for proof completion
   */
  async pollEdges(edges) {
    for (const edge of edges) {
      if (edge.status === EdgeStatus.PROVING && edge.jobId) {
        try {
          const status = await this.apiClient.getProofStatus(edge.jobId);

          if (status.status === 'success') {
            edge.proofResult = status;
            edge.proofCompleteTime = Date.now();
            edge.status = EdgeStatus.SUBMITTED;

            const proofDuration = edge.proofCompleteTime - edge.startTime;
            console.log(`[Orchestrator] Edge ${edge.id}: Proof complete in ${(proofDuration / 1000).toFixed(1)}s`);

            // Debug: log proof result fields
            console.log(`[Orchestrator] Edge ${edge.id}: Proof result keys:`, Object.keys(status));
            console.log(`[Orchestrator] Edge ${edge.id}: publicValuesRaw present:`, !!status.publicValuesRaw);
            if (status.publicValuesRaw) {
              console.log(`[Orchestrator] Edge ${edge.id}: publicValuesRaw length:`, status.publicValuesRaw.length);
            }

            this.metrics.recordProofComplete(edge.id, proofDuration);

            // Submit to relayer
            await this.submitToRelayer(edge);

          } else if (status.status === 'error') {
            edge.status = EdgeStatus.FAILED;
            edge.error = status.error;
            edge.endTime = Date.now();
            console.error(`[Orchestrator] Edge ${edge.id}: Proof failed - ${status.error}`);
            this.metrics.recordError('proof_generation', { message: status.error }, edge.id);
          }
          // else: still proving, continue polling

        } catch (error) {
          console.error(`[Orchestrator] Edge ${edge.id}: Poll error - ${error.message}`);
          this.metrics.recordError('proof_poll', error, edge.id);
        }
      }
    }
  }

  /**
   * Submit proven transaction to relayer
   */
  async submitToRelayer(edge) {
    try {
      const txData = edge.txData;
      const proofResult = edge.proofResult;

      // Build encrypted outputs with proven commitments
      const encryptedOutputs = txData.encryptedOutputs.map((eo, i) => ({
        commitment: proofResult.publicOutputs.outputCommitments[i],
        keyType: 0,
        ephemeralPubkey: eo.ephemeralPubkey,
        nonce: eo.nonce,
        ciphertext: eo.ciphertext
      }));

      const result = await this.apiClient.submitTransaction({
        encryptedOutputs,
        proof: proofResult.proof,
        publicValues: proofResult.publicValuesRaw // prover returns publicValuesRaw
      });

      edge.txHash = result.txHash;
      edge.status = EdgeStatus.CONFIRMED;
      edge.endTime = Date.now();

      const totalDuration = edge.endTime - edge.startTime;
      console.log(`[Orchestrator] Edge ${edge.id}: Confirmed in ${(totalDuration / 1000).toFixed(1)}s - tx ${edge.txHash.slice(0, 18)}...`);

      // Update UTXO state
      this.updateUTXOState(edge, proofResult);

      this.metrics.recordTxConfirmed(edge.id, totalDuration, edge.txHash);

      // Verify local balance consistency after transaction
      if (this.verifyBalances) {
        this.verifyLocalBalanceConsistency(edge);
      }

    } catch (error) {
      edge.status = EdgeStatus.FAILED;
      edge.error = error.message;
      edge.endTime = Date.now();
      console.error(`[Orchestrator] Edge ${edge.id}: Relayer failed - ${error.message}`);
      this.metrics.recordError('relayer_submission', error, edge.id);
    }
  }

  /**
   * Update UTXO state after confirmed transaction
   */
  updateUTXOState(edge, proofResult) {
    const fromWallet = this.topology.getWallet(edge.from);
    const toWallet = this.topology.getWallet(edge.to);
    const txData = edge.txData;

    // Mark inputs as spent
    fromWallet.spendUTXOs(txData.selectedUTXOs);

    const outputCommitments = proofResult.publicOutputs.outputCommitments;

    // Update Merkle Tree (local or on-chain)
    for (const comm of outputCommitments) {
      if (this.onChainMode) {
        // In on-chain mode, insert into the OnChainMerkle tracker
        this.onChainMerkle.insert(comm);
      } else {
        this.merkleTree.insert(comm);
      }
    }

    // Add recipient UTXO
    toWallet.addUTXO({
      commitment: outputCommitments[0],
      amount: BigInt(edge.amount),
      owner: '0x' + toWallet.ownerX,
      blinding: txData.recipientBlinding,
      index: this.nextIndex++
    });

    // Add change UTXO (if exists)
    if (outputCommitments.length > 1 && txData.changeAmount > 0n) {
      fromWallet.addUTXO({
        commitment: outputCommitments[1],
        amount: txData.changeAmount,
        owner: '0x' + fromWallet.ownerX,
        blinding: txData.changeBlinding,
        index: this.nextIndex++
      });
    }

    // Update merkle root from proof result
    this.currentRoot = proofResult.publicOutputs.newRoot;

    // In on-chain mode, also verify root consistency
    if (this.onChainMode) {
      const localRoot = this.onChainMerkle.root();
      if (localRoot.toLowerCase() !== this.currentRoot.toLowerCase()) {
        console.warn(
          `[Orchestrator] Warning: Local root ${localRoot.slice(0, 18)}... differs from proof newRoot ${this.currentRoot.slice(0, 18)}...`
        );
      }
    }
  }

  /**
   * Start queue monitoring
   */
  startQueueMonitoring() {
    this.queueMonitorInterval = setInterval(async () => {
      try {
        const status = await this.apiClient.getQueueStatus();
        this.metrics.recordQueueSnapshot(status);
      } catch (error) {
        // Ignore queue status errors
      }
    }, this.pollInterval);
  }

  /**
   * Stop queue monitoring
   */
  stopQueueMonitoring() {
    if (this.queueMonitorInterval) {
      clearInterval(this.queueMonitorInterval);
      this.queueMonitorInterval = null;
    }
  }

  /**
   * Get the metrics report
   */
  getReport() {
    return this.metrics.generateReport();
  }

  /**
   * Verify local balance consistency after a transaction
   * Ensures UTXO tracking is correct (what UI would display)
   */
  verifyLocalBalanceConsistency(edge) {
    const fromWallet = this.topology.getWallet(edge.from);
    const toWallet = this.topology.getWallet(edge.to);
    const txData = edge.txData;

    const verification = {
      edgeId: edge.id,
      timestamp: Date.now(),
      checks: []
    };

    // Check sender balance = sum of remaining UTXOs
    const senderBalance = fromWallet.getBalance();
    const senderUtxoSum = fromWallet.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    const senderConsistent = senderBalance === senderUtxoSum;

    verification.checks.push({
      wallet: fromWallet.walletId,
      balance: senderBalance.toString(),
      utxoSum: senderUtxoSum.toString(),
      utxoCount: fromWallet.utxos.length,
      consistent: senderConsistent
    });

    if (!senderConsistent) {
      console.warn(`[Orchestrator] ⚠ ${fromWallet.walletId} balance inconsistent: balance=${senderBalance}, utxoSum=${senderUtxoSum}`);
      this.metrics.recordError('balance_inconsistent', {
        wallet: fromWallet.walletId,
        balance: senderBalance.toString(),
        utxoSum: senderUtxoSum.toString()
      }, edge.id);
    }

    // Check receiver received the correct amount
    const receiverBalance = toWallet.getBalance();
    const receiverUtxoSum = toWallet.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    const receiverConsistent = receiverBalance === receiverUtxoSum;

    // Verify the last UTXO added is the expected amount
    const lastUtxo = toWallet.utxos[toWallet.utxos.length - 1];
    const receivedCorrectAmount = lastUtxo && BigInt(lastUtxo.amount) === BigInt(edge.amount);

    verification.checks.push({
      wallet: toWallet.walletId,
      balance: receiverBalance.toString(),
      utxoSum: receiverUtxoSum.toString(),
      utxoCount: toWallet.utxos.length,
      consistent: receiverConsistent,
      receivedAmount: lastUtxo ? lastUtxo.amount.toString() : '0',
      expectedAmount: edge.amount.toString(),
      receivedCorrectAmount
    });

    if (!receiverConsistent) {
      console.warn(`[Orchestrator] ⚠ ${toWallet.walletId} balance inconsistent: balance=${receiverBalance}, utxoSum=${receiverUtxoSum}`);
      this.metrics.recordError('balance_inconsistent', {
        wallet: toWallet.walletId,
        balance: receiverBalance.toString(),
        utxoSum: receiverUtxoSum.toString()
      }, edge.id);
    }

    if (!receivedCorrectAmount) {
      console.warn(`[Orchestrator] ⚠ ${toWallet.walletId} received wrong amount: expected=${edge.amount}, got=${lastUtxo?.amount}`);
      this.metrics.recordError('wrong_amount_received', {
        wallet: toWallet.walletId,
        expected: edge.amount.toString(),
        received: lastUtxo?.amount?.toString() || '0'
      }, edge.id);
    }

    // Log successful verification
    console.log(`[Orchestrator] Balance check: ${fromWallet.walletId} $${Number(senderBalance) / 1e6} (${fromWallet.utxos.length} UTXOs), ${toWallet.walletId} $${Number(receiverBalance) / 1e6} (${toWallet.utxos.length} UTXOs)`);

    this.balanceVerifications.push(verification);
    return verification;
  }

  /**
   * Verify all wallet balances at end of test
   * Returns comprehensive local balance verification
   */
  verifyFinalBalances() {
    console.log('\n[Orchestrator] === Final Balance Verification ===');

    const wallets = Array.from(this.topology.wallets.values());
    const results = [];
    let allMatch = true;

    for (const wallet of wallets) {
      const balance = wallet.getBalance();
      const utxoSum = wallet.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
      const consistent = balance === utxoSum;

      if (!consistent) {
        allMatch = false;
        console.log(`  ❌ ${wallet.walletId}: balance=${balance}, utxoSum=${utxoSum} - MISMATCH`);
      } else {
        console.log(`  ✓ ${wallet.walletId}: $${Number(balance) / 1e6} (${wallet.utxos.length} UTXOs)`);
      }

      results.push({
        walletId: wallet.walletId,
        balance,
        utxoSum,
        utxoCount: wallet.utxos.length,
        consistent
      });
    }

    console.log(`\n  Overall: ${allMatch ? '✓ All balances consistent' : '❌ Some balances inconsistent'}`);

    return { allMatch, results };
  }

  /**
   * Get balance verification summary
   */
  getBalanceVerificationSummary() {
    const totalChecks = this.balanceVerifications.reduce(
      (sum, v) => sum + v.checks.length, 0
    );
    const inconsistent = this.balanceVerifications.reduce(
      (sum, v) => sum + v.checks.filter(c => c.consistent === false).length, 0
    );
    const wrongAmounts = this.balanceVerifications.reduce(
      (sum, v) => sum + v.checks.filter(c => c.receivedCorrectAmount === false).length, 0
    );

    return {
      totalVerifications: this.balanceVerifications.length,
      totalWalletChecks: totalChecks,
      inconsistent,
      wrongAmounts,
      allValid: inconsistent === 0 && wrongAmounts === 0
    };
  }
}
