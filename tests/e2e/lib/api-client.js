/**
 * API Client for Prover and Relayer servers
 * Provides typed methods for all server endpoints
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import { CONFIG } from '../setup.js';

/**
 * Fetch with exponential backoff retry
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} baseDelay - Base delay in ms (doubles each retry)
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[ApiClient] Fetch failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`HTTP request failed: ${lastError.message}`);
}

export class ApiClient {
  constructor(proverUrl, relayerUrl) {
    this.proverUrl = proverUrl || CONFIG.PROVER_SERVER;
    this.relayerUrl = relayerUrl || CONFIG.RELAYER_SERVER;

    // On-chain client for reading contract state
    this.onChainClient = createPublicClient({
      chain: sepolia,
      transport: http(CONFIG.RPC_URL)
    });
  }

  /**
   * Get current merkle root from contract
   * @returns {Promise<string>} - Current merkle root (0x prefixed)
   */
  async getCurrentRoot() {
    return this.onChainClient.readContract({
      address: CONFIG.PRIVATE_UTXO_LEDGER,
      abi: [{
        inputs: [],
        name: 'currentRoot',
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function'
      }],
      functionName: 'currentRoot'
    });
  }

  /**
   * Submit a proof generation request to the prover
   * POST /api/generate-proof
   *
   * @param {Object} request - Proof request payload
   * @param {Array} request.inputNotes - Input notes [{amount, ownerPubkey, blinding}]
   * @param {Array} request.outputNotes - Output notes [{amount, ownerPubkey, blinding}]
   * @param {Array} request.nullifierSignatures - Signatures for nullifier computation
   * @param {Array} request.txSignatures - Transaction binding signatures
   * @param {Array} request.inputIndices - Merkle tree indices of inputs
   * @param {string} request.oldRoot - Current merkle root
   * @returns {Promise<{jobId: string, queuePosition: number, proverMode: string}>}
   */
  async submitProofRequest(request) {
    const response = await fetch(`${this.proverUrl}/api/generate-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Proof submission failed: ${error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get proof job status
   * GET /api/proof-status/:jobId
   *
   * @param {string} jobId - Job ID from submitProofRequest
   * @returns {Promise<{status: string, stage?: string, stageDescription?: string, progress?: number, proof?: string, publicValuesRaw?: string, publicOutputs?: Object, error?: string}>}
   */
  async getProofStatus(jobId) {
    const response = await fetch(`${this.proverUrl}/api/proof-status/${jobId}`);

    if (!response.ok) {
      throw new Error(`Status check failed for ${jobId}: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get overall queue status
   * GET /api/queue-status
   *
   * @returns {Promise<{activeJobs: number, queuedJobs: number, maxConcurrent: number, totalTracked: number}>}
   */
  async getQueueStatus() {
    const response = await fetch(`${this.proverUrl}/api/queue-status`);

    if (!response.ok) {
      throw new Error(`Queue status failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Submit a proven transaction to the relayer
   * POST /api/submit-tx
   *
   * @param {Object} payload - Transaction payload
   * @param {Array} payload.encryptedOutputs - Encrypted output notes
   * @param {string} payload.proof - SP1 proof bytes
   * @param {string} payload.publicValues - SP1 public values bytes
   * @returns {Promise<{success: boolean, txHash: string, userOpHash: string}>}
   */
  async submitTransaction(payload) {
    const response = await fetchWithRetry(`${this.relayerUrl}/api/submit-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 3, 1000);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Relayer submission failed: ${error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Submit a withdrawal to the relayer
   * POST /api/withdraw
   *
   * @param {Object} payload - Withdrawal payload
   * @param {string} payload.recipient - ETH address to receive funds
   * @param {string} payload.amount - Amount in wei (string)
   * @param {string} payload.proof - SP1 proof bytes
   * @param {string} payload.publicValues - SP1 public values bytes
   * @param {Array} payload.encryptedOutputs - Encrypted change output (if any)
   * @returns {Promise<{success: boolean, txHash: string, userOpHash: string}>}
   */
  async withdraw(payload) {
    const response = await fetchWithRetry(`${this.relayerUrl}/api/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 3, 1000);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Withdraw failed: ${error.error || response.statusText}`);
    }

    return response.json();
  }

  /**
   * Check health of both servers
   * @returns {Promise<{prover: Object|null, relayer: Object|null}>}
   */
  async checkHealth() {
    const [prover, relayer] = await Promise.all([
      fetch(`${this.proverUrl}/api/health`)
        .then(r => r.json())
        .catch(() => null),
      fetch(`${this.relayerUrl}/api/health`)
        .then(r => r.json())
        .catch(() => null)
    ]);

    return { prover, relayer };
  }

  /**
   * Wait for a proof to complete with polling
   *
   * @param {string} jobId - Job ID to poll
   * @param {Object} options - Polling options
   * @param {number} options.pollInterval - Interval between polls (ms)
   * @param {number} options.timeout - Maximum wait time (ms)
   * @param {Function} options.onStatus - Callback for status updates
   * @returns {Promise<Object>} - Final proof result
   */
  async waitForProof(jobId, options = {}) {
    const {
      pollInterval = 5000,
      timeout = 300000, // 5 minutes default
      onStatus = () => {}
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await this.getProofStatus(jobId);
      onStatus(status);

      if (status.status === 'success') {
        return status;
      }

      if (status.status === 'error') {
        throw new Error(status.error || 'Proof generation failed');
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(`Proof timeout after ${timeout}ms for job ${jobId}`);
  }
}

// Default client instance using CONFIG
export const defaultClient = new ApiClient();
