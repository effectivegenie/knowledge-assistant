import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const bedrockClient = new BedrockAgentClient({});
const dynamo = new DynamoDBClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DEFAULT_DATA_SOURCE_ID = process.env.DEFAULT_DATA_SOURCE_ID;

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

export function getTenantIdFromKey(key) {
  if (!key || typeof key !== 'string') return 'default';
  const parts = key.split('/').filter(Boolean);
  return parts[0] || 'default';
}

// Normalize SNS-wrapped S3 events (SNS fanout pattern)
function extractS3Record(event) {
  const first = (event.Records || [])[0];
  if (!first) return null;
  if (first.EventSource === 'aws:sns') {
    const inner = JSON.parse(first.Sns?.Message || '{}');
    return (inner.Records || [])[0] || null;
  }
  return first;
}

export const handler = async (event) => {
  const record = extractS3Record(event);
  const key = record?.s3?.object?.key;
  const bucket = record?.s3?.bucket?.name;
  const tenantId = decodeURIComponent(getTenantIdFromKey(key));

  log.info('S3 sync triggered', { bucket, key, tenantId });

  let knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID;
  let dataSourceId = DEFAULT_DATA_SOURCE_ID;

  if (tenantId !== 'default' && TENANTS_TABLE) {
    const resp = await dynamo.send(new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }));
    if (resp.Item?.knowledgeBaseId?.S) knowledgeBaseId = resp.Item.knowledgeBaseId.S;
    if (resp.Item?.dataSourceId?.S) dataSourceId = resp.Item.dataSourceId.S;
    log.debug('Resolved tenant KB config', { tenantId, knowledgeBaseId, dataSourceId });
  } else {
    log.debug('Using default KB config', { tenantId, knowledgeBaseId, dataSourceId });
  }

  if (!knowledgeBaseId || !dataSourceId) {
    log.warn('No KB/dataSource configured for tenant — skipping sync', { tenantId });
    return;
  }

  try {
    await bedrockClient.send(new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
    }));
    log.info('Ingestion job started', { tenantId, knowledgeBaseId, dataSourceId });
  } catch (err) {
    log.error('Failed to start ingestion job', { tenantId, knowledgeBaseId, dataSourceId, error: err.message });
    throw err;
  }
};
