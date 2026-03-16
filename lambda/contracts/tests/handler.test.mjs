import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockDynamoSend  = vi.hoisted(() => vi.fn());
const mockS3Send      = vi.hoisted(() => vi.fn());
const mockGetSignedUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://s3.example.com/view'));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient:  vi.fn(() => ({ send: mockDynamoSend })),
  QueryCommand:    vi.fn(i => ({ input: i })),
  GetItemCommand:  vi.fn(i => ({ input: i })),
  UpdateItemCommand: vi.fn(i => ({ input: i })),
  DeleteItemCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:            vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand:    vi.fn(i => ({ input: i })),
  DeleteObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent({
  method = 'GET',
  path = '/tenants/acme/contracts',
  groups = ['TenantAdmin'],
  tenantId = 'acme',
  pathParameters = { tenantId: 'acme' },
  body = null,
  qs = {},
} = {}) {
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

function marshalContract(c) {
  const item = {};
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'string') item[k] = { S: v };
    else if (typeof v === 'number') item[k] = { N: String(v) };
  }
  return item;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.CONTRACTS_TABLE  = 'contracts';
  process.env.TENANTS_TABLE    = 'tenants';
  process.env.DOCS_BUCKET_NAME = 'docs-bucket';
});

// ── Authorization ────────────────────────────────────────────────────────────

describe('contracts handler — authorization', () => {
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
    mockDynamoSend.mockResolvedValue({ Items: [], Count: 0 });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: ['RootAdmin'], tenantId: 'any' }));
    expect(res.statusCode).not.toBe(403);
  });
});

// ── GET /contracts ────────────────────────────────────────────────────────────

describe('contracts handler — GET /contracts', () => {
  it('returns paginated contract list', async () => {
    const contract = marshalContract({
      tenantId: 'acme', contractId: 'c-1', status: 'confirmed',
      contractType: 'services', signingDate: '2024-01-15',
    });
    mockDynamoSend.mockResolvedValue({ Items: [contract], LastEvaluatedKey: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.items[0].contractId).toBe('c-1');
  });

  it('filters by status', async () => {
    const confirmed = marshalContract({ tenantId: 'acme', contractId: 'a', status: 'confirmed', contractType: 'services' });
    const pending   = marshalContract({ tenantId: 'acme', contractId: 'b', status: 'extracted', contractType: 'nda' });
    mockDynamoSend.mockResolvedValue({ Items: [confirmed, pending] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ qs: { status: 'confirmed' } }));
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].contractId).toBe('a');
  });

  it('filters by search on clientName', async () => {
    const match   = marshalContract({ tenantId: 'acme', contractId: 'a', status: 'confirmed', contractType: 'services', clientName: 'Acme Client' });
    const noMatch = marshalContract({ tenantId: 'acme', contractId: 'b', status: 'confirmed', contractType: 'services', clientName: 'Other Corp' });
    mockDynamoSend.mockResolvedValue({ Items: [match, noMatch] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ qs: { search: 'acme' } }));
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].clientName).toBe('Acme Client');
  });
});

// ── PUT /contracts/{contractId} ───────────────────────────────────────────────

describe('contracts handler — PUT /contracts/{contractId}', () => {
  it('updates contract status to confirmed', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
      body: { status: 'confirmed' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('confirmed');
  });

  it('returns 400 for invalid contractType', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
      body: { status: 'confirmed', contractType: 'invalid-type' },
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/contractType/i);
  });

  it('returns 400 for invalid status', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
      body: { status: 'flying' },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when conditional check fails (contract does not exist)', async () => {
    const err = new Error('ConditionalCheckFailed');
    err.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(err);
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/contracts/missing',
      pathParameters: { tenantId: 'acme', contractId: 'missing' },
      body: { status: 'confirmed' },
    }));
    expect(res.statusCode).toBe(404);
  });

  it('recomputes deduplicationKey when clientVatNumber + contractNumber both provided', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
      body: { status: 'confirmed', clientVatNumber: 'BG123', contractNumber: 'CTR-001' },
    }));
    const updateCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.UpdateExpression);
    expect(updateCall[0].input.ExpressionAttributeValues[':dk']).toEqual({ S: 'BG123#CTR-001' });
  });
});

