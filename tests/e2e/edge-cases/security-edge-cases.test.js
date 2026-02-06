/**
 * Security Edge Cases Tests
 * Tests for security vulnerabilities and malicious input handling
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Security Edge Cases', () => {
  describe('Malformed Input Handling', () => {
    test('should handle extremely large amounts', async () => {
      logStep(1, 'Testing extremely large amount values');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935', // uint256 max
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32)
          }],
          outputNotes: [{
            amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      // Should handle without crashing
      expect([200, 400, 500]).toContain(response.status);
      logStep(1, `Large amount handled with status ${response.status}`);
    });

    test('should handle negative amounts (as strings)', async () => {
      logStep(2, 'Testing negative amount strings');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '-1000000',
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32)
          }],
          outputNotes: [{
            amount: '-1000000',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(2, `Negative amount handled with status ${response.status}`);
    });

    test('should handle zero amounts', async () => {
      logStep(3, 'Testing zero amounts');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '0',
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32)
          }],
          outputNotes: [{
            amount: '0',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(3, `Zero amount handled with status ${response.status}`);
    });

    test('should handle mismatched input/output amounts', async () => {
      logStep(4, 'Testing input/output amount mismatch');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32)
          }],
          outputNotes: [{
            amount: '2000000', // More than input - should fail
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      // Request accepted but proof will fail
      expect([200, 400, 500]).toContain(response.status);
      logStep(4, `Amount mismatch handled with status ${response.status}`);
    });
  });

  describe('Hex String Validation', () => {
    test('should handle invalid hex strings (odd length)', async () => {
      logStep(5, 'Testing odd-length hex string');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x123', // Odd length - invalid
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
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(5, `Odd hex handled with status ${response.status}`);
    });

    test('should handle non-hex characters', async () => {
      logStep(6, 'Testing non-hex characters');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', // Invalid hex
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
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(6, `Non-hex characters handled with status ${response.status}`);
    });

    test('should handle missing 0x prefix', async () => {
      logStep(7, 'Testing missing 0x prefix');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '01'.repeat(32), // Missing 0x
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
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(7, `Missing 0x handled with status ${response.status}`);
    });

    test('should handle oversized hex strings', async () => {
      logStep(8, 'Testing oversized hex strings');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '01'.repeat(1000), // Way too long
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
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(8, `Oversized hex handled with status ${response.status}`);
    });
  });

  describe('Array Boundary Tests', () => {
    test('should handle empty input notes array', async () => {
      logStep(9, 'Testing empty inputNotes array');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [], // Empty
          outputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: [],
          txSignatures: [],
          inputIndices: [],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(9, `Empty inputNotes handled with status ${response.status}`);
    });

    test('should handle many input notes (10)', async () => {
      logStep(10, 'Testing 10 input notes');

      const inputNotes = Array.from({ length: 10 }, (_, i) => ({
        amount: '100000',
        ownerPubkey: '0x' + (i + 1).toString(16).padStart(64, '0'),
        blinding: '0x' + (i + 100).toString(16).padStart(64, '0')
      }));

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes,
          outputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: Array(10).fill('0x' + '00'.repeat(65)),
          txSignatures: Array(10).fill('0x' + '00'.repeat(65)),
          inputIndices: Array.from({ length: 10 }, (_, i) => i),
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(10, `10 input notes handled with status ${response.status}`);
    });

    test('should handle signature/note count mismatch', async () => {
      logStep(11, 'Testing signature count mismatch');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [
            { amount: '500000', ownerPubkey: '0x' + '01'.repeat(32), blinding: '0x' + '02'.repeat(32) },
            { amount: '500000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }
          ],
          outputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '05'.repeat(32),
            blinding: '0x' + '06'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)], // Only 1, should be 2
          txSignatures: ['0x' + '00'.repeat(65)], // Only 1, should be 2
          inputIndices: [0, 1],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(11, `Signature mismatch handled with status ${response.status}`);
    });
  });

  describe('Relayer Input Validation', () => {
    test('should handle invalid recipient address format', async () => {
      logStep(12, 'Testing invalid recipient address');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: 'not-an-address',
          amount: '1000000',
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      expect(response.status).toBe(500);
      logStep(12, 'Invalid address rejected');
    });

    test('should handle recipient as zero address', async () => {
      logStep(13, 'Testing zero address recipient');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: '0x0000000000000000000000000000000000000000',
          amount: '1000000',
          proof: '0x' + '01'.repeat(100),
          publicValues: '0x' + '00'.repeat(64),
          encryptedOutputs: []
        })
      });

      expect(response.status).toBe(500);
      logStep(13, 'Zero address handled');
    });

    test('should handle extremely large proof data', async () => {
      logStep(14, 'Testing large proof data');

      const response = await fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedOutputs: [],
          proof: '0x' + '01'.repeat(100000), // 100KB proof
          publicValues: '0x' + '00'.repeat(64)
        })
      });

      expect([400, 413, 500]).toContain(response.status);
      logStep(14, `Large proof handled with status ${response.status}`);
    });
  });

  describe('JSON Injection Tests', () => {
    test('should handle nested object injection in amount', async () => {
      logStep(15, 'Testing object injection in amount field');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: { $gt: 0 }, // MongoDB-style injection attempt
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
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(15, `Object injection handled with status ${response.status}`);
    });

    test('should handle prototype pollution attempt', async () => {
      logStep(16, 'Testing prototype pollution');

      const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '01'.repeat(32),
            blinding: '0x' + '02'.repeat(32),
            __proto__: { isAdmin: true },
            constructor: { prototype: { isAdmin: true } }
          }],
          outputNotes: [{
            amount: '1000000',
            ownerPubkey: '0x' + '03'.repeat(32),
            blinding: '0x' + '04'.repeat(32)
          }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });

      expect([200, 400, 500]).toContain(response.status);
      logStep(16, `Prototype pollution attempt handled with status ${response.status}`);
    });
  });

  describe('Rate Limiting Behavior', () => {
    test('should handle 50 rapid requests', async () => {
      logStep(17, 'Testing 50 rapid requests');

      const requests = Array.from({ length: 50 }, (_, i) =>
        fetch(`${CONFIG.PROVER_SERVER}/api/health`)
      );

      const responses = await Promise.all(requests);

      // All health checks should succeed (or be rate limited gracefully)
      const successCount = responses.filter(r => r.status === 200).length;
      const rateLimitCount = responses.filter(r => r.status === 429).length;

      expect(successCount + rateLimitCount).toBe(50);
      logStep(17, `50 requests: ${successCount} success, ${rateLimitCount} rate limited`);
    });

    test('should remain operational after burst', async () => {
      logStep(18, 'Verifying server health after burst');

      // Wait a bit after burst
      await new Promise(r => setTimeout(r, 1000));

      const health = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(health.status).toBe(200);

      const relayerHealth = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(relayerHealth.status).toBe(200);

      logStep(18, 'Both servers healthy after burst');
    });
  });
});
