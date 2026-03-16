import { DynamoDBClient, ScanCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminDeleteUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockAgentClient, CreateDataSourceCommand, DeleteDataSourceCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const dynamo      = new DynamoDBClient({});
const cognito     = new CognitoIdentityProviderClient({});
const bedrockAgent = new BedrockAgentClient({});
const s3          = new S3Client({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const TENANTS_TABLE            = process.env.TENANTS_TABLE;
const CHAT_TABLE               = process.env.CHAT_TABLE;
const USER_POOL_ID             = process.env.USER_POOL_ID;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DEFAULT_DATA_SOURCE_ID   = process.env.DEFAULT_DATA_SOURCE_ID;
const DOCS_BUCKET_ARN          = process.env.DOCS_BUCKET_ARN;
const DOCS_BUCKET_NAME         = process.env.DOCS_BUCKET_NAME;
const TENANT_ADMIN_GROUP       = 'TenantAdmin';
const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales', 'design', 'HR',
];

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
      return raw.slice(1, -1).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
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
  const path   = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};

  log.debug('Admin request received', {
    method, path,
    sub: auth['sub'], email: auth['email'],
    groups_raw: auth['cognito:groups'], groups_type: typeof auth['cognito:groups'],
  });

  const groups = getGroupsFromClaims(event);
  const isRootAdmin = groups.includes('RootAdmin');
  log.debug('Authorization', { groups, isRootAdmin });

  if (!isRootAdmin) {
    log.warn('Admin access denied', { method, path, sub: auth['sub'], email: auth['email'] });
    return jsonResponse(403, { error: 'Forbidden' });
  }

  // ── GET /tenants ──────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/tenants') {
    log.info('Listing tenants');
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
    let items = (scan2.Items || []).map(i => ({
      tenantId:  i.tenantId?.S || '',
      name:      i.name?.S || '',
      createdAt: i.createdAt?.S || '',
    }));

    const qs = event.queryStringParameters || {};
    const search   = (qs.search || '').toLowerCase().trim();
    const sortBy   = qs.sortBy || 'name';
    const sortDir  = qs.sortOrder === 'desc' ? -1 : 1;
    const page     = Math.max(0, parseInt(qs.page || '0', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(qs.pageSize || '20', 10)));

    if (search) {
      items = items.filter(t =>
        t.tenantId.toLowerCase().includes(search) ||
        t.name.toLowerCase().includes(search)
      );
    }
    items.sort((a, b) => sortDir * String(a[sortBy] || '').localeCompare(String(b[sortBy] || '')));

    const total = items.length;
    const paged = items.slice(page * pageSize, (page + 1) * pageSize);
    return jsonResponse(200, { items: paged, total, page, pageSize });
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

    log.info('Creating tenant', { tenantId: id, name, adminEmail });

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
      // Assign all business groups to the tenant admin user — non-fatal per group
      for (const group of BUSINESS_GROUPS) {
        try {
          await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: adminEmail,
            GroupName: group,
          }));
        } catch (err) {
          log.warn('Failed to assign business group to tenant admin (non-fatal)', { adminEmail, group, error: err.message });
        }
      }
      log.info('Cognito admin user created and groups assigned', { adminEmail, tenantId: id });
    } catch (err) {
      log.error('Failed to create Cognito admin user', { adminEmail, tenantId: id, error: err.message });
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
          dataDeletionPolicy: 'DELETE',
        }));
        dataSourceId = dsResult.dataSource.dataSourceId;
        log.info('Bedrock data source created', { tenantId: id, dataSourceId });
      } catch (err) {
        log.warn('Bedrock CreateDataSource failed, falling back to default data source', { tenantId: id, error: err.message });
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
    log.info('Tenant DynamoDB record written', { tenantId: id });

    // Create S3 folder placeholder (DynamoDB record already exists so sync Lambda uses correct data source)
    if (DOCS_BUCKET_NAME) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: `${id}/`, Body: '' }));
        log.info('S3 tenant folder created', { tenantId: id, key: `${id}/` });
      } catch (err) {
        log.error('S3 folder creation failed (non-fatal)', { tenantId: id, error: err.message });
      }
    }

    // Start initial ingestion job so any existing S3 objects are indexed immediately
    if (DEFAULT_KNOWLEDGE_BASE_ID && dataSourceId) {
      try {
        await bedrockAgent.send(new StartIngestionJobCommand({
          knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
          dataSourceId,
        }));
        log.info('Initial ingestion job started', { tenantId: id, dataSourceId });
      } catch (err) {
        log.error('StartIngestionJob failed (non-fatal)', { tenantId: id, dataSourceId, error: err.message });
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
    log.info('Tenant updated', { tenantId: tenantIdParam, name });
    return jsonResponse(200, { tenantId: tenantIdParam, name });
  }

  // ── DELETE /tenants/{tenantId} ────────────────────────────────────────────
  if (method === 'DELETE' && tenantIdParam) {
    log.info('Deleting tenant', { tenantId: tenantIdParam });
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
        log.error('Error fetching tenant record before delete (non-fatal)', { tenantId: tenantIdParam, error: err.message });
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
              log.info('S3 objects deleted', { tenantId: tenantIdParam, count: objects.length });
            }
            continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
          } while (continuationToken);
        } catch (err) {
          log.error('Error deleting S3 objects (non-fatal)', { tenantId: tenantIdParam, error: err.message });
        }
      }

      // 2. Delete the data source — dataDeletionPolicy:'DELETE' ensures Bedrock
      //    removes all indexed vectors for this tenant automatically.
      if (kbId && dsId && dsId !== DEFAULT_DATA_SOURCE_ID) {
        try {
          await bedrockAgent.send(new DeleteDataSourceCommand({
            knowledgeBaseId: kbId,
            dataSourceId: dsId,
          }));
          log.info('Bedrock data source deleted', { tenantId: tenantIdParam, dataSourceId: dsId });
        } catch (err) {
          log.warn('Bedrock data source deletion failed (non-fatal)', { tenantId: tenantIdParam, dataSourceId: dsId, error: err.message });
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
            log.info('Chat history items deleted', { tenantId: tenantIdParam, count: items.length });
            lastKey = scanRes.LastEvaluatedKey;
          } while (lastKey);
        } catch (err) {
          log.error('Error deleting chat history (non-fatal)', { tenantId: tenantIdParam, error: err.message });
        }
      }

      // 4. Delete DynamoDB tenant record
      try {
        await dynamo.send(new DeleteItemCommand({
          TableName: TENANTS_TABLE,
          Key: { tenantId: { S: tenantIdParam } },
        }));
        log.info('Tenant DynamoDB record deleted', { tenantId: tenantIdParam });
      } catch (err) {
        log.error('Failed to delete tenant DynamoDB record', { tenantId: tenantIdParam, error: err.message });
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
        log.info('Cognito users deleted', { tenantId: tenantIdParam, count: toDelete.length });
      } catch (err) {
        log.error('Error deleting Cognito users (non-fatal)', { tenantId: tenantIdParam, error: err.message });
      }

      return jsonResponse(200, { deleted: tenantIdParam });
    } catch (err) {
      log.error('DELETE /tenants failed', { tenantId: tenantIdParam, error: err.message });
      return jsonResponse(500, { error: err.message || 'Failed to delete tenant' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
