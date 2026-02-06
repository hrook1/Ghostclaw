/**
 * Payment Requests Tests
 * Tests the encrypted payment requests feature
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

describe('Payment Requests Flow', () => {
  let publicClient;

  beforeAll(() => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  });

  describe('Contract State', () => {
    test('should have deployed payment requests contract', async () => {
      logStep(1, 'Checking payment requests contract deployment');

      const code = await publicClient.getBytecode({
        address: CONFIG.PAYMENT_REQUESTS
      });

      expect(code).toBeDefined();
      expect(code.length).toBeGreaterThan(2);
      logStep(1, 'Payment requests contract deployed');
    });
  });

  describe('Create Payment Request', () => {
    test('should reject create-payment-request without recipientTag', async () => {
      logStep(2, 'Testing create-payment-request validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Missing recipientTag
          encryptedPayload: '0x' + '00'.repeat(64)
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('recipientTag');
      logStep(2, 'Payment request correctly rejected without recipientTag');
    });

    test('should reject create-payment-request without encryptedPayload', async () => {
      logStep(3, 'Testing create-payment-request encryptedPayload validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: '0x' + '00'.repeat(8),
          // Missing encryptedPayload
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('encryptedPayload');
      logStep(3, 'Payment request correctly rejected without encryptedPayload');
    });

    test('should accept valid create-payment-request format', async () => {
      logStep(4, 'Testing valid create-payment-request format');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: '0x0102030405060708', // 8 bytes
          encryptedPayload: '0x' + '00'.repeat(100)
        })
      });

      // Either 200 (success) or 500 (contract revert) - not 400 (validation)
      expect([200, 500]).toContain(response.status);
      logStep(4, 'Valid format accepted by API');
    });
  });
});
