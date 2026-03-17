import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCognitoSend   = vi.hoisted(() => vi.fn());
const mockGetSignedUrl  = vi.hoisted(() => vi.fn().mockResolvedValue('https://s3.example.com/put'));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: mockCognitoSend })),
  ListUsersCommand:              vi.fn(i => ({ input: i })),
  AdminCreateUserCommand:        vi.fn(i => ({ input: i })),
  AdminAddUserToGroupCommand:    vi.fn(i => ({ input: i })),
  AdminRemoveUserFromGroupCommand: vi.fn(i => ({ input: i })),
  AdminListGroupsForUserCommand: vi.fn(i => ({ input: i })),
  AdminDeleteUserCommand:        vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         vi.fn(() => ({})),
  PutObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent({ method = 'GET', path = '/tenants/acme/users', groups = ['TenantAdmin'], tenantId = 'acme', pathParameters = { tenantId: 'acme' }, body = null, qs = {} } = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { 'cognito:groups': groups, 'custom:tenantId': tenantId } } },
      http: { method, path },
    },
    pathParameters,
    queryStringParameters: qs,
    body: body ? JSON.stringify(body) : null,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.USER_POOL_ID     = 'us-east-1_TEST';
  process.env.DOCS_BUCKET_NAME = 'docs-bucket';
});

// ── Authorization ─────────────────────────────────────────────────────────────

describe('tenant-admin handler — authorization', () => {
  it('returns 403 when caller has no relevant group', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: [] }));
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when TenantAdmin accesses different tenant', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: ['TenantAdmin'], tenantId: 'other' }));
    expect(res.statusCode).toBe(403);
  });

  it('allows RootAdmin to access any tenant', async () => {
    mockCognitoSend.mockResolvedValue({ Users: [], Groups: [] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: ['RootAdmin'], tenantId: 'any', pathParameters: { tenantId: 'acme' } }));
    expect(res.statusCode).not.toBe(403);
  });
});

// ── GET /users ────────────────────────────────────────────────────────────────

describe('tenant-admin handler — GET /users', () => {
  it('returns empty list when no users belong to tenant', async () => {
    mockCognitoSend.mockResolvedValue({ Users: [] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('filters users by tenantId attribute and fetches business groups', async () => {
    mockCognitoSend
      .mockResolvedValueOnce({
        Users: [
          {
            Username: 'user@acme.com',
            UserStatus: 'CONFIRMED',
            Attributes: [{ Name: 'custom:tenantId', Value: 'acme' }, { Name: 'email', Value: 'user@acme.com' }],
          },
          {
            Username: 'other@other.com',
            UserStatus: 'CONFIRMED',
            Attributes: [{ Name: 'custom:tenantId', Value: 'other' }],
          },
        ],
      })
      .mockResolvedValueOnce({ Groups: [{ GroupName: 'financial' }, { GroupName: 'TenantAdmin' }] });

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].email).toBe('user@acme.com');
    // TenantAdmin is a system group and should not appear in businessGroups
    expect(data.items[0].businessGroups).toEqual(['financial']);
  });
});

// ── POST /users ───────────────────────────────────────────────────────────────

describe('tenant-admin handler — POST /users', () => {
  it('creates user and assigns business groups', async () => {
    mockCognitoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      body: { email: 'new@acme.com', temporaryPassword: 'Temp1234', businessGroups: ['financial', 'IT'] },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.email).toBe('new@acme.com');
    expect(data.businessGroups).toEqual(['financial', 'IT']);
  });

  it('returns 400 for invalid business group', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      body: { email: 'x@acme.com', temporaryPassword: 'Temp1234', businessGroups: ['unknown-group'] },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ method: 'POST', body: { temporaryPassword: 'Temp1234' } }));
    expect(res.statusCode).toBe(400);
  });
});

// ── DELETE /users/{username} ──────────────────────────────────────────────────

describe('tenant-admin handler — DELETE /users/{username}', () => {
  it('deletes user', async () => {
    mockCognitoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/users/user@acme.com',
      pathParameters: { tenantId: 'acme', username: 'user@acme.com' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe('user@acme.com');
  });
});

// ── PUT /users/{username} ─────────────────────────────────────────────────────

describe('tenant-admin handler — PUT /users/{username}', () => {
  it('updates business groups', async () => {
    mockCognitoSend
      .mockResolvedValueOnce({ Groups: [{ GroupName: 'financial' }] }) // current groups
      .mockResolvedValue({});                                          // add/remove
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/users/user@acme.com',
      pathParameters: { tenantId: 'acme', username: 'user@acme.com' },
      body: { businessGroups: ['IT'] },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).businessGroups).toEqual(['IT']);
  });

  it('returns 400 for invalid business group', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/users/user@acme.com',
      pathParameters: { tenantId: 'acme', username: 'user@acme.com' },
      body: { businessGroups: ['unknown'] },
    }));
    expect(res.statusCode).toBe(400);
  });
});

// ── POST /upload-url ──────────────────────────────────────────────────────────

describe('tenant-admin handler — POST /upload-url', () => {
  it('returns presigned URLs with default category general', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'report.pdf', groups: ['financial'] },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.url).toBe('https://s3.example.com/put');
    expect(data.metadataUrl).toBe('https://s3.example.com/put');
    expect(data.key).toBe('acme/report.pdf');
    expect(data.category).toBe('general');
  });

  it('accepts invoice category', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'invoice.pdf', groups: [], category: 'invoice' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).category).toBe('invoice');
  });

  it('accepts contract category', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'contract.pdf', groups: [], category: 'contract' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).category).toBe('contract');
  });

  it('falls back to general for unknown category', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'doc.pdf', category: 'unknown' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).category).toBe('general');
  });

  it('defaults groups to [general] when none provided', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'doc.pdf' },
    }));
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid group', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'doc.pdf', groups: ['unknown-group'] },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when filename is missing', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: {},
    }));
    expect(res.statusCode).toBe(400);
  });

  it('sanitises filename special characters', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'POST',
      path: '/tenants/acme/upload-url',
      body: { filename: 'my file (1).pdf' },
    }));
    const data = JSON.parse(res.body);
    expect(data.key).toMatch(/^acme\//);
    expect(data.key).not.toContain('(');
    expect(data.key).not.toContain(')');
  });
});
