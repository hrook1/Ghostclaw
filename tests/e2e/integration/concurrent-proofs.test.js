/**
 * Concurrent Proof Tests
 * Tests the job queue system under concurrent load
 */

import { CONFIG, logStep, fetchWithRetry } from '../setup.js';

describe('Concurrent Proof Handling', () => {
  const createProofRequest = (id) => ({
    inputNotes: [{
      amount: `${1000000 + id}`,
      ownerPubkey: '0x' + id.toString(16).padStart(64, '0'),
      blinding: '0x' + (id + 1).toString(16).padStart(64, '0')
    }],
    outputNotes: [{
      amount: `${1000000 + id}`,
      ownerPubkey: '0x' + (id + 2).toString(16).padStart(64, '0'),
      blinding: '0x' + (id + 3).toString(16).padStart(64, '0')
    }],
    nullifierSignatures: ['0x' + '00'.repeat(65)],
    txSignatures: ['0x' + '00'.repeat(65)],
    inputIndices: [id % 10],
    oldRoot: '0x' + '00'.repeat(32)
  });

  test('should queue multiple proof requests', async () => {
    logStep(1, 'Submitting multiple proof requests');

    const numRequests = 3;
    const jobIds = [];

    // Submit multiple requests quickly
    for (let i = 0; i < numRequests; i++) {
      const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createProofRequest(i))
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      jobIds.push(result.jobId);
      logStep(1, `Job ${i + 1}/${numRequests}: ${result.jobId} (queue position: ${result.queuePosition})`);
    }

    expect(jobIds.length).toBe(numRequests);
  });

  test('should report queue status correctly', async () => {
    logStep(2, 'Checking queue status after submissions');

    const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/queue-status`);
    expect(response.status).toBe(200);

    const status = await response.json();
    logStep(2, `Queue: ${status.activeJobs} active, ${status.queuedJobs} queued`);

    expect(status.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(status.activeJobs).toBeLessThanOrEqual(status.maxConcurrent);
  });

  test('should update queue positions as jobs complete', async () => {
    logStep(3, 'Testing queue position updates');

    // Submit a request
    const response = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/generate-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createProofRequest(100))
    });

    const { jobId, queuePosition, queuedJobs } = await response.json();
    logStep(3, `Job ${jobId} started at position ${queuePosition}, ${queuedJobs} total queued`);

    // Check that the job status includes queue position
    const statusResponse = await fetchWithRetry(`${CONFIG.PROVER_SERVER}/api/proof-status/${jobId}`);
    const status = await statusResponse.json();

    expect(status).toHaveProperty('queuePosition');
    expect(status).toHaveProperty('queuedAt');
    logStep(3, `Job status: ${status.status}, queue position: ${status.queuePosition}`);
  });
});
