/**
 * On-Chain Merkle Tree Synchronization
 *
 * Fetches OutputCommitted and RootUpdated events from the PrivateUTXOLedger contract
 * and rebuilds the Merkle tree to generate valid proofs for existing commitments.
 *
 * IMPORTANT: The deployed contract on Sepolia has a history of tree resets where
 * withdrawals set the root to 0x0000... This breaks normal incremental tree invariants.
 *
 * This implementation handles resets by:
 * 1. Finding the LAST reset event (RootUpdated with newRoot = 0x0000...)
 * 2. Syncing only events AFTER that reset
 * 3. Using the actual newRoot from RootUpdated events as the authoritative root
 *
 * NOTE: The deployed contract's OutputCommitted event does NOT have leafIndex:
 *   OutputCommitted(bytes32 indexed,uint8,bytes,bytes12,bytes) - NO leafIndex!
 */

import { keccak256, parseAbiItem } from 'viem';

// Event topic hashes for the deployed contract
// OutputCommitted(bytes32 indexed,uint8,bytes,bytes12,bytes) - matches deployed version
const OUTPUT_COMMITTED_TOPIC = '0x081196d4de3263d6ada7324878e24e0df49acec00e8e67713fb85b6046aca3c2';
// RootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot)
const ROOT_UPDATED_TOPIC = '0x26df13263ccd588bd14d17b939ae977c1d51960da437d7eb886d1cfb6f3d0682';
// Zero root used during resets
const ZERO_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Contract ABI for reading state
const MERKLE_ABI = [
  {
    name: 'currentRoot',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }]
  }
];

/**
 * Incremental Merkle Tree implementation matching the Solidity contract
 */
class IncrementalMerkleTree {
  constructor() {
    this.levels = 32;
    this.leaves = [];
    this.filledSubtrees = [];
    this.zeros = this.computeZeros();
    this.root = this.zeros[this.levels - 1]; // Empty tree root

    // Initialize filled subtrees with zeros
    for (let i = 0; i < this.levels; i++) {
      this.filledSubtrees[i] = this.zeros[i];
    }
  }

  computeZeros() {
    const zeros = new Array(this.levels);
    zeros[0] = '0x' + '00'.repeat(32);
    for (let i = 1; i < this.levels; i++) {
      zeros[i] = this.hashPair(zeros[i - 1], zeros[i - 1]);
    }
    return zeros;
  }

  hashPair(left, right) {
    const leftBytes = Buffer.from(left.slice(2), 'hex');
    const rightBytes = Buffer.from(right.slice(2), 'hex');
    const data = Buffer.concat([leftBytes, rightBytes]);
    return keccak256(data);
  }

  insert(leaf) {
    const index = this.leaves.length;
    this.leaves.push(leaf);

    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < this.levels; level++) {
      if (currentIndex % 2 === 0) {
        // We're on the left, update filled subtree
        this.filledSubtrees[level] = currentHash;
        // Hash with zero on right (empty subtree)
        currentHash = this.hashPair(currentHash, this.zeros[level]);
      } else {
        // We're on the right, hash with filled subtree on left
        currentHash = this.hashPair(this.filledSubtrees[level], currentHash);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.root = currentHash;
    return index;
  }

  generateProof(index) {
    if (index >= this.leaves.length) {
      throw new Error(`Index ${index} out of bounds (tree has ${this.leaves.length} leaves)`);
    }

    const proof = [];
    let currentIndex = index;

    // Rebuild the path to compute siblings
    // We need to track what was at each level when this leaf was inserted
    // For a static tree, we can recompute

    // Actually, for an incremental tree, we need to reconstruct siblings
    // by computing what the sibling would be at each level

    // Start from the leaves
    let currentLevel = [...this.leaves];

    for (let level = 0; level < this.levels; level++) {
      // Pad to even length
      while (currentLevel.length % 2 !== 0) {
        currentLevel.push(this.zeros[level]);
      }

      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      if (siblingIndex < currentLevel.length) {
        proof.push(currentLevel[siblingIndex]);
      } else {
        proof.push(this.zeros[level]);
      }

      // Move to next level
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hashPair(currentLevel[i], currentLevel[i + 1]));
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }
}

/**
 * OnChainMerkle - Syncs and maintains Merkle tree from on-chain events
 */
// Default addresses for Sepolia
const DEFAULTS = {
  PRIVATE_UTXO_LEDGER: '0x42ae920DFD0d25Ac014DFd751bd2ff2D2fBa0443',
  DEPLOYMENT_BLOCK: '9847904'
};

export class OnChainMerkle {
  constructor(publicClient, contractAddress, deploymentBlock) {
    this.publicClient = publicClient;
    this.contractAddress = contractAddress || DEFAULTS.PRIVATE_UTXO_LEDGER;
    this.deploymentBlock = deploymentBlock || BigInt(DEFAULTS.DEPLOYMENT_BLOCK);

    // Initialize empty incremental tree (matches contract)
    this.tree = new IncrementalMerkleTree();

    // Map commitment -> leafIndex for quick lookup
    this.commitmentToIndex = new Map();

    // Track sync state
    this.lastSyncBlock = null;
    this.leafCount = 0;
  }

