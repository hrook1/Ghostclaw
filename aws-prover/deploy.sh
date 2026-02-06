#!/bin/bash
set -e

echo "=== Deploying SP1 Prover Infrastructure ==="
echo ""

# Load config
if [ ! -f config.env ]; then
    echo "ERROR: Run setup-aws.sh first"
    exit 1
fi
source config.env

if [ -z "$PROVER_AMI_ID" ]; then
    echo "ERROR: Run build-ami.sh first to create the prover AMI"
    exit 1
fi

echo "Using config:"
echo "  Region: $AWS_REGION"
echo "  AMI: $PROVER_AMI_ID"
echo "  S3 Bucket: $S3_BUCKET"
echo "  DynamoDB Table: $DYNAMODB_TABLE"
echo ""

# Build Lambda package
echo "Building Lambda package..."
cd lambda
npm install --omit=dev
zip -r ../lambda-package.zip .
cd ..

# Create/Update Lambda function
LAMBDA_NAME="sp1-prover-api"
echo "Deploying Lambda: $LAMBDA_NAME"

# Check if function exists
if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$AWS_REGION" 2>/dev/null; then
    echo "  Updating existing function..."
    aws lambda update-function-code \
        --function-name "$LAMBDA_NAME" \
        --zip-file fileb://lambda-package.zip \
        --region "$AWS_REGION"
else
    echo "  Creating new function..."
    aws lambda create-function \
        --function-name "$LAMBDA_NAME" \
        --runtime nodejs20.x \
        --handler index.handler \
        --role "$LAMBDA_ROLE_ARN" \
        --zip-file fileb://lambda-package.zip \
        --timeout 30 \
        --memory-size 256 \
        --environment "Variables={PROVER_AMI_ID=$PROVER_AMI_ID,SECURITY_GROUP_ID=$SECURITY_GROUP_ID,IAM_INSTANCE_PROFILE=$EC2_PROFILE_NAME,DYNAMODB_TABLE=$DYNAMODB_TABLE,S3_BUCKET=$S3_BUCKET,INSTANCE_TYPE=c7i.48xlarge,PROVER_REGION=$AWS_REGION}" \
        --region "$AWS_REGION"
fi

# Wait for function to be ready
echo "  Waiting for Lambda to be ready..."
aws lambda wait function-active --function-name "$LAMBDA_NAME" --region "$AWS_REGION"

# Update environment variables (in case they changed)
aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --environment "Variables={PROVER_AMI_ID=$PROVER_AMI_ID,SECURITY_GROUP_ID=$SECURITY_GROUP_ID,IAM_INSTANCE_PROFILE=$EC2_PROFILE_NAME,DYNAMODB_TABLE=$DYNAMODB_TABLE,S3_BUCKET=$S3_BUCKET,INSTANCE_TYPE=c7i.48xlarge,PROVER_REGION=$AWS_REGION}" \
    --region "$AWS_REGION" > /dev/null

# Create API Gateway
API_NAME="sp1-prover-api"
echo "Setting up API Gateway: $API_NAME"

# Check if API exists
EXISTING_API=$(aws apigatewayv2 get-apis \
    --query "Items[?Name=='$API_NAME'].ApiId" \
    --output text \
    --region "$AWS_REGION")

if [ -n "$EXISTING_API" ] && [ "$EXISTING_API" != "None" ]; then
    API_ID=$EXISTING_API
    echo "  Using existing API: $API_ID"
else
    # Create HTTP API
    API_ID=$(aws apigatewayv2 create-api \
        --name "$API_NAME" \
        --protocol-type HTTP \
        --cors-configuration "AllowOrigins=*,AllowMethods=GET,POST,OPTIONS,AllowHeaders=Content-Type" \
        --query 'ApiId' \
        --output text \
        --region "$AWS_REGION")
    echo "  Created API: $API_ID"
fi

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function \
    --function-name "$LAMBDA_NAME" \
    --query 'Configuration.FunctionArn' \
    --output text \
    --region "$AWS_REGION")

# Create/Update integration
echo "  Setting up Lambda integration..."
EXISTING_INTEGRATION=$(aws apigatewayv2 get-integrations \
    --api-id "$API_ID" \
    --query "Items[0].IntegrationId" \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "")

if [ -n "$EXISTING_INTEGRATION" ] && [ "$EXISTING_INTEGRATION" != "None" ]; then
    INTEGRATION_ID=$EXISTING_INTEGRATION
else
    INTEGRATION_ID=$(aws apigatewayv2 create-integration \
        --api-id "$API_ID" \
        --integration-type AWS_PROXY \
        --integration-uri "$LAMBDA_ARN" \
        --payload-format-version "2.0" \
        --query 'IntegrationId' \
        --output text \
        --region "$AWS_REGION")
fi

# Create routes
echo "  Creating API routes..."
for ROUTE in "POST /api/generate-proof" "GET /api/proof-status/{jobId}" "GET /api/health" "OPTIONS /{proxy+}"; do
    ROUTE_KEY=$(echo "$ROUTE" | sed 's/ /%20/g')

    # Check if route exists
    EXISTING_ROUTE=$(aws apigatewayv2 get-routes \
        --api-id "$API_ID" \
        --query "Items[?RouteKey=='$ROUTE'].RouteId" \
        --output text \
        --region "$AWS_REGION" 2>/dev/null || echo "")

    if [ -z "$EXISTING_ROUTE" ] || [ "$EXISTING_ROUTE" == "None" ]; then
        aws apigatewayv2 create-route \
            --api-id "$API_ID" \
            --route-key "$ROUTE" \
            --target "integrations/$INTEGRATION_ID" \
            --region "$AWS_REGION" > /dev/null
        echo "    Created route: $ROUTE"
    fi
done

# Create default stage
echo "  Creating prod stage..."
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name "prod" --region "$AWS_REGION" 2>/dev/null; then
    aws apigatewayv2 create-stage \
        --api-id "$API_ID" \
        --stage-name "prod" \
        --auto-deploy \
        --region "$AWS_REGION" > /dev/null
fi

# Add Lambda permission for API Gateway
echo "  Adding Lambda permissions..."
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "apigateway-invoke-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$AWS_REGION:$AWS_ACCOUNT_ID:$API_ID/*" \
    --region "$AWS_REGION" 2>/dev/null || true

# Get API URL
API_URL="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/prod"

# Save to config
echo "export API_URL=$API_URL" >> config.env
echo "export API_ID=$API_ID" >> config.env

# Clean up
rm -f lambda-package.zip

echo ""
echo "=== Deployment Complete! ==="
echo ""
echo "API URL: $API_URL"
echo ""
echo "Test endpoints:"
echo "  Health:     curl $API_URL/api/health"
echo "  Gen Proof:  curl -X POST $API_URL/api/generate-proof -H 'Content-Type: application/json' -d '{\"inputCommitments\":[\"0x01\"],\"nullifiers\":[\"0x01\"]}'"
echo ""
echo "Update your app's config:"
echo "  NEXT_PUBLIC_PROVER_URL=$API_URL"
echo ""
echo "Add this to wallet-ui/.env.local:"
echo "  NEXT_PUBLIC_PROVER_URL=$API_URL"
