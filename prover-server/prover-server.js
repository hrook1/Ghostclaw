const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const path = require('path');
const { createPublicClient, http, parseAbiItem } = require('viem');
const { sepolia } = require('viem/chains');
const { blake3 } = require('@noble/hashes/blake3');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit for large proof requests

const PORT = process.env.PORT || 3001;

// SP1 Prover configuration
const SP1_PROVER = process.env.SP1_PROVER || 'cpu';
const NETWORK_PRIVATE_KEY = process.env.NETWORK_PRIVATE_KEY;
const PROVER_NETWORK_RPC = process.env.PROVER_NETWORK_RPC || 'https://rpc.mainnet.succinct.xyz';

// Proof-required contract - all state changes require valid SP1 proofs
// SECURITY FIX: Contract now decodes outputs from publicValues (proof binding bypass fix)
const LEDGER_CONTRACT = process.env.LEDGER_CONTRACT || '0xF3Ac04b13dfb9D879c00Bd9F5924f80C7DB58AD0';

// RPC URL for blockchain queries
const RPC_URL = process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY';
const DEPLOYMENT_BLOCK = BigInt(process.env.DEPLOYMENT_BLOCK || '7662871');

// Detect localhost mode
const IS_LOCALHOST = RPC_URL.includes('localhost') || RPC_URL.includes('127.0.0.1');

// Blake3 domain separator (must match Rust core/src/note.rs)
const NOTE_COMMITMENT_DOMAIN = new TextEncoder().encode('NOTE_COMMITMENT_v1');

/**
 * SECURITY CRITICAL: Compute note commitment using Blake3
 * Must exactly match the Rust implementation in core/src/note.rs
 */
function computeCommitment(amount, ownerPubkey, blinding) {
  // amount: u64 as little-endian bytes
  const amountLE = new Uint8Array(8);
  let amt = BigInt(amount);
  for (let i = 0; i < 8; i++) {
    amountLE[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }

  // ownerPubkey: 32 bytes (hex string without 0x)
  const ownerBytes = Buffer.from(ownerPubkey.replace('0x', '').padStart(64, '0'), 'hex');

  // blinding: 32 bytes (hex string without 0x)
  const blindingBytes = Buffer.from(blinding.replace('0x', '').padStart(64, '0'), 'hex');

  // Hash: domain || amount || owner || blinding
  const preimage = new Uint8Array(NOTE_COMMITMENT_DOMAIN.length + 8 + 32 + 32);
  preimage.set(NOTE_COMMITMENT_DOMAIN, 0);
  preimage.set(amountLE, NOTE_COMMITMENT_DOMAIN.length);
  preimage.set(ownerBytes, NOTE_COMMITMENT_DOMAIN.length + 8);
  preimage.set(blindingBytes, NOTE_COMMITMENT_DOMAIN.length + 8 + 32);

  return '0x' + Buffer.from(blake3(preimage)).toString('hex');
}

/**
 * SECURITY CRITICAL: Verify that input note commitments exist on-chain
 * This prevents the "infinite mint" attack where attackers create fake notes
 *
 * Note: In mock mode (SP1_PROVER=mock), verification is skipped for localhost testing.
 */
async function verifyInputCommitmentsExist(inputNotes, inputIndices) {
  // Skip verification in mock mode for localhost testing
  if (SP1_PROVER === 'mock' && IS_LOCALHOST) {
    console.log('[Security] Mock mode on localhost - skipping on-chain commitment verification');
    return { events: [], onChainCommitments: new Map() };
  }

  console.log('[Security] Verifying input commitments exist on-chain...');

  // Define chain for localhost or Sepolia
  const chain = IS_LOCALHOST
    ? { ...sepolia, id: 31337, name: 'Localhost', rpcUrls: { default: { http: [RPC_URL] } } }
    : sepolia;

  const client = createPublicClient({
    chain,
    transport: http(RPC_URL)
  });

  // Fetch all OutputCommitted events from the contract
  const events = await client.getLogs({
    address: LEDGER_CONTRACT,
    event: parseAbiItem('event OutputCommitted(bytes32 indexed commitment, uint8 keyType, bytes ephemeralPubkey, bytes12 nonce, bytes ciphertext)'),
    fromBlock: DEPLOYMENT_BLOCK,
    toBlock: 'latest'
  });

  console.log(`[Security] Found ${events.length} on-chain commitments`);

  // Build set of on-chain commitments with their indices
  const onChainCommitments = new Map();
  events.forEach((event, index) => {
    const commitment = event.args.commitment.toLowerCase();
    onChainCommitments.set(commitment, index);
  });

  // Verify each input note
  for (let i = 0; i < inputNotes.length; i++) {
    const note = inputNotes[i];
    const expectedIndex = inputIndices[i];

    // Compute commitment from note data
    const commitment = computeCommitment(
      note.amount,
      note.ownerPubkey,
      note.blinding
    ).toLowerCase();

    console.log(`[Security] Input ${i}: commitment=${commitment.slice(0, 18)}..., claimedIndex=${expectedIndex}`);

    // Check if commitment exists on-chain
    if (!onChainCommitments.has(commitment)) {
      throw new Error(
        `SECURITY VIOLATION: Input note ${i} commitment does not exist on-chain. ` +
        `This could be an attempt to mint fake tokens. Commitment: ${commitment}`
      );
    }

    // Verify the index matches
    const actualIndex = onChainCommitments.get(commitment);
    if (actualIndex !== expectedIndex) {
      throw new Error(
        `SECURITY VIOLATION: Input note ${i} claims index ${expectedIndex} but exists at index ${actualIndex}. ` +
        `This could be an attempt to double-spend or manipulate the merkle tree.`
      );
    }

    console.log(`[Security] Input ${i}: ✅ Verified at index ${actualIndex}`);
  }

  console.log(`[Security] All ${inputNotes.length} input commitments verified on-chain`);
  return { events, onChainCommitments };
}

// Track ongoing proof jobs
const proofJobs = new Map();

// ============================================
// JOB QUEUE SYSTEM
// ============================================
// Process proofs sequentially to prevent race conditions and ensure
// merkle tree state consistency between proofs
const jobQueue = [];
let isProcessing = false;
const MAX_CONCURRENT = 1; // Process one at a time for safety
let activeJobs = 0;

// Status stages for UI tracking
const STAGES = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  COMPUTING: 'computing',
  PROVING: 'proving',
  SUBMITTING: 'submitting',
  CONFIRMING: 'confirming',
  SUCCESS: 'success',
  ERROR: 'error'
};

