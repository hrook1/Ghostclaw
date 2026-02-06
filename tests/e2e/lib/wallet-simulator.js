/**
 * Simulated Wallet for API-level testing
 * Replicates the exact cryptographic operations from wallet-ui/lib/blockchain/crypto.ts
 */

import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { keccak256 } from 'viem';

// Configure HMAC for secp256k1 (required for synchronous signing)
secp256k1.etc.hmacSha256Sync = (k, ...msgs) => {
  const data = secp256k1.etc.concatBytes(...msgs);
  return hmac(sha256, k, data);
};

/**
 * SimulatedWallet - Encapsulates wallet operations for testing
 * All crypto operations match the Rust prover implementation exactly
 */
export class SimulatedWallet {
  constructor(walletId, seed) {
    this.walletId = walletId;
    this.seed = seed;

    // Derive deterministic keys from seed (matches crypto.ts:deriveKeys)
    const domain = 'utxo-prototype-v1-key-derivation:';
    this.privateKey = sha256(new TextEncoder().encode(domain + seed));
    this.publicKey = secp256k1.getPublicKey(this.privateKey, true); // Compressed
    this.address = '0x' + Buffer.from(this.publicKey).toString('hex');
    this.ownerX = this.address.slice(4); // X-coordinate only (skip 0x and 02/03 prefix)

    // Track owned UTXOs
    this.utxos = [];
    this.pendingOps = new Map(); // jobId -> operation details

    // Metrics
    this.metrics = {
      proofsGenerated: 0,
      proofTotalTime: 0,
      txSubmitted: 0,
      txConfirmed: 0,
      errors: []
    };
  }

  /**
   * Compute note commitment using Blake3
   * MUST match crypto.ts:computeCommitment (lines 89-121)
   *
   * Format: Blake3(domain | amount_le(8) | ownerX(32) | blinding(32))
   * Domain separator: "NOTE_COMMITMENT_v1"
   */
  computeCommitment(amount, ownerX, blinding) {
    // Clean inputs
    const ownerXClean = ownerX.startsWith('0x') ? ownerX.slice(2) : ownerX;
    const blindingClean = blinding.startsWith('0x') ? blinding.slice(2) : blinding;

    // Domain separator (matches Rust: b"NOTE_COMMITMENT_v1")
    const domain = new TextEncoder().encode('NOTE_COMMITMENT_v1');

    // Amount as 8-byte little-endian (matches Rust u64.to_le_bytes())
    const amountLE = new Uint8Array(8);
    let amt = BigInt(amount);
    for (let i = 0; i < 8; i++) {
      amountLE[i] = Number(amt & 0xffn);
      amt >>= 8n;
    }

    // Owner X-coord (32 bytes, left-padded with zeros)
    const ownerBytes = Buffer.from(ownerXClean.padStart(64, '0'), 'hex');

    // Blinding (32 bytes)
    const blindingBytes = Buffer.from(blindingClean.padStart(64, '0'), 'hex');

    // Concatenate: domain + amount(8 LE) + owner(32) + blinding(32)
    const data = new Uint8Array(domain.length + 8 + 32 + 32);
    data.set(domain, 0);
    data.set(amountLE, domain.length);
    data.set(ownerBytes, domain.length + 8);
    data.set(blindingBytes, domain.length + 8 + 32);

    // Blake3 hash (matches Rust prover)
    return '0x' + Buffer.from(blake3(data)).toString('hex');
  }

  /**
   * Compute nullifier from signature
   * MUST match crypto.ts:computeNullifier (lines 61-77)
   *
   * Format: Blake3(domain | signature(65))
   * Domain separator: "NULLIFIER_v1"
   */
  computeNullifier(signature) {
    // Domain separator (matches Rust: b"NULLIFIER_v1")
    const domain = new TextEncoder().encode('NULLIFIER_v1');

    // Clean signature
    const sigClean = signature.startsWith('0x') ? signature.slice(2) : signature;
    const sigBytes = Buffer.from(sigClean, 'hex');

    if (sigBytes.length !== 65) {
      throw new Error(`Invalid signature length: ${sigBytes.length}, expected 65`);
    }

    // Concatenate: domain + signature
    const data = new Uint8Array(domain.length + sigBytes.length);
    data.set(domain);
    data.set(sigBytes, domain.length);

    // Blake3 hash (matches Rust prover)
    return '0x' + Buffer.from(blake3(data)).toString('hex');
  }

