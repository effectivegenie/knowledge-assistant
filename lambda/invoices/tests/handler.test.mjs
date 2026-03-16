import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockDynamoSend = vi.hoisted(() => vi.fn());
const mockS3Send     = vi.hoisted(() => vi.fn());
const mockGetSignedUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://s3.example.com/view'));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDynamoSend })),
  QueryCommand:        vi.fn(i => ({ input: i })),
  GetItemCommand:      vi.fn(i => ({ input: i })),
  UpdateItemCommand:   vi.fn(i => ({ input: i })),
  DeleteItemCommand:   vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand:    vi.fn(i => ({ input: i })),
  DeleteObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent({ method = 'GET', path = '/tenants/acme/invoices', groups = ['TenantAdmin'], tenantId = 'acme', pathParameters = { tenantId: 'acme' }, body = null, qs = {} } = {}) {
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

function marshalInvoice(inv) {
  const item = {};
  for (const [k, v] of Object.entries(inv)) {
    if (typeof v === 'string') item[k] = { S: v };
    else if (typeof v === 'number') item[k] = { N: String(v) };
  }
  return item;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.INVOICES_TABLE = 'invoices';
  process.env.TENANTS_TABLE  = 'tenants';
  process.env.DOCS_BUCKET_NAME = 'docs-bucket';
});

// ── Authorization ────────────────────────────────────────────────────────────

describe('invoices handler — authorization', () => {
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

// ── GET /invoices ────────────────────────────────────────────────────────────

describe('invoices handler — GET /invoices', () => {
  it('returns paginated invoice list', async () => {
    const inv = marshalInvoice({ tenantId: 'acme', invoiceId: 'uuid-1', status: 'confirmed', documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-15', amountTotal: 1000 });
    mockDynamoSend.mockResolvedValue({ Items: [inv], LastEvaluatedKey: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.items[0].invoiceId).toBe('uuid-1');
  });

  it('filters by status', async () => {
    const confirmed = marshalInvoice({ tenantId: 'acme', invoiceId: 'a', status: 'confirmed', documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-15' });
    const pending   = marshalInvoice({ tenantId: 'acme', invoiceId: 'b', status: 'pending',   documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-15' });
    mockDynamoSend.mockResolvedValue({ Items: [confirmed, pending] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ qs: { status: 'confirmed' } }));
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].invoiceId).toBe('a');
  });

  it('filters by search on supplierName', async () => {
    const match   = marshalInvoice({ tenantId: 'acme', invoiceId: 'a', status: 'confirmed', documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-15', supplierName: 'Acme Supplier' });
    const noMatch = marshalInvoice({ tenantId: 'acme', invoiceId: 'b', status: 'confirmed', documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-15', supplierName: 'Other Corp' });
    mockDynamoSend.mockResolvedValue({ Items: [match, noMatch] });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ qs: { search: 'acme' } }));
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].supplierName).toBe('Acme Supplier');
  });
});

// ── PUT /invoices/{invoiceId} ────────────────────────────────────────────────

describe('invoices handler — PUT /invoices/{invoiceId}', () => {
  it('updates invoice status to confirmed', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'confirmed' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('confirmed');
  });

  it('returns 400 for invalid status', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'flying' },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when invoice does not exist (conditional check fails)', async () => {
    const err = new Error('ConditionalCheckFailed');
    err.name = 'ConditionalCheckFailedException';
    mockDynamoSend.mockRejectedValue(err);
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/missing',
      pathParameters: { tenantId: 'acme', invoiceId: 'missing' },
      body: { status: 'confirmed' },
    }));
    expect(res.statusCode).toBe(404);
  });

  it('includes editable string and numeric fields in update expression', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'confirmed', invoiceNumber: 'INV-999', supplierName: 'Supplier Ltd', amountTotal: 1500 },
    }));
    expect(res.statusCode).toBe(200);
    const updateCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.UpdateExpression);
    expect(updateCall[0].input.ExpressionAttributeValues[':invoiceNumber']).toEqual({ S: 'INV-999' });
    expect(updateCall[0].input.ExpressionAttributeValues[':supplierName']).toEqual({ S: 'Supplier Ltd' });
    expect(updateCall[0].input.ExpressionAttributeValues[':amountTotal']).toEqual({ N: '1500' });
  });

  it('recomputes deduplicationKey when supplierVatNumber + invoiceNumber both provided', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'confirmed', supplierVatNumber: 'BG123', invoiceNumber: 'INV-001' },
    }));
    const updateCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.UpdateExpression);
    expect(updateCall[0].input.ExpressionAttributeValues[':dk']).toEqual({ S: 'BG123#INV-001' });
  });

  it('returns 400 for invalid direction', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'confirmed', direction: 'sideways' },
    }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid documentType', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
      body: { status: 'confirmed', documentType: 'receipt' },
    }));
    expect(res.statusCode).toBe(400);
  });
});

// ── GET /invoices/{invoiceId}/view-url ───────────────────────────────────────

describe('invoices handler — GET /invoices/{invoiceId}/view-url', () => {
  it('returns presigned URL for existing invoice', async () => {
    mockDynamoSend.mockResolvedValue({
      Item: marshalInvoice({ tenantId: 'acme', invoiceId: 'uuid-1', s3Key: 'acme/invoice.pdf', s3Bucket: 'docs-bucket', status: 'confirmed', documentType: 'invoice', direction: 'incoming' }),
    });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/invoices/uuid-1/view-url',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://s3.example.com/view');
  });

  it('returns 404 when invoice not found', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/invoices/missing/view-url',
      pathParameters: { tenantId: 'acme', invoiceId: 'missing' },
    }));
    expect(res.statusCode).toBe(404);
  });
});

