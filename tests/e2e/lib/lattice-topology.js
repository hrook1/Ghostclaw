/**
 * Lattice Topology - Define wallet-to-wallet transaction relationships
 *
 * Supports various patterns:
 * - Chain: A→B→C→D (sequential dependencies)
 * - Fan-out: A→B, A→C, A→D (one source, multiple recipients)
 * - Fan-in: B→A, C→A, D→A (multiple sources, one recipient)
 * - Diamond: A→B, A→C, B→D, C→D (DAG pattern)
 * - Mesh: All-to-all interactions
 */

/**
 * Edge status enum
 */
export const EdgeStatus = {
  PENDING: 'pending',      // Not yet started
  PROVING: 'proving',      // Proof generation in progress
  SUBMITTED: 'submitted',  // Submitted to relayer
  CONFIRMED: 'confirmed',  // Transaction confirmed on-chain
  FAILED: 'failed'         // Failed at any stage
};

/**
 * LatticeTopology - Manages directed graph of wallet transactions
 */
export class LatticeTopology {
  constructor(wallets) {
    this.wallets = wallets;
    this.walletMap = new Map(wallets.map(w => [w.walletId, w]));
    this.edges = [];
    this.edgeCounter = 0;
  }

  /**
   * Add a directed edge (transaction) between wallets
   *
   * @param {string} fromId - Source wallet ID
   * @param {string} toId - Destination wallet ID
   * @param {number} amount - Amount to transfer (in wei/smallest unit)
   * @param {Array<number>} dependsOn - Edge IDs that must complete first
   * @returns {number} - Edge ID
   */
  addEdge(fromId, toId, amount, dependsOn = []) {
    const edge = {
      id: this.edgeCounter++,
      from: fromId,
      to: toId,
      amount,
      dependsOn,
      status: EdgeStatus.PENDING,

      // Filled during execution
      jobId: null,
      queuePosition: null,
      proofResult: null,
      txHash: null,
      txData: null,
      error: null,

      // Timing
      startTime: null,
      proofCompleteTime: null,
      endTime: null
    };

    this.edges.push(edge);
    return edge.id;
  }

  /**
   * Get edges that are ready to start (all dependencies satisfied)
   */
  getReadyEdges() {
    const confirmedIds = new Set(
      this.edges
        .filter(e => e.status === EdgeStatus.CONFIRMED)
        .map(e => e.id)
    );

    return this.edges.filter(e =>
      e.status === EdgeStatus.PENDING &&
      e.dependsOn.every(depId => confirmedIds.has(depId))
    );
  }

  /**
   * Get edges currently in progress (proving or submitted)
   */
  getInProgressEdges() {
    return this.edges.filter(e =>
      e.status === EdgeStatus.PROVING ||
      e.status === EdgeStatus.SUBMITTED
    );
  }

  /**
   * Get all pending edges (not yet started)
   */
  getPendingEdges() {
    return this.edges.filter(e => e.status === EdgeStatus.PENDING);
  }

  /**
   * Get completed edges (confirmed or failed)
   */
  getCompletedEdges() {
    return this.edges.filter(e =>
      e.status === EdgeStatus.CONFIRMED ||
      e.status === EdgeStatus.FAILED
    );
  }

  /**
   * Check if all edges are complete
   */
  isComplete() {
    return this.edges.every(e =>
      e.status === EdgeStatus.CONFIRMED ||
      e.status === EdgeStatus.FAILED
    );
  }

  /**
   * Get edge by ID
   */
  getEdge(id) {
    return this.edges.find(e => e.id === id);
  }

  /**
   * Get wallet by ID
   */
  getWallet(id) {
    return this.walletMap.get(id);
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const byStatus = {};
    for (const edge of this.edges) {
      byStatus[edge.status] = (byStatus[edge.status] || 0) + 1;
    }

    const proofTimes = this.edges
      .filter(e => e.proofCompleteTime && e.startTime)
      .map(e => e.proofCompleteTime - e.startTime);

    const totalTimes = this.edges
      .filter(e => e.endTime && e.startTime)
      .map(e => e.endTime - e.startTime);

    return {
      totalEdges: this.edges.length,
      byStatus,
      proofTimes: {
        count: proofTimes.length,
        avg: proofTimes.length ? proofTimes.reduce((a, b) => a + b, 0) / proofTimes.length : 0,
        min: proofTimes.length ? Math.min(...proofTimes) : 0,
        max: proofTimes.length ? Math.max(...proofTimes) : 0
      },
      totalTimes: {
        count: totalTimes.length,
        avg: totalTimes.length ? totalTimes.reduce((a, b) => a + b, 0) / totalTimes.length : 0
      }
    };
  }