// ============================================
// QUEUE PROCESSOR
// ============================================
function processQueue() {
  if (activeJobs >= MAX_CONCURRENT || jobQueue.length === 0) {
    return;
  }

  const nextJob = jobQueue.shift();
  if (!nextJob) return;

  activeJobs++;
  console.log(`[Queue] Starting job ${nextJob.jobId}. Active: ${activeJobs}, Queued: ${jobQueue.length}`);

  // Update queue positions for remaining jobs
  updateQueuePositions();

  // Execute the proof generation
  executeProofGeneration(nextJob.jobId, nextJob.proofRequest)
    .finally(() => {
      activeJobs--;
      console.log(`[Queue] Job ${nextJob.jobId} finished. Active: ${activeJobs}, Queued: ${jobQueue.length}`);
      // Process next job in queue
      processQueue();
    });
}

function updateQueuePositions() {
  jobQueue.forEach((queuedJob, index) => {
    const job = proofJobs.get(queuedJob.jobId);
    if (job && job.status === STAGES.QUEUED) {
      job.queuePosition = index + 1;
      job.stageDescription = `Queued (position ${index + 1} of ${jobQueue.length})`;
      proofJobs.set(queuedJob.jobId, job);
    }
  });
}

// Execute proof generation (called by queue processor)
function executeProofGeneration(jobId, proofRequest) {
  return new Promise((resolve) => {
    const job = proofJobs.get(jobId);
    if (!job) {
      resolve();
      return;
    }

    // Update status to preparing
    updateJobStatus(jobId, STAGES.PREPARING, 'Initializing prover...', 10);

    // Run SP1 prover - use PROVER_PATH env var if set, otherwise relative path
    const proverPath = process.env.PROVER_PATH || path.join(__dirname, '../prover/host');

    // Build environment with SP1 network credentials
    const proverEnv = {
      ...process.env,
      SP1_PROVER: SP1_PROVER,
      RUST_LOG: 'info'
    };

    // Add network credentials if using network prover
    if (SP1_PROVER === 'network' && NETWORK_PRIVATE_KEY) {
      proverEnv.NETWORK_PRIVATE_KEY = NETWORK_PRIVATE_KEY;
      proverEnv.PROVER_NETWORK_RPC = PROVER_NETWORK_RPC;
      console.log(`[${jobId}] Using Succinct Prover Network (Mainnet)`);
      updateJobStatus(jobId, STAGES.PREPARING, 'Connecting to Succinct Prover Network...', 15);
    } else {
      console.log(`[${jobId}] Using local CPU prover`);
      updateJobStatus(jobId, STAGES.PREPARING, 'Starting local CPU prover...', 15);
    }

    const jsonInput = JSON.stringify(proofRequest);
    console.log(`[${jobId}] Proof request JSON length: ${jsonInput.length} bytes`);

    // Use prebuilt binary if available (Docker), otherwise use cargo run (local dev)
    const SP1_HOST_BINARY = process.env.SP1_HOST_BINARY;
    let prover;
    if (SP1_HOST_BINARY) {
      console.log(`[${jobId}] Using prebuilt binary: ${SP1_HOST_BINARY}`);
      prover = spawn(SP1_HOST_BINARY, [], { env: proverEnv });
    } else {
      console.log(`[${jobId}] Using cargo run`);
      prover = spawn('cargo', ['run', '--release', '--bin', 'sp1-host'], {
        cwd: proverPath,
        env: proverEnv
      });
    }

    // Write JSON input to stdin
    prover.stdin.write(jsonInput);
    prover.stdin.end();

    let stderrOutput = '';  // Logs go to stderr
    let stdoutOutput = '';  // JSON response goes to stdout

    // stdout receives JSON response from prover
    prover.stdout.on('data', (data) => {
      stdoutOutput += data.toString();
    });

    // stderr receives logs (for debugging and status updates)
    prover.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrOutput += chunk;
      console.log(`[${jobId}] ${chunk.trim()}`);

      // Parse status updates from prover logs
      const currentJob = proofJobs.get(jobId);
      if (!currentJob) return;

      // Detect stage transitions based on prover output
      if (chunk.includes('Precomputing') || chunk.includes('precomputing')) {
        updateJobStatus(jobId, STAGES.PREPARING, 'Precomputing nullifiers and commitments...', 20);
      }
      else if (chunk.includes('Verification Key Hash')) {
        updateJobStatus(jobId, STAGES.COMPUTING, 'Setting up proving key...', 30);
      }
      else if (chunk.includes('Requesting Groth16')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Requesting Groth16 proof from network...', 40);
      }
      else if (chunk.includes('local CPU')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Generating proof on local CPU...', 40);
      }
      else if (chunk.includes('Generating ZK proof')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Generating ZK proof...', 50);
      }
      else if (chunk.includes('Proof generated')) {
        updateJobStatus(jobId, STAGES.SUBMITTING, 'Proof generated, preparing for submission...', 85);
      }
      else if (chunk.includes('=== Public Outputs ===')) {
        updateJobStatus(jobId, STAGES.SUBMITTING, 'Extracting public outputs...', 90);
      }
      else if (chunk.includes('SUCCESS')) {
        updateJobStatus(jobId, STAGES.SUBMITTING, 'Proof ready for submission', 95);
      }
      // Network-specific status updates
      else if (chunk.includes('Auction') || chunk.includes('auction')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Proof request in auction...', 45);
      }
      else if (chunk.includes('Fulfilling') || chunk.includes('fulfilling')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Network fulfilling proof request...', 60);
      }
      else if (chunk.includes('Completed') || chunk.includes('completed')) {
        updateJobStatus(jobId, STAGES.PROVING, 'Network proof completed, downloading...', 80);
      }
    });

    prover.on('close', (code) => {
      const finalJob = proofJobs.get(jobId);
      const duration = finalJob ? Date.now() - finalJob.startTime : 0;

      if (code === 0) {
        console.log(`[${jobId}] Proof generation complete in ${duration}ms`);

        // Parse JSON response from stdout
        try {
          const response = JSON.parse(stdoutOutput.trim());
          console.log(`[${jobId}] Parsed proof response: vkey=${response.vkeyHash?.slice(0, 18)}...`);

          proofJobs.set(jobId, {
            ...finalJob,
            status: STAGES.SUCCESS,
            stage: STAGES.SUCCESS,
            stageDescription: 'Proof generated successfully',
            progress: 100,
            duration,
            proof: response.proof,
            publicValuesRaw: response.publicValuesRaw,
            publicOutputs: response.publicOutputs,
            vkeyHash: response.vkeyHash,
            contractAddress: LEDGER_CONTRACT
          });
        } catch (parseError) {
          console.error(`[${jobId}] Failed to parse proof JSON: ${parseError.message}`);
          console.error(`[${jobId}] Raw stdout: ${stdoutOutput.slice(0, 500)}`);
          proofJobs.set(jobId, {
            ...finalJob,
            status: STAGES.ERROR,
            stage: STAGES.ERROR,
            stageDescription: 'Failed to parse proof response',
            progress: 0,
            error: `Failed to parse proof JSON: ${parseError.message}`,
            output: stderrOutput.slice(-2000)
          });
        }
      } else {
        console.error(`[${jobId}] Proof generation failed with code ${code}`);
        proofJobs.set(jobId, {
          ...finalJob,
          status: STAGES.ERROR,
          stage: STAGES.ERROR,
          stageDescription: 'Proof generation failed',
          progress: 0,
          error: `Prover exited with code ${code}`,
          output: stderrOutput.slice(-2000)
        });
      }

      resolve();
    });

    prover.on('error', (err) => {
      console.error(`[${jobId}] Prover process error: ${err.message}`);
      const errorJob = proofJobs.get(jobId);
      proofJobs.set(jobId, {
        ...errorJob,
        status: STAGES.ERROR,
        stage: STAGES.ERROR,
        stageDescription: 'Prover process error',
        progress: 0,
        error: err.message
      });
      resolve();
    });
  });
}

