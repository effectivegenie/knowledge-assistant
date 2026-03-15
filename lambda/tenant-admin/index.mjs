import { CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID;

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

function parseGroups(raw) {
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
  const claims        = event.requestContext?.authorizer?.jwt?.claims || {};
  const groups        = parseGroups(claims['cognito:groups']);
  const userTenantId  = claims['custom:tenantId'] || '';
  const isTenantAdmin = groups.includes('TenantAdmin');

  const path       = event.requestContext?.http?.path || event.path || '';
  const method     = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};

  const tenantIdFromPath = pathParams.tenantId || path.match(/^\/tenants\/([^/]+)\/users/)?.[1] || null;

  if (!tenantIdFromPath) return jsonResponse(404, { error: 'Not found' });
  if (!isTenantAdmin || userTenantId !== tenantIdFromPath) return jsonResponse(403, { error: 'Forbidden' });

  // ── GET /tenants/{tenantId}/users ─────────────────────────────────────────
  if (method === 'GET') {
    const list = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
    const attrs = (u) => (u.Attributes || []).reduce((acc, a) => ({ ...acc, [a.Name]: a.Value }), {});
    const users = (list.Users || [])
      .filter(u => attrs(u)['custom:tenantId'] === tenantIdFromPath)
      .map(u => ({
        username:  u.Username,
        email:     attrs(u).email,
        status:    u.UserStatus,
        createdAt: u.UserCreateDate,
      }));
    return jsonResponse(200, { users });
  }

  // ── POST /tenants/{tenantId}/users ────────────────────────────────────────
  if (method === 'POST' && !pathParams.username) {
    const { email, temporaryPassword } = parseBody(event);
    if (!email || !temporaryPassword) return jsonResponse(400, { error: 'Missing email or temporaryPassword' });
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        TemporaryPassword: temporaryPassword,
        UserAttributes: [
          { Name: 'email',           Value: email },
          { Name: 'email_verified',  Value: 'true' },
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

  // ── DELETE /tenants/{tenantId}/users/{username} ───────────────────────────
  const username = pathParams.username || path.match(/^\/tenants\/[^/]+\/users\/([^/]+)$/)?.[1];
  if (method === 'DELETE' && username) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      return jsonResponse(200, { deleted: username });
    } catch (err) {
      console.error('AdminDeleteUser error:', err);
      return jsonResponse(400, { error: 'Failed to delete user', detail: err.message });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
