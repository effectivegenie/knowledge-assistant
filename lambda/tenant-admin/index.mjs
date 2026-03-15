import { CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID;

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

function getClaims(event) {
  const auth = event.requestContext?.authorizer?.jwt?.claims;
  if (!auth) return {};
  return auth;
}

export const handler = async (event) => {
  const claims = getClaims(event);
  const groups = typeof claims['cognito:groups'] === 'string' ? [claims['cognito:groups']] : (claims['cognito:groups'] || []);
  const userTenantId = claims['custom:tenantId'] || '';
  const isTenantAdmin = groups.includes('TenantAdmin');

  const path = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};
  const tenantIdFromPath = pathParams.tenantId || path.match(/^\/tenants\/([^/]+)\/users\/?$/)?.[1] || null;

  if (!tenantIdFromPath) {
    return jsonResponse(404, { error: 'Not found' });
  }

  if (!isTenantAdmin || userTenantId !== tenantIdFromPath) {
    return jsonResponse(403, { error: 'Forbidden' });
  }

  // GET /tenants/:tenantId/users
  if (method === 'GET') {
    const list = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Limit: 60,
    }));
    const attrs = (u) => (u.Attributes || []).reduce((acc, a) => ({ ...acc, [a.Name]: a.Value }), {});
    const users = (list.Users || [])
      .filter(u => attrs(u)['custom:tenantId'] === tenantIdFromPath)
      .map(u => ({
        username: u.Username,
        email: attrs(u).email,
        status: u.UserStatus,
        createdAt: u.UserCreateDate,
      }));
    return jsonResponse(200, { users });
  }

  // POST /tenants/:tenantId/users
  if (method === 'POST') {
    const body = parseBody(event);
    const { email, temporaryPassword } = body;
    if (!email || !temporaryPassword) {
      return jsonResponse(400, { error: 'Missing email or temporaryPassword' });
    }
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        TemporaryPassword: temporaryPassword,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:tenantId', Value: tenantIdFromPath },
        ],
        MessageAction: 'SUPPRESS',
      }));
      return jsonResponse(200, { email, tenantId: tenantIdFromPath });
    } catch (err) {
      console.error('Cognito create user error:', err);
      return jsonResponse(400, { error: 'Failed to create user', detail: err.message });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
