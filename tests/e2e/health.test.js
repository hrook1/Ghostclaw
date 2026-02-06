/**
 * Health Check Tests
 * Verifies all services are running and configured correctly
 */

import { CONFIG, fetchWithRetry, logStep } from './setup.js';

describe('Service Health Checks', () => {
  describe('Prover Server', () => {
    test('should be running and healthy', async () => {
      logStep(1, 'Checking prover server health');

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/health`);
      expect(response.ok).toBe(true);

      const health = await response.json();
      expect(health.status).toBe('ok');
      expect(health.prover).toBeDefined();

      logStep(1, `Prover mode: ${health.prover}`);
    });

    test('should have network prover configured', async () => {
      logStep(2, 'Checking network prover configuration');

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/health`);
      const health = await response.json();

      // For production, network prover should be configured
      if (process.env.CI || process.env.PRODUCTION) {
        expect(health.networkConfigured).toBe(true);
      }

      logStep(2, `Network configured: ${health.networkConfigured}`);
    });

    test('should report queue status', async () => {
      logStep(3, 'Checking queue status');

      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/queue-status`);
      expect(response.ok).toBe(true);

      const status = await response.json();
      expect(status).toHaveProperty('activeJobs');
      expect(status).toHaveProperty('queuedJobs');
      expect(status).toHaveProperty('maxConcurrent');

      logStep(3, `Queue: ${status.activeJobs} active, ${status.queuedJobs} queued`);
    });
  });

  describe('Relayer Server', () => {
    test('should be running and healthy', async () => {
      logStep(4, 'Checking relayer server health');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/health`);
      expect(response.ok).toBe(true);

      const health = await response.json();
      expect(health.status).toBe('ok');
      expect(health.smartAccountAddress).toBeDefined();
      expect(health.gasSponsorship).toBe('enabled');

      logStep(4, `Smart account: ${health.smartAccountAddress}`);
    });

    test('should have valid smart account address', async () => {
      logStep(5, 'Validating smart account address');

      const response = await fetchWithRetry(`${CONFIG.RELAYER_SERVER}/api/health`);
      const health = await response.json();

      // Should be a valid Ethereum address
      expect(health.smartAccountAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

      logStep(5, 'Smart account address format valid');
    });
  });

  describe('Contract Verification', () => {
    test('should have valid contract addresses', () => {
      logStep(6, 'Validating contract addresses');

      // Check address format
      expect(CONFIG.PRIVATE_UTXO_LEDGER).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(CONFIG.ENCRYPTED_CONTACTS).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(CONFIG.PAYMENT_REQUESTS).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(CONFIG.USDC_ADDRESS).toMatch(/^0x[a-fA-F0-9]{40}$/);

      logStep(6, 'All contract addresses valid');
    });

    test('should have deployed contracts on Sepolia', async () => {
      logStep(7, 'Checking contract deployments');

      // Check UTXO ledger contract has code
      const response = await fetch(CONFIG.RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getCode',
          params: [CONFIG.PRIVATE_UTXO_LEDGER, 'latest']
        })
      });

      const result = await response.json();
      expect(result.result).not.toBe('0x');
      expect(result.result.length).toBeGreaterThan(10);

      logStep(7, 'UTXO Ledger contract deployed');
    });
  });
});
