import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all AWS SDK clients before importing the handler
vi.mock('@aws-sdk/client-dynamodb', () => {
  const send = vi.fn();
  return {
    DynamoDBClient: vi.fn(() => ({ send })),
    ScanCommand: vi.fn(),
    PutItemCommand: vi.fn(),
    DeleteItemCommand: vi.fn(),
    UpdateItemCommand: vi.fn(),
    GetItemCommand: vi.fn(),
    _send: send,
  };
});

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: vi.fn() })),
  AdminCreateUserCommand: vi.fn(),
  AdminAddUserToGroupCommand: vi.fn(),
  AdminDeleteUserCommand: vi.fn(),
  ListUsersCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: vi.fn(() => ({ send: vi.fn() })),
  CreateDataSourceCommand: vi.fn(),
  DeleteDataSourceCommand: vi.fn(),
  StartIngestionJobCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));

function makeEvent({ method = 'GET', path = '/tenants', groups = ['RootAdmin'], pathParameters = {} } = {}) {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: { 'cognito:groups': groups },
        },
      },
      http: { method, path },
    },
    pathParameters,
    body: null,
  };
}

describe('admin handler — authorization', () => {
  it('returns 403 when caller is not RootAdmin', async () => {
    const { handler } = await import('../index.mjs');
    const event = makeEvent({ groups: ['TenantAdmin'] });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Forbidden');
  });

  it('returns 403 when no groups claim present', async () => {
    const { handler } = await import('../index.mjs');
    const event = makeEvent({ groups: [] });
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
  });
});
