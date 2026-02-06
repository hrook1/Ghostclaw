#!/bin/bash
set -e

echo "=== Building SP1 Prover AMI ==="
echo ""

# Load config
if [ ! -f config.env ]; then
    echo "ERROR: Run setup-aws.sh first"
    exit 1
fi
source config.env

REGION=${AWS_REGION:-eu-west-1}

# Get latest Amazon Linux 2023 AMI
BASE_AMI=$(aws ec2 describe-images \
    --owners amazon \
    --filters "Name=name,Values=al2023-ami-2023*-x86_64" "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text \
    --region "$REGION")

echo "Base AMI: $BASE_AMI"

# Create user data script file
USER_DATA_FILE=$(mktemp)
cat > "$USER_DATA_FILE" << 'USERDATA'
#!/bin/bash
set -e
exec > /var/log/ami-setup.log 2>&1

echo "=== Installing SP1 Prover Dependencies ==="

# Update system
dnf update -y
dnf install -y git gcc gcc-c++ make openssl-devel pkg-config clang awscli

# Install Rust for root
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source /root/.cargo/env

# Install SP1
echo "Installing SP1..."
curl -L https://sp1up.dev | bash
export PATH="/root/.sp1/bin:$PATH"
/root/.sp1/bin/sp1up

# Verify installations
rustc --version
cargo --version
/root/.sp1/bin/cargo-prove --version || echo "SP1 installed"

# Create prover directory
mkdir -p /opt/sp1-prover

# Create marker file
echo "SP1 Prover AMI Ready" > /opt/sp1-prover/READY
date >> /opt/sp1-prover/READY

echo "=== Setup Complete ==="
USERDATA

echo "User data script created at: $USER_DATA_FILE"

# Launch instance for AMI creation
echo "Launching build instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$BASE_AMI" \
    --instance-type c7i.xlarge \
    --iam-instance-profile Name="$EC2_PROFILE_NAME" \
    --security-group-ids "$SECURITY_GROUP_ID" \
    --user-data "file://$USER_DATA_FILE" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=sp1-prover-ami-builder},{Key=Purpose,Value=ami-build}]" \
    --query 'Instances[0].InstanceId' \
    --output text \
    --region "$REGION")

# Clean up temp file
rm -f "$USER_DATA_FILE"

echo "Build instance: $INSTANCE_ID"
echo ""
echo "Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

echo ""
echo "Instance is running. Setup will take ~15-20 minutes."
echo "You can monitor with: aws ec2 get-console-output --instance-id $INSTANCE_ID --region $REGION"
echo ""
echo "When setup completes, run:"
echo "  ./create-ami-from-instance.sh $INSTANCE_ID"
echo ""
echo "Or wait and this script will check automatically..."

# Wait for setup to complete (check every 60 seconds for up to 30 minutes)
echo ""
echo "Waiting for setup to complete..."
for i in {1..30}; do
    sleep 60
    echo "  Checking... (attempt $i/30)"

    # Try to check if the READY file exists via SSM or console output
    CONSOLE=$(aws ec2 get-console-output --instance-id "$INSTANCE_ID" --region "$REGION" --query 'Output' --output text 2>/dev/null || echo "")

    if echo "$CONSOLE" | grep -q "Setup Complete"; then
        echo ""
        echo "Setup complete! Creating AMI..."
        break
    fi

    if [ $i -eq 30 ]; then
        echo ""
        echo "Timeout waiting for setup. Check instance manually."
        echo "Instance ID: $INSTANCE_ID"
        exit 1
    fi
done

# Create AMI
AMI_NAME="sp1-prover-$(date +%Y%m%d-%H%M%S)"
echo "Creating AMI: $AMI_NAME"

NEW_AMI_ID=$(aws ec2 create-image \
    --instance-id "$INSTANCE_ID" \
    --name "$AMI_NAME" \
    --description "SP1 Prover with Rust and SP1 pre-installed" \
    --query 'ImageId' \
    --output text \
    --region "$REGION")

echo "AMI ID: $NEW_AMI_ID"
echo ""
echo "Waiting for AMI to be available..."
aws ec2 wait image-available --image-ids "$NEW_AMI_ID" --region "$REGION"

# Terminate build instance
echo "Terminating build instance..."
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID" --region "$REGION" > /dev/null

# Update config
echo "export PROVER_AMI_ID=$NEW_AMI_ID" >> config.env
sed -i '' "s/PROVER_AMI_ID=.*/PROVER_AMI_ID=$NEW_AMI_ID/" config.env 2>/dev/null || true

echo ""
echo "=== AMI Build Complete! ==="
echo ""
echo "New AMI: $NEW_AMI_ID"
echo ""
echo "To use it, redeploy Lambda:"
echo "  ./deploy.sh"
