// JWT verification tests have been moved to verifyJwt.test.mjs
// This file tests the connect handler's response to missing/invalid tokens.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: vi.fn() })) },
  PutCommand: vi.fn(),
}));

import { handler } from '../index.mjs';

const baseEvent = { requestContext: { connectionId: 'test-conn-id' } };

describe('connect handler — token guard', () => {
  it('returns 401 when no token is supplied', async () => {
    const event = { ...baseEvent, queryStringParameters: {} };
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token is a plaintext string (not a JWT)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [] }),
    }));
    const event = { ...baseEvent, queryStringParameters: { token: 'notajwt' } };
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
  });
});
