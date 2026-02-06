/**
 * State Consistency Tests
 * Tests for verifying state remains consistent across operations
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

describe('State Consistency', () => {
  let publicClient;

  beforeAll(() => {
    publicClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  });

  describe('Merkle Root Consistency', () => {
    test('should return same root across multiple queries', async () => {
      logStep(1, 'Testing root consistency across reads');

      const roots = [];
      for (let i = 0; i < 10; i++) {
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
        roots.push(root);
      }

      const uniqueRoots = new Set(roots);
      expect(uniqueRoots.size).toBe(1);
      logStep(1, `10 queries returned consistent root: ${roots[0].slice(0, 18)}...`);
    });

    test('should maintain root during failed transaction attempts', async () => {
      logStep(2, 'Testing root stability during failed txs');

      // Get initial root
      const rootBefore = await publicClient.readContract({
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

      // Attempt several failed transactions
      const failedTxs = Array.from({ length: 5 }, (_, i) =>
        fetch(`${CONFIG.RELAYER_SERVER}/api/submit-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encryptedOutputs: [],
            proof: '0x' + 'ff'.repeat(100),
            publicValues: '0x' + '00'.repeat(64)
          })
        })
      );

      await Promise.all(failedTxs);

      // Root should be unchanged
      const rootAfter = await publicClient.readContract({
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

      expect(rootAfter).toBe(rootBefore);
      logStep(2, 'Root unchanged after failed transactions');
    });
  });

  describe('Job Queue Consistency', () => {
    test('should track all submitted jobs', async () => {
      logStep(3, 'Testing job tracking consistency');

      const submittedJobs = [];

      // Submit 5 jobs
      for (let i = 0; i < 5; i++) {
        const response = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + (i + 1).toString(16).padStart(64, '0'), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: '0x' + '00'.repeat(32)
          })
        });
        const result = await response.json();
        submittedJobs.push(result.jobId);
      }

      // Verify all jobs are trackable
      for (const jobId of submittedJobs) {
        const statusResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
        expect(statusResponse.status).toBe(200);
      }

      logStep(3, `All ${submittedJobs.length} jobs trackable`);
    });

    test('should report consistent queue status', async () => {
      logStep(4, 'Testing queue status consistency');

      // Query queue status 5 times rapidly
      const statuses = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetch(`${CONFIG.PROVER_SERVER}/api/queue-status`).then(r => r.json())
        )
      );

      // Max concurrent should be consistent
      const maxConcurrentValues = statuses.map(s => s.maxConcurrent);
      const uniqueMaxConcurrent = new Set(maxConcurrentValues);
      expect(uniqueMaxConcurrent.size).toBe(1);

      logStep(4, `Queue status consistent: maxConcurrent=${maxConcurrentValues[0]}`);
    });

    test('should not lose jobs during concurrent status queries', async () => {
      logStep(5, 'Testing job persistence during queries');

      // Submit a job
      const submitResponse = await fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'aa'.repeat(32), blinding: '0x' + 'bb'.repeat(32) }],
          outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + 'cc'.repeat(32), blinding: '0x' + 'dd'.repeat(32) }],
          nullifierSignatures: ['0x' + '00'.repeat(65)],
          txSignatures: ['0x' + '00'.repeat(65)],
          inputIndices: [0],
          oldRoot: '0x' + '00'.repeat(32)
        })
      });
      const { jobId } = await submitResponse.json();

      // Rapidly query status 20 times
      const statusQueries = Array.from({ length: 20 }, () =>
        fetch(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`)
      );

      const responses = await Promise.all(statusQueries);

      // All queries should find the job
      responses.forEach(r => {
        expect(r.status).toBe(200);
      });

      logStep(5, 'Job persisted through 20 concurrent status queries');
    });
  });

  describe('Contract State Consistency', () => {
    test('should read contract balance consistently', async () => {
      logStep(6, 'Testing balance read consistency');

      const balances = await Promise.all(
        Array.from({ length: 5 }, () =>
          publicClient.readContract({
            address: CONFIG.PRIVATE_UTXO_LEDGER,
            abi: [{
              inputs: [],
              name: 'getBalance',
              outputs: [{ name: '', type: 'uint256' }],
              stateMutability: 'view',
              type: 'function'
            }],
            functionName: 'getBalance'
          })
        )
      );

      const uniqueBalances = new Set(balances.map(b => b.toString()));
      expect(uniqueBalances.size).toBe(1);

      logStep(6, `Balance consistent: ${balances[0]}`);
    });

    test('should read contacts contract consistently', async () => {
      logStep(7, 'Testing contacts contract consistency');

      // Just verify the contract is readable
      const codes = await Promise.all(
        Array.from({ length: 3 }, () =>
          publicClient.getBytecode({ address: CONFIG.ENCRYPTED_CONTACTS })
        )
      );

      codes.forEach(code => {
        expect(code).toBeDefined();
        expect(code.length).toBeGreaterThan(2);
      });

      logStep(7, 'Contacts contract consistently readable');
    });

    test('should read payment requests contract consistently', async () => {
      logStep(8, 'Testing payment requests contract consistency');

      const codes = await Promise.all(
        Array.from({ length: 3 }, () =>
          publicClient.getBytecode({ address: CONFIG.PAYMENT_REQUESTS })
        )
      );

      codes.forEach(code => {
        expect(code).toBeDefined();
        expect(code.length).toBeGreaterThan(2);
      });

      logStep(8, 'Payment requests contract consistently readable');
    });
  });

  describe('Server Health Consistency', () => {
    test('should report consistent prover health', async () => {
      logStep(9, 'Testing prover health consistency');

      const healthResponses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${CONFIG.PROVER_SERVER}/api/health`).then(r => r.json())
        )
      );

      // All should report same status and prover mode
      const statuses = healthResponses.map(h => h.status);
      const proverModes = healthResponses.map(h => h.prover);

      expect(new Set(statuses).size).toBe(1);
      expect(new Set(proverModes).size).toBe(1);

      logStep(9, `Prover health consistent: status=${statuses[0]}, mode=${proverModes[0]}`);
    });

    test('should report consistent relayer health', async () => {
      logStep(10, 'Testing relayer health consistency');

      const healthResponses = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${CONFIG.RELAYER_SERVER}/api/health`).then(r => r.json())
        )
      );

      // All should report same smart account address
      const addresses = healthResponses.map(h => h.smartAccountAddress);
      expect(new Set(addresses).size).toBe(1);

      logStep(10, `Relayer health consistent: address=${addresses[0]}`);
    });

    test('should maintain health after stress', async () => {
      logStep(11, 'Testing health after stress test');

      // Submit 10 rapid requests to prover
      const proofRequests = Array.from({ length: 10 }, (_, i) =>
        fetch(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputNotes: [{ amount: '1000000', ownerPubkey: '0x' + (i + 50).toString(16).padStart(64, '0'), blinding: '0x' + '02'.repeat(32) }],
            outputNotes: [{ amount: '1000000', ownerPubkey: '0x' + '03'.repeat(32), blinding: '0x' + '04'.repeat(32) }],
            nullifierSignatures: ['0x' + '00'.repeat(65)],
            txSignatures: ['0x' + '00'.repeat(65)],
            inputIndices: [0],
            oldRoot: '0x' + '00'.repeat(32)
          })
        })
      );

      await Promise.all(proofRequests);

      // Wait a moment
      await new Promise(r => setTimeout(r, 500));

      // Check health
      const proverHealth = await fetch(`${CONFIG.PROVER_SERVER}/api/health`);
      const relayerHealth = await fetch(`${CONFIG.RELAYER_SERVER}/api/health`);

      expect(proverHealth.status).toBe(200);
      expect(relayerHealth.status).toBe(200);

      logStep(11, 'Both servers healthy after stress');
    });
  });

  describe('Cross-Service Consistency', () => {
    test('should have matching contract addresses', async () => {
      logStep(12, 'Testing contract address consistency');

      const proverHealth = await fetch(`${CONFIG.PROVER_SERVER}/api/health`).then(r => r.json());
      const contractInfo = await fetch(`${CONFIG.PROVER_SERVER}/api/contract-info`).then(r => r.json());

      // Prover's ledger contract should match our config
      expect(proverHealth.ledgerContract).toBe(CONFIG.PRIVATE_UTXO_LEDGER);
      expect(contractInfo.ledgerContract).toBe(CONFIG.PRIVATE_UTXO_LEDGER);

      logStep(12, `Contract addresses match: ${CONFIG.PRIVATE_UTXO_LEDGER}`);
    });

    test('should have consistent network configuration', async () => {
      logStep(13, 'Testing network configuration');

      const proverHealth = await fetch(`${CONFIG.PROVER_SERVER}/api/health`).then(r => r.json());

      // Should be using network prover
      expect(proverHealth.prover).toBe('network');
      expect(proverHealth.networkConfigured).toBe(true);

      logStep(13, `Network prover configured: ${proverHealth.rpcUrl}`);
    });
  });
});
