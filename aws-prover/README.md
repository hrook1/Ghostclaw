# AWS On-Demand SP1 Prover Setup

This setup runs the SP1 prover on AWS **only when needed** to minimize costs.

## Architecture

```
[Your App] --> [API Gateway] --> [Lambda] --> [EC2 Spot Instance]
                                    |              |
                                    v              v
                                 [DynamoDB]     [S3 Bucket]
                                 (job status)   (proofs)
```

## Cost Breakdown (Estimated)

| Component | Cost | Notes |
|-----------|------|-------|
| Lambda | ~$0.00 | Free tier: 1M requests/month |
| API Gateway | ~$0.00 | Free tier: 1M calls/month |
| EC2 Spot (c6i.2xlarge) | ~$0.10/hr | Only runs during proof generation |
| S3 | ~$0.02/GB | Minimal storage needed |
| DynamoDB | ~$0.00 | Free tier covers job tracking |

**Estimated cost per proof: ~$0.02-0.05** (assuming 10-30 min proof time)

## Instance Recommendations

For SP1 ZK proofs, CPU is king. Recommended instances:

| Instance | vCPUs | RAM | Spot Price* | Good For |
|----------|-------|-----|-------------|----------|
| c6i.2xlarge | 8 | 16GB | ~$0.10/hr | Fast proofs, good balance |
| c6i.4xlarge | 16 | 32GB | ~$0.20/hr | Very fast proofs |
| c6i.8xlarge | 32 | 64GB | ~$0.40/hr | Blazing fast |

*Spot prices vary by region. us-east-1 typically cheapest.

## Setup Instructions

### 1. Prerequisites

```bash
# Install AWS CLI
brew install awscli

# Configure AWS (use your new account credentials)
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output (json)
```

### 2. Create IAM Role for EC2

```bash
# Run the setup script
cd aws-prover
./setup-aws.sh
```

### 3. Build and Upload Prover AMI

```bash
# This creates a custom AMI with Rust + SP1 pre-installed
./build-ami.sh
```

### 4. Deploy Infrastructure

```bash
# Deploy Lambda, API Gateway, DynamoDB
./deploy.sh
```

### 5. Update Your App

Update `wallet-ui/lib/blockchain/config.ts`:
```typescript
export const PROVER_SERVER = process.env.NEXT_PUBLIC_PROVER_URL || 'https://your-api-gateway-url.amazonaws.com/prod'
```

## How It Works

1. **Request comes in** - Lambda receives proof request
2. **Lambda starts EC2 Spot** - Launches prover instance (30-60 sec startup)
3. **EC2 runs proof** - SP1 generates proof (5-30 min depending on complexity)
4. **Result stored in S3** - Lambda polls for completion
5. **EC2 auto-terminates** - Instance shuts down after proof complete
6. **Lambda returns result** - Your app gets the proof

## Manual Testing

```bash
# Test the prover endpoint
curl -X POST https://your-api-url/generate-proof \
  -H "Content-Type: application/json" \
  -d '{"inputCommitments": ["0x..."], "nullifiers": ["0x..."]}'

# Check status
curl https://your-api-url/proof-status/JOB_ID
```

## Monitoring

View logs and costs:
- CloudWatch Logs: Lambda execution logs
- EC2 Console: Spot instance history
- Cost Explorer: Actual spending

## Emergency Stop

If something goes wrong:
```bash
# Terminate all prover instances
aws ec2 describe-instances --filters "Name=tag:Purpose,Values=sp1-prover" --query 'Reservations[].Instances[].InstanceId' --output text | xargs -I {} aws ec2 terminate-instances --instance-ids {}
```
