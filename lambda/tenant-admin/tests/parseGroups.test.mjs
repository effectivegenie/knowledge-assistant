import { describe, it, expect, vi } from 'vitest';

const mockCognitoSend = vi.hoisted(() => vi.fn().mockResolvedValue({ Users: [] }));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: mockCognitoSend })),
  ListUsersCommand: vi.fn(),
  AdminCreateUserCommand: vi.fn(),
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
