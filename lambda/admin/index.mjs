import { DynamoDBClient, ScanCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminDeleteUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockAgentClient, CreateDataSourceCommand, DeleteDataSourceCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const dynamo      = new DynamoDBClient({});
const cognito     = new CognitoIdentityProviderClient({});
const bedrockAgent = new BedrockAgentClient({});
const s3          = new S3Client({});

const TENANTS_TABLE            = process.env.TENANTS_TABLE;
const CHAT_TABLE               = process.env.CHAT_TABLE;
const USER_POOL_ID             = process.env.USER_POOL_ID;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DEFAULT_DATA_SOURCE_ID   = process.env.DEFAULT_DATA_SOURCE_ID;
const DOCS_BUCKET_ARN          = process.env.DOCS_BUCKET_ARN;
const DOCS_BUCKET_NAME         = process.env.DOCS_BUCKET_NAME;
const TENANT_ADMIN_GROUP       = 'TenantAdmin';

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; }
}

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data),
  };
}

export function parseGroups(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try { return JSON.parse(raw); } catch {}
      return raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }
    return raw.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function getGroupsFromClaims(event) {
  const auth = event.requestContext?.authorizer?.jwt?.claims;
  if (!auth) return [];
  return parseGroups(auth['cognito:groups']);
}

