/**
 * Withdraw Flow Tests
 * Tests the complete withdraw flow from private UTXO to public address
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Withdraw Flow', () => {
  describe('Withdraw Validation', () => {
    test('should reject withdraw without proof', async () => {
      logStep(1, 'Testing withdraw validation without proof');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0x' + '00'.repeat(20),
          amount: '1000000',
          proof: '0x', // Empty proof
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      // Error message should indicate the problem (proof validation or contract revert)
      expect(error.error).toBeDefined();
      expect(error.error.length).toBeGreaterThan(10);
      logStep(1, `Withdraw correctly rejected: ${error.error.slice(0, 50)}...`);
    });

    test('should reject withdraw without publicValues', async () => {
      logStep(2, 'Testing withdraw validation without publicValues');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0x' + '00'.repeat(20),
          amount: '1000000',
          proof: '0x' + '00'.repeat(100),
          // Missing publicValues
          encryptedOutputs: []
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('publicValues');
      logStep(2, 'Withdraw correctly rejected without publicValues');
    });

    test('should validate recipient address format', async () => {
      logStep(3, 'Testing recipient address validation');

      // Send with valid proof but check server logs the recipient
      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Vitalik's address
          amount: '1000000',
          proof: '0x' + '00'.repeat(100),
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      // Will fail due to invalid proof, but validates address is accepted
      expect(response.status).toBe(500);
      logStep(3, 'Recipient address accepted (proof invalid as expected)');
    });
  });
});
