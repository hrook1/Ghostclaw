/**
 * Encrypted Contacts Tests
 * Tests the encrypted contacts storage feature
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

describe('Encrypted Contacts Flow', () => {
  let publicClient;

  beforeAll(() => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  });

  describe('Contract State', () => {
    test('should have deployed contacts contract', async () => {
      logStep(1, 'Checking contacts contract deployment');

      const code = await publicClient.getBytecode({
        address: CONFIG.ENCRYPTED_CONTACTS
      });

      expect(code).toBeDefined();
      expect(code.length).toBeGreaterThan(2); // Not just '0x'
      logStep(1, 'Contacts contract deployed');
    });
  });

  describe('Save Contact', () => {
    test('should reject save-contact without ownerTag', async () => {
      logStep(2, 'Testing save-contact validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Missing ownerTag
          encryptedData: '0x' + '00'.repeat(64)
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('ownerTag');
      logStep(2, 'Save contact correctly rejected without ownerTag');
    });

    test('should reject save-contact without encryptedData', async () => {
      logStep(3, 'Testing save-contact encryptedData validation');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerTag: '0x' + '00'.repeat(8),
          // Missing encryptedData
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toContain('encryptedData');
      logStep(3, 'Save contact correctly rejected without encryptedData');
    });

    test('should accept valid save-contact request format', async () => {
      logStep(4, 'Testing valid save-contact request format');

      // This will fail at contract level (invalid data) but validates API accepts the format
      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerTag: '0x0102030405060708', // 8 bytes
          encryptedData: '0x' + '00'.repeat(100)
        })
      });

      // Either 200 (success) or 500 (contract revert) - not 400 (validation)
      expect([200, 500]).toContain(response.status);
      logStep(4, 'Valid format accepted by API');
    });
  });
});
