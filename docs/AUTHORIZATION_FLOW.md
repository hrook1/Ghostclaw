# Private UTXO Authorization Flow

## How Users Prove Ownership Without Signing Transactions

In traditional Ethereum, users sign every transaction with MetaMask. In our private UTXO system, authorization works differently—through **cryptographic proof of knowledge**.

---

## The Key Concept: Nullifiers

A **nullifier** is a unique identifier that proves you can spend a UTXO without revealing your identity.

```
nullifier = hash(private_key, commitment)
```

Only the owner of the private key can compute the correct nullifier for a commitment.

---

## Step-by-Step Flow

### 1. Login (One-time MetaMask Signature)

When the user connects their wallet, they sign a message:

```typescript
// unified-login.ts
const signature = await walletClient.signMessage({ message: MESSAGE_TO_SIGN })
const privateKey = sha256(hexToBytes(signature))
const publicKey = secp256k1.getPublicKey(privateKey, true)
const derivedAddress = '0x' + bytesToHex(publicKey)  // "Private Address"
```

This derives a **private key** from their signature. This key is used for all private operations.

### 2. Deposit (Creates Commitment)

When depositing ETH, a commitment is created:

```
commitment = hash(amount, blinding_factor, owner_public_key)
```

This is stored on-chain. Nobody can see what's inside.

### 3. Send/Spend (Proves Ownership via Nullifier)

When spending, the user computes a nullifier using their private key:

```typescript
// send.ts line 282
const nullifiers = selectedUTXOs.map(u => 
  computeNullifier(privateKey, u.commitment)
)
```

The `computeNullifier` function:

```typescript
// crypto.ts
export function computeNullifier(privateKey: Uint8Array, commitment: string): string {
  const commitmentBytes = hexToBytes(commitment.slice(2))
  const combined = new Uint8Array([...privateKey, ...commitmentBytes])
  const hash = sha256(combined)
  return '0x' + bytesToHex(hash)
}
```

### 4. ZK Proof Verification (Contract Side)

The ZK proof mathematically proves:
- "I know a private key that produces this nullifier from this commitment"
- "The public key from this private key matches the commitment's owner"

Without revealing the private key itself.

---

## Security Properties

| Property | How It's Achieved |
|----------|-------------------|
| **Authorization** | Only the private key holder can compute correct nullifier |
| **Privacy** | Private key is never revealed; only nullifier + proof |
| **Double-spend prevention** | Contract marks nullifiers as "used" - can't reuse |
| **Unlinkability** | Different nullifiers for each UTXO; can't trace owner |

---

## Current Implementation Status

| Component | Status |
|-----------|--------|
| Private key derivation | ✅ Implemented |
| Nullifier computation | ✅ Implemented |
| ZK proof generation | 🟡 Mock (returns placeholder) |
| ZK proof verification | ❌ Not implemented (contract in testing mode) |

---

## Why No MetaMask Pop-up for Sends?

1. **Login**: User signs once → derives private key → stored in session
2. **Send**: Private key computes nullifier → included in ZK proof → relayer submits

The MetaMask signature at login **is** the authorization. All subsequent operations use the derived private key, wrapped in ZK proofs for privacy.

---

## References

- `wallet-ui/lib/blockchain/unified-login.ts` - Key derivation
- `wallet-ui/lib/blockchain/crypto.ts` - computeNullifier function
- `wallet-ui/lib/blockchain/send.ts` - Send flow using nullifiers
- `contracts/src/PrivateUTXOLedger.sol` - On-chain verification