// ── Profile ──────────────────────────────────────────────────────────────────

describe('invoices handler — tenant profile', () => {
  it('GET /profile returns tenant legal identity', async () => {
    mockDynamoSend.mockResolvedValue({
      Item: {
        tenantId:  { S: 'acme' },
        legalName: { S: 'Acme Ltd' },
        vatNumber: { S: 'BG123456789' },
        bulstat:   { S: '123456789' },
        aliases:   { L: [{ S: 'Acme' }] },
      },
    });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ method: 'GET', path: '/tenants/acme/profile', pathParameters: { tenantId: 'acme' } }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.legalName).toBe('Acme Ltd');
    expect(data.vatNumber).toBe('BG123456789');
    expect(data.aliases).toEqual(['Acme']);
  });

  it('PUT /profile updates legal identity', async () => {
    mockDynamoSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'PUT',
      path: '/tenants/acme/profile',
      pathParameters: { tenantId: 'acme' },
      body: { legalName: 'Acme Ltd', vatNumber: 'BG123', bulstat: '456', aliases: ['Acme', 'ACME Corp'] },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.legalName).toBe('Acme Ltd');
  });
});

// ── DELETE /invoices/{invoiceId} ─────────────────────────────────────────────

describe('invoices handler — DELETE /invoices/{invoiceId}', () => {
  it('returns 404 when invoice not found', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
    }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/not found/i);
  });

  it('deletes DynamoDB record and all S3 files', async () => {
    const item = marshalInvoice({ tenantId: 'acme', invoiceId: 'uuid-1', s3Key: 'acme/invoice.pdf', s3Bucket: 'docs-bucket', status: 'confirmed', documentType: 'invoice', direction: 'incoming' });
    mockDynamoSend
      .mockResolvedValueOnce({ Item: item })  // GetItem
      .mockResolvedValueOnce({});              // DeleteItem
    mockS3Send.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
    }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.deleted).toBe(true);
    expect(data.invoiceId).toBe('uuid-1');
    // 4 S3 DeleteObjectCommand calls for the 4 derived keys
    expect(mockS3Send).toHaveBeenCalledTimes(4);
  });

  it('still returns 200 when S3 delete partially fails (allSettled)', async () => {
    const item = marshalInvoice({ tenantId: 'acme', invoiceId: 'uuid-1', s3Key: 'acme/invoice.pdf', s3Bucket: 'docs-bucket', status: 'confirmed', documentType: 'invoice', direction: 'incoming' });
    mockDynamoSend
      .mockResolvedValueOnce({ Item: item })  // GetItem
      .mockResolvedValueOnce({});              // DeleteItem
    // First S3 call fails, the rest succeed
    mockS3Send
      .mockRejectedValueOnce(new Error('NoSuchKey'))
      .mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/invoices/uuid-1',
      pathParameters: { tenantId: 'acme', invoiceId: 'uuid-1' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(true);
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

describe('invoices handler — GET /invoices/stats', () => {
  it('computes income, expenses, net, unpaid', async () => {
    const invoices = [
      marshalInvoice({ tenantId: 'acme', invoiceId: 'a', status: 'confirmed', documentType: 'invoice', direction: 'outgoing', issueDate: '2024-01-15', amountTotal: 5000 }),
      marshalInvoice({ tenantId: 'acme', invoiceId: 'b', status: 'paid',      documentType: 'invoice', direction: 'incoming', issueDate: '2024-01-20', amountTotal: 2000 }),
      marshalInvoice({ tenantId: 'acme', invoiceId: 'c', status: 'confirmed', documentType: 'proforma', direction: 'outgoing', issueDate: '2024-01-25', amountTotal: 999 }), // excluded from stats
    ];
    mockDynamoSend.mockResolvedValue({ Items: invoices });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ method: 'GET', path: '/tenants/acme/invoices/stats', pathParameters: { tenantId: 'acme' } }));
    expect(res.statusCode).toBe(200);
    const { totals } = JSON.parse(res.body);
    expect(totals.income).toBe(5000);    // outgoing confirmed invoice
    expect(totals.expenses).toBe(2000);  // incoming paid invoice
    expect(totals.net).toBe(3000);
    expect(totals.unpaid).toBe(5000);    // confirmed (not yet paid) outgoing invoice
  });

  it('groups amounts by month in byMonth', async () => {
    const invoices = [
      marshalInvoice({ tenantId: 'acme', invoiceId: 'a', status: 'confirmed', documentType: 'invoice', direction: 'outgoing', issueDate: '2024-01-15', amountTotal: 1000 }),
      marshalInvoice({ tenantId: 'acme', invoiceId: 'b', status: 'confirmed', documentType: 'invoice', direction: 'outgoing', issueDate: '2024-02-10', amountTotal: 2000 }),
    ];
    mockDynamoSend.mockResolvedValue({ Items: invoices });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ method: 'GET', path: '/tenants/acme/invoices/stats', pathParameters: { tenantId: 'acme' } }));
    const { byMonth } = JSON.parse(res.body);
    expect(byMonth).toHaveLength(2);
    expect(byMonth[0].month).toBe('2024-01');
    expect(byMonth[0].income).toBe(1000);
    expect(byMonth[1].month).toBe('2024-02');
    expect(byMonth[1].income).toBe(2000);
  });
});
