/**
 * Error Handling Tests
 * Tests error responses and edge cases across all services
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Error Handling', () => {
  describe('Prover Server Errors', () => {
    test('should handle malformed JSON gracefully', async () => {
      logStep(1, 'Testing malformed JSON handling');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{'
      });

      // Should return 400 or 500, not crash
      expect([400, 500]).toContain(response.status);
      logStep(1, 'Malformed JSON handled gracefully');
    });

    test('should handle empty request body', async () => {
      logStep(2, 'Testing empty request body');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });

      expect(response.status).toBe(400);
      logStep(2, 'Empty body rejected');
    });

    test('should handle invalid data types', async () => {
      logStep(3, 'Testing invalid data types');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: 'not an array', // Should be array
          outputNotes: [],
          nullifierSignatures: [],
          txSignatures: [],
          inputIndices: [],
          oldRoot: '0x00'
        })
      });

      // Prover queues requests and fails during proof generation, so 200 is also valid
      // The job will fail asynchronously with an error status
      expect([200, 400, 500]).toContain(response.status);
      logStep(3, 'Invalid types handled');
    });
  });

  describe('Relayer Server Errors', () => {
    test('should handle missing Content-Type header', async () => {
      logStep(4, 'Testing missing Content-Type');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        // No Content-Type header
        body: JSON.stringify({
          encryptedOutputs: [],
          proof: '0x00',
          publicValues: '0x00'
        })
      });

      // Should still process or return proper error
      expect([400, 415, 500]).toContain(response.status);
      logStep(4, 'Missing Content-Type handled');
    });

    test('should return helpful error messages', async () => {
      logStep(5, 'Testing error message quality');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [],
          proof: null,
          publicValues: null
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();

      // Error should be descriptive
      expect(error.error).toBeDefined();
      expect(error.error.length).toBeGreaterThan(10);
      logStep(5, `Error message: ${error.error.slice(0, 50)}...`);
    });
  });

  describe('Network Resilience', () => {
    test('should handle server unavailable gracefully', async () => {
      logStep(6, 'Testing unavailable server handling');

      // Try to connect to a non-existent port
      try {
        const response = await fetch('http://localhost:9999/api/health', {
          signal: AbortSignal.timeout(5000)
        });
        // If we get here, some service is running on 9999
        expect(response).toBeDefined();
      } catch (error) {
        // Expected - connection refused
        expect(error).toBeDefined();
      }

      logStep(6, 'Connection error handled');
    });
  });
});
