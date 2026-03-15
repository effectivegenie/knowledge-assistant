import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

const bedrockClient = new BedrockAgentClient({});
const dynamo = new DynamoDBClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DEFAULT_DATA_SOURCE_ID = process.env.DEFAULT_DATA_SOURCE_ID;

function getTenantIdFromKey(key) {
  if (!key || typeof key !== 'string') return 'default';
  const parts = key.split('/').filter(Boolean);
  return parts[0] || 'default';
}

export const handler = async (event) => {
  console.log('Received S3 event for KB sync:', JSON.stringify(event));

  const record = event.Records?.[0];
  const key = record?.s3?.object?.key;
  const tenantId = decodeURIComponent(getTenantIdFromKey(key));

  let knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID;
  let dataSourceId = DEFAULT_DATA_SOURCE_ID;

  if (tenantId !== 'default' && TENANTS_TABLE) {
    const resp = await dynamo.send(new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }));
    if (resp.Item?.knowledgeBaseId?.S) knowledgeBaseId = resp.Item.knowledgeBaseId.S;
    if (resp.Item?.dataSourceId?.S) dataSourceId = resp.Item.dataSourceId.S;
  }

  if (!knowledgeBaseId || !dataSourceId) {
    console.warn('No KB/dataSource for tenant', tenantId, '- skipping sync');
    return;
  }

  try {
    await bedrockClient.send(new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
    }));
    console.log('Started ingestion job for tenant', tenantId, 'KB:', knowledgeBaseId);
  } catch (err) {
    console.error('Failed to start ingestion job:', err);
    throw err;
  }
};
