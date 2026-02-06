#!/bin/bash
# Check status of prover instances and estimated costs

echo "=== SP1 Prover Status ==="
echo ""

REGION=${AWS_REGION:-us-east-1}

# Check for running instances
echo "Running Prover Instances:"
aws ec2 describe-instances \
    --filters "Name=tag:Purpose,Values=sp1-prover" "Name=instance-state-name,Values=pending,running" \
    --query 'Reservations[].Instances[].{ID:InstanceId,Type:InstanceType,State:State.Name,LaunchTime:LaunchTime}' \
    --output table \
    --region "$REGION" 2>/dev/null || echo "  None"

echo ""

# Check recent jobs in DynamoDB
if [ -f config.env ]; then
    source config.env
    echo "Recent Proof Jobs:"
    aws dynamodb scan \
        --table-name "$DYNAMODB_TABLE" \
        --limit 5 \
        --query 'Items[].{JobId:jobId.S,Status:status.S,Progress:progress.N}' \
        --output table \
        --region "$REGION" 2>/dev/null || echo "  No jobs found"
fi

echo ""
echo "Cost Estimate (c7i.48xlarge spot):"
echo "  Hourly rate: ~\$2.50/hr"
echo "  Per minute:  ~\$0.042/min"
echo "  Typical proof (1-2 min): ~\$0.04-0.08"
echo ""
echo "Check actual costs: https://console.aws.amazon.com/cost-management"
