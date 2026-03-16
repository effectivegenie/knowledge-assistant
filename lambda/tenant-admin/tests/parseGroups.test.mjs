import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCognitoSend = vi.hoisted(() => vi.fn().mockResolvedValue({ Users: [] }));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: mockCognitoSend })),
  ListUsersCommand: vi.fn(),
  AdminCreateUserCommand: vi.fn(),
  AdminAddUserToGroupCommand: vi.fn(),
  AdminDeleteUserCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned'),
}));

import { handler } from '../index.mjs';

function makeEvent({ method = 'GET', path = '/tenants/acme/users', groups = [], tenantId = 'acme', pathParameters = { tenantId: 'acme' } } = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            'cognito:groups': groups,
            'custom:tenantId': tenantId,
          },
        },
      },
      http: { method, path },
    },
    pathParameters,
    body: null,
  };
}

describe('tenant-admin handler — authorization', () => {
  it('returns 403 when caller has no relevant group', async () => {
    const event = makeEvent({ groups: [] });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when TenantAdmin accesses a different tenant', async () => {
    const event = makeEvent({ groups: ['TenantAdmin'], tenantId: 'other-tenant' });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });

  it('allows RootAdmin to access any tenant users', async () => {
    const event = makeEvent({ groups: ['RootAdmin'], tenantId: 'completely-different' });
    const res = await handler(event);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).users).toEqual([]);
  });

  it('allows TenantAdmin to access their own tenant', async () => {
    const event = makeEvent({ groups: ['TenantAdmin'], tenantId: 'acme' });
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
  });
});

function makeCreateUserEvent(body, groups = ['TenantAdmin'], tenantId = 'acme') {
  return {
    requestContext: {
      authorizer: {
        jwt: { claims: { 'cognito:groups': groups, 'custom:tenantId': tenantId } },
      },
      http: { method: 'POST', path: `/tenants/${tenantId}/users` },
    },
    pathParameters: { tenantId },
    body: JSON.stringify(body),
  };
}

function makeUploadEvent(body, groups = ['TenantAdmin'], tenantId = 'acme') {
  return {
    requestContext: {
      authorizer: {
        jwt: { claims: { 'cognito:groups': groups, 'custom:tenantId': tenantId } },
      },
      http: { method: 'POST', path: `/tenants/${tenantId}/upload-url` },
    },
    pathParameters: { tenantId },
    body: JSON.stringify(body),
  };
}

describe('tenant-admin handler — POST /users business group validation', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.USER_POOL_ID = 'us-east-1_test';
    mockCognitoSend.mockResolvedValue({});
  });

  it('creates user with valid business groups', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeCreateUserEvent({ email: 'u@acme.com', temporaryPassword: 'TempPass1', businessGroups: ['financial', 'IT'] }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).businessGroups).toEqual(['financial', 'IT']);
  });

  it('returns 400 for unknown business groups', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeCreateUserEvent({ email: 'u@acme.com', temporaryPassword: 'TempPass1', businessGroups: ['financial', 'unicorn'] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid business groups/);
  });

  it('creates user with no business groups (empty array)', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeCreateUserEvent({ email: 'u@acme.com', temporaryPassword: 'TempPass1', businessGroups: [] }));
    expect(res.statusCode).toBe(200);
  });

  it('creates user when businessGroups field is omitted', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeCreateUserEvent({ email: 'u@acme.com', temporaryPassword: 'TempPass1' }));
    expect(res.statusCode).toBe(200);
  });
});

describe('tenant-admin handler — POST /upload-url group validation', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.DOCS_BUCKET_NAME = 'docs-bucket';
  });

  it('returns both url and metadataUrl for valid groups', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeUploadEvent({ filename: 'doc.pdf', groups: ['financial', 'IT'] }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.url).toBeDefined();
    expect(data.metadataUrl).toBeDefined();
    expect(data.key).toBe('acme/doc.pdf');
  });

  it('returns 400 for unknown groups in upload', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeUploadEvent({ filename: 'doc.pdf', groups: ['invalid-group'] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Invalid groups/);
  });

  it('accepts general tag in upload', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeUploadEvent({ filename: 'doc.pdf', groups: ['general'] }));
    expect(res.statusCode).toBe(200);
  });

  it('accepts mixed general + business group tags', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeUploadEvent({ filename: 'doc.pdf', groups: ['general', 'IT'] }));
    expect(res.statusCode).toBe(200);
  });

  it('returns url and metadataUrl when no groups are specified', async () => {
    const { handler: h } = await import('../index.mjs');
    const res = await h(makeUploadEvent({ filename: 'doc.pdf' }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.url).toBeDefined();
    expect(data.metadataUrl).toBeDefined();
  });
});
