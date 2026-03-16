import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'crypto';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: vi.fn(() => ({ send: vi.fn() })) },
  PutCommand: vi.fn(),
}));

// Generate RSA key pairs once at module level (expensive operation)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkPublic = publicKey.export({ format: 'jwk' });
const TEST_KID = 'test-key-2024';

const REGION = 'us-east-1';
const USER_POOL_ID = 'us-east-1_TestPool';
const CLIENT_ID = 'test-app-client-id';

function signJwt(payload, kid = TEST_KID, signingKey = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(signingKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

function validPayload() {
  return {
    sub: 'user-abc',
    email: 'user@test.com',
    iss: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: CLIENT_ID,
    'custom:tenantId': 'acme',
    'cognito:groups': ['TenantAdmin'],
  };
}

describe('verifyJwt', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AWS_REGION = REGION;
    process.env.USER_POOL_ID = USER_POOL_ID;
    process.env.APP_CLIENT_ID = CLIENT_ID;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [{ ...jwkPublic, kid: TEST_KID, use: 'sig' }] }),
    }));
  });

  it('verifies a valid JWT and returns payload', async () => {
    const { verifyJwt } = await import('../index.mjs');
    const token = signJwt(validPayload());
    const result = await verifyJwt(token);
    expect(result.sub).toBe('user-abc');
    expect(result['custom:tenantId']).toBe('acme');
    expect(result['cognito:groups']).toEqual(['TenantAdmin']);
  });

  it('rejects an expired token before fetching JWKS', async () => {
    const { verifyJwt } = await import('../index.mjs');
    const token = signJwt({ ...validPayload(), exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyJwt(token)).rejects.toThrow('Token expired');
  });

  it('rejects a token with invalid issuer', async () => {
    const { verifyJwt } = await import('../index.mjs');
    const token = signJwt({ ...validPayload(), iss: 'https://evil.com/pool' });
    await expect(verifyJwt(token)).rejects.toThrow('Invalid issuer');
  });

  it('rejects a token with invalid audience', async () => {
    const { verifyJwt } = await import('../index.mjs');
    const token = signJwt({ ...validPayload(), aud: 'wrong-client' });
    await expect(verifyJwt(token)).rejects.toThrow('Invalid audience');
  });

  it('rejects a forged token with unknown kid (cache refresh also returns no key)', async () => {
    const { verifyJwt } = await import('../index.mjs');
    // Both initial fetch and cache-refresh return empty JWKS
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [] }),
    }));
    const token = signJwt(validPayload(), 'unknown-kid-forged');
    await expect(verifyJwt(token)).rejects.toThrow('Unknown key ID');
  });

  it('rejects a token with invalid signature (signed by a different key)', async () => {
    const { verifyJwt } = await import('../index.mjs');
    const token = signJwt(validPayload(), TEST_KID, otherPrivateKey);
    await expect(verifyJwt(token)).rejects.toThrow('Invalid signature');
  });

  it('rejects a malformed token (not three dot-separated parts)', async () => {
    const { verifyJwt } = await import('../index.mjs');
    await expect(verifyJwt('notavalidjwt')).rejects.toThrow('Invalid JWT format');
  });

  it('retries JWKS fetch when kid is not in cache', async () => {
    const { verifyJwt } = await import('../index.mjs');
    // First call: JWKS has wrong kid; second call (force refresh): correct kid
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      const keys = callCount === 1
        ? [{ ...jwkPublic, kid: 'other-kid', use: 'sig' }]
        : [{ ...jwkPublic, kid: TEST_KID, use: 'sig' }];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ keys }) });
    }));
    const token = signJwt(validPayload());
    const result = await verifyJwt(token);
    expect(result.sub).toBe('user-abc');
    expect(callCount).toBe(2);
  });
});
