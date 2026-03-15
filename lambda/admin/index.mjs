import { DynamoDBClient, ScanCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminSetUserMFAPreferenceCommand } from '@aws-sdk/client-cognito-identity-provider';

const dynamo = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const USER_POOL_ID = process.env.USER_POOL_ID;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DEFAULT_DATA_SOURCE_ID = process.env.DEFAULT_DATA_SOURCE_ID;
const TENANT_ADMIN_GROUP = 'TenantAdmin';

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
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
  const groups = auth['cognito:groups'];
  if (typeof groups === 'string') return [groups];
  if (Array.isArray(groups)) return groups;
  return [];
}

export const handler = async (event) => {
  const groups = getGroupsFromClaims(event);
  const isRootAdmin = groups.includes('RootAdmin');
  const path = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';

  // GET /tenants -> list tenants (RootAdmin only); ensure default tenant exists
  if (method === 'GET' && (path === '/tenants' || path === '/admin/tenants')) {
    if (!isRootAdmin) return jsonResponse(403, { error: 'Forbidden' });
    const scan = await dynamo.send(new ScanCommand({ TableName: TENANTS_TABLE }));
    const hasDefault = (scan.Items || []).some(i => i.tenantId?.S === 'default');
    if (!hasDefault && DEFAULT_KNOWLEDGE_BASE_ID && DEFAULT_DATA_SOURCE_ID) {
      await dynamo.send(new PutItemCommand({
        TableName: TENANTS_TABLE,
        Item: {
          tenantId: { S: 'default' },
          name: { S: 'Default' },
          knowledgeBaseId: { S: DEFAULT_KNOWLEDGE_BASE_ID },
          dataSourceId: { S: DEFAULT_DATA_SOURCE_ID },
          docsPrefix: { S: 'default/' },
          createdAt: { S: new Date().toISOString() },
        },
      }));
    }
    const scan2 = await dynamo.send(new ScanCommand({ TableName: TENANTS_TABLE }));
    const tenants = (scan2.Items || []).map(i => ({
      tenantId: i.tenantId?.S,
      name: i.name?.S,
      createdAt: i.createdAt?.S,
    }));
    return jsonResponse(200, { tenants });
  }

  // POST /tenants -> create tenant + first tenant admin user (RootAdmin only)
  if (method === 'POST' && (path === '/tenants' || path === '/admin/tenants')) {
    if (!isRootAdmin) return jsonResponse(403, { error: 'Forbidden' });
    const body = parseBody(event);
    const { tenantId, name, adminEmail, temporaryPassword } = body;
    if (!tenantId || !name || !adminEmail || !temporaryPassword) {
      return jsonResponse(400, { error: 'Missing tenantId, name, adminEmail, or temporaryPassword' });
    }
    const id = String(tenantId).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id) return jsonResponse(400, { error: 'Invalid tenantId' });

    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: adminEmail,
        TemporaryPassword: temporaryPassword,
        UserAttributes: [
          { Name: 'email', Value: adminEmail },
          { Name: 'email_verified', Value: 'true' },
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

    await dynamo.send(new PutItemCommand({
      TableName: TENANTS_TABLE,
      Item: {
        tenantId: { S: id },
        name: { S: String(name) },
        knowledgeBaseId: { S: DEFAULT_KNOWLEDGE_BASE_ID || '' },
        dataSourceId: { S: DEFAULT_DATA_SOURCE_ID || '' },
        docsPrefix: { S: `${id}/` },
        createdAt: { S: new Date().toISOString() },
      },
    }));

    return jsonResponse(200, { tenantId: id, name, adminEmail });
  }

  return jsonResponse(404, { error: 'Not found' });
};
