#!/bin/bash
# Emergency script to terminate ALL prover instances

echo "=== Emergency Instance Terminator ==="
echo ""

REGION=${AWS_REGION:-us-east-1}

# Find all prover instances
INSTANCES=$(aws ec2 describe-instances \
    --filters "Name=tag:Purpose,Values=sp1-prover" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text \
    --region "$REGION")

if [ -z "$INSTANCES" ]; then
    echo "No prover instances found. You're safe!"
    exit 0
fi

echo "Found instances: $INSTANCES"
echo ""
echo "Terminating..."

for INSTANCE in $INSTANCES; do
    echo "  Terminating $INSTANCE..."
    aws ec2 terminate-instances --instance-ids "$INSTANCE" --region "$REGION" > /dev/null
done

echo ""
echo "Done! All prover instances terminated."
echo ""
echo "Check your EC2 console to confirm: https://console.aws.amazon.com/ec2"
