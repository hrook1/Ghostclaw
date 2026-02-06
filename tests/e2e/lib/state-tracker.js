/**
 * State Tracker - Verify on-chain UTXO state consistency
 *
 * Provides methods to:
 * - Query current merkle root
 * - Check nullifier usage
 * - Validate wallet balances match expectations
 * - Scan and decrypt UTXOs from on-chain events
 * - Verify displayed balance matches actual on-chain state
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { sepolia } from 'viem/chains';
import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { CONFIG } from '../setup.js';

// Configure HMAC for secp256k1 (required for synchronous signing)
secp256k1.etc.hmacSha256Sync = (k, ...msgs) => {
  const data = secp256k1.etc.concatBytes(...msgs);
  return hmac(sha256, k, data);
};

// Deployment block for the contract (to limit event scanning)
const DEPLOYMENT_BLOCK = 9847904n;

// KDF for ECIES decryption (must match crypto.ts:kdfNew)
function kdfNew(sharedSecret) {
  return hkdf(sha256, sharedSecret, undefined,
    new TextEncoder().encode('utxo-prototype-v1-encryption'), 32);
}

// Legacy KDF for backward compatibility
function kdfLegacy(sharedSecret) {
  return sha256(sharedSecret.slice(1));
}

// AES-256-GCM decryption
async function decryptAES256GCM(key, nonce, ciphertext) {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'AES-GCM' }, false, ['decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce }, cryptoKey, ciphertext
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

// Decrypt a UTXO note (tries both KDF methods)
async function decryptNote(ephemeralPubkey, nonce, ciphertext, privateKey) {
  try {
    const ephPubkey = ephemeralPubkey.startsWith('0x') ? ephemeralPubkey.slice(2) : ephemeralPubkey;
    const ephemeralPubkeyBytes = new Uint8Array(Buffer.from(ephPubkey, 'hex'));
    const nonceBytes = new Uint8Array(Buffer.from(nonce.startsWith('0x') ? nonce.slice(2) : nonce, 'hex'));
    const ciphertextBytes = new Uint8Array(Buffer.from(ciphertext.startsWith('0x') ? ciphertext.slice(2) : ciphertext, 'hex'));

    // Perform ECDH
    const sharedSecret = secp256k1.getSharedSecret(privateKey, ephemeralPubkeyBytes, true);

    // Try both KDFs
    const kdfs = [kdfLegacy, kdfNew];
    for (const kdf of kdfs) {
      const aesKey = kdf(sharedSecret);
      const plaintext = await decryptAES256GCM(aesKey, nonceBytes, ciphertextBytes);

      if (plaintext && plaintext.length >= 96) {
        const amount = BigInt('0x' + Buffer.from(plaintext.slice(0, 32)).toString('hex'));
        const owner = '0x' + Buffer.from(plaintext.slice(32, 64)).toString('hex');
        const blinding = '0x' + Buffer.from(plaintext.slice(64, 96)).toString('hex');
        return { amount, owner, blinding };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class StateTracker {
  constructor(rpcUrl, contractAddress) {
    this.client = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl || `https://eth-sepolia.g.alchemy.com/v2/${CONFIG.ALCHEMY_API_KEY}`)
    });
    this.contractAddress = contractAddress || CONFIG.PRIVATE_UTXO_LEDGER;
    this.knownCommitments = new Set();
    this.usedNullifiers = new Set();
  }

  /**
   * Get current merkle root from contract
   */
  async getCurrentRoot() {
    return this.client.readContract({
      address: this.contractAddress,
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
   * Check if a nullifier has been used
   */
  async isNullifierUsed(nullifier) {
    return this.client.readContract({
      address: this.contractAddress,
      abi: [{
        inputs: [{ type: 'bytes32' }],
        name: 'nullifierUsed',
        outputs: [{ type: 'bool' }],
        stateMutability: 'view',
        type: 'function'
      }],
      functionName: 'nullifierUsed',
      args: [nullifier]
    });
  }

  /**
   * Get the current block number
   */
  async getBlockNumber() {
    return this.client.getBlockNumber();
  }

  /**
   * Verify consistency between local and on-chain state
   *
   * For each wallet's tracked UTXOs:
   * - Verify the nullifier has NOT been used (UTXO is unspent)
   *
   * @param {Array} wallets - Array of SimulatedWallet instances
   * @returns {Object} - Verification results
   */
  async verifyConsistency(wallets) {
    const results = {
      passed: true,
      errors: [],
      checks: [],
      summary: {
        totalWallets: wallets.length,
        totalUTXOs: 0,
        validUTXOs: 0,
        invalidUTXOs: 0
      }
    };

    for (const wallet of wallets) {
      for (const utxo of wallet.utxos) {
        results.summary.totalUTXOs++;

        try {
          // Compute the nullifier for this UTXO
          const commitment = wallet.computeCommitment(
            utxo.amount,
            utxo.owner,
            utxo.blinding
          );
          const nullifierSig = await wallet.signCommitment(commitment);
          const nullifier = wallet.computeNullifier(nullifierSig);

          // Check if nullifier has been used on-chain
          const isUsed = await this.isNullifierUsed(nullifier);

          if (isUsed) {
            results.passed = false;
            results.summary.invalidUTXOs++;
            results.errors.push({
              type: 'utxo_spent',
              wallet: wallet.walletId,
              commitment: utxo.commitment,
              message: `UTXO marked as unspent locally but nullifier is used on-chain`
            });
          } else {
            results.summary.validUTXOs++;
          }

          results.checks.push({
            wallet: wallet.walletId,
            commitment: utxo.commitment?.slice(0, 18) + '...',
            amount: utxo.amount.toString(),
            nullifierUsed: isUsed,
            valid: !isUsed
          });

        } catch (error) {
          results.passed = false;
          results.errors.push({
            type: 'verification_error',
            wallet: wallet.walletId,
            message: error.message
          });
        }
      }
    }

    return results;
  }

  /**
   * Compute expected balances for each wallet
   *
   * @param {Array} wallets - Array of SimulatedWallet instances
   * @returns {Map} - walletId -> balance (BigInt)
   */
  computeExpectedBalances(wallets) {
    const balances = new Map();

    for (const wallet of wallets) {
      const balance = wallet.utxos.reduce(
        (sum, u) => sum + BigInt(u.amount),
        0n
      );
      balances.set(wallet.walletId, balance);
    }

    return balances;
  }

  /**
   * Get all OutputCommitted events from contract
   */
  async getOutputEvents(fromBlock = 0n) {
    return this.client.getLogs({
      address: this.contractAddress,
      event: parseAbiItem(
        'event OutputCommitted(bytes32 indexed commitment, uint8 keyType, bytes ephemeralPubkey, bytes12 nonce, bytes ciphertext)'
      ),
      fromBlock,
      toBlock: 'latest'
    });
  }

  /**
   * Get all NullifierUsed events from contract
   */
  async getNullifierEvents(fromBlock = 0n) {
    return this.client.getLogs({
      address: this.contractAddress,
      event: parseAbiItem('event NullifierUsed(bytes32 indexed nullifier)'),
      fromBlock,
      toBlock: 'latest'
    });
  }

  /**
   * Generate a state report
   */
  async generateReport(wallets) {
    const root = await this.getCurrentRoot();
    const blockNumber = await this.getBlockNumber();
    const balances = this.computeExpectedBalances(wallets);

    const lines = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║                    STATE TRACKER REPORT                      ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '',
      `  Block Number: ${blockNumber}`,
      `  Merkle Root:  ${root.slice(0, 18)}...${root.slice(-8)}`,
      '',
      '  Wallet Balances:',
    ];

    for (const [walletId, balance] of balances) {
      const usdcBalance = (Number(balance) / 1e6).toFixed(2);
      lines.push(`    ${walletId}: $${usdcBalance} (${balance} wei)`);
    }

    lines.push('');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Scan for UTXOs belonging to a wallet from on-chain events
   * This verifies what the wallet should actually have based on chain state
   *
   * @param {SimulatedWallet} wallet - The wallet to scan for
   * @param {bigint} fromBlock - Block to start scanning from
   * @returns {Object} - { utxos, totalBalance, lastScannedBlock }
   */
  async scanWalletUTXOs(wallet, fromBlock = DEPLOYMENT_BLOCK) {
    const latestBlock = await this.getBlockNumber();

    if (fromBlock > latestBlock) {
      return { utxos: [], totalBalance: 0n, lastScannedBlock: latestBlock };
    }

    // Get all OutputCommitted events
    const events = await this.getOutputEvents(fromBlock);
    console.log(`[StateTracker] Found ${events.length} OutputCommitted events`);

    // Attempt to decrypt each event for this wallet
    const myX = wallet.ownerX.toLowerCase();
    const myNotes = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const { commitment, ephemeralPubkey, nonce, ciphertext } = event.args;

      const decrypted = await decryptNote(ephemeralPubkey, nonce, ciphertext, wallet.privateKey);

      if (decrypted) {
        // Check if this note belongs to this wallet
        const noteOwnerX = decrypted.owner.slice(2).toLowerCase();
        if (myX === noteOwnerX) {
          myNotes.push({
            event,
            decrypted,
            commitment,
            index: i
          });
        }
      }
    }

    console.log(`[StateTracker] Decrypted ${myNotes.length} notes for ${wallet.walletId}`);

    // Check which notes are unspent (nullifier not used)
    const finalUTXOs = [];
    let totalBalance = 0n;

    for (const noteWrapper of myNotes) {
      // Compute nullifier for this note
      const inputComm = wallet.computeCommitment(
        noteWrapper.decrypted.amount,
        noteWrapper.decrypted.owner.slice(2), // X-coord only
        noteWrapper.decrypted.blinding
      );
      const nullifierSig = await wallet.signCommitment(inputComm);
      const nullifier = wallet.computeNullifier(nullifierSig);

      // Check if spent
      const isSpent = await this.isNullifierUsed(nullifier);

      if (!isSpent && noteWrapper.decrypted.amount > 0n) {
        finalUTXOs.push({
          commitment: noteWrapper.commitment,
          amount: noteWrapper.decrypted.amount,
          owner: noteWrapper.decrypted.owner,
          blinding: noteWrapper.decrypted.blinding,
          blockNumber: noteWrapper.event.blockNumber,
          index: noteWrapper.index
        });
        totalBalance += noteWrapper.decrypted.amount;
      }
    }

    return {
      utxos: finalUTXOs,
      totalBalance,
      lastScannedBlock: latestBlock
    };
  }

  /**
   * Verify a single wallet's balance matches on-chain state
   *
   * @param {SimulatedWallet} wallet - The wallet to verify
   * @returns {Object} - { matches, localBalance, onChainBalance, discrepancy }
   */
  async verifyWalletBalance(wallet) {
    const localBalance = wallet.getBalance();
    const { totalBalance: onChainBalance, utxos } = await this.scanWalletUTXOs(wallet);

    const matches = localBalance === onChainBalance;
    const discrepancy = localBalance - onChainBalance;

    return {
      walletId: wallet.walletId,
      matches,
      localBalance,
      onChainBalance,
      discrepancy,
      localUtxoCount: wallet.utxos.length,
      onChainUtxoCount: utxos.length
    };
  }

  /**
   * Verify all wallets' balances match on-chain state
   *
   * @param {Array} wallets - Array of SimulatedWallet instances
   * @returns {Object} - { allMatch, results, errors }
   */
  async verifyAllBalances(wallets) {
    const results = [];
    const errors = [];
    let allMatch = true;

    console.log(`\n[StateTracker] Verifying balances for ${wallets.length} wallets...`);

    for (const wallet of wallets) {
      try {
        const result = await this.verifyWalletBalance(wallet);
        results.push(result);

        if (!result.matches) {
          allMatch = false;
          errors.push({
            walletId: wallet.walletId,
            type: 'balance_mismatch',
            message: `Local: ${result.localBalance}, On-chain: ${result.onChainBalance}, Diff: ${result.discrepancy}`
          });
          console.log(`  ❌ ${wallet.walletId}: MISMATCH - Local $${Number(result.localBalance) / 1e6} vs Chain $${Number(result.onChainBalance) / 1e6}`);
        } else {
          console.log(`  ✓ ${wallet.walletId}: $${Number(result.localBalance) / 1e6} (${result.localUtxoCount} UTXOs)`);
        }
      } catch (error) {
        allMatch = false;
        errors.push({
          walletId: wallet.walletId,
          type: 'verification_error',
          message: error.message
        });
        console.log(`  ⚠ ${wallet.walletId}: ERROR - ${error.message}`);
      }
    }

    return { allMatch, results, errors };
  }

  /**
   * Generate a balance verification report
   */
  generateBalanceReport(verificationResult) {
    const { allMatch, results, errors } = verificationResult;

    const lines = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║               BALANCE VERIFICATION REPORT                    ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '',
      `  Status: ${allMatch ? '✓ ALL BALANCES MATCH' : '❌ MISMATCHES FOUND'}`,
      '',
      '  Wallet Balances:',
    ];

    for (const result of results) {
      const localUSDC = (Number(result.localBalance) / 1e6).toFixed(6);
      const chainUSDC = (Number(result.onChainBalance) / 1e6).toFixed(6);
      const status = result.matches ? '✓' : '❌';

      lines.push(`    ${status} ${result.walletId}:`);
      lines.push(`        Local:    $${localUSDC} (${result.localUtxoCount} UTXOs)`);
      lines.push(`        On-chain: $${chainUSDC} (${result.onChainUtxoCount} UTXOs)`);

      if (!result.matches) {
        const diffUSDC = (Number(result.discrepancy) / 1e6).toFixed(6);
        lines.push(`        Diff:     $${diffUSDC}`);
      }
    }

    if (errors.length > 0) {
      lines.push('');
      lines.push('  Errors:');
      for (const error of errors) {
        lines.push(`    - ${error.walletId}: ${error.type} - ${error.message}`);
      }
    }

    lines.push('');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');

    return lines.join('\n');
  }
}
