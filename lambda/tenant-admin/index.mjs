import { CognitoIdentityProviderClient, ListUsersCommand, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand, AdminListGroupsForUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const cognito = new CognitoIdentityProviderClient({});
const s3 = new S3Client({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const USER_POOL_ID      = process.env.USER_POOL_ID;
const DOCS_BUCKET_NAME  = process.env.DOCS_BUCKET_NAME;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales',
];

// Document tags include business groups + 'general' (accessible to all users)
const DOCUMENT_TAGS = [...BUSINESS_GROUPS, 'general'];

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
      return raw.slice(1, -1).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
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
  const isRootAdmin   = groups.includes('RootAdmin');

  const path       = event.requestContext?.http?.path || event.path || '';
  const method     = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};

  const tenantIdFromPath = pathParams.tenantId || path.match(/^\/tenants\/([^/]+)/)?.[1] || null;

  log.debug('TenantAdmin request', {
    method, path, tenantIdFromPath, userTenantId,
    groups_raw: claims['cognito:groups'],
    groups_parsed: groups,
    isTenantAdmin, isRootAdmin,
  });

  if (!tenantIdFromPath) return jsonResponse(404, { error: 'Not found' });
  if (!isRootAdmin && (!isTenantAdmin || userTenantId !== tenantIdFromPath)) {
    log.warn('TenantAdmin access denied', {
      method, path, userTenantId, tenantIdFromPath, isTenantAdmin, isRootAdmin,
      groups_parsed: groups,
      groups_raw: claims['cognito:groups'],
      groups_raw_type: typeof claims['cognito:groups'],
    });
    return jsonResponse(403, { error: 'Forbidden', detail: {
      userTenantId, tenantIdFromPath, isTenantAdmin, isRootAdmin,
      groups_parsed: groups,
      groups_raw: claims['cognito:groups'],
      groups_raw_type: typeof claims['cognito:groups'],
    } });
  }

  // ── POST /tenants/{tenantId}/upload-url ───────────────────────────────────
  if (method === 'POST' && path.endsWith('/upload-url')) {
    const { filename, groups } = parseBody(event);
    if (!filename) return jsonResponse(400, { error: 'Missing filename' });
    if (!DOCS_BUCKET_NAME) return jsonResponse(500, { error: 'Upload not configured' });

    // Validate requested groups (business groups + 'general')
    const docGroups = Array.isArray(groups) ? groups : [];
    const invalidGroups = docGroups.filter(g => !DOCUMENT_TAGS.includes(g));
    if (invalidGroups.length > 0) {
      return jsonResponse(400, { error: `Invalid groups: ${invalidGroups.join(', ')}` });
    }

    const safeFilename = String(filename).replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim();
    const key = `${tenantIdFromPath}/${safeFilename}`;
    const metadataKey = `${key}.metadata.json`;
    try {
      const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: key }), { expiresIn: 300 });
      const metadataUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: metadataKey, ContentType: 'application/json' }),
        { expiresIn: 300 },
      );
      log.info('Upload URL generated', { tenantId: tenantIdFromPath, key, groups: docGroups });
      return jsonResponse(200, { url, metadataUrl, key });
    } catch (err) {
      log.error('Presigned URL generation failed', { tenantId: tenantIdFromPath, key, error: err.message });
      return jsonResponse(500, { error: 'Failed to generate upload URL' });
    }
  }

  // ── GET /tenants/{tenantId}/users ─────────────────────────────────────────
  if (method === 'GET' && !pathParams.username) {
    log.info('Listing tenant users', { tenantId: tenantIdFromPath });
    const list = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
    const attrs = (u) => (u.Attributes || []).reduce((acc, a) => ({ ...acc, [a.Name]: a.Value }), {});
    const tenantUsers = (list.Users || []).filter(u => attrs(u)['custom:tenantId'] === tenantIdFromPath);

    const users = await Promise.all(tenantUsers.map(async (u) => {
      let businessGroups = [];
      try {
        const groupsResp = await cognito.send(new AdminListGroupsForUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: u.Username,
        }));
        businessGroups = (groupsResp.Groups || [])
          .map(g => g.GroupName)
          .filter(g => BUSINESS_GROUPS.includes(g));
      } catch (err) {
        log.warn('Failed to fetch groups for user', { username: u.Username, error: err.message });
      }
      return {
        username:       u.Username,
        email:          attrs(u).email,
        status:         u.UserStatus,
        createdAt:      u.UserCreateDate,
        businessGroups,
      };
    }));

    return jsonResponse(200, { users });
  }

  // ── POST /tenants/{tenantId}/users ────────────────────────────────────────
  if (method === 'POST' && !pathParams.username) {
    const { email, temporaryPassword, businessGroups } = parseBody(event);
    if (!email || !temporaryPassword) return jsonResponse(400, { error: 'Missing email or temporaryPassword' });

    const requestedGroups = Array.isArray(businessGroups) ? businessGroups : [];
    const invalidGroups = requestedGroups.filter(g => !BUSINESS_GROUPS.includes(g));
    if (invalidGroups.length > 0) {
      return jsonResponse(400, { error: `Invalid business groups: ${invalidGroups.join(', ')}` });
    }

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
      for (const group of requestedGroups) {
        await cognito.send(new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
          GroupName: group,
        }));
      }
      log.info('Tenant user created', { email, tenantId: tenantIdFromPath, businessGroups: requestedGroups });
      return jsonResponse(200, { email, tenantId: tenantIdFromPath, businessGroups: requestedGroups });
    } catch (err) {
      log.error('Failed to create tenant user', { email, tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(400, { error: 'Failed to create user', detail: err.message });
    }
  }

  // ── PUT /tenants/{tenantId}/users/{username}/groups ───────────────────────
  const username = pathParams.username || path.match(/^\/tenants\/[^/]+\/users\/([^/]+)$/)?.[1];
  if (method === 'PUT' && username) {
    const { businessGroups } = parseBody(event);
    const requestedGroups = Array.isArray(businessGroups) ? businessGroups : [];
    const invalidGroups = requestedGroups.filter(g => !BUSINESS_GROUPS.includes(g));
    if (invalidGroups.length > 0) {
      return jsonResponse(400, { error: `Invalid business groups: ${invalidGroups.join(', ')}` });
    }

    try {
      const groupsResp = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }));
      const currentGroups = (groupsResp.Groups || [])
        .map(g => g.GroupName)
        .filter(g => BUSINESS_GROUPS.includes(g));

      const toAdd    = requestedGroups.filter(g => !currentGroups.includes(g));
      const toRemove = currentGroups.filter(g => !requestedGroups.includes(g));

      await Promise.all([
        ...toAdd.map(g => cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: g }))),
        ...toRemove.map(g => cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: g }))),
      ]);

      log.info('User groups updated', { username, tenantId: tenantIdFromPath, added: toAdd, removed: toRemove });
      return jsonResponse(200, { username, businessGroups: requestedGroups });
    } catch (err) {
      log.error('Failed to update user groups', { username, tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(400, { error: 'Failed to update user groups', detail: err.message });
    }
  }

  // ── DELETE /tenants/{tenantId}/users/{username} ───────────────────────────
  if (method === 'DELETE' && username) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      log.info('Tenant user deleted', { username, tenantId: tenantIdFromPath });
      return jsonResponse(200, { deleted: username });
    } catch (err) {
      log.error('Failed to delete tenant user', { username, tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(400, { error: 'Failed to delete user', detail: err.message });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
