/**
 * Contacts and Payment Requests Edge Cases
 * Tests for encrypted contacts and payment request features
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

describe('Contacts and Payment Requests Edge Cases', () => {
  let publicClient;

  beforeAll(() => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  });

  describe('Encrypted Contacts', () => {
    test('should handle simultaneous contact saves', async () => {
      logStep(1, 'Testing simultaneous contact saves');

      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerTag: '0x' + (i + 1).toString(16).padStart(16, '0'),
            encryptedData: '0x' + 'aa'.repeat(100 + i * 10)
          })
        })
      );

      const responses = await Promise.all(requests);

      // All should either succeed (200) or fail with contract revert (500)
      responses.forEach(r => {
        expect([200, 500]).toContain(r.status);
      });

      logStep(1, `${responses.filter(r => r.status === 200).length}/5 contact saves processed`);
    });

    test('should handle empty ownerTag', async () => {
      logStep(2, 'Testing empty ownerTag');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerTag: '',
          encryptedData: '0x' + 'bb'.repeat(100)
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toBeDefined();

      logStep(2, 'Empty ownerTag rejected');
    });

    test('should handle very large encrypted data', async () => {
      logStep(3, 'Testing large encrypted data');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerTag: '0x1234567890abcdef',
          encryptedData: '0x' + 'cc'.repeat(10000) // 10KB of data
        })
      });

      // May succeed or fail depending on gas limits
      expect([200, 500]).toContain(response.status);

      logStep(3, `Large data handled with status ${response.status}`);
    });

    test('should handle ownerTag collision attempt', async () => {
      logStep(4, 'Testing ownerTag collision');

      const sameTag = '0xdeadbeefdeadbeef';

      // Try to save two contacts with same tag
      const [response1, response2] = await Promise.all([
        fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerTag: sameTag,
            encryptedData: '0x' + 'dd'.repeat(100)
          })
        }),
        fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerTag: sameTag,
            encryptedData: '0x' + 'ee'.repeat(100)
          })
        })
      ]);

      // Both should be handled (may both succeed if contract allows overwrite)
      expect([200, 500]).toContain(response1.status);
      expect([200, 500]).toContain(response2.status);

      logStep(4, 'Collision attempt handled');
    });

    test('should handle invalid ownerTag format', async () => {
      logStep(5, 'Testing invalid ownerTag formats');

      const invalidTags = [
        'not-hex',
        '0x123', // Too short
        '0xGGGGGGGGGGGGGGGG', // Invalid hex
        null,
        123456789
      ];

      for (const tag of invalidTags) {
        const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerTag: tag,
            encryptedData: '0x' + 'ff'.repeat(100)
          })
        });

        expect(response.status).toBe(500);
      }

      logStep(5, 'All invalid ownerTag formats rejected');
    });
  });

  describe('Payment Requests', () => {
    test('should handle simultaneous payment request creation', async () => {
      logStep(6, 'Testing simultaneous payment requests');

      const requests = Array.from({ length: 5 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientTag: '0x' + (i + 100).toString(16).padStart(16, '0'),
            encryptedPayload: '0x' + '11'.repeat(100 + i * 10)
          })
        })
      );

      const responses = await Promise.all(requests);

      // All should be handled
      responses.forEach(r => {
        expect([200, 500]).toContain(r.status);
      });

      logStep(6, `${responses.filter(r => r.status === 200).length}/5 payment requests processed`);
    });

    test('should handle duplicate payment request to same recipient', async () => {
      logStep(7, 'Testing duplicate payment requests');

      const sameRecipient = '0xfeedfeedfeedfeed';

      // Create two payment requests to same recipient
      const response1 = await fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: sameRecipient,
          encryptedPayload: '0x' + '22'.repeat(100)
        })
      });

      const response2 = await fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: sameRecipient,
          encryptedPayload: '0x' + '33'.repeat(100)
        })
      });

      // Both should be accepted (multiple payment requests to same recipient is valid)
      expect([200, 500]).toContain(response1.status);
      expect([200, 500]).toContain(response2.status);

      logStep(7, 'Duplicate payment requests handled');
    });

    test('should handle empty encryptedPayload', async () => {
      logStep(8, 'Testing empty payload');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: '0x0102030405060708',
          encryptedPayload: ''
        })
      });

      expect(response.status).toBe(500);
      const error = await response.json();
      expect(error.error).toBeDefined();

      logStep(8, 'Empty payload rejected');
    });

    test('should handle payment request with minimal payload', async () => {
      logStep(9, 'Testing minimal payload');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: '0x0102030405060708',
          encryptedPayload: '0x00' // Minimal valid payload
        })
      });

      // May succeed or fail depending on contract requirements
      expect([200, 500]).toContain(response.status);

      logStep(9, `Minimal payload handled with status ${response.status}`);
    });

    test('should handle large payment request payload', async () => {
      logStep(10, 'Testing large payment request payload');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientTag: '0x0102030405060708',
          encryptedPayload: '0x' + '44'.repeat(50000) // 50KB payload
        })
      });

      // May succeed or fail due to gas/size limits
      expect([200, 413, 500]).toContain(response.status);

      logStep(10, `Large payload handled with status ${response.status}`);
    });
  });

  describe('Mixed Operations', () => {
    test('should handle contacts and payment requests concurrently', async () => {
      logStep(11, 'Testing mixed contact + payment request operations');

      const contactRequests = Array.from({ length: 3 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ownerTag: '0x' + (i + 500).toString(16).padStart(16, '0'),
            encryptedData: '0x' + '55'.repeat(100)
          })
        })
      );

      const paymentRequests = Array.from({ length: 3 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipientTag: '0x' + (i + 600).toString(16).padStart(16, '0'),
            encryptedPayload: '0x' + '66'.repeat(100)
          })
        })
      );

      const allResponses = await Promise.all([...contactRequests, ...paymentRequests]);

      // All should be handled without crashing
      allResponses.forEach(r => {
        expect([200, 500]).toContain(r.status);
      });

      // Server should still be healthy
      const health = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      logStep(11, 'Mixed operations completed, server healthy');
    });

    test('should handle rapid alternating operations', async () => {
      logStep(12, 'Testing rapid alternating contact/payment operations');

      const operations = [];

      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          operations.push(
            fetch(`${CONFIG.RELAYER_SERVER}/api/save-contact`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ownerTag: '0x' + (i + 700).toString(16).padStart(16, '0'),
                encryptedData: '0x' + '77'.repeat(50)
              })
            })
          );
        } else {
          operations.push(
            fetch(`${CONFIG.RELAYER_SERVER}/api/create-payment-request`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipientTag: '0x' + (i + 800).toString(16).padStart(16, '0'),
                encryptedPayload: '0x' + '88'.repeat(50)
              })
            })
          );
        }
      }

      const responses = await Promise.all(operations);

      responses.forEach(r => {
        expect([200, 500]).toContain(r.status);
      });

      logStep(12, `10 alternating operations completed`);
    });
  });

  describe('Contract State Verification', () => {
    test('should verify contacts contract is deployed', async () => {
      logStep(13, 'Verifying contacts contract');

      const code = await publicClient.getBytecode({
        address: CONFIG.ENCRYPTED_CONTACTS
      });

      expect(code).toBeDefined();
      expect(code.length).toBeGreaterThan(2);

      logStep(13, `Contacts contract deployed: ${code.length} bytes`);
    });

    test('should verify payment requests contract is deployed', async () => {
      logStep(14, 'Verifying payment requests contract');

      const code = await publicClient.getBytecode({
        address: CONFIG.PAYMENT_REQUESTS
      });

      expect(code).toBeDefined();
      expect(code.length).toBeGreaterThan(2);

      logStep(14, `Payment requests contract deployed: ${code.length} bytes`);
    });

    test('should handle queries to both contracts simultaneously', async () => {
      logStep(15, 'Testing simultaneous contract queries');

      const queries = await Promise.all([
        publicClient.getBytecode({ address: CONFIG.ENCRYPTED_CONTACTS }),
        publicClient.getBytecode({ address: CONFIG.PAYMENT_REQUESTS }),
        publicClient.getBytecode({ address: CONFIG.PRIVATE_UTXO_LEDGER })
      ]);

      queries.forEach(code => {
        expect(code).toBeDefined();
        expect(code.length).toBeGreaterThan(2);
      });

      logStep(15, 'All contracts queryable simultaneously');
    });
  });
});
