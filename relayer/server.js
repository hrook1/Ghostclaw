import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Alchemy Account Kit for gasless transactions
import { createLightAccountAlchemyClient } from '@account-kit/smart-contracts';
import { sepolia, alchemy } from '@account-kit/infra';
import { LocalAccountSigner } from '@aa-sdk/core';
import { encodeFunctionData, formatEther, createPublicClient, http } from 'viem';
import { sepolia as viemSepolia } from 'viem/chains';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '.env') });

const app = express();

// CORS configuration
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));
app.use(express.json());

const PORT = process.env.PORT || 3002;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const GAS_POLICY_ID = process.env.GAS_POLICY_ID;
// PrivateUTXOLedger contract - proof-required UTXO system
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x42ae920DFD0d25Ac014DFd751bd2ff2D2fBa0443';

if (!ALCHEMY_API_KEY || !RELAYER_PRIVATE_KEY || !GAS_POLICY_ID) {
    console.error('Missing required environment variables: ALCHEMY_API_KEY, RELAYER_PRIVATE_KEY, GAS_POLICY_ID');
    process.exit(1);
}

// Smart account client
let smartAccountClient = null;
let smartAccountAddress = null;

// function initializeSmartAccount removed (replaced below)

// Public client for reading contract state
console.log('SEPOLIA_RPC_URL:', process.env.SEPOLIA_RPC_URL);
const transport = http(process.env.SEPOLIA_RPC_URL || 'http://127.0.0.1:8545');

let chain;
if (process.env.SEPOLIA_RPC_URL && !process.env.SEPOLIA_RPC_URL.includes('localhost') && !process.env.SEPOLIA_RPC_URL.includes('127.0.0.1')) {
    chain = viemSepolia;
} else {
    chain = { ...viemSepolia, id: 31337, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } };
}

const publicClient = createPublicClient({
    chain,
    transport
});

import { createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

async function initializeSmartAccount() {
    try {
        console.log('Initializing Account...');

        // CHECK FOR LOCAL MODE
        if (process.env.FORCE_STANDARD_WALLET === 'true' || (process.env.SEPOLIA_RPC_URL && (process.env.SEPOLIA_RPC_URL.includes('localhost') || process.env.SEPOLIA_RPC_URL.includes('127.0.0.1')))) {
            console.log('Detected generic RPC (Local/Anvil). utilizing standard wallet instead of Smart Account.');

            const account = privateKeyToAccount(RELAYER_PRIVATE_KEY);
            const walletClient = createWalletClient({
                account,
                chain,
                transport
            });

            smartAccountAddress = account.address;

            // Mock the smart account client interface
            smartAccountClient = {
                getAddress: async () => account.address,
                sendUserOperation: async ({ uo }) => {
                    console.log('[MockRelayer] Sending transaction to', uo.target);
                    const hash = await walletClient.sendTransaction({
                        to: uo.target,
                        data: uo.data,
                        value: uo.value || 0n
                    });
                    console.log('[MockRelayer] Tx sent:', hash);
                    return { hash };
                },
                waitForUserOperationTransaction: async (res) => {
                    const receipt = await publicClient.waitForTransactionReceipt({ hash: res.hash });
                    return res.hash;
                }
            };

            console.log('Local Relayer Initialized. Address:', smartAccountAddress);
            return true;
        }

        console.log('Initializing Alchemy Smart Account (Sepolia)...');

        const signer = LocalAccountSigner.privateKeyToAccountSigner(RELAYER_PRIVATE_KEY);
        const alchemyTransport = alchemy({ apiKey: ALCHEMY_API_KEY });

        smartAccountClient = await createLightAccountAlchemyClient({
            transport: alchemyTransport,
            chain: sepolia,
            signer,
            policyId: GAS_POLICY_ID,
        });

        smartAccountAddress = await smartAccountClient.getAddress();
        console.log('Smart Account Address:', smartAccountAddress);
        console.log('Gas Sponsorship: ENABLED');

        return true;
    } catch (error) {
        console.error('Failed to initialize smart account:', error);
        return false;
    }
}

// Contract ABI
const UTXO_LEDGER_ABI = [
    {
        inputs: [],
        name: 'currentRoot',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [
            { name: 'commitment', type: 'bytes32' },
            {
                components: [
                    { name: 'commitment', type: 'bytes32' },
                    { name: 'keyType', type: 'uint8' },
                    { name: 'ephemeralPubkey', type: 'bytes' },
                    { name: 'nonce', type: 'bytes12' },
                    { name: 'ciphertext', type: 'bytes' }
                ],
                name: 'encrypted',
                type: 'tuple'
            },
            { name: 'amount', type: 'uint256' },
            {
                components: [
                    {
                        components: [
                            { name: 'token', type: 'address' },
                            { name: 'amount', type: 'uint256' }
                        ],
                        name: 'permitted',
                        type: 'tuple'
                    },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'deadline', type: 'uint256' }
                ],
                name: 'permit',
                type: 'tuple'
            },
            { name: 'signature', type: 'bytes' },
            { name: 'depositor', type: 'address' }
        ],
        name: 'depositWithPermit2',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    // SECURITY FIX: Removed 'outputs' parameter - contract now decodes from publicValues
    // This prevents proof-binding bypass where attacker could submit valid proof with malicious outputs
    {
        inputs: [
            {
                components: [
                    { name: 'commitment', type: 'bytes32' },
                    { name: 'keyType', type: 'uint8' },
                    { name: 'ephemeralPubkey', type: 'bytes' },
                    { name: 'nonce', type: 'bytes12' },
                    { name: 'ciphertext', type: 'bytes' }
                ],
                name: 'encryptedOutputs',
                type: 'tuple[]'
            },
            { name: 'proof', type: 'bytes' },
            { name: 'publicValues', type: 'bytes' }
        ],
        name: 'submitTx',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [
            { name: 'recipient', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'proof', type: 'bytes' },
            { name: 'publicValues', type: 'bytes' },
            {
                components: [
                    { name: 'commitment', type: 'bytes32' },
                    { name: 'keyType', type: 'uint8' },
                    { name: 'ephemeralPubkey', type: 'bytes' },
                    { name: 'nonce', type: 'bytes12' },
                    { name: 'ciphertext', type: 'bytes' }
                ],
                name: 'encryptedOutputs',
                type: 'tuple[]'
            }
        ],
        name: 'withdraw',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    }
];

console.log('Relayer starting...');
console.log('Contract:', CONTRACT_ADDRESS);

// Submit private transaction (for sends between private addresses)
// SECURITY FIX: Contract now decodes outputs from publicValues (no separate outputs param)
app.post('/api/submit-tx', async (req, res) => {
    try {
        const { encryptedOutputs, proof, publicValues } = req.body;

        console.log('[Relayer] Processing submit-tx...');
        console.log('[Relayer] publicValues:', publicValues ? `${publicValues.slice(0, 20)}... (${publicValues.length} chars)` : 'MISSING');

        if (!smartAccountClient) {
            throw new Error('Smart account not initialized');
        }

        if (!publicValues) {
            throw new Error('Missing publicValues - required for SP1 proof verification');
        }

        // Validate proof is present and not empty
        if (!proof || proof === '0x' || proof.length < 10) {
            throw new Error('Invalid or missing proof - cannot submit transaction without valid proof');
        }

        console.log('[Relayer] Proof length:', proof.length, 'bytes');
        console.log('[Relayer] PublicValues length:', publicValues.length, 'bytes');
        console.log('[Relayer] EncryptedOutputs count:', encryptedOutputs?.length || 0);

        const callData = encodeFunctionData({
            abi: UTXO_LEDGER_ABI,
            functionName: 'submitTx',
            args: [
                encryptedOutputs.map(eo => ({
                    commitment: eo.commitment,
                    keyType: eo.keyType,
                    ephemeralPubkey: eo.ephemeralPubkey,
                    nonce: eo.nonce,
                    ciphertext: eo.ciphertext
                })),
                proof,
                publicValues
            ]
        });

        // Log calldata info for debugging
        console.log('[Relayer] CallData length:', callData.length, 'bytes');
        console.log('[Relayer] Target contract:', CONTRACT_ADDRESS);

        const result = await smartAccountClient.sendUserOperation({
            uo: { target: CONTRACT_ADDRESS, data: callData, value: 0n },
        });

        console.log('[Relayer] UserOp hash:', result.hash);
        console.log('[Relayer] Waiting for transaction to be mined...');

        const txHash = await smartAccountClient.waitForUserOperationTransaction(result);
        console.log('[Relayer] Tx confirmed:', txHash);

        res.json({ success: true, txHash, userOpHash: result.hash });
    } catch (error) {
        console.error('[Relayer] submit-tx error:', error.message);
        // Log full error details for debugging
        if (error.cause) {
            console.error('[Relayer] Error cause:', error.cause);
        }
        if (error.details) {
            console.error('[Relayer] Error details:', error.details);
        }
        if (error.shortMessage) {
            console.error('[Relayer] Short message:', error.shortMessage);
        }
        res.status(500).json({ error: error.message });
    }
});

// Withdraw from private to public address
// SECURITY FIX: Contract now decodes outputs from publicValues (no separate outputs param)
app.post('/api/withdraw', async (req, res) => {
    try {
        const { recipient, amount, proof, publicValues } = req.body;

        console.log('[Relayer] Processing withdraw...');
        console.log('[Relayer] Recipient:', recipient);
        console.log('[Relayer] Amount:', formatEther(BigInt(amount)), 'ETH');
        console.log('[Relayer] publicValues:', publicValues ? `${publicValues.slice(0, 20)}... (${publicValues.length} chars)` : 'MISSING');
        console.log('[Relayer] EncryptedOutputs:', req.body.encryptedOutputs ? req.body.encryptedOutputs.length : 0);

        if (!smartAccountClient) {
            throw new Error('Smart account not initialized');
        }

        if (!publicValues) {
            throw new Error('Missing publicValues - required for SP1 proof verification');
        }

        // Validate proof is present and not empty
        if (!proof || proof === '0x' || proof.length < 10) {
            throw new Error('Invalid or missing proof - cannot withdraw without valid proof');
        }

        console.log('[Relayer] Proof length:', proof.length, 'bytes');
        console.log('[Relayer] PublicValues length:', publicValues.length, 'bytes');

        const callData = encodeFunctionData({
            abi: UTXO_LEDGER_ABI,
            functionName: 'withdraw',
            args: [
                recipient,
                BigInt(amount),
                proof,
                publicValues,
                (req.body.encryptedOutputs || []).map(eo => ({
                    commitment: eo.commitment,
                    keyType: eo.keyType,
                    ephemeralPubkey: eo.ephemeralPubkey,
                    nonce: eo.nonce,
                    ciphertext: eo.ciphertext
                }))
            ]
        });

        // Log calldata info for debugging
        console.log('[Relayer] CallData length:', callData.length, 'bytes');
        console.log('[Relayer] Target contract:', CONTRACT_ADDRESS);

        const result = await smartAccountClient.sendUserOperation({
            uo: { target: CONTRACT_ADDRESS, data: callData, value: 0n },
        });

        console.log('[Relayer] UserOp hash:', result.hash);
        console.log('[Relayer] Waiting for transaction to be mined...');

        const txHash = await smartAccountClient.waitForUserOperationTransaction(result);
        console.log('[Relayer] Tx confirmed:', txHash);

        res.json({ success: true, txHash, userOpHash: result.hash });
    } catch (error) {
        console.error('[Relayer] withdraw error:', error.message);
        // Log full error details for debugging
        if (error.cause) {
            console.error('[Relayer] Error cause:', error.cause);
        }
        if (error.details) {
            console.error('[Relayer] Error details:', error.details);
        }
        res.status(500).json({ error: error.message });
    }
});

// Gasless deposit using Permit2 signature
app.post('/api/deposit-with-permit', async (req, res) => {
    try {
        const { commitment, encrypted, amount, permit, signature, depositor } = req.body;

        console.log('[Relayer] Processing deposit-with-permit...');
        console.log('[Relayer] Depositor:', depositor);
        console.log('[Relayer] Amount:', amount);

        if (!smartAccountClient) {
            throw new Error('Smart account not initialized');
        }

        const callData = encodeFunctionData({
            abi: UTXO_LEDGER_ABI,
            functionName: 'depositWithPermit2',
            args: [
                commitment,
                {
                    commitment: encrypted.commitment,
                    keyType: encrypted.keyType,
                    ephemeralPubkey: encrypted.ephemeralPubkey,
                    nonce: encrypted.nonce,
                    ciphertext: encrypted.ciphertext
                },
                BigInt(amount),
                {
                    permitted: {
                        token: permit.permitted.token,
                        amount: BigInt(permit.permitted.amount)
                    },
                    nonce: BigInt(permit.nonce),
                    deadline: BigInt(permit.deadline)
                },
                signature,
                depositor
            ]
        });

        const result = await smartAccountClient.sendUserOperation({
            uo: { target: CONTRACT_ADDRESS, data: callData, value: 0n },
        });

        console.log('[Relayer] UserOp hash:', result.hash);
        const txHash = await smartAccountClient.waitForUserOperationTransaction(result);
        console.log('[Relayer] Deposit tx confirmed:', txHash);

        res.json({ success: true, txHash, userOpHash: result.hash });
    } catch (error) {
        console.error('[Relayer] deposit-with-permit error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// EncryptedContacts contract address (2025-12-16 - fresh deploy)
const ENCRYPTED_CONTACTS_ADDRESS = '0x813e453D13dE769922aFc40780FADeF3AC6d939D';

// EncryptedContacts ABI (just the functions we need)
const ENCRYPTED_CONTACTS_ABI = [
    {
        inputs: [
            { name: '_ownerTag', type: 'bytes8' },
            { name: '_encryptedData', type: 'bytes' }
        ],
        name: 'saveContact',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'nonpayable',
        type: 'function'
    }
];

// PaymentRequests contract address
const PAYMENT_REQUESTS_ADDRESS = '0x3c4d73f028d99eC10eB15fED99AC5080C99A4a4d';

// PaymentRequests ABI
const PAYMENT_REQUESTS_ABI = [
    {
        inputs: [
            { name: '_recipientTag', type: 'bytes8' },
            { name: '_encryptedPayload', type: 'bytes' }
        ],
        name: 'createRequest',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'nonpayable',
        type: 'function'
    }
];

// Save encrypted contact via relayer (gasless)
app.post('/api/save-contact', async (req, res) => {
    try {
        const { ownerTag, encryptedData } = req.body;

        console.log('[Relayer] Saving contact...');
        console.log('[Relayer] Owner tag:', ownerTag);
        console.log('[Relayer] Encrypted data length:', encryptedData?.length || 0);

        if (!smartAccountClient) {
            throw new Error('Smart account not initialized');
        }

        if (!ownerTag || !encryptedData) {
            throw new Error('Missing ownerTag or encryptedData');
        }

        const callData = encodeFunctionData({
            abi: ENCRYPTED_CONTACTS_ABI,
            functionName: 'saveContact',
            args: [ownerTag, encryptedData]
        });

        const result = await smartAccountClient.sendUserOperation({
            uo: { target: ENCRYPTED_CONTACTS_ADDRESS, data: callData, value: 0n },
        });

        console.log('[Relayer] Contact save UserOp hash:', result.hash);
        const txHash = await smartAccountClient.waitForUserOperationTransaction(result);
        console.log('[Relayer] Contact save tx confirmed:', txHash);

        res.json({ success: true, txHash, userOpHash: result.hash });
    } catch (error) {
        console.error('[Relayer] save-contact error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Create payment request via relayer (gasless)
app.post('/api/create-payment-request', async (req, res) => {
    try {
        const { recipientTag, encryptedPayload } = req.body;

        console.log('[Relayer] Creating payment request...');
        console.log('[Relayer] Recipient tag:', recipientTag);
        console.log('[Relayer] Encrypted payload length:', encryptedPayload?.length || 0);

        if (!smartAccountClient) {
            throw new Error('Smart account not initialized');
        }

        if (!recipientTag || !encryptedPayload) {
            throw new Error('Missing recipientTag or encryptedPayload');
        }

        const callData = encodeFunctionData({
            abi: PAYMENT_REQUESTS_ABI,
            functionName: 'createRequest',
            args: [recipientTag, encryptedPayload]
        });

        const result = await smartAccountClient.sendUserOperation({
            uo: { target: PAYMENT_REQUESTS_ADDRESS, data: callData, value: 0n },
        });

        console.log('[Relayer] Payment request UserOp hash:', result.hash);
        const txHash = await smartAccountClient.waitForUserOperationTransaction(result);
        console.log('[Relayer] Payment request tx confirmed:', txHash);

        res.json({ success: true, txHash, userOpHash: result.hash });
    } catch (error) {
        console.error('[Relayer] create-payment-request error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check
const healthHandler = async (req, res) => {
    try {
        const block = await publicClient.getBlockNumber();

        let balance = '0';
        if (smartAccountAddress) {
            const balanceWei = await publicClient.getBalance({ address: smartAccountAddress });
            balance = formatEther(balanceWei);
        }

        res.json({
            status: 'ok',
            smartAccountAddress,
            balance,
            block: Number(block),
            gasSponsorship: 'enabled',
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.get('/', (req, res) => {
    res.json({
        service: 'UTXO Relayer (Gasless)',
        version: '2.0.0',
        smartAccountAddress,
        gasSponsorship: 'enabled',
        endpoints: ['/api/submit-tx', '/api/withdraw', '/api/deposit-with-permit', '/api/save-contact', '/api/create-payment-request', '/api/health']
    });
});

// Initialize and start
async function start() {
    const initialized = await initializeSmartAccount();

    if (!initialized) {
        console.error('Failed to initialize smart account. Exiting.');
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log('Relayer on port', PORT);
    });
}

start();
