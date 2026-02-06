/**
 * On-Chain UTXO Seeder for Lattice Tests
 *
 * Seeds test wallets with real on-chain USDC deposits on Sepolia testnet.
 * This enables lattice tests to work with actual on-chain state.
 */

import { createPublicClient, createWalletClient, http, parseAbiItem, decodeEventLog, decodeAbiParameters } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../setup.js';

// ERC20 ABI for USDC approval
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
];

// Deposit ABI for PrivateUTXOLedger
const DEPOSIT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'commitment', type: 'bytes32' },
      {
        name: 'encrypted',
        type: 'tuple',
        components: [
          { name: 'commitment', type: 'bytes32' },
          { name: 'keyType', type: 'uint8' },
          { name: 'ephemeralPubkey', type: 'bytes' },
          { name: 'nonce', type: 'bytes12' },
          { name: 'ciphertext', type: 'bytes' }
        ]
      },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  }
];

// Deposited event ABI (matches new contract with leafIndex)
const DEPOSITED_EVENT = parseAbiItem(
  'event Deposited(address indexed from, uint256 amount, bytes32 commitment, uint256 leafIndex)'
);

// OutputCommitted event ABI (has leafIndex)
const OUTPUT_COMMITTED_EVENT = parseAbiItem(
  'event OutputCommitted(bytes32 indexed commitment, uint8 keyType, bytes ephemeralPubkey, bytes12 nonce, bytes ciphertext, uint256 leafIndex)'
);

/**
 * OnChainSeeder - Seeds test wallets with real on-chain deposits
 */
