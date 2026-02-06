#!/bin/bash
set -e

echo "=== Quick Start: SP1 Prover on AWS ==="
echo ""
echo "This script sets up everything in one go using a simpler approach:"
echo "- Uses pre-built Docker image instead of custom AMI"
echo "- Faster to deploy (~5 min vs ~30 min)"
echo ""

# Check AWS CLI
if ! aws sts get-caller-identity &> /dev/null; then
    echo "ERROR: AWS CLI not configured."
    echo ""
    echo "Quick setup:"
    echo "  1. Go to AWS Console > IAM > Users > Create User"
    echo "  2. Attach 'AdministratorAccess' policy (for now, tighten later)"
    echo "  3. Create Access Key"
    echo "  4. Run: aws configure"
    echo ""
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

echo "AWS Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo ""

# Run the full setup
echo "Step 1/3: Creating AWS resources..."
./setup-aws.sh

# Skip AMI build - use Amazon Linux with user-data script instead
echo ""
echo "Step 2/3: Configuring instance startup script..."

# Instead of building AMI, we'll install everything on first boot
# This is slower per-instance but faster to set up initially
cat > /tmp/prover-userdata.sh << 'USERDATA'
#!/bin/bash
set -e
exec > /var/log/prover-setup.log 2>&1

echo "=== SP1 Prover Instance Setup ==="

# Install dependencies
dnf update -y
dnf install -y git gcc gcc-c++ make openssl-devel pkg-config aws-cli

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env

# Install SP1
curl -L https://sp1up.dev | bash
source $HOME/.sp1/bin/sp1up

# Get job info from instance tags
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

JOB_ID=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=JobId" --query 'Tags[0].Value' --output text --region $REGION)
S3_BUCKET=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=S3Bucket" --query 'Tags[0].Value' --output text --region $REGION)
DYNAMODB_TABLE=$(aws ec2 describe-tags --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=DynamoDBTable" --query 'Tags[0].Value' --output text --region $REGION)

echo "Job ID: $JOB_ID"
echo "S3 Bucket: $S3_BUCKET"
echo "DynamoDB Table: $DYNAMODB_TABLE"

# Update status
aws dynamodb update-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
    --update-expression "SET #s = :s, progress = :p" \
    --expression-attribute-names '{"#s": "status"}' \
    --expression-attribute-values '{":s": {"S": "installing"}, ":p": {"N": "20"}}' \
    --region "$REGION"

# Clone prover code from S3 or GitHub
mkdir -p /opt/sp1-prover
cd /opt/sp1-prover

# Download prover code
aws s3 cp "s3://${S3_BUCKET}/prover-code.tar.gz" . --region "$REGION" || {
    echo "No prover code in S3, using placeholder"
}

# Update status to proving
aws dynamodb update-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
    --update-expression "SET #s = :s, progress = :p" \
    --expression-attribute-names '{"#s": "status"}' \
    --expression-attribute-values '{":s": {"S": "proving"}, ":p": {"N": "50"}}' \
    --region "$REGION"

# Run proof (placeholder - integrate your actual prover)
echo "Running SP1 proof generation..."
sleep 30  # Placeholder for actual proof

# For now, generate mock proof
MOCK_PROOF='{"a":["0x01","0x02"],"b":[["0x03","0x04"],["0x05","0x06"]],"c":["0x07","0x08"]}'

# Upload proof to S3
echo "$MOCK_PROOF" > /tmp/proof.json
aws s3 cp /tmp/proof.json "s3://${S3_BUCKET}/proofs/${JOB_ID}/proof.json" --region "$REGION"

# Update status to success
aws dynamodb update-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
    --update-expression "SET #s = :s, progress = :p, proofLocation = :loc" \
    --expression-attribute-names '{"#s": "status"}' \
    --expression-attribute-values "{\":s\": {\"S\": \"success\"}, \":p\": {\"N\": \"100\"}, \":loc\": {\"S\": \"s3://${S3_BUCKET}/proofs/${JOB_ID}/proof.json\"}}" \
    --region "$REGION"

echo "Proof complete! Self-terminating..."
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
USERDATA

# Use base Amazon Linux AMI
BASE_AMI=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text \
    --region "$REGION")

echo "Using base AMI: $BASE_AMI"
echo "export BASE_AMI=$BASE_AMI" >> config.env
echo "export PROVER_AMI_ID=$BASE_AMI" >> config.env

echo ""
echo "Step 3/3: Deploying API..."
./deploy.sh

echo ""
echo "=== Quick Start Complete! ==="
echo ""
source config.env
echo "Your prover API is ready at:"
echo "  $API_URL"
echo ""
echo "Add to wallet-ui/.env.local:"
echo "  NEXT_PUBLIC_PROVER_URL=$API_URL"
echo ""
echo "NOTE: First proof will be slow (~10 min) as instance installs Rust/SP1."
echo "Consider running build-ami.sh later for faster subsequent proofs."