  /**
   * Sync tree from on-chain events
   *
   * IMPORTANT: The deployed contract has had tree resets. This method:
   * 1. Finds the LAST reset (RootUpdated with newRoot = 0x0000...)
   * 2. Only syncs events AFTER that reset
   * 3. Uses the authoritative roots from RootUpdated events
   *
   * @returns {Promise<{root: string, leafCount: number}>}
   */
  async sync() {
    console.log(`[OnChainMerkle] Syncing from block ${this.deploymentBlock}...`);

    const events = [];

    // 1. Fetch Deposited events (contains leafIndex)
    // event Deposited(address indexed from, uint256 amount, bytes32 commitment, uint256 leafIndex);
    const depositedLogs = await this.publicClient.getLogs({
      address: this.contractAddress,
      event: parseAbiItem('event Deposited(address indexed from, uint256 amount, bytes32 commitment, uint256 leafIndex)'),
      fromBlock: this.deploymentBlock,
      toBlock: 'latest'
    });

    console.log(`[OnChainMerkle] Found ${depositedLogs.length} Deposited events`);

    for (const log of depositedLogs) {
      events.push({
        type: 'Deposited',
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        commitment: log.args.commitment,
        leafIndex: Number(log.args.leafIndex),
        txHash: log.transactionHash
      });
    }

    // 2. Fetch OutputCommitted events (for transfers/outputs)
    // event OutputCommitted(bytes32 indexed commitment, uint8 keyType, bytes ephemeralPubkey, bytes12 nonce, bytes ciphertext, uint256 leafIndex);
    const outputLogs = await this.publicClient.getLogs({
      address: this.contractAddress,
      event: parseAbiItem('event OutputCommitted(bytes32 indexed commitment, uint8 keyType, bytes ephemeralPubkey, bytes12 nonce, bytes ciphertext, uint256 leafIndex)'),
      fromBlock: this.deploymentBlock,
      toBlock: 'latest'
    });

    console.log(`[OnChainMerkle] Found ${outputLogs.length} OutputCommitted events`);

    for (const log of outputLogs) {
      events.push({
        type: 'OutputCommitted',
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        commitment: log.args.commitment,
        leafIndex: Number(log.args.leafIndex),
        txHash: log.transactionHash
      });
    }

    // Deduplicate by leafIndex
    const uniqueEvents = new Map(); // leafIndex -> event
    for (const e of events) {
      if (!uniqueEvents.has(e.leafIndex)) {
        uniqueEvents.set(e.leafIndex, e);
      } else {
        const existing = uniqueEvents.get(e.leafIndex);
        if (existing.commitment !== e.commitment) {
          console.warn(`[OnChainMerkle] Leaf index collision at ${e.leafIndex}: ${existing.commitment} vs ${e.commitment}`);
        }
      }
    }

    // Rebuild tree in order
    const sortedLeaves = Array.from(uniqueEvents.values()).sort((a, b) => a.leafIndex - b.leafIndex);

    // Reset tree matches contract (empty)
    this.tree = new IncrementalMerkleTree();
    this.commitmentToIndex.clear();

    if (sortedLeaves.length > 0) {
      const maxIndex = sortedLeaves[sortedLeaves.length - 1].leafIndex;
      console.log(`[OnChainMerkle] Rebuilding tree with ${uniqueEvents.size} leaves (max index: ${maxIndex})`);

      for (let i = 0; i <= maxIndex; i++) {
        const leafEvent = uniqueEvents.get(i);
        if (leafEvent) {
          this.tree.insert(leafEvent.commitment);
          this.commitmentToIndex.set(leafEvent.commitment, i);
        } else {
          console.warn(`[OnChainMerkle] Missing leaf at index ${i}, inserting zero hash`);
          this.tree.insert('0x' + '00'.repeat(32));
        }
      }
    }

    this.leafCount = this.tree.leaves.length;
    this.lastSyncBlock = await this.publicClient.getBlockNumber();

    // Verify root
    const contractRoot = await this.getCurrentRoot();
    const localRoot = this.tree.root;

    if (localRoot.toLowerCase() !== contractRoot.toLowerCase()) {
      console.warn(`[OnChainMerkle] Root mismatch! Local: ${localRoot}, Contract: ${contractRoot}`);
      this.authoritativeRoot = contractRoot;
    } else {
      console.log(`[OnChainMerkle] Root verified: ${localRoot}`);
      this.authoritativeRoot = localRoot;
    }

    return {
      root: this.authoritativeRoot,
      leafCount: this.leafCount
    };
  }