export class OnChainSeeder {
  constructor(funderPrivateKey, options = {}) {
    if (!funderPrivateKey) {
      throw new Error('Funder private key is required');
    }

    this.funderPrivateKey = funderPrivateKey;
    this.funderAccount = privateKeyToAccount(funderPrivateKey);

    const rpcUrl = options.rpcUrl || CONFIG.RPC_URL;

    this.publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl)
    });

    this.walletClient = createWalletClient({
      account: this.funderAccount,
      chain: sepolia,
      transport: http(rpcUrl)
    });

    this.contractAddress = options.contractAddress || CONFIG.PRIVATE_UTXO_LEDGER;
    this.usdcAddress = options.usdcAddress || CONFIG.USDC_ADDRESS;

    // Track nonces for sequential transactions
    this.nextNonce = null;
  }

  /**
   * Check funder's USDC balance
   */
  async getFunderBalance() {
    const balance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.funderAccount.address]
    });
    return balance;
  }

  /**
   * Ensure USDC is approved for the contract
   */
  async ensureApproval(totalAmount) {
    const currentAllowance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.funderAccount.address, this.contractAddress]
    });

    if (currentAllowance < totalAmount) {
      console.log(`[Seeder] Approving USDC spend: ${totalAmount}`);

      const hash = await this.walletClient.writeContract({
        address: this.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [this.contractAddress, totalAmount * 2n] // Approve double for headroom
      });

      await this.publicClient.waitForTransactionReceipt({ hash });
      console.log(`[Seeder] USDC approved: ${hash}`);
    }
  }

  /**
   * Seed a single wallet with real on-chain deposit
   *
   * @param {SimulatedWallet} wallet - The wallet to seed
   * @param {number|bigint} amount - Amount in USDC units (6 decimals)
   * @returns {Promise<{txHash: string, commitment: string, leafIndex: number}>}
   */
  async seedWallet(wallet, amount) {
    const amountBigInt = BigInt(amount);

    // Generate blinding for this deposit
    const blinding = wallet.generateBlinding();

    // Compute commitment (matches wallet-simulator.js)
    const commitment = wallet.computeCommitment(amountBigInt, wallet.ownerX, blinding);

    // Encrypt note for on-chain storage
    const encrypted = await wallet.encryptNote(
      amountBigInt,
      wallet.ownerX,
      blinding,
      wallet.publicKey
    );

    // Prepare encrypted struct for contract
    const encryptedStruct = {
      commitment: commitment,
      keyType: 0,
      ephemeralPubkey: encrypted.ephemeralPubkey,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext
    };

    console.log(`[Seeder] Depositing ${amountBigInt} to ${wallet.walletId}...`);

    // Ensure USDC is approved for the contract
    await this.ensureApproval(amountBigInt);

    // Call deposit on contract
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: DEPOSIT_ABI,
      functionName: 'deposit',
      args: [commitment, encryptedStruct, amountBigInt]
    });

    // Wait for confirmation
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    // Parse Deposited event to get leafIndex
    const depositEvent = this.parseDepositedEvent(receipt);

    if (!depositEvent) {
      throw new Error(`Deposited event not found in receipt for tx: ${hash}`);
    }

    console.log(`[Seeder] ${wallet.walletId} seeded: index=${depositEvent.leafIndex}, tx=${hash.slice(0, 18)}...`);

    // Add UTXO to wallet with REAL on-chain index
    wallet.addUTXO({
      commitment,
      amount: amountBigInt,
      owner: '0x' + wallet.ownerX,
      blinding,
      index: Number(depositEvent.leafIndex)
    });

    return {
      txHash: hash,
      commitment,
      leafIndex: Number(depositEvent.leafIndex),
      blockNumber: Number(receipt.blockNumber)
    };
  }

  /**
   * Parse deposit events from transaction receipt
   * Uses OutputCommitted event to get the leafIndex
   */
  /**
   * Parse Deposited event from receipt
   */
  parseDepositedEvent(receipt) {
    for (const log of receipt.logs) {
      try {
        const event = decodeEventLog({
          abi: [DEPOSITED_EVENT],
          data: log.data,
          topics: log.topics
        });

        if (event.eventName === 'Deposited') {
          const leafIndex = Number(event.args.leafIndex);
          const commitment = event.args.commitment;
          console.log(`[Seeder] Found Deposited: leafIndex=${leafIndex}, commitment=${commitment}`);
          return {
            leafIndex,
            commitment
          };
        }
      } catch (e) {
        // Ignore parsing errors for other events
      }
    }

    // Fallback: Check OutputCommitted if Deposited parsing fails (sanity check)
    // But for the new contract, Deposited MUST be present.
    console.log('[Seeder] Deposited event not found in receipt');
    return null;
  }

  /**
   * Seed multiple wallets sequentially
   *
   * @param {SimulatedWallet[]} wallets - Array of wallets to seed
   * @param {number|bigint|Array} amounts - Amount per wallet or array of amounts
   * @param {Object} options - Options
   * @returns {Promise<Array<{txHash, commitment, leafIndex}>>}
   */
  async seedWallets(wallets, amounts, options = {}) {
    const { delayBetween = 2000 } = options;
    const results = [];

    // Normalize amounts to array
    const amountArray = Array.isArray(amounts)
      ? amounts
      : wallets.map(() => amounts);

    // Calculate total and ensure approval
    const totalAmount = amountArray.reduce((sum, a) => sum + BigInt(a), 0n);

    // Check balance
    const balance = await this.getFunderBalance();
    if (balance < totalAmount) {
      throw new Error(
        `Insufficient USDC balance: have ${balance}, need ${totalAmount}`
      );
    }

    // Ensure approval for total
    await this.ensureApproval(totalAmount);

    // Seed each wallet sequentially
    for (let i = 0; i < wallets.length; i++) {
      const result = await this.seedWallet(wallets[i], amountArray[i]);
      results.push(result);

      // Delay between deposits to avoid nonce issues
      if (i < wallets.length - 1 && delayBetween > 0) {
        await new Promise(r => setTimeout(r, delayBetween));
      }
    }

    return results;
  }

  /**
   * Get funder address
   */
  getFunderAddress() {
    return this.funderAccount.address;
  }
}

export default OnChainSeeder;