export const handler = async (event) => {
  const auth = event.requestContext?.authorizer?.jwt?.claims || {};
  console.log('AdminFn claims:', JSON.stringify({
    sub: auth['sub'],
    email: auth['email'],
    groups_raw: auth['cognito:groups'],
    groups_type: typeof auth['cognito:groups'],
    path: event.requestContext?.http?.path,
    method: event.requestContext?.http?.method,
  }));

  const groups = getGroupsFromClaims(event);
  const isRootAdmin = groups.includes('RootAdmin');
  console.log('AdminFn parsed groups:', groups, 'isRootAdmin:', isRootAdmin);

  const path   = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};

  if (!isRootAdmin) return jsonResponse(403, { error: 'Forbidden' });

  // ── GET /tenants ──────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/tenants') {
    const scan = await dynamo.send(new ScanCommand({ TableName: TENANTS_TABLE }));
    const hasDefault = (scan.Items || []).some(i => i.tenantId?.S === 'default');
    if (!hasDefault && DEFAULT_KNOWLEDGE_BASE_ID && DEFAULT_DATA_SOURCE_ID) {
      await dynamo.send(new PutItemCommand({
        TableName: TENANTS_TABLE,
        Item: {
          tenantId:       { S: 'default' },
          name:           { S: 'Default' },
          knowledgeBaseId: { S: DEFAULT_KNOWLEDGE_BASE_ID },
          dataSourceId:   { S: DEFAULT_DATA_SOURCE_ID },
          docsPrefix:     { S: 'default/' },
          createdAt:      { S: new Date().toISOString() },
        },
      }));
    }
    const scan2 = await dynamo.send(new ScanCommand({ TableName: TENANTS_TABLE }));
    const tenants = (scan2.Items || []).map(i => ({
      tenantId:  i.tenantId?.S,
      name:      i.name?.S,
      createdAt: i.createdAt?.S,
    }));
    return jsonResponse(200, { tenants });
  }

  // ── POST /tenants ─────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/tenants') {
    const body = parseBody(event);
    const { tenantId, name, adminEmail, temporaryPassword } = body;
    if (!tenantId || !name || !adminEmail || !temporaryPassword) {
      return jsonResponse(400, { error: 'Missing tenantId, name, adminEmail, or temporaryPassword' });
    }
    const id = String(tenantId).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id) return jsonResponse(400, { error: 'Invalid tenantId' });

    // Create Cognito admin user
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: adminEmail,
        TemporaryPassword: temporaryPassword,
        UserAttributes: [
          { Name: 'email',           Value: adminEmail },
          { Name: 'email_verified',  Value: 'true' },
          { Name: 'custom:tenantId', Value: id },
        ],
        MessageAction: 'SUPPRESS',
      }));
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: adminEmail,
        GroupName: TENANT_ADMIN_GROUP,
      }));
    } catch (err) {
      console.error('Cognito create user error:', err);
      return jsonResponse(400, { error: 'Failed to create tenant admin user', detail: err.message });
    }

    // Provision per-tenant Bedrock data source
    let dataSourceId = DEFAULT_DATA_SOURCE_ID || '';
    if (DEFAULT_KNOWLEDGE_BASE_ID && DOCS_BUCKET_ARN) {
      try {
        const dsResult = await bedrockAgent.send(new CreateDataSourceCommand({
          knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
          name: `ds-${id}`,
          dataSourceConfiguration: {
            type: 'S3',
            s3Configuration: { bucketArn: DOCS_BUCKET_ARN, inclusionPrefixes: [`${id}/`] },
          },
          dataDeletionPolicy: 'RETAIN',
        }));
        dataSourceId = dsResult.dataSource.dataSourceId;
        console.log('Created data source', dataSourceId, 'for tenant', id);
      } catch (err) {
        console.error('Bedrock CreateDataSource error (falling back to default):', err);
      }
    }

    // Write DynamoDB record BEFORE creating S3 folder so sync Lambda finds the correct data source
    await dynamo.send(new PutItemCommand({
      TableName: TENANTS_TABLE,
      Item: {
        tenantId:       { S: id },
        name:           { S: String(name) },
        knowledgeBaseId: { S: DEFAULT_KNOWLEDGE_BASE_ID || '' },
        dataSourceId:   { S: dataSourceId },
        docsPrefix:     { S: `${id}/` },
        createdAt:      { S: new Date().toISOString() },
      },
    }));

    // Create S3 folder placeholder (DynamoDB record already exists so sync Lambda uses correct data source)
    if (DOCS_BUCKET_NAME) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: `${id}/`, Body: '' }));
        console.log('Created S3 folder', `${id}/`);
      } catch (err) {
        console.error('S3 folder creation error (non-fatal):', err);
      }
    }

    // Start initial ingestion job so any existing S3 objects are indexed immediately
    if (DEFAULT_KNOWLEDGE_BASE_ID && dataSourceId) {
      try {
        await bedrockAgent.send(new StartIngestionJobCommand({
          knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
          dataSourceId,
        }));
        console.log('Started initial ingestion job for tenant', id, 'dataSource', dataSourceId);
      } catch (err) {
        console.error('StartIngestionJob error (non-fatal):', err);
      }
    }

    return jsonResponse(200, { tenantId: id, name, adminEmail });
  }

  // ── PUT /tenants/{tenantId} ───────────────────────────────────────────────
  const tenantIdParam = pathParams.tenantId;
  if (method === 'PUT' && tenantIdParam) {
    const { name } = parseBody(event);
    if (!name) return jsonResponse(400, { error: 'Missing name' });
    await dynamo.send(new UpdateItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId: { S: tenantIdParam } },
      UpdateExpression: 'SET #n = :name',
      ExpressionAttributeNames:  { '#n': 'name' },
      ExpressionAttributeValues: { ':name': { S: String(name) } },
    }));
    return jsonResponse(200, { tenantId: tenantIdParam, name });
  }

  // ── DELETE /tenants/{tenantId} ────────────────────────────────────────────
  if (method === 'DELETE' && tenantIdParam) {
    try {
      // Fetch tenant record first to get dataSourceId, knowledgeBaseId
      let tenantItem;
      try {
        const getRes = await dynamo.send(new GetItemCommand({
          TableName: TENANTS_TABLE,
          Key: { tenantId: { S: tenantIdParam } },
        }));
        tenantItem = getRes.Item;
      } catch (err) {
        console.error('Error fetching tenant record (non-fatal):', err);
      }
      const kbId = tenantItem?.knowledgeBaseId?.S;
      const dsId = tenantItem?.dataSourceId?.S;

      // 1. Delete S3 objects under tenant prefix
      if (DOCS_BUCKET_NAME) {
        try {
          let continuationToken;
          do {
            const listRes = await s3.send(new ListObjectsV2Command({
              Bucket: DOCS_BUCKET_NAME,
              Prefix: `${tenantIdParam}/`,
              ContinuationToken: continuationToken,
            }));
            const objects = (listRes.Contents || []).map(o => ({ Key: o.Key }));
            if (objects.length > 0) {
              await s3.send(new DeleteObjectsCommand({
                Bucket: DOCS_BUCKET_NAME,
                Delete: { Objects: objects, Quiet: true },
              }));
              console.log('Deleted', objects.length, 'S3 objects for tenant', tenantIdParam);
            }
            continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
          } while (continuationToken);
        } catch (err) {
          console.error('Error deleting S3 objects (non-fatal):', err);
        }
      }

      // 2. Delete Bedrock data source (skip if it's the shared default)
      if (kbId && dsId && dsId !== DEFAULT_DATA_SOURCE_ID) {
        try {
          await bedrockAgent.send(new DeleteDataSourceCommand({
            knowledgeBaseId: kbId,
            dataSourceId: dsId,
          }));
          console.log('Deleted Bedrock data source', dsId, 'for tenant', tenantIdParam);
        } catch (err) {
          // ConflictException: vector store deletion not permitted — data source is left orphaned
          // but S3 objects and DynamoDB record are already removed so it causes no harm
          console.error('Error deleting Bedrock data source (non-fatal, may need manual cleanup):', err.message);
        }
      }

      // 3. Delete chat history from DynamoDB
      if (CHAT_TABLE) {
        try {
          let lastKey;
          do {
            const scanRes = await dynamo.send(new ScanCommand({
              TableName: CHAT_TABLE,
              FilterExpression: 'begins_with(tenantUser, :prefix)',
              ExpressionAttributeValues: { ':prefix': { S: `${tenantIdParam}#` } },
              ExclusiveStartKey: lastKey,
            }));
            const items = scanRes.Items || [];
            await Promise.all(items.map(item =>
              dynamo.send(new DeleteItemCommand({
                TableName: CHAT_TABLE,
                Key: { tenantUser: item.tenantUser, timestamp: item.timestamp },
              }))
            ));
            console.log('Deleted', items.length, 'chat history items for tenant', tenantIdParam);
            lastKey = scanRes.LastEvaluatedKey;
          } while (lastKey);
        } catch (err) {
          console.error('Error deleting chat history (non-fatal):', err);
        }
      }

      // 4. Delete DynamoDB tenant record
      try {
        await dynamo.send(new DeleteItemCommand({
          TableName: TENANTS_TABLE,
          Key: { tenantId: { S: tenantIdParam } },
        }));
      } catch (err) {
        console.error('Error deleting tenant DynamoDB record:', err);
        throw err; // re-throw — this is the critical step
      }

      // 5. Delete all Cognito users belonging to this tenant
      try {
        const list = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
        const toDelete = (list.Users || []).filter(u =>
          (u.Attributes || []).some(a => a.Name === 'custom:tenantId' && a.Value === tenantIdParam)
        );
        await Promise.all(toDelete.map(u =>
          cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: u.Username }))
        ));
        console.log('Deleted', toDelete.length, 'Cognito users for tenant', tenantIdParam);
      } catch (err) {
        console.error('Error deleting Cognito users (non-fatal):', err);
      }

      return jsonResponse(200, { deleted: tenantIdParam });
    } catch (err) {
      console.error('DELETE /tenants error:', err);
      return jsonResponse(500, { error: err.message || 'Failed to delete tenant' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
