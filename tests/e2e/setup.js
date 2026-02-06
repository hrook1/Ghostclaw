/**
 * E2E Test Setup - Environment configuration
 *
 * All sensitive values must be provided via environment variables.
 * Create a .env file in tests/e2e/ with:
 *
 * PROVER_URL=http://localhost:3001
 * RELAYER_URL=http://localhost:3002
 * RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY
 * ALCHEMY_API_KEY=YOUR_API_KEY
 * FUNDER_PRIVATE_KEY=0x...
 */

import 'dotenv/config';

// Test configuration - all from environment
export const CONFIG = {
  PROVER_URL: process.env.PROVER_URL || 'http://localhost:3001',
  RELAYER_URL: process.env.RELAYER_URL || 'http://localhost:3002',
  RPC_URL: process.env.RPC_URL,
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '0x5A4c17e4701f0570eE2E5D71EC409e2bcD1D58ea',
  USDC_ADDRESS: process.env.USDC_ADDRESS || '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  FUNDER_PRIVATE_KEY: process.env.FUNDER_PRIVATE_KEY,

  // Timeouts
  PROOF_TIMEOUT: parseInt(process.env.PROOF_TIMEOUT || '300000'),
  TX_TIMEOUT: parseInt(process.env.TX_TIMEOUT || '60000'),
};

// Validate required config
if (!CONFIG.RPC_URL && !CONFIG.ALCHEMY_API_KEY) {
  console.warn('Warning: RPC_URL or ALCHEMY_API_KEY not set. Some tests may fail.');
}

// Helper to log test steps
export function logStep(testNum, step, message) {
  console.log(`[Test ${testNum}][Step ${step}] ${message}`);
}

// Helper to fetch with retry
export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// Conditional test helper - skip if prover not available
export function testIfProver(name, fn, timeout = CONFIG.PROOF_TIMEOUT) {
  return test(name, async () => {
    try {
      const response = await fetch(`${CONFIG.PROVER_URL}/api/health`);
      if (!response.ok) {
        console.log(`Skipping ${name} - prover not available`);
        return;
      }
    } catch {
      console.log(`Skipping ${name} - prover not available`);
      return;
    }
    return fn();
  }, timeout);
}

// Conditional describe - skip suite if conditions not met
export function describeOnChain(name, fn) {
  if (!CONFIG.FUNDER_PRIVATE_KEY) {
    describe.skip(name, fn);
  } else {
    describe(name, fn);
  }
}
