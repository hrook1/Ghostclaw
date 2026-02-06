/**
 * Deposit Flow Tests
 * Tests the complete deposit flow from wallet to private UTXO
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http, parseUnits } from 'viem';
import { sepolia } from 'viem/chains';

describe('Deposit Flow', () => {
  let publicClient;

  beforeAll(() => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  });

  describe('Contract State', () => {
    test('should read current merkle root', async () => {
      logStep(1, 'Reading current merkle root');

      const root = await publicClient.readContract({
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

      expect(root).toMatch(/^0x[a-fA-F0-9]{64}$/);
      logStep(1, `Current root: ${root.slice(0, 18)}...`);
    });

    test('should have contract balance readable', async () => {
      logStep(2, 'Reading contract balance');

      const balance = await publicClient.readContract({
        address: CONFIG.PRIVATE_UTXO_LEDGER,
        abi: [{
          inputs: [],
          name: 'getBalance',
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function'
        }],
        functionName: 'getBalance'
      });

      expect(typeof balance).toBe('bigint');
      expect(balance).toBeGreaterThanOrEqual(0n);
      logStep(2, `Contract balance: ${balance}`);
    });
  });

  describe('Deposit Validation', () => {
    test('should reject deposit without permit signature', async () => {
      logStep(3, 'Testing deposit rejection without permit');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/deposit-with-permit`, {
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
            permitted: {
              token: CONFIG.USDC_ADDRESS,
              amount: '1000000'
            },
            nonce: '0',
            deadline: Math.floor(Date.now() / 1000) + 3600
          },
          signature: '0x' + '00'.repeat(65),
          depositor: '0x' + '00'.repeat(20)
        })
      });

      // Should fail with 500 (invalid signature)
      expect(response.status).toBe(500);
      logStep(3, 'Deposit correctly rejected');
    });
  });
});
