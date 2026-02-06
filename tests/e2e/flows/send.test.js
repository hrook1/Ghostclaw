/**
 * Send Flow Tests
 * Tests the complete private-to-private send flow with proof generation
 */

import { SimulatedWallet, MerkleTree } from '../lib/wallet-simulator.js';
import { CONFIG, logStep, fetchWithRetry, waitFor } from '../setup.js';

describe('Send Flow', () => {
  describe('Proof Generation', () => {
    test('should reject proof request with missing fields', async () => {
      logStep(1, 'Testing proof request validation');

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [],
          // Missing other required fields
        })
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toContain('Missing required fields');
      logStep(1, 'Invalid request correctly rejected');
    });


    test('should accept valid proof request and return job ID', async () => {
      logStep(2, 'Submitting valid proof request');

      const wallet = new SimulatedWallet('test-wallet', 'test-seed');
      const tree = new MerkleTree();

      const note = {
        amount: '1000000',
        ownerPubkey: wallet.address.slice(2), // 64 chars hex
        blinding: '0x' + '02'.repeat(32)
      };

      // Compute commitment and update tree
      const commitment = wallet.computeCommitment(note.amount, wallet.ownerX, note.blinding);
      tree.insert(commitment);
      const root = tree.root();
      const proof = tree.generateProof(0);

      // Create minimal valid proof request
      const proofRequest = {
        inputNotes: [{
          amount: note.amount,
          ownerPubkey: '0x' + note.ownerPubkey,
          blinding: note.blinding
        }],
        outputNotes: [{
          amount: '1000000',
          ownerPubkey: '0x' + '03'.repeat(32),
          blinding: '0x' + '04'.repeat(32)
        }],
        nullifierSignatures: ['0x' + '00'.repeat(65)],
        txSignatures: ['0x' + '00'.repeat(65)],
        inputIndices: [0],
        inputProofs: [proof], // Included proof
        oldRoot: root
      };

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proofRequest)
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.jobId).toBeDefined();
      expect(result.proverMode).toBeDefined();
      logStep(2, `Job created: ${result.jobId}`);

      // Note: We don't wait for completion as this test just validates the API accepts the request
      // The proof will likely fail due to invalid signatures, but that's expected
    });

    test('should track job status', async () => {
      logStep(3, 'Testing job status tracking');

      // Submit a job
      // Use dummy proof for this test as we only check status
      const proofRequest = {
        inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
        outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
        nullifierSignatures: ['0x' + '00'.repeat(65)],
        txSignatures: ['0x' + '00'.repeat(65)],
        inputIndices: [0],
        inputProofs: [new Array(32).fill('0x' + '00'.repeat(32))], // Dummy proof
        oldRoot: '0x' + '00'.repeat(32)
      };

      const submitResponse = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proofRequest)
      });

      const { jobId } = await submitResponse.json();

      // Check job status
      const statusResponse = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
      expect(statusResponse.status).toBe(200);

      const status = await statusResponse.json();
      expect(status.status).toBeDefined();
      expect(status.stage).toBeDefined();
      expect(status.progress).toBeDefined();

      logStep(3, `Job ${jobId} status: ${status.status} (${status.progress}%)`);
    });

    test('should return 404 for unknown job ID', async () => {
      logStep(4, 'Testing unknown job ID handling');

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/proof-status/nonexistent123`);
      expect(response.status).toBe(404);
      logStep(4, 'Unknown job correctly returns 404');
    });
  });

  describe('Transaction Submission', () => {
    test('should reject submit-tx without proof', async () => {
      logStep(5, 'Testing submit-tx validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [{
            commitment: '0x' + '00'.repeat(32),
            keyType: 0,
            ephemeralPubkey: '0x' + '00'.repeat(33),
            nonce: '0x' + '00'.repeat(12),
            ciphertext: '0x' + '00'.repeat(64)
          }],
          proof: '0x', // Empty proof
          publicValues: '0x' + '00'.repeat(64)
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      // Error message should indicate the problem (proof validation or contract revert)
      expect(error.error).toBeDefined();
      expect(error.error.length).toBeGreaterThan(10);
      logStep(5, `Submit correctly rejected: ${error.error.slice(0, 50)}...`);
    });

    test('should reject submit-tx without publicValues', async () => {
      logStep(6, 'Testing submit-tx publicValues validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [],
          proof: '0x' + '00'.repeat(100),
          // Missing publicValues
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('publicValues');
      logStep(6, 'Submit correctly rejected without publicValues');
    });
  });
});
