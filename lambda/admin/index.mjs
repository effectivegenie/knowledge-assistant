import { DynamoDBClient, ScanCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminDeleteUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockAgentClient, CreateDataSourceCommand } from '@aws-sdk/client-bedrock-agent';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const dynamo      = new DynamoDBClient({});
const cognito     = new CognitoIdentityProviderClient({});
const bedrockAgent = new BedrockAgentClient({});
const s3          = new S3Client({});

const TENANTS_TABLE            = process.env.TENANTS_TABLE;
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

function getGroupsFromClaims(event) {
  const auth = event.requestContext?.authorizer?.jwt?.claims;
  if (!auth) return [];
  const raw = auth['cognito:groups'];
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

    // Create S3 folder placeholder
    if (DOCS_BUCKET_NAME) {
      try {
        await s3.send(new PutObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: `${id}/`, Body: '' }));
        console.log('Created S3 folder', `${id}/`);
      } catch (err) {
        console.error('S3 folder creation error (non-fatal):', err);
      }
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
        }));
        dataSourceId = dsResult.dataSource.dataSourceId;
        console.log('Created data source', dataSourceId, 'for tenant', id);
      } catch (err) {
        console.error('Bedrock CreateDataSource error (falling back to default):', err);
      }
    }

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
    // Delete DynamoDB record
    await dynamo.send(new DeleteItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId: { S: tenantIdParam } },
    }));

    // Delete all Cognito users belonging to this tenant
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
  }

  return jsonResponse(404, { error: 'Not found' });
};
