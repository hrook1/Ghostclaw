/**
 * On-Chain Lattice Test Fixture
 *
 * Provides shared setup for all on-chain lattice tests.
 * Handles real deposit seeding on Sepolia testnet.
 */

import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { OnChainSeeder } from '../lib/on-chain-seeder.js';
import { OnChainMerkle } from '../lib/on-chain-merkle.js';
import { createTestWallets } from '../lib/wallet-simulator.js';
import { CONFIG } from '../setup.js';

/**
 * On-chain test configuration
 *
 * Budget constraints:
 * - 10 wallets max
 * - $0.03 USDC per wallet (30000 in 6-decimal)
 * - Gas for 2 transactions per wallet
 */
export const ON_CHAIN_CONFIG = {
  // Funder address (private key from environment)
  FUNDER_ADDRESS: CONFIG.ON_CHAIN?.FUNDER_ADDRESS || '0x93AD852fa514255722D22315d64772BB72aEE40A',

  // USDC amount per wallet ($0.03 = 30000 in 6-decimal)
  USDC_PER_WALLET: CONFIG.ON_CHAIN?.USDC_PER_WALLET || 30000,

  // Maximum wallets to seed
  MAX_WALLETS: 10,

  // Transfer amounts for different test topologies
  AMOUNTS: {
    // Chain test: small transfers to maximize hops
    CHAIN_TRANSFER: 5000, // $0.005 per transfer

    // Diamond test: split and converge
    DIAMOND_SPLIT: 10000, // $0.01 per branch
    DIAMOND_CONVERGE: 5000, // $0.005 to destination

    // Fan-in: multiple sources to one destination
    FAN_IN_TRANSFER: 5000, // $0.005 per source

    // Fan-out: one source to multiple destinations
    FAN_OUT_TRANSFER: 5000 // $0.005 per destination
  },

  // Contract deployment block (for event sync optimization)
  DEPLOYMENT_BLOCK: BigInt(CONFIG.ON_CHAIN?.DEPLOYMENT_BLOCK || '9847904')
};

/**
 * Setup fixture for on-chain lattice tests
 *
 * @param {string} testRunId - Unique identifier for this test run
 * @returns {Promise<{seeder, onChainMerkle, publicClient, config}>}
 */
export async function setupOnChainFixture(testRunId) {
  const funderPrivateKey = CONFIG.ON_CHAIN?.FUNDER_PRIVATE_KEY || process.env.FUNDER_PRIVATE_KEY;

  if (!funderPrivateKey) {
    throw new Error(
      'FUNDER_PRIVATE_KEY environment variable required for on-chain tests.\n' +
      'Set it to the private key for: ' + ON_CHAIN_CONFIG.FUNDER_ADDRESS
    );
  }

  // Create public client for reading chain state
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(CONFIG.RPC_URL)
  });

  // Create seeder for making real deposits
  const seeder = new OnChainSeeder(funderPrivateKey, {
    rpcUrl: CONFIG.RPC_URL,
    contractAddress: CONFIG.PRIVATE_UTXO_LEDGER,
    usdcAddress: CONFIG.USDC_ADDRESS
  });

  // Create on-chain Merkle sync
  const onChainMerkle = new OnChainMerkle(
    publicClient,
    CONFIG.PRIVATE_UTXO_LEDGER,
    ON_CHAIN_CONFIG.DEPLOYMENT_BLOCK
  );

  // Verify funder has sufficient balance
  const balance = await seeder.getFunderBalance();
  console.log(`[Fixture] Funder USDC balance: ${balance}`);

  return {
    seeder,
    onChainMerkle,
    publicClient,
    config: ON_CHAIN_CONFIG,
    testRunId
  };
}

/**
 * Create deterministic wallets for a test
 *
 * @param {number} count - Number of wallets
 * @param {string} testRunId - Test run identifier for deterministic seeds
 * @returns {SimulatedWallet[]}
 */
export function createDeterministicWallets(count, testRunId) {
  if (count > ON_CHAIN_CONFIG.MAX_WALLETS) {
    throw new Error(
      `Cannot create ${count} wallets. Max is ${ON_CHAIN_CONFIG.MAX_WALLETS}`
    );
  }
  return createTestWallets(count, `onchain-${testRunId}`);
}

/**
 * Helper to seed and sync for a test
 * Combines seeding + merkle sync in one call
 *
 * @param {Object} fixture - The fixture from setupOnChainFixture
 * @param {SimulatedWallet[]} wallets - Wallets to seed
 * @param {number|number[]} amounts - Amount(s) per wallet
 * @returns {Promise<{seedResults: Array, root: string}>}
 */
export async function seedAndSync(fixture, wallets, amounts) {
  const { seeder, onChainMerkle } = fixture;

  // Seed all wallets
  console.log(`[Fixture] Seeding ${wallets.length} wallets...`);
  const seedResults = await seeder.seedWallets(wallets, amounts, {
    delayBetween: 2000 // 2 seconds between deposits
  });

  // Sync merkle tree from chain
  console.log('[Fixture] Syncing Merkle tree...');
  const { root, leafCount } = await onChainMerkle.sync();

  // Verify root matches contract
  const rootCheck = await onChainMerkle.verifyRoot();
  if (!rootCheck.matches) {
    throw new Error(
      `Merkle root mismatch after seeding!\n` +
      `  Local: ${rootCheck.local}\n` +
      `  Contract: ${rootCheck.contract}`
    );
  }

  console.log(`[Fixture] Seeding complete. Tree has ${leafCount} leaves.`);

  return {
    seedResults,
    root
  };
}

/**
 * Skip test if on-chain tests are disabled
 */
export function skipIfNoFunder() {
  if (!process.env.FUNDER_PRIVATE_KEY) {
    console.log('[Fixture] Skipping on-chain test (FUNDER_PRIVATE_KEY not set)');
    return true;
  }
  return false;
}

/**
 * Conditional describe for on-chain tests
 */
export const describeOnChain = process.env.FUNDER_PRIVATE_KEY
  ? describe
  : describe.skip;

/**
 * Conditional test for on-chain tests
 */
export const testOnChain = process.env.FUNDER_PRIVATE_KEY
  ? test
  : test.skip;

export default {
  ON_CHAIN_CONFIG,
  setupOnChainFixture,
  createDeterministicWallets,
  seedAndSync,
  skipIfNoFunder,
  describeOnChain,
  testOnChain
};