  /**
   * Sign a commitment for nullifier/tx signatures
   * MUST match crypto.ts:signCommitment (lines 541-582)
   *
   * Uses Ethereum-style signing:
   * 1. Keccak256(commitment)
   * 2. "\x19Ethereum Signed Message:\n32" + hash
   * 3. Keccak256(prefixed)
   * 4. ECDSA sign
   */
  async signCommitment(commitment) {
    // 1. Hash the commitment (Keccak256)
    const commitBytes = Buffer.from(
      commitment.startsWith('0x') ? commitment.slice(2) : commitment,
      'hex'
    );
    const msgHash = keccak256(commitBytes); // Returns 0x hex string

    // 2. Ethereum Signed Message hashing
    const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
    const msgHashBytes = Buffer.from(msgHash.slice(2), 'hex');

    const ethMsg = new Uint8Array(prefix.length + msgHashBytes.length);
    ethMsg.set(prefix);
    ethMsg.set(msgHashBytes, prefix.length);

    const ethMsgHash = keccak256(ethMsg);
    const ethMsgHashBytes = Buffer.from(ethMsgHash.slice(2), 'hex');

    // 3. Sign using secp256k1
    // noble/secp256k1 v2: sign returns Signature object with recovery
    const sig = secp256k1.sign(ethMsgHashBytes, this.privateKey, {
      lowS: true
    });

    // Get recovery ID
    const recoveryBit = sig.recovery;

    // Build 65-byte signature in Ethereum format: r(32) + s(32) + v(1)
    const fullSig = new Uint8Array(65);
    const rBytes = sig.r.toString(16).padStart(64, '0');
    const sBytes = sig.s.toString(16).padStart(64, '0');

    for (let i = 0; i < 32; i++) {
      fullSig[i] = parseInt(rBytes.slice(i * 2, i * 2 + 2), 16);
      fullSig[32 + i] = parseInt(sBytes.slice(i * 2, i * 2 + 2), 16);
    }
    fullSig[64] = recoveryBit + 27; // v = 27 + recovery_id

    return '0x' + Buffer.from(fullSig).toString('hex');
  }

  /**
   * Generate a random 32-byte blinding factor
   */
  generateBlinding() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return '0x' + Buffer.from(bytes).toString('hex');
  }

  /**
   * Encrypt a note using ECIES (ECDH + AES-256-GCM)
   * Matches send.ts:encryptNote
   */
  async encryptNote(amount, ownerAddress, blinding, recipientPubkey) {
    // Generate ephemeral keypair
    const ephemeralPriv = new Uint8Array(32);
    crypto.getRandomValues(ephemeralPriv);
    const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, true);

    // Ensure recipientPubkey is Uint8Array
    let recipientPubBytes;
    if (typeof recipientPubkey === 'string') {
      const hex = recipientPubkey.startsWith('0x') ? recipientPubkey.slice(2) : recipientPubkey;
      recipientPubBytes = new Uint8Array(Buffer.from(hex, 'hex'));
    } else {
      recipientPubBytes = recipientPubkey;
    }

    // ECDH shared secret
    const sharedSecret = secp256k1.getSharedSecret(ephemeralPriv, recipientPubBytes, true);

    // KDF using HKDF (matches crypto.ts:kdfNew)
    const aesKey = hkdf(sha256, sharedSecret, undefined,
      new TextEncoder().encode('utxo-prototype-v1-encryption'), 32);

    // Build plaintext: amount(32) + owner(32) + blinding(32) = 96 bytes
    const plaintext = new Uint8Array(96);

    // Amount as 32-byte big-endian
    const amountHex = BigInt(amount).toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) {
      plaintext[i] = parseInt(amountHex.slice(i * 2, i * 2 + 2), 16);
    }

    // Owner X-coord (32 bytes) - strip prefix if present
    const ownerClean = ownerAddress.startsWith('0x') ? ownerAddress.slice(2) : ownerAddress;
    const ownerX = ownerClean.length === 66 ? ownerClean.slice(2) : ownerClean; // Skip 02/03 prefix
    const ownerBytes = Buffer.from(ownerX.padStart(64, '0'), 'hex');
    plaintext.set(ownerBytes, 32);

    // Blinding (32 bytes)
    const blindingClean = blinding.startsWith('0x') ? blinding.slice(2) : blinding;
    const blindingBytes = Buffer.from(blindingClean.padStart(64, '0'), 'hex');
    plaintext.set(blindingBytes, 64);

    // Generate nonce for AES-GCM
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);

    // AES-256-GCM encryption
    const cryptoKey = await crypto.subtle.importKey(
      'raw', aesKey, { name: 'AES-GCM' }, false, ['encrypt']
    );
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce }, cryptoKey, plaintext
    );

    return {
      ephemeralPubkey: '0x' + Buffer.from(ephemeralPub).toString('hex'),
      nonce: '0x' + Buffer.from(nonce).toString('hex'),
      ciphertext: '0x' + Buffer.from(new Uint8Array(encrypted)).toString('hex')
    };
  }

  /**
   * Add a UTXO to this wallet's tracked set
   */
  addUTXO(utxo) {
    this.utxos.push({
      ...utxo,
      addedAt: Date.now()
    });
  }

  /**
   * Select UTXOs to cover a given amount (greedy algorithm)
   * Returns selected UTXOs and total value
   */
  selectUTXOs(amount) {
    const amountBigInt = BigInt(amount);
    const selected = [];
    let total = 0n;

    // Sort by amount descending for efficiency
    const sorted = [...this.utxos].sort((a, b) =>
      Number(BigInt(b.amount) - BigInt(a.amount))
    );

    for (const utxo of sorted) {
      if (total >= amountBigInt) break;
      selected.push(utxo);
      total += BigInt(utxo.amount);
    }

    if (total < amountBigInt) {
      throw new Error(`Insufficient balance: have ${total}, need ${amount}`);
    }

    return { selected, total };
  }

  /**
   * Mark UTXOs as spent (remove from tracked set)
   */
  spendUTXOs(utxos) {
    const commitments = new Set(utxos.map(u => u.commitment));
    this.utxos = this.utxos.filter(u => !commitments.has(u.commitment));
  }

  /**
   * Get current balance (sum of all tracked UTXOs)
   */
  getBalance() {
    return this.utxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
  }

  /**
   * Get wallet info for logging
   */
  toString() {
    return `Wallet(${this.walletId}, balance=${this.getBalance()}, utxos=${this.utxos.length})`;
  }
}

