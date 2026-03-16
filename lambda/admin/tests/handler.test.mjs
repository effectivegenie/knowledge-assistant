import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCognitoSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockDynamoSend = vi.hoisted(() => vi.fn().mockResolvedValue({ Items: [] }));

// Mock all AWS SDK clients before importing the handler
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDynamoSend })),
  ScanCommand: vi.fn(),
  PutItemCommand: vi.fn(),
  DeleteItemCommand: vi.fn(),
  UpdateItemCommand: vi.fn(),
  GetItemCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: mockCognitoSend })),
  AdminCreateUserCommand: vi.fn().mockImplementation((input) => ({ input })),
  AdminAddUserToGroupCommand: vi.fn().mockImplementation((input) => ({ input })),
  AdminDeleteUserCommand: vi.fn().mockImplementation((input) => ({ input })),
  ListUsersCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({ dataSource: { dataSourceId: 'ds-1' } }) })),
  CreateDataSourceCommand: vi.fn(),
  DeleteDataSourceCommand: vi.fn(),
  StartIngestionJobCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));

function makeEvent({ method = 'GET', path = '/tenants', groups = ['RootAdmin'], pathParameters = {}, body = null } = {}) {
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
    body: body ? JSON.stringify(body) : null,
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

describe('admin handler — POST /tenants business groups assignment', () => {
  beforeEach(() => {
    mockCognitoSend.mockResolvedValue({});
    mockDynamoSend.mockResolvedValue({ Items: [] });
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.TENANTS_TABLE = 'TenantsTable';
  });

  it('assigns all 9 business groups to the tenant admin on creation', async () => {
    const { handler } = await import('../index.mjs');
    const event = makeEvent({
      method: 'POST',
      path: '/tenants',
      body: {
        tenantId: 'acme',
        name: 'Acme Corp',
        adminEmail: 'admin@acme.com',
        temporaryPassword: 'TempPass1',
      },
    });

    const res = await handler(event);
    expect(res.statusCode).toBe(200);

    // mockCognitoSend receives objects shaped { input: { UserPoolId, Username, GroupName } }
    // because AdminAddUserToGroupCommand mock is: (input) => ({ input })
    const EXPECTED_GROUPS = ['financial', 'accounting', 'operations', 'marketing', 'IT', 'warehouse', 'security', 'logistics', 'sales', 'design', 'HR'];
    for (const g of EXPECTED_GROUPS) {
      expect(mockCognitoSend).toHaveBeenCalledWith(
        expect.objectContaining({ input: expect.objectContaining({ GroupName: g }) }),
      );
    }
  });
});
