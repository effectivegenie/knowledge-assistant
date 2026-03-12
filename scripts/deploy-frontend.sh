#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "==> Generating frontend config from CDK outputs..."
node scripts/generate-config.js

echo "==> Building frontend..."
(cd frontend && npm run build)

BUCKET=$(node -e "const o=require('./cdk-outputs.json');console.log(o.KnowledgeAssistantStack.FrontendBucketName)")
DIST_ID=$(node -e "const o=require('./cdk-outputs.json');console.log(o.KnowledgeAssistantStack.DistributionId)")

echo "==> Uploading frontend to S3 (${BUCKET})..."
aws s3 sync frontend/dist "s3://${BUCKET}" --delete

echo "==> Invalidating CloudFront cache (${DIST_ID})..."
aws cloudfront create-invalidation --distribution-id "${DIST_ID}" --paths "/*" --no-cli-pager

echo "==> Done!"
CLOUDFRONT_URL=$(node -e "const o=require('./cdk-outputs.json');console.log(o.KnowledgeAssistantStack.CloudFrontUrl)")
echo "App available at: ${CLOUDFRONT_URL}"
