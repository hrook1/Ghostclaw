/**
 * Metrics Collector - Track and report performance metrics during lattice tests
 */

export class MetricsCollector {
  constructor() {
    this.proofSubmissions = [];
    this.proofCompletions = [];
    this.txConfirmations = [];
    this.errors = [];
    this.queueSnapshots = [];
    this.startTime = Date.now();
  }

  /**
   * Record a proof submission event
   */
  recordProofSubmission(edgeId, jobId, queuePosition) {
    this.proofSubmissions.push({
      edgeId,
      jobId,
      queuePosition,
      timestamp: Date.now()
    });
  }

  /**
   * Record a proof completion event
   */
  recordProofComplete(edgeId, durationMs) {
    this.proofCompletions.push({
      edgeId,
      durationMs,
      timestamp: Date.now()
    });
  }

  /**
   * Record a transaction confirmation event
   */
  recordTxConfirmed(edgeId, totalDurationMs, txHash) {
    this.txConfirmations.push({
      edgeId,
      totalDurationMs,
      txHash,
      timestamp: Date.now()
    });
  }

  /**
   * Record an error event
   */
  recordError(type, error, edgeId = null) {
    this.errors.push({
      type,
      message: error.message || String(error),
      edgeId,
      timestamp: Date.now()
    });
  }

  /**
   * Record a queue status snapshot
   */
  recordQueueSnapshot(status) {
    this.queueSnapshots.push({
      ...status,
      timestamp: Date.now()
    });
  }

  /**
   * Calculate percentile value from sorted array
   */
  percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(arr.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Group errors by type
   */
  groupErrorsByType() {
    const groups = {};
    for (const e of this.errors) {
      groups[e.type] = (groups[e.type] || 0) + 1;
    }
    return groups;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const proofTimes = this.proofCompletions.map(p => p.durationMs);
    const txTimes = this.txConfirmations.map(t => t.totalDurationMs);

    return {
      totalDuration: Date.now() - this.startTime,

      proofs: {
        submitted: this.proofSubmissions.length,
        completed: this.proofCompletions.length,
        avgTime: proofTimes.length ? proofTimes.reduce((a, b) => a + b, 0) / proofTimes.length : 0,
        minTime: proofTimes.length ? Math.min(...proofTimes) : 0,
        maxTime: proofTimes.length ? Math.max(...proofTimes) : 0,
        p50: this.percentile(proofTimes, 50),
        p95: this.percentile(proofTimes, 95),
        p99: this.percentile(proofTimes, 99)
      },

      transactions: {
        confirmed: this.txConfirmations.length,
        avgTime: txTimes.length ? txTimes.reduce((a, b) => a + b, 0) / txTimes.length : 0,
        minTime: txTimes.length ? Math.min(...txTimes) : 0,
        maxTime: txTimes.length ? Math.max(...txTimes) : 0
      },

      errors: {
        count: this.errors.length,
        byType: this.groupErrorsByType()
      },

      queue: {
        snapshots: this.queueSnapshots.length,
        maxDepth: Math.max(...this.queueSnapshots.map(s => s.queuedJobs || 0), 0),
        maxActive: Math.max(...this.queueSnapshots.map(s => s.activeJobs || 0), 0),
        avgDepth: this.queueSnapshots.length
          ? this.queueSnapshots.reduce((a, s) => a + (s.queuedJobs || 0), 0) / this.queueSnapshots.length
          : 0
      }
    };
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  /**
   * Generate detailed text report
   */
  generateReport() {
    const s = this.getSummary();

    const lines = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║             LATTICE TEST METRICS REPORT                      ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '',
      `  Total Duration: ${this.formatDuration(s.totalDuration)}`,
      '',
      '  ┌─────────────────────────────────────────────────────────┐',
      '  │ PROOF GENERATION                                        │',
      '  ├─────────────────────────────────────────────────────────┤',
      `  │  Submitted:  ${s.proofs.submitted.toString().padStart(6)}                                   │`,
      `  │  Completed:  ${s.proofs.completed.toString().padStart(6)}                                   │`,
      `  │  Avg Time:   ${this.formatDuration(s.proofs.avgTime).padStart(6)}                                   │`,
      `  │  Min Time:   ${this.formatDuration(s.proofs.minTime).padStart(6)}                                   │`,
      `  │  Max Time:   ${this.formatDuration(s.proofs.maxTime).padStart(6)}                                   │`,
      `  │  P50:        ${this.formatDuration(s.proofs.p50).padStart(6)}                                   │`,
      `  │  P95:        ${this.formatDuration(s.proofs.p95).padStart(6)}                                   │`,
      `  │  P99:        ${this.formatDuration(s.proofs.p99).padStart(6)}                                   │`,
      '  └─────────────────────────────────────────────────────────┘',
      '',
      '  ┌─────────────────────────────────────────────────────────┐',
      '  │ TRANSACTIONS                                            │',
      '  ├─────────────────────────────────────────────────────────┤',
      `  │  Confirmed:  ${s.transactions.confirmed.toString().padStart(6)}                                   │`,
      `  │  Avg Time:   ${this.formatDuration(s.transactions.avgTime).padStart(6)}                                   │`,
      `  │  Min Time:   ${this.formatDuration(s.transactions.minTime).padStart(6)}                                   │`,
      `  │  Max Time:   ${this.formatDuration(s.transactions.maxTime).padStart(6)}                                   │`,
      '  └─────────────────────────────────────────────────────────┘',
      '',
      '  ┌─────────────────────────────────────────────────────────┐',
      '  │ QUEUE STATISTICS                                        │',
      '  ├─────────────────────────────────────────────────────────┤',
      `  │  Snapshots:  ${s.queue.snapshots.toString().padStart(6)}                                   │`,
      `  │  Max Depth:  ${s.queue.maxDepth.toString().padStart(6)}                                   │`,
      `  │  Max Active: ${s.queue.maxActive.toString().padStart(6)}                                   │`,
      `  │  Avg Depth:  ${s.queue.avgDepth.toFixed(1).padStart(6)}                                   │`,
      '  └─────────────────────────────────────────────────────────┘',
      '',
      '  ┌─────────────────────────────────────────────────────────┐',
      '  │ ERRORS                                                  │',
      '  ├─────────────────────────────────────────────────────────┤',
      `  │  Total:      ${s.errors.count.toString().padStart(6)}                                   │`,
    ];

    // Add error breakdown
    for (const [type, count] of Object.entries(s.errors.byType)) {
      lines.push(`  │    ${type}: ${count}`.padEnd(61) + '│');
    }

    lines.push('  └─────────────────────────────────────────────────────────┘');
    lines.push('');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate JSON summary for programmatic use
   */
  toJSON() {
    return {
      summary: this.getSummary(),
      proofSubmissions: this.proofSubmissions,
      proofCompletions: this.proofCompletions,
      txConfirmations: this.txConfirmations,
      errors: this.errors,
      queueSnapshots: this.queueSnapshots
    };
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.proofSubmissions = [];
    this.proofCompletions = [];
    this.txConfirmations = [];
    this.errors = [];
    this.queueSnapshots = [];
    this.startTime = Date.now();
  }
}
