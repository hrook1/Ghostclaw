#!/bin/bash
set -e
exec > /var/log/prover-run.log 2>&1

JOB_ID="$1"
S3_BUCKET="$2"
DYNAMODB_TABLE="$3"
REGION="$4"

echo "=== SP1 Prover Starting ==="
echo "Job ID: $JOB_ID"
echo "S3 Bucket: $S3_BUCKET"
echo "DynamoDB Table: $DYNAMODB_TABLE"
echo "Region: $REGION"

INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
echo "Instance ID: $INSTANCE_ID"

# Function to update status
update_status() {
    local status="$1"
    local progress="$2"
    aws dynamodb update-item \
        --table-name "$DYNAMODB_TABLE" \
        --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
        --update-expression "SET #s = :s, progress = :p" \
        --expression-attribute-names '{"#s": "status"}' \
        --expression-attribute-values "{\":s\": {\"S\": \"$status\"}, \":p\": {\"N\": \"$progress\"}}" \
        --region "$REGION"
}

# Function to handle errors
handle_error() {
    local error_msg="$1"
    echo "ERROR: $error_msg"
    aws dynamodb update-item \
        --table-name "$DYNAMODB_TABLE" \
        --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
        --update-expression "SET #s = :s, errorMessage = :e" \
        --expression-attribute-names '{"#s": "status"}' \
        --expression-attribute-values "{\":s\": {\"S\": \"failed\"}, \":e\": {\"S\": \"$error_msg\"}}" \
        --region "$REGION"

    # Self-terminate on error
    aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
    exit 1
}

# Update status: downloading code
update_status "downloading" 10

# Download prover code from S3
echo "Downloading prover code from S3..."
mkdir -p /opt/sp1-prover
cd /opt/sp1-prover

aws s3 cp "s3://${S3_BUCKET}/prover-code.tar.gz" . --region "$REGION" || handle_error "Failed to download prover code"
tar -xzf prover-code.tar.gz || handle_error "Failed to extract prover code"

# Download proof request
echo "Downloading proof request..."
aws s3 cp "s3://${S3_BUCKET}/jobs/${JOB_ID}/request.json" . --region "$REGION" || handle_error "Failed to download proof request"

update_status "installing" 20

# Check if Rust is installed, if not install it
if ! command -v cargo &> /dev/null; then
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi

# Check if SP1 is installed, if not install it
if ! command -v sp1up &> /dev/null; then
    echo "Installing SP1..."
    curl -L https://sp1up.dev | bash
    export PATH="$HOME/.sp1/bin:$PATH"
    sp1up || echo "SP1 already installed or install completed"
fi

# Ensure paths are set
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$PATH"

update_status "building" 30

# Build the prover if needed
cd /opt/sp1-prover/prover/host
echo "Building prover..."
cargo build --release 2>&1 || handle_error "Failed to build prover"

update_status "proving" 50

# Run the proof generation
echo "Generating proof..."
# The proof request contains the transaction data
# We need to run the prover with the appropriate inputs

# Read request data
REQUEST_DATA=$(cat /opt/sp1-prover/request.json)
echo "Request data: $REQUEST_DATA"

# Run SP1 prover (using CPU mode for simplicity)
export SP1_PROVER=cpu
cd /opt/sp1-prover/prover/host

# Generate the Groth16 proof
cargo run --release --bin generate_groth16_proof -- --request-file /opt/sp1-prover/request.json --output-file /tmp/proof.json 2>&1 || handle_error "Proof generation failed"

update_status "uploading" 90

# Upload proof to S3
echo "Uploading proof to S3..."
aws s3 cp /tmp/proof.json "s3://${S3_BUCKET}/proofs/${JOB_ID}/proof.json" --region "$REGION" || handle_error "Failed to upload proof"

# Update status to success
aws dynamodb update-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"jobId\": {\"S\": \"$JOB_ID\"}}" \
    --update-expression "SET #s = :s, progress = :p, proofLocation = :loc, completedAt = :t" \
    --expression-attribute-names '{"#s": "status"}' \
    --expression-attribute-values "{\":s\": {\"S\": \"success\"}, \":p\": {\"N\": \"100\"}, \":loc\": {\"S\": \"s3://${S3_BUCKET}/proofs/${JOB_ID}/proof.json\"}, \":t\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" \
    --region "$REGION"

echo "=== Proof Complete! ==="
echo "Self-terminating instance..."

# Self-terminate
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION"
