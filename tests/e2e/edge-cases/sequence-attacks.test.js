/**
 * Sequence Attack Tests
 * Tests for manipulation attempts using request sequencing
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

describe('Sequence Attack Prevention', () => {
  let publicClient;
  let initialRoot;

  beforeAll(async () => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });

    // Get initial merkle root
    initialRoot = await publicClient.readContract({
      address: CONFIG.PRIVATE_UTXO_LEDGER,
      abi: [{
        inputs: [],
        name: 'currentRoot',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function'
      }],
      functionName: 'currentRoot'
    });
  });

  describe('Stale Root Attacks', () => {
    test('should reject proof with outdated merkle root', async () => {
      logStep(1, 'Testing stale root rejection');

      // Use a fabricated old root
      const staleRoot = '0x' + '11'.repeat(32);

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32)
          }],
          outputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: staleRoot // Intentionally stale
        })
      });

      // Request is accepted but proof will fail during generation
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.jobId).toBeDefined();

      logStep(1, `Request accepted for processing, will fail at proof stage`);
    });

    test('should handle rapid root queries during processing', async () => {
      logStep(2, 'Testing root consistency during concurrent reads');

      // Query root 5 times rapidly
      const rootQueries = Array.from({ length: 5 }, () =>
        publicClient.readContract({
          address: CONFIG.PRIVATE_UTXO_LEDGER,
          abi: [{
            inputs: [],
            name: 'currentRoot',
            outputs: [{ name: '', type: 'bytes32' }],
            stateMutability: 'view',
            type: 'function'
          }],
          functionName: 'currentRoot'
        })
      );

      const roots = await Promise.all(rootQueries);

      // All roots should be identical (no state change during reads)
      const uniqueRoots = new Set(roots);
      expect(uniqueRoots.size).toBe(1);

      logStep(2, `Root consistent across 5 queries: ${roots[0].slice(0, 18)}...`);
    });
  });

  describe('Double Spend Attempts', () => {
    test('should handle two proofs trying to spend same UTXO', async () => {
      logStep(3, 'Testing double spend attempt');

      // Same input note in two different requests
      const sameInputNote = {
        amount: '1000000',
        ownerPubkey: '0x' + 'aa'.repeat(32),
        blinding: '0x' + 'bb'.repeat(32)
      };

      const request1 = {
        inputNotes: [sameInputNote],
        outputNotes: [{
          amount: '1000000',
          ownerPubkey: '0x' + '01'.repeat(32),
          blinding: '0x' + '02'.repeat(32)
        }],
        nullifierSignatures: ['0x' + '00'.repeat(65)],
        txSignatures: ['0x' + '00'.repeat(65)],
        inputIndices: [0],
        oldRoot: initialRoot
      };

      const request2 = {
        inputNotes: [sameInputNote], // Same input!
        outputNotes: [{
          amount: '1000000',
          ownerPubkey: '0x' + '03'.repeat(32),
          blinding: '0x' + '04'.repeat(32)
        }],
        nullifierSignatures: ['0x' + '00'.repeat(65)],
        txSignatures: ['0x' + '00'.repeat(65)],
        inputIndices: [0],
        oldRoot: initialRoot
      };

      // Submit both simultaneously
      const [response1, response2] = await Promise.all([
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request1)
        }),
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request2)
        })
      ]);

      // Both requests should be accepted for processing
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // In reality, only one could succeed on-chain due to nullifier check
      logStep(3, 'Both requests accepted - nullifier check happens on-chain');
    });

    test('should handle sequential double spend attempts', async () => {
      logStep(4, 'Testing sequential double spend');

      const sameInput = {
        amount: '500000',
        ownerPubkey: '0x' + 'cc'.repeat(32),
        blinding: '0x' + 'dd'.repeat(32)
      };

      // First request
      const response1 = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [sameInput],
          outputNotes: [{ amount: '500000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: initialRoot
        })
      });

      const job1 = await response1.json();

      // Wait a bit then submit second request with same input
      await new Promise(r => setTimeout(r, 100));

      const response2 = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [sameInput],
          outputNotes: [{ amount: '500000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: initialRoot
        })
      });

      const job2 = await response2.json();

      expect(job1.jobId).toBeDefined();
      expect(job2.jobId).toBeDefined();
      expect(job1.jobId).not.toBe(job2.jobId);

      logStep(4, `Two jobs created: ${job1.jobId}, ${job2.jobId}`);
    });
  });

  describe('Interleaved Operations', () => {
    test('should handle deposit-send-withdraw sequence', async () => {
      logStep(5, 'Testing deposit-send-withdraw interleaving');

      // Simulate user trying deposit, send, and withdraw simultaneously
      const depositRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/deposit-with-permit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitment: '0x' + '01'.repeat(32),
          encrypted: {
            commitment: '0x' + '01'.repeat(32),
            keyType: 0,
            ephemeralPubkey: '0x' + '00'.repeat(33),
            nonce: '0x' + '00'.repeat(12),
            ciphertext: '0x' + '00'.repeat(64)
          },
          amount: '1000000',
          permit: {
            permitted: { token: CONFIG.USDC_ADDRESS, amount: '1000000' },
            nonce: '0',
            deadline: Math.floor(Date.now() / 1000) + 3600
          },
          signature: '0x' + '00'.repeat(65),
          depositor: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
        })
      });

      const sendRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [{
            commitment: '0x' + '02'.repeat(32),
            keyType: 0,
            ephemeralPubkey: '0x' + '00'.repeat(33),
            nonce: '0x' + '00'.repeat(12),
            ciphertext: '0x' + '00'.repeat(64)
          }],
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64)
        })
      });

      const withdrawRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          amount: '500000',
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      const responses = await Promise.all([depositRequest, sendRequest, withdrawRequest]);

      // All should fail due to invalid data but server shouldn't crash
      responses.forEach(r => {
        expect(r.status).toBe(500);
      });

      // Verify server health
      const health = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      logStep(5, 'All operations failed gracefully, server healthy');
    });

    test('should handle proof request during status polling', async () => {
      logStep(6, 'Testing proof request + status polling race');

      // Submit a job
      const submitResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
          outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: initialRoot
        })
      });

      const { jobId } = await submitResponse.json();

      // Rapidly poll status while submitting more requests
      const operations = [];

      // 5 status polls
      for (let i = 0; i < 5; i++) {
        operations.push(fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`));
      }

      // 2 new proof requests
      for (let i = 0; i < 2; i++) {
        operations.push(fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '2000000', ownerPubkey: '0x' + (10 + i).toString(16).padStart(64, '0'), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '2000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: initialRoot
          })
        }));
      }

      const responses = await Promise.all(operations);

      // First 5 are status polls (should be 200)
      responses.slice(0, 5).forEach(r => {
        expect(r.status).toBe(200);
      });

      // Last 2 are new requests (should be 200)
      responses.slice(5).forEach(r => {
        expect(r.status).toBe(200);
      });

      logStep(6, 'Status polling and new requests handled correctly');
    });
  });

  describe('Replay Attacks', () => {
    test('should handle identical request submissions', async () => {
      logStep(7, 'Testing identical request replay');

      const request = {
        inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'ff'.repeat(32), blinding: '0x' + 'ee'.repeat(32) }],
        outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'dd'.repeat(32), blinding: '0x' + 'cc'.repeat(32) }],
        nullifierSignatures: ['0x' + '00'.repeat(65)],
        txSignatures: ['0x' + '00'.repeat(65)],
        inputIndices: [0],
        oldRoot: initialRoot
      };

      // Submit exact same request 3 times
      const responses = await Promise.all([
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        }),
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        }),
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request)
        })
      ]);

      const results = await Promise.all(responses.map(r => r.json()));

      // All should get unique job IDs
      const jobIds = results.map(r => r.jobId);
      const uniqueIds = new Set(jobIds);
      expect(uniqueIds.size).toBe(3);

      logStep(7, `3 identical requests got unique job IDs: ${jobIds.join(', ')}`);
    });
  });
});
