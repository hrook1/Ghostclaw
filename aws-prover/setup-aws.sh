#!/bin/bash
set -e

echo "=== SP1 Prover AWS Setup ==="
echo ""

# Check AWS CLI is configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "ERROR: AWS CLI not configured. Run 'aws configure' first."
    exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

echo "Account: $ACCOUNT_ID"
echo "Region: $REGION"
echo ""

# 1. Create S3 bucket for proofs
BUCKET_NAME="sp1-proofs-${ACCOUNT_ID}"
echo "Creating S3 bucket: $BUCKET_NAME"
if aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
    echo "  Bucket already exists"
else
    aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
        $([ "$REGION" != "us-east-1" ] && echo "--create-bucket-configuration LocationConstraint=$REGION")
    echo "  Created!"
fi

# 2. Create DynamoDB table for job tracking
TABLE_NAME="sp1-prover-jobs"
echo "Creating DynamoDB table: $TABLE_NAME"
if aws dynamodb describe-table --table-name "$TABLE_NAME" 2>/dev/null; then
    echo "  Table already exists"
else
    aws dynamodb create-table \
        --table-name "$TABLE_NAME" \
        --attribute-definitions AttributeName=jobId,AttributeType=S \
        --key-schema AttributeName=jobId,KeyType=HASH \
        --billing-mode PAY_PER_REQUEST \
        --region "$REGION"
    echo "  Created! Waiting for table to be active..."
    aws dynamodb wait table-exists --table-name "$TABLE_NAME"
fi

# 3. Create IAM role for EC2 prover instances
ROLE_NAME="sp1-prover-ec2-role"
echo "Creating IAM role: $ROLE_NAME"

# Trust policy for EC2
cat > /tmp/ec2-trust-policy.json << 'EOF'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "ec2.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
    echo "  Role already exists"
else
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document file:///tmp/ec2-trust-policy.json
    echo "  Created!"
fi

# Attach policies
echo "  Attaching policies..."
cat > /tmp/prover-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:UpdateItem",
                "dynamodb:GetItem"
            ],
            "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"
        }
    ]
}
EOF

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "sp1-prover-access" \
    --policy-document file:///tmp/prover-policy.json

# Create instance profile
PROFILE_NAME="sp1-prover-profile"
if aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" 2>/dev/null; then
    echo "  Instance profile already exists"
else
    aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME"
    aws iam add-role-to-instance-profile \
        --instance-profile-name "$PROFILE_NAME" \
        --role-name "$ROLE_NAME"
    echo "  Created instance profile!"
fi

# 4. Create IAM role for Lambda
LAMBDA_ROLE_NAME="sp1-prover-lambda-role"
echo "Creating Lambda role: $LAMBDA_ROLE_NAME"

cat > /tmp/lambda-trust-policy.json << 'EOF'
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "lambda.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF

if aws iam get-role --role-name "$LAMBDA_ROLE_NAME" 2>/dev/null; then
    echo "  Role already exists"
else
    aws iam create-role \
        --role-name "$LAMBDA_ROLE_NAME" \
        --assume-role-policy-document file:///tmp/lambda-trust-policy.json
    echo "  Created!"
fi

# Lambda policy
cat > /tmp/lambda-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "arn:aws:logs:*:*:*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "ec2:RunInstances",
                "ec2:DescribeInstances",
                "ec2:TerminateInstances",
                "ec2:CreateTags"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "iam:PassRole"
            ],
            "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
        },
        {
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:GetItem",
                "dynamodb:UpdateItem",
                "dynamodb:Query"
            ],
            "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
        }
    ]
}
EOF

aws iam put-role-policy \
    --role-name "$LAMBDA_ROLE_NAME" \
    --policy-name "sp1-prover-lambda-access" \
    --policy-document file:///tmp/lambda-policy.json

# 5. Create security group for prover instances
SG_NAME="sp1-prover-sg"
echo "Creating security group: $SG_NAME"

VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)

if aws ec2 describe-security-groups --group-names "$SG_NAME" 2>/dev/null; then
    echo "  Security group already exists"
    SG_ID=$(aws ec2 describe-security-groups --group-names "$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text)
else
    SG_ID=$(aws ec2 create-security-group \
        --group-name "$SG_NAME" \
        --description "Security group for SP1 prover instances" \
        --vpc-id "$VPC_ID" \
        --query 'GroupId' --output text)

    # Allow outbound only (no inbound needed)
    echo "  Created: $SG_ID"
fi

# Save config
cat > config.env << EOF
# Generated by setup-aws.sh on $(date)
export AWS_REGION=$REGION
export AWS_ACCOUNT_ID=$ACCOUNT_ID
export S3_BUCKET=$BUCKET_NAME
export DYNAMODB_TABLE=$TABLE_NAME
export EC2_ROLE_NAME=$ROLE_NAME
export EC2_PROFILE_NAME=$PROFILE_NAME
export LAMBDA_ROLE_NAME=$LAMBDA_ROLE_NAME
export LAMBDA_ROLE_ARN=arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}
export SECURITY_GROUP_ID=$SG_ID
export VPC_ID=$VPC_ID
EOF

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Config saved to: config.env"
echo ""
echo "Next steps:"
echo "  1. Run ./build-ami.sh to create the prover AMI"
echo "  2. Run ./deploy.sh to deploy Lambda + API Gateway"
