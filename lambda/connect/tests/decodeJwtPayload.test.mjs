import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: vi.fn() })) },
  PutCommand: vi.fn(),
}));

import { decodeJwtPayload } from '../index.mjs';

// Helper: build a minimal fake JWT with the given payload
function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

describe('decodeJwtPayload', () => {
  it('decodes a valid JWT payload', () => {
    const payload = { sub: 'user-123', email: 'user@example.com', exp: 9999999999 };
    const result = decodeJwtPayload(makeJwt(payload));
    expect(result.sub).toBe('user-123');
    expect(result.email).toBe('user@example.com');
  });

  it('decodes custom:tenantId claim', () => {
    const payload = { 'custom:tenantId': 'acme', sub: 'u1' };
    const result = decodeJwtPayload(makeJwt(payload));
    expect(result['custom:tenantId']).toBe('acme');
  });

  it('decodes cognito:groups claim', () => {
    const payload = { 'cognito:groups': ['RootAdmin'], sub: 'u1' };
    const result = decodeJwtPayload(makeJwt(payload));
    expect(result['cognito:groups']).toEqual(['RootAdmin']);
  });

  it('throws on malformed token (no dots)', () => {
    expect(() => decodeJwtPayload('notajwt')).toThrow();
  });

  it('throws on invalid base64 payload', () => {
    expect(() => decodeJwtPayload('header.!!!.sig')).toThrow();
  });
});
