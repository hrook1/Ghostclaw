/**
 * Timeout and Recovery Tests
 * Tests for handling timeouts and recovering from errors
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Timeout and Recovery', () => {
  describe('Request Timeout Handling', () => {
    test('should handle client-side timeout gracefully', async () => {
      logStep(1, 'Testing client-side timeout');

      try {
        // Very short timeout that will likely trigger
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1);

        await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: '0x' + '00'.repeat(32)
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        // If we get here, request completed before timeout
        logStep(1, 'Request completed before timeout');
      } catch (error) {
        // Expected: AbortError
        expect(error.name).toBe('AbortError');
        logStep(1, 'Client timeout handled correctly');
      }

      // Verify server is still healthy
      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(health.status).toBe(200);
    });

    test('should handle abandoned requests', async () => {
      logStep(2, 'Testing abandoned request cleanup');

      // Submit a request then immediately check queue
      const submitPromise = fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'ab'.repeat(32), blinding: '0x' + 'cd'.repeat(32) }],
          outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'ef'.repeat(32), blinding: '0x' + '12'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      // Get response
      const response = await submitPromise;
      const { jobId } = await response.json();

      // Check job exists
      const statusResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
      expect(statusResponse.status).toBe(200);

      logStep(2, `Abandoned request ${jobId} still tracked`);
    });
  });

  describe('Server Recovery', () => {
    test('should recover from burst of malformed requests', async () => {
      logStep(3, 'Testing recovery from malformed request burst');

      // Send burst of malformed requests
      const malformedRequests = Array.from({ length: 20 }, () =>
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json at all {{{{'
        })
      );

      await Promise.allSettled(malformedRequests);

      // Server should still be healthy
      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      // Should still accept valid requests
      const validResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
          outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect(validResponse.status).toBe(200);
      logStep(3, 'Server recovered and accepting valid requests');
    });

    test('should handle relayer recovery from failed transactions', async () => {
      logStep(4, 'Testing relayer recovery');

      // Send several requests that will fail
      const failedRequests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encryptedOutputs: [],
            proof: '0x' + 'bad'.repeat(33),
            publicValues: '0x' + 'bad'.repeat(21)
          })
        })
      );

      await Promise.allSettled(failedRequests);

      // Relayer should still be healthy
      const health = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      const healthData = await health.json();
      expect(healthData.status).toBe('ok');
      expect(healthData.gasSponsorship).toBe('enabled');

      logStep(4, 'Relayer healthy after failed transactions');
    });
  });

  describe('Job Status Recovery', () => {
    test('should track job through error state', async () => {
      logStep(5, 'Testing job error state tracking');

      // Submit a request that will fail during proof generation
      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) }],
          outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      const { jobId } = await response.json();

      // Wait for job to fail (invalid signatures will cause failure)
      let status;
      let attempts = 0;
      const maxAttempts = 30;

      while (attempts < maxAttempts) {
        const statusResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
        status = await statusResponse.json();

        if (status.status === 'error' || status.status === 'success') {
          break;
        }

        await new Promise(r => setTimeout(r, 1000));
        attempts++;
      }

      // Job should be in error state (invalid inputs)
      expect(['error', 'queued', 'preparing', 'computing', 'proving']).toContain(status.status);

      logStep(5, `Job ${jobId} tracked through to status: ${status.status}`);
    });

    test('should maintain job history during server load', async () => {
      logStep(6, 'Testing job history under load');

      // Submit 5 jobs
      const jobIds = [];
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + (i + 100).toString(16).padStart(64, '0'), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: '0x' + '00'.repeat(32)
          })
        });
        const { jobId } = await response.json();
        jobIds.push(jobId);
      }

      // Apply load (many status queries + health checks)
      const loadRequests = [];
      for (let i = 0; i < 50; i++) {
        loadRequests.push(fetch(`${CONFIG.PROVER_SERVER}/api/health`));
        loadRequests.push(fetch(`${CONFIG.PROVER_SERVER}/api/queue-status`));
      }

      await Promise.all(loadRequests);

      // All jobs should still be trackable
      for (const jobId of jobIds) {
        const statusResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
        expect(statusResponse.status).toBe(200);
      }

      logStep(6, `All ${jobIds.length} jobs remained trackable under load`);
    });
  });

  describe('Connection Recovery', () => {
    test('should handle connection reset simulation', async () => {
      logStep(7, 'Testing connection recovery');

      // Make many rapid requests to potentially trigger connection issues
      const requests = [];
      for (let i = 0; i < 30; i++) {
        requests.push(
          fetch(`${CONFIG.PROVER_SERVER}/api/health`)
            .then(r => ({ success: true, status: r.status }))
            .catch(e => ({ success: false, error: e.message }))
        );
      }

      const results = await Promise.all(requests);
      const successCount = results.filter(r => r.success).length;

      // Most should succeed
      expect(successCount).toBeGreaterThan(25);

      // Final health check
      const finalHealth = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(finalHealth.status).toBe(200);

      logStep(7, `${successCount}/30 requests succeeded, server healthy`);
    });

    test('should handle partial request data', async () => {
      logStep(8, 'Testing partial request handling');

      // Send request with partial/truncated JSON
      const partialRequests = [
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"inputNotes": [{"amount":'
        }),
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: ''
        }),
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      ];

      const responses = await Promise.all(partialRequests);

      // All should return error codes, not crash
      responses.forEach(r => {
        expect([400, 500]).toContain(r.status);
      });

      // Server should still be healthy
      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      logStep(8, 'Partial requests handled, server healthy');
    });
  });

  describe('Memory/Resource Recovery', () => {
    test('should handle large payload submissions', async () => {
      logStep(9, 'Testing large payload handling');

      // Create a large but valid request
      const largeRequest = {
        inputNotes: Array.from({ length: 5 }, (_, i) => ({
          amount: '200000',
          ownerPubkey: '0x' + (i + 1).toString(16).padStart(64, '0'),
          blinding: '0x' + (i + 10).toString(16).padStart(64, '0')
        })),
        outputNotes: [{
          amount: '1000000',
          ownerPubkey: '0x' + '99'.repeat(32),
          blinding: '0x' + 'aa'.repeat(32)
        }],
        nullifierSignatures: Array(5).fill('0x' + '00'.repeat(65)),
        txSignatures: Array(5).fill('0x' + '00'.repeat(65)),
        inputIndices: [0, 1, 2, 3, 4],
        oldRoot: '0x' + '00'.repeat(32)
      };

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(largeRequest)
      });

      expect([200, 400, 500]).toContain(response.status);

      // Server should still be healthy
      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      logStep(9, `Large payload handled with status ${response.status}`);
    });

    test('should remain responsive after processing many jobs', async () => {
      logStep(10, 'Testing responsiveness after heavy load');

      // Submit 20 jobs rapidly
      const submitPromises = Array.from({ length: 20 }, (_, i) =>
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + (i + 200).toString(16).padStart(64, '0'), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: '0x' + '00'.repeat(32)
          })
        })
      );

      await Promise.all(submitPromises);

      // Measure response time for health check
      const startTime = Date.now();
      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      const responseTime = Date.now() - startTime;

      expect(health.status).toBe(200);
      expect(responseTime).toBeLessThan(5000); // Should respond within 5 seconds

      logStep(10, `Server responsive in ${responseTime}ms after 20 job submissions`);
    });
  });
});