/**
 * Create N test wallets with deterministic keys
 * Uses testRunId for reproducibility across test runs
 */
export function createTestWallets(count, testRunId = Date.now().toString()) {
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const seed = `test-wallet-${testRunId}-${i}`;
    wallets.push(new SimulatedWallet(`wallet-${i}`, seed));
  }
  return wallets;
}

/**
 * Create a wallet map from array (walletId -> wallet)
 */
export function createWalletMap(wallets) {
  return new Map(wallets.map(w => [w.walletId, w]));
}

/**
 * Merkle Tree implementation for testing
 * Matches wallet-ui/lib/blockchain/merkle.ts logic
 */
export class MerkleTree {
  constructor() {
    this.leaves = [];
    this.levels = 32;
    this.zeros = this.computeZeros();
  }

  computeZeros() {
    const zeros = new Array(this.levels).fill('0x' + '00'.repeat(32));
    // Level 0 is already 0
    // Subsequent levels are hash(zero, zero)
    for (let i = 1; i < this.levels; i++) {
      zeros[i] = this.hashPair(zeros[i - 1], zeros[i - 1]);
    }
    return zeros;
  }

  hashPair(left, right) {
    // keccak256(abi.encodePacked(left, right))
    // we manually concat bytes
    const leftBytes = Buffer.from(left.slice(2), 'hex');
    const rightBytes = Buffer.from(right.slice(2), 'hex');
    const data = Buffer.concat([leftBytes, rightBytes]);
    return keccak256(data);
  }

  insert(leaf) {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    return index;
  }

  root() {
    if (this.leaves.length === 0) return this.zeros[this.levels - 1];

    let currentLevel = [...this.leaves];
    let levelIndex = 0;

    // Debug logging
    // Debug logging
    // console.log('DEBUG: ZEROS[0]:', this.zeros[0]);
    // console.log('DEBUG: ZEROS[1]:', this.zeros[1]);

    while (currentLevel.length > 1 || levelIndex < this.levels) {
      if (currentLevel.length % 2 !== 0) {
        currentLevel.push(this.zeros[levelIndex]);
      }

      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const h = this.hashPair(currentLevel[i], currentLevel[i + 1]);
        nextLevel.push(h);
        if (this.leaves.length === 1 && levelIndex < 3) {
          // console.log(`DEBUG: L${levelIndex} Pair: ${currentLevel[i]}, ${currentLevel[i + 1]} -> ${h}`);
        }
      }

      currentLevel = nextLevel;
      levelIndex++;

      // console.log(`DEBUG: After L${levelIndex-1}, currentLevel len: ${currentLevel.length}`);
    }

    // console.log('DEBUG: Calculated Root:', currentLevel[0]);
    return currentLevel[0];
  }

  generateProof(index) {
    if (index >= this.leaves.length) throw new Error('Index out of bounds');

    const proof = [];
    let currentIndex = index;
    let currentLevel = [...this.leaves];

    for (let i = 0; i < this.levels; i++) {
      // Ensure even length for pairing
      if (currentLevel.length % 2 !== 0) {
        currentLevel.push(this.zeros[i]);
      }

      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      let sibling = this.zeros[i];
      if (siblingIndex < currentLevel.length) {
        sibling = currentLevel[siblingIndex];
      }

      proof.push(sibling);

      // Move to next level
      const nextLevel = [];
      for (let j = 0; j < currentLevel.length; j += 2) {
        nextLevel.push(this.hashPair(currentLevel[j], currentLevel[j + 1]));
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }
}