// ── DELETE /contracts/{contractId} ───────────────────────────────────────────

describe('contracts handler — DELETE /contracts/{contractId}', () => {
  it('returns 404 when contract not found', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
    }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not found/i);
  });

  it('deletes DynamoDB record and all 4 S3 files', async () => {
    const item = marshalContract({
      tenantId: 'acme', contractId: 'c-1', s3Key: 'acme/contract.pdf',
      s3Bucket: 'docs-bucket', status: 'confirmed', contractType: 'services',
    });
    mockDynamoSend
      .mockResolvedValueOnce({ Item: item })  // GetItem
      .mockResolvedValueOnce({});              // DeleteItem
    mockS3Send.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/contracts/c-1',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.deleted).toBe(true);
    expect(data.contractId).toBe('c-1');
    expect(mockS3Send).toHaveBeenCalledTimes(4);
  });
});

// ── GET /contracts/{contractId}/view-url ─────────────────────────────────────

describe('contracts handler — GET /contracts/{contractId}/view-url', () => {
  it('returns presigned URL for existing contract', async () => {
    mockDynamoSend.mockResolvedValue({
      Item: marshalContract({
        tenantId: 'acme', contractId: 'c-1', s3Key: 'acme/contract.pdf',
        s3Bucket: 'docs-bucket', status: 'confirmed', contractType: 'services',
      }),
    });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/contracts/c-1/view-url',
      pathParameters: { tenantId: 'acme', contractId: 'c-1' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://s3.example.com/view');
  });

  it('returns 404 when contract not found', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/contracts/missing/view-url',
      pathParameters: { tenantId: 'acme', contractId: 'missing' },
    }));
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /contracts/stats ──────────────────────────────────────────────────────

describe('contracts handler — GET /contracts/stats', () => {
  it('computes active, expiringSoon, expired, and pending counts', async () => {
    // Use today's date to build relative endDate values
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);

    const pastDate   = fmt(new Date(today.getTime() - 10 * 86400000));       // 10 days ago → expired
    const soonDate   = fmt(new Date(today.getTime() + 15 * 86400000));       // 15 days from now → expiringSoon
    const futureDate = fmt(new Date(today.getTime() + 60 * 86400000));       // 60 days from now → active

    const contracts = [
      // active — no endDate
      marshalContract({ tenantId: 'acme', contractId: 'a', status: 'confirmed', contractType: 'services' }),
      // active — endDate far in future
      marshalContract({ tenantId: 'acme', contractId: 'b', status: 'confirmed', contractType: 'nda', endDate: futureDate }),
      // expiringSoon — endDate within 30 days
      marshalContract({ tenantId: 'acme', contractId: 'c', status: 'confirmed', contractType: 'rental', endDate: soonDate }),
      // expired — endDate in the past
      marshalContract({ tenantId: 'acme', contractId: 'd', status: 'confirmed', contractType: 'supply', endDate: pastDate }),
      // pending — status extracted
      marshalContract({ tenantId: 'acme', contractId: 'e', status: 'extracted', contractType: 'other' }),
      // pending — status review_needed
      marshalContract({ tenantId: 'acme', contractId: 'f', status: 'review_needed', contractType: 'other' }),
    ];
    mockDynamoSend.mockResolvedValue({ Items: contracts });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/contracts/stats',
      pathParameters: { tenantId: 'acme' },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.active).toBe(2);        // a (no endDate) + b (far future)
    expect(data.expiringSoon).toBe(1);  // c
    expect(data.expired).toBe(1);       // d
    expect(data.pending).toBe(2);       // e + f
    expect(data.total).toBe(4);         // confirmed only: a, b, c, d
  });

  it('counts no-endDate confirmed contracts as active', async () => {
    const contracts = [
      marshalContract({ tenantId: 'acme', contractId: 'x', status: 'confirmed', contractType: 'services' }),
    ];
    mockDynamoSend.mockResolvedValue({ Items: contracts });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/contracts/stats',
      pathParameters: { tenantId: 'acme' },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.active).toBe(1);
    expect(data.expired).toBe(0);
    expect(data.expiringSoon).toBe(0);
  });
});
