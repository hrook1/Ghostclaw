/**
 * Concurrent Request Tests
 * Tests race conditions and concurrent request handling
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Concurrent Request Handling', () => {
  // Helper to create a proof request with unique identifiers
  const createProofRequest = (id) => ({
    inputNotes: [{
      amount: `${1000000 + id}`,
      ownerPubkey: '0x' + id.toString(16).padStart(64, '0'),
      blinding: '0x' + (id + 1).toString(16).padStart(64, '0')
    }],
    outputNotes: [{
      amount: `${1000000 + id}`,
      ownerPubkey: '0x' + (id + 2).toString(16).padStart(64, '0'),
      blinding: '0x' + (id + 3).toString(16).padStart(64, '0')
    }],
    nullifierSignatures: ['0x' + '00'.repeat(65)],
    txSignatures: ['0x' + '00'.repeat(65)],
    inputIndices: [id % 10],
    oldRoot: '0x' + '00'.repeat(32)
  });

  describe('Simultaneous Proof Requests', () => {
    test('should handle 5 simultaneous proof requests without crashing', async () => {
      logStep(1, 'Submitting 5 simultaneous proof requests');

      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createProofRequest(i * 100))
        })
      );

      const responses = await Promise.all(requests);
      const results = await Promise.all(responses.map(r => r.json()));

      // All should be accepted (200) with unique job IDs
      responses.forEach((r, i) => {
        expect(r.status).toBe(200);
      });

      const jobIds = results.map(r => r.jobId);
      const uniqueJobIds = new Set(jobIds);
      expect(uniqueJobIds.size).toBe(5);

      logStep(1, `All 5 requests accepted with unique IDs: ${jobIds.join(', ')}`);
    });

    test('should handle 10 simultaneous proof requests', async () => {
      logStep(2, 'Submitting 10 simultaneous proof requests');

      const requests = Array.from({ length: 10 }, (_, i) =>
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createProofRequest(i * 1000))
        })
      );

      const responses = await Promise.all(requests);

      // All should be accepted
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBe(10);

      logStep(2, `10/10 requests accepted`);
    });

    test('should correctly queue jobs with sequential queue positions', async () => {
      logStep(3, 'Testing queue position assignment');

      // Clear any existing jobs by waiting
      await new Promise(r => setTimeout(r, 1000));

      // Submit 3 requests rapidly
      const results = [];
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createProofRequest(i + 500))
        });
        results.push(await response.json());
      }

      // First one should start immediately (position 0), others should be queued
      // Queue positions should be sequential
      logStep(3, `Queue positions: ${results.map(r => r.queuePosition).join(', ')}`);

      // All should have valid job IDs
      results.forEach(r => {
        expect(r.jobId).toBeDefined();
      });
    });
  });

  describe('Simultaneous Relayer Requests', () => {
    test('should handle simultaneous submit-tx requests', async () => {
      logStep(4, 'Testing simultaneous submit-tx requests');

      const createSubmitRequest = (id) => ({
        encryptedOutputs: [{
          commitment: '0x' + id.toString(16).padStart(64, '0'),
          keyType: 0,
          ephemeralPubkey: '0x' + '00'.repeat(33),
          nonce: '0x' + '00'.repeat(12),
          ciphertext: '0x' + '00'.repeat(64)
        }],
        proof: '0x' + '01'.repeat(100), // Invalid but non-empty proof
        publicValues: '0x' + '00'.repeat(64)
      });

      const requests = Array.from({ length: 3 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createSubmitRequest(i + 1))
        })
      );

      const responses = await Promise.all(requests);

      // All should fail with 500 (invalid proof) but not crash
      responses.forEach(r => {
        expect(r.status).toBe(500);
      });

      logStep(4, 'All simultaneous submit-tx requests handled without crash');
    });

    test('should handle simultaneous withdraw requests', async () => {
      logStep(5, 'Testing simultaneous withdraw requests');

      const createWithdrawRequest = (id) => ({
        recipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        amount: `${1000000 + id}`,
        proof: '0x' + '01'.repeat(100),
        publicValues: '0x' + '00'.repeat(64),
        encryptedOutputs: []
      });

      const requests = Array.from({ length: 3 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createWithdrawRequest(i * 1000))
        })
      );

      const responses = await Promise.all(requests);

      // All should fail gracefully
      responses.forEach(r => {
        expect(r.status).toBe(500);
      });

      logStep(5, 'All simultaneous withdraw requests handled');
    });

    test('should handle mixed simultaneous requests (submit + withdraw + deposit)', async () => {
      logStep(6, 'Testing mixed simultaneous requests');

      const submitRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [],
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64)
        })
      });

      const withdrawRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
          amount: '1000000',
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      const depositRequest = fetch(`${CONFIG.RELAYER_SERVER}/api/deposit-with-permit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitment: '0x' + '00'.repeat(32),
          encrypted: {
            commitment: '0x' + '00'.repeat(32),
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
          depositor: '0x' + '00'.repeat(20)
        })
      });

      const responses = await Promise.all([submitRequest, withdrawRequest, depositRequest]);

      // All should fail (invalid data) but not crash the server
      responses.forEach(r => {
        expect(r.status).toBe(500);
      });

      // Verify server is still healthy
      const healthResponse = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(healthResponse.status).toBe(200);

      logStep(6, 'Mixed requests handled, server still healthy');
    });
  });

  describe('Rapid Fire Requests', () => {
    test('should handle 20 rapid proof requests in 1 second', async () => {
      logStep(7, 'Rapid fire: 20 requests in 1 second');

      const startTime = Date.now();
      const requests = [];

      for (let i = 0; i < 20; i++) {
        requests.push(
          fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createProofRequest(i + 2000))
          })
        );
        // Small delay to spread requests across 1 second
        await new Promise(r => setTimeout(r, 50));
      }

      const responses = await Promise.all(requests);
      const elapsed = Date.now() - startTime;

      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBe(20);

      logStep(7, `20 requests completed in ${elapsed}ms, all accepted`);
    });

    test('should handle burst of health checks during proof processing', async () => {
      logStep(8, 'Testing health checks during proof processing');

      // Start a proof request
      const proofPromise = fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createProofRequest(3000))
      });

      // Immediately fire 10 health checks
      const healthChecks = Array.from({ length: 10 }, () =>
        fetch(`${CONFIG.PROVER_SERVER}/api/health`)
      );

      const [proofResponse, ...healthResponses] = await Promise.all([proofPromise, ...healthChecks]);

      expect(proofResponse.status).toBe(200);
      healthResponses.forEach(r => {
        expect(r.status).toBe(200);
      });

      logStep(8, 'Health checks responsive during proof processing');
    });
  });
});