// Generate proof using SP1 (network or CPU)
// Requests are queued and processed sequentially to prevent race conditions
app.post('/api/generate-proof', async (req, res) => {
  const {
    inputNotes,      // Array of { amount, ownerPubkey, blinding }
    outputNotes,     // Array of { amount, ownerPubkey, blinding }
    nullifierSignatures, // Array of signatures (hex strings)
    txSignatures,        // Array of signatures (hex strings)
    inputIndices,    // Array of merkle tree indices
    inputProofs,     // Array of merkle proofs (string[])
    oldRoot          // Current merkle root from contract (hex string)
  } = req.body;

  const jobId = Math.random().toString(36).substring(7);

  console.log(`[${jobId}] Received proof request`);
  console.log(`[${jobId}] Mode: ${SP1_PROVER}`);
  console.log(`[${jobId}] Inputs: ${inputNotes?.length || 0}, Outputs: ${outputNotes?.length || 0}`);

  // Validate required fields
  if (!inputNotes || !outputNotes || !nullifierSignatures || !txSignatures || !inputIndices || !inputProofs || !oldRoot) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['inputNotes', 'outputNotes', 'nullifierSignatures', 'txSignatures', 'inputIndices', 'inputProofs', 'oldRoot'],
      received: {
        inputNotes: !!inputNotes,
        outputNotes: !!outputNotes,
        nullifierSignatures: !!nullifierSignatures,
        txSignatures: !!txSignatures,
        inputIndices: !!inputIndices,
        inputProofs: !!inputProofs,
        oldRoot: !!oldRoot
      }
    });
  }

  // Validate proofs match inputs
  if (inputProofs.length !== inputNotes.length) {
    return res.status(400).json({
      error: 'Input mismatch',
      message: `Received ${inputNotes.length} inputs but ${inputProofs.length} proofs`
    });
  }

  // Calculate queue position
  const queuePosition = jobQueue.length + 1;
  const willStartImmediately = activeJobs < MAX_CONCURRENT;

  // Set initial job status
  proofJobs.set(jobId, {
    status: STAGES.QUEUED,
    stage: STAGES.QUEUED,
    stageDescription: willStartImmediately ? 'Starting proof generation...' : `Queued (position ${queuePosition})`,
    progress: 0,
    startTime: Date.now(),
    proverMode: SP1_PROVER,
    queuePosition: willStartImmediately ? 0 : queuePosition,
    queuedAt: Date.now()
  });

  // Prepare proof request data
  const proofRequest = {
    inputNotes,
    outputNotes,
    nullifierSignatures,
    txSignatures,
    inputIndices,
    inputProofs, // Added
    oldRoot
  };

  // Add to queue
  jobQueue.push({ jobId, proofRequest });
  console.log(`[Queue] Job ${jobId} added. Active: ${activeJobs}, Queued: ${jobQueue.length}`);

  // Return job ID immediately with queue info
  res.json({
    jobId,
    proverMode: SP1_PROVER,
    queuePosition: willStartImmediately ? 0 : queuePosition,
    activeJobs,
    queuedJobs: jobQueue.length
  });

  // Trigger queue processing
  processQueue();
});