  /**
   * Print topology as ASCII art
   */
  toString() {
    const lines = ['Topology:'];
    for (const edge of this.edges) {
      const deps = edge.dependsOn.length > 0 ? ` (after ${edge.dependsOn.join(',')})` : '';
      const status = `[${edge.status}]`;
      lines.push(`  ${edge.id}: ${edge.from} → ${edge.to} (${edge.amount})${deps} ${status}`);
    }
    return lines.join('\n');
  }
}

/**
 * Create a chain topology: A→B→C→D
 * Each transaction depends on the previous one
 *
 * @param {Array} wallets - Array of wallets (first sends to second, etc.)
 * @param {number} amountPerTx - Amount for each transaction
 * @returns {LatticeTopology}
 */
export function createChainTopology(wallets, amountPerTx) {
  const topology = new LatticeTopology(wallets);
  let prevEdgeId = null;

  for (let i = 0; i < wallets.length - 1; i++) {
    const edgeId = topology.addEdge(
      wallets[i].walletId,
      wallets[i + 1].walletId,
      amountPerTx,
      prevEdgeId !== null ? [prevEdgeId] : []
    );
    prevEdgeId = edgeId;
  }

  return topology;
}

/**
 * Create a fan-out topology: One source to many destinations (parallel)
 *
 * @param {Object} sourceWallet - Source wallet
 * @param {Array} destWallets - Array of destination wallets
 * @param {number} amountPerTx - Amount for each transaction
 * @returns {LatticeTopology}
 */
export function createFanOutTopology(sourceWallet, destWallets, amountPerTx) {
  const topology = new LatticeTopology([sourceWallet, ...destWallets]);

  for (const dest of destWallets) {
    topology.addEdge(sourceWallet.walletId, dest.walletId, amountPerTx);
  }

  return topology;
}

/**
 * Create a fan-in topology: Many sources to one destination (parallel)
 *
 * @param {Array} sourceWallets - Array of source wallets
 * @param {Object} destWallet - Destination wallet
 * @param {number} amountPerTx - Amount for each transaction
 * @returns {LatticeTopology}
 */
export function createFanInTopology(sourceWallets, destWallet, amountPerTx) {
  const topology = new LatticeTopology([...sourceWallets, destWallet]);

  for (const source of sourceWallets) {
    topology.addEdge(source.walletId, destWallet.walletId, amountPerTx);
  }

  return topology;
}

/**
 * Create a diamond topology: A→B, A→C, B→D, C→D
 *
 *      A
 *     / \
 *    B   C
 *     \ /
 *      D
 *
 * @param {Array} wallets - At least 4 wallets [A, B, C, D]
 * @param {Object} amounts - Amount configuration {ab, ac, bd, cd}
 * @returns {LatticeTopology}
 */
export function createDiamondTopology(wallets, amounts = {}) {
  if (wallets.length < 4) {
    throw new Error('Diamond topology requires at least 4 wallets');
  }

  const [A, B, C, D] = wallets;
  const topology = new LatticeTopology(wallets.slice(0, 4));

  // First layer (parallel)
  const abEdge = topology.addEdge(A.walletId, B.walletId, amounts.ab || 100000);
  const acEdge = topology.addEdge(A.walletId, C.walletId, amounts.ac || 100000);

  // Second layer (depends on first)
  topology.addEdge(B.walletId, D.walletId, amounts.bd || 50000, [abEdge]);
  topology.addEdge(C.walletId, D.walletId, amounts.cd || 50000, [acEdge]);

  return topology;
}

/**
 * Create a mesh topology: Every wallet sends to every other wallet
 * Warning: O(n^2) edges, use with caution!
 *
 * @param {Array} wallets - Array of wallets
 * @param {number} amountPerTx - Amount for each transaction
 * @returns {LatticeTopology}
 */
export function createMeshTopology(wallets, amountPerTx) {
  const topology = new LatticeTopology(wallets);

  for (const from of wallets) {
    for (const to of wallets) {
      if (from.walletId !== to.walletId) {
        topology.addEdge(from.walletId, to.walletId, amountPerTx);
      }
    }
  }

  return topology;
}

/**
 * Create a custom topology from edge specifications
 *
 * @param {Array} wallets - Array of wallets
 * @param {Array} edgeSpecs - Edge specifications [{from, to, amount, dependsOn?}]
 * @returns {LatticeTopology}
 */
export function createCustomTopology(wallets, edgeSpecs) {
  const topology = new LatticeTopology(wallets);
  const edgeIdMap = new Map(); // edgeName -> edgeId for dependency resolution

  for (const spec of edgeSpecs) {
    const dependsOn = (spec.dependsOn || []).map(name => {
      if (!edgeIdMap.has(name)) {
        throw new Error(`Dependency "${name}" not found`);
      }
      return edgeIdMap.get(name);
    });

    const edgeId = topology.addEdge(spec.from, spec.to, spec.amount, dependsOn);

    if (spec.name) {
      edgeIdMap.set(spec.name, edgeId);
    }
  }

  return topology;
}
