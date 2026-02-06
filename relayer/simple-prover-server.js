
import express from 'express'; // relayer/node_modules has express
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '50mb' }));

// In-memory job store: { id: { status, result, error, timestamp } }
const jobs = new Map();

app.post('/api/generate-proof', (req, res) => {
    const jobId = randomUUID();
    console.log(`[Prover] Starting job ${jobId}`);

    // Initialize job
    jobs.set(jobId, { status: 'queued', timestamp: Date.now() });

    // Set environment variables for the Rust process
    const env = {
        ...process.env,
        RUST_LOG: 'info'
    };

    // Path to Cargo.toml (relative to relayer/)
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '../prover/host/Cargo.toml');

    const child = spawn('cargo', ['run', '--release', '--bin', 'sp1-host', '--manifest-path', manifestPath], {
        env,
        stdio: ['pipe', 'pipe', 'inherit'] // Input via stdin, Output via stdout, Logs via stderr
    });

    // Update status to processing
    jobs.get(jobId).status = 'processing';

    let stdout = '';

    child.stdout.on('data', (data) => {
        stdout += data.toString();
    });

    child.on('close', (code) => {
        const job = jobs.get(jobId);
        if (code !== 0) {
            console.error(`[Prover] Job ${jobId} failed with code ${code}`);
            job.status = 'error';
            job.error = `Prover process exited with code ${code}`;
        } else {
            try {
                // Find the last line which should be the JSON response
                const lines = stdout.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                const response = JSON.parse(lastLine);
                console.log('Parsed response keys:', Object.keys(response));
                job.status = 'success';
                job.result = {
                    proof: response.proof,
                    publicValues: response.publicValuesRaw, // Map to publicValues expected by client
                    publicOutputs: response.publicOutputs // Optional
                };
                console.log(`[Prover] Job ${jobId} completed successfully`);
            } catch (e) {
                console.error(`[Prover] Job ${jobId} parsing failed:`, e);
                job.status = 'error';
                job.error = 'Failed to parse prover output';
            }
        }
    });

    // Write input to stdin
    child.stdin.write(JSON.stringify(req.body) + '\n');
    child.stdin.end();

    // Return Job ID immediately
    res.json({
        jobId,
        queuePosition: 0,
        proverMode: process.env.SP1_PROVER || 'cpu'
    });
});

app.get('/api/proof-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status === 'success') {
        res.json({
            status: 'success',
            proof: job.result.proof,
            publicValues: job.result.publicValues,
            publicOutputs: job.result.publicOutputs
        });
    } else if (job.status === 'error') {
        res.json({ status: 'error', error: job.error });
    } else {
        res.json({ status: job.status }); // queued or processing
    }
});

app.get('/api/queue-status', (req, res) => {
    res.json({
        activeJobs: 1,
        queuedJobs: 0,
        maxConcurrent: 1,
        totalTracked: jobs.size
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', type: process.env.SP1_PROVER || 'cpu' });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', type: process.env.SP1_PROVER || 'cpu' });
});

app.listen(PORT, () => {
    console.log(`Prover Server running on port ${PORT}`);
    console.log(`Mode: ${process.env.SP1_PROVER || 'cpu'}`);
});