// Helper to update job status
function updateJobStatus(jobId, stage, description, progress) {
  const job = proofJobs.get(jobId);
  if (job) {
    job.status = stage;
    job.stage = stage;
    job.stageDescription = description;
    job.progress = progress;
    proofJobs.set(jobId, job);
  }
}

// Poll for proof status
app.get('/api/proof-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = proofJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);

  // Clean up completed jobs after 10 minutes
  if (job.status === STAGES.SUCCESS || job.status === STAGES.ERROR) {
    setTimeout(() => proofJobs.delete(jobId), 10 * 60 * 1000);
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    prover: SP1_PROVER,
    networkConfigured: !!(SP1_PROVER === 'network' && NETWORK_PRIVATE_KEY),
    rpcUrl: SP1_PROVER === 'network' ? PROVER_NETWORK_RPC : null,
    ledgerContract: LEDGER_CONTRACT,
    queue: {
      activeJobs,
      queuedJobs: jobQueue.length,
      maxConcurrent: MAX_CONCURRENT,
      totalTracked: proofJobs.size
    }
  });
});

// Queue status endpoint
app.get('/api/queue-status', (req, res) => {
  const queuedJobIds = jobQueue.map(j => j.jobId);
  const activeJobIds = [...proofJobs.entries()]
    .filter(([_, job]) => job.status !== STAGES.QUEUED && job.status !== STAGES.SUCCESS && job.status !== STAGES.ERROR)
    .map(([id, _]) => id);

  res.json({
    activeJobs,
    queuedJobs: jobQueue.length,
    maxConcurrent: MAX_CONCURRENT,
    queuedJobIds,
    activeJobIds
  });
});

// Get contract info
app.get('/api/contract-info', (req, res) => {
  res.json({
    ledgerContract: LEDGER_CONTRACT,
    sp1Verifier: '0x397A5f7f3dBd538f23DE225B51f532c34448dA9B',
    programVkey: '0x0018245978a05d128f6eb6b48b68659844589c3dea82d81cf0cd3c1be2e47789',
    network: 'sepolia'
  });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`SP1 Prover Server v2.0`);
  console.log(`========================================`);
  console.log(`Port: ${PORT}`);
  console.log(`Prover Mode: ${SP1_PROVER}`);
  console.log(`Ledger Contract: ${LEDGER_CONTRACT}`);

  if (SP1_PROVER === 'network' && NETWORK_PRIVATE_KEY) {
    console.log(`Network RPC: ${PROVER_NETWORK_RPC}`);
    console.log(`Status: Connected to Succinct Prover Network`);
  } else if (SP1_PROVER === 'network' && !NETWORK_PRIVATE_KEY) {
    console.log(`WARNING: SP1_PROVER=network but NETWORK_PRIVATE_KEY not set!`);
  } else {
    console.log(`Status: Using local CPU prover`);
  }
  console.log(`========================================\n`);
});