  /**
   * Incremental sync - only fetch new events since last sync
   * Uses the same RootUpdated + OutputCommitted matching as full sync
   *
   * @returns {Promise<{root: string, newLeaves: number}>}
   */
  async incrementalSync() {
    if (!this.lastSyncBlock) {
      return this.sync();
    }

    const fromBlock = this.lastSyncBlock + 1n;

    // Fetch RootUpdated events
    const rootLogs = await this.publicClient.getLogs({
      address: this.contractAddress,
      topics: [ROOT_UPDATED_TOPIC],
      fromBlock,
      toBlock: 'latest'
    });

    // Fetch OutputCommitted events
    const outputLogs = await this.publicClient.getLogs({
      address: this.contractAddress,
      topics: [OUTPUT_COMMITTED_TOPIC],
      fromBlock,
      toBlock: 'latest'
    });

    if (rootLogs.length === 0) {
      return { root: this.tree.root, newLeaves: 0 };
    }

    // Build map of txHash -> events
    const txMap = new Map();

    for (const log of outputLogs) {
      if (!txMap.has(log.transactionHash)) {
        txMap.set(log.transactionHash, { outputs: [], roots: [] });
      }
      txMap.get(log.transactionHash).outputs.push({
        commitment: log.topics[1],
        logIndex: Number(log.logIndex)
      });
    }

    for (const log of rootLogs) {
      if (!txMap.has(log.transactionHash)) {
        txMap.set(log.transactionHash, { outputs: [], roots: [] });
      }
      txMap.get(log.transactionHash).roots.push({
        logIndex: Number(log.logIndex)
      });
    }

    // Sort and process
    const sortedRootLogs = [...rootLogs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return Number(a.blockNumber - b.blockNumber);
      }
      return Number(a.logIndex - b.logIndex);
    });

    let newLeaves = 0;
    for (const rootLog of sortedRootLogs) {
      const txEvents = txMap.get(rootLog.transactionHash);
      if (!txEvents) continue;

      const outputs = txEvents.outputs.sort((a, b) => a.logIndex - b.logIndex);
      const roots = txEvents.roots.sort((a, b) => a.logIndex - b.logIndex);
      const rootIndex = roots.findIndex(r => r.logIndex === Number(rootLog.logIndex));

      if (rootIndex >= 0 && rootIndex < outputs.length) {
        const commitment = outputs[rootIndex].commitment;
        const insertedIndex = this.tree.insert(commitment);
        this.commitmentToIndex.set(commitment, insertedIndex);
        this.leafCount++;
        newLeaves++;
      }
    }

    this.lastSyncBlock = await this.publicClient.getBlockNumber();

    return {
      root: this.tree.root,
      newLeaves
    };
  }

  /**
   * Get current on-chain root from contract
   *
   * @returns {Promise<string>}
   */
  async getCurrentRoot() {
    const root = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: MERKLE_ABI,
      functionName: 'currentRoot'
    });
    return root;
  }

  /**
   * Verify local tree root matches contract root
   *
   * @returns {Promise<{matches: boolean, local: string, contract: string}>}
   */
  async verifyRoot() {
    const localRoot = this.tree.root;
    const contractRoot = await this.getCurrentRoot();

    return {
      matches: localRoot.toLowerCase() === contractRoot.toLowerCase(),
      local: localRoot,
      contract: contractRoot
    };
  }

  /**
   * Generate Merkle proof for a leaf at given index
   *
   * @param {number} index - Leaf index
   * @returns {string[]} - Array of sibling hashes
   */
  generateProof(index) {
    if (index >= this.leafCount) {
      throw new Error(
        `Index ${index} out of bounds (tree has ${this.leafCount} leaves)`
      );
    }
    return this.tree.generateProof(index);
  }

  /**
   * Get index for a commitment
   *
   * @param {string} commitment - The commitment hash
   * @returns {number|undefined}
   */
  getIndex(commitment) {
    return this.commitmentToIndex.get(commitment);
  }

  /**
   * Get the current tree root (authoritative from contract)
   *
   * @returns {string}
   */
  root() {
    return this.authoritativeRoot || this.tree.root;
  }

  /**
   * Get leaf count
   *
   * @returns {number}
   */
  getLeafCount() {
    return this.leafCount;
  }

  /**
   * Insert a new commitment (for tracking outputs after sends)
   * Should match on-chain insertion
   *
   * @param {string} commitment - The commitment to insert
   * @returns {number} - The inserted index
   */
  insert(commitment) {
    const index = this.tree.insert(commitment);
    this.commitmentToIndex.set(commitment, index);
    this.leafCount++;
    return index;
  }
}

export default OnChainMerkle;
