# E2E Test Suite

Comprehensive end-to-end tests for the UTXO prototype. These tests simulate real user actions and verify the complete flow from UI to blockchain.

## Quick Start

```bash
cd tests/e2e

# Install dependencies
npm install

# Run all tests (requires prover and relayer running)
npm test

# Run specific test categories
npm run test:integration  # Queue/concurrency tests
npm run test:flow         # User flow tests
```

## Prerequisites

Before running tests, ensure:

1. **Prover Server** is running on `http://localhost:3001`
   ```bash
   cd prover-server && npm start
   ```

2. **Relayer Server** is running on `http://localhost:3002`
   ```bash
   cd relayer && npm start
   ```

3. **Sepolia RPC** access is configured

## Test Categories

### Health Checks (`health.test.js`)
- Server availability
- Configuration validation
- Contract deployment verification

### Flow Tests (`flows/`)
- `deposit.test.js` - Deposit flow validation
- `send.test.js` - Private send with proof generation
- `withdraw.test.js` - Withdraw to public address
- `contacts.test.js` - Encrypted contacts storage
- `payment-requests.test.js` - Payment request creation

### Integration Tests (`integration/`)
- `concurrent-proofs.test.js` - Job queue under load
- `error-handling.test.js` - Error response validation

## Configuration

Environment variables (optional):
```bash
PROVER_SERVER=http://localhost:3001
RELAYER_SERVER=http://localhost:3002
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
```

## Test Timeouts

- Proof generation: 5 minutes (network proving can be slow)
- Transaction confirmation: 1 minute
- Default test timeout: 30 seconds

## Writing New Tests

1. Create test file in appropriate directory
2. Import from `setup.js`:
   ```javascript
   import { CONFIG, logStep, fetchWithRetry } from '../setup.js';
   ```
3. Use `logStep(n, message)` for visibility
4. Use `fetchWithRetry()` for resilient HTTP calls

## CI Integration

For CI pipelines:
```yaml
- name: Run E2E tests
  run: |
    cd tests/e2e
    npm ci
    npm test
  env:
    PROVER_SERVER: http://prover:3001
    RELAYER_SERVER: http://relayer:3002
    CI: true
```
