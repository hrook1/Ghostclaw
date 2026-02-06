const { EC2Client, RunInstancesCommand, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const ec2 = new EC2Client({});
const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});

// Environment variables (set in Lambda config)
const {
  PROVER_AMI_ID,
  SECURITY_GROUP_ID,
  IAM_INSTANCE_PROFILE,
  DYNAMODB_TABLE,
  S3_BUCKET,
  INSTANCE_TYPE = 'c7i.48xlarge', // 192 vCPUs - BEAST MODE for fast proofs
  PROVER_REGION,
  AWS_REGION // Lambda provides this automatically
} = process.env;

// Use PROVER_REGION if set, otherwise fall back to AWS_REGION
const REGION = PROVER_REGION || AWS_REGION;

// Generate unique job ID
function generateJobId() {
  return `proof-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Response helper
function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
  };
}

// Save proof request to S3
async function saveProofRequest(jobId, proofRequest) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `jobs/${jobId}/request.json`,
    Body: JSON.stringify(proofRequest),
    ContentType: 'application/json'
  }));
}

// Launch EC2 Spot instance for proving
async function launchProverInstance(jobId, proofRequest) {
  // Save proof request to S3 first
  await saveProofRequest(jobId, proofRequest);

  const userData = Buffer.from(`#!/bin/bash
set -e
exec > /var/log/prover-startup.log 2>&1

echo "Starting prover for job: ${jobId}"
echo "Region: ${REGION}"
echo "S3 Bucket: ${S3_BUCKET}"

# Install AWS CLI if not present
if ! command -v aws &> /dev/null; then
    echo "Installing AWS CLI..."
    dnf install -y aws-cli || yum install -y aws-cli || apt-get install -y awscli
fi

# Download and run the proof script from S3
echo "Downloading run-proof.sh from S3..."
aws s3 cp "s3://${S3_BUCKET}/scripts/run-proof.sh" /tmp/run-proof.sh --region ${REGION}
chmod +x /tmp/run-proof.sh

# Run the proof script
/tmp/run-proof.sh "${jobId}" "${S3_BUCKET}" "${DYNAMODB_TABLE}" "${REGION}"
`).toString('base64');

  const command = new RunInstancesCommand({
    ImageId: PROVER_AMI_ID,
    InstanceType: INSTANCE_TYPE,
    MinCount: 1,
    MaxCount: 1,
    IamInstanceProfile: {
      Name: IAM_INSTANCE_PROFILE
    },
    SecurityGroupIds: [SECURITY_GROUP_ID],
    UserData: userData,
    InstanceMarketOptions: {
      MarketType: 'spot',
      SpotOptions: {
        SpotInstanceType: 'one-time',
        InstanceInterruptionBehavior: 'terminate'
      }
    },
    TagSpecifications: [{
      ResourceType: 'instance',
      Tags: [
        { Key: 'Name', Value: `sp1-prover-${jobId}` },
        { Key: 'Purpose', Value: 'sp1-prover' },
        { Key: 'JobId', Value: jobId }
      ]
    }]
  });

  const result = await ec2.send(command);
  return result.Instances[0].InstanceId;
}

// Main handler
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  const path = event.path || event.rawPath || '';
  const method = event.httpMethod || event.requestContext?.http?.method;

  try {
    // Health check
    if (path.endsWith('/health') || path === '/health') {
      return response(200, {
        status: 'ok',
        prover: 'aws-spot',
        instanceType: INSTANCE_TYPE
      });
    }

    // Generate proof
    if (path.endsWith('/generate-proof') && method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { inputCommitments, outputCommitments, nullifiers } = body;

      if (!inputCommitments || !nullifiers) {
        return response(400, { error: 'Missing required fields' });
      }

      const jobId = generateJobId();

      // Store job in DynamoDB
      await dynamodb.send(new PutCommand({
        TableName: DYNAMODB_TABLE,
        Item: {
          jobId,
          status: 'starting',
          progress: 0,
          createdAt: new Date().toISOString(),
          request: { inputCommitments, outputCommitments, nullifiers }
        }
      }));

      // Launch EC2 Spot instance
      console.log(`Launching prover instance for job ${jobId}`);
      const instanceId = await launchProverInstance(jobId, body);
      console.log(`Instance launched: ${instanceId}`);

      // Update job with instance ID
      await dynamodb.send(new UpdateCommand({
        TableName: DYNAMODB_TABLE,
        Key: { jobId },
        UpdateExpression: 'SET instanceId = :iid, #s = :s, progress = :p',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':iid': instanceId,
          ':s': 'launching',
          ':p': 5
        }
      }));

      return response(200, {
        jobId,
        message: 'Proof generation started. Instance launching (~60s), then proof generation (~5-20 min).'
      });
    }

    // Check proof status
    if (path.includes('/proof-status/')) {
      const jobId = path.split('/proof-status/')[1];

      if (!jobId) {
        return response(400, { error: 'Missing job ID' });
      }

      const result = await dynamodb.send(new GetCommand({
        TableName: DYNAMODB_TABLE,
        Key: { jobId }
      }));

      if (!result.Item) {
        return response(404, { error: 'Job not found' });
      }

      const job = result.Item;

      // If complete, fetch and include proof data from S3
      if (job.status === 'success' && job.proofLocation) {
        try {
          const proofResponse = await s3.send(new GetObjectCommand({
            Bucket: S3_BUCKET,
            Key: `proofs/${jobId}/proof.json`
          }));
          const proofData = await proofResponse.Body.transformToString();
          const proof = JSON.parse(proofData);

          return response(200, {
            status: job.status,
            progress: job.progress,
            proof: proof
          });
        } catch (s3Error) {
          console.error('Failed to fetch proof from S3:', s3Error);
          return response(200, {
            status: job.status,
            progress: job.progress,
            error: 'Proof completed but failed to fetch from storage'
          });
        }
      }

      return response(200, {
        status: job.status,
        progress: job.progress || 0,
        error: job.errorMessage
      });
    }

    return response(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return response(500, { error: error.message });
  }
};
