import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockS3Send       = vi.hoisted(() => vi.fn());
const mockGetSignedUrl = vi.hoisted(() => vi.fn().mockResolvedValue('https://s3.example.com/view'));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:               vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand:       vi.fn(i => ({ input: i })),
  DeleteObjectCommand:    vi.fn(i => ({ input: i })),
  ListObjectsV2Command:   vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent({
  method = 'GET',
  path = '/tenants/acme/documents',
  groups = ['TenantAdmin'],
  tenantId = 'acme',
  pathParameters = { tenantId: 'acme' },
  qs = {},
} = {}) {
  return {
    requestContext: {
      authorizer: { jwt: { claims: { 'cognito:groups': groups, 'custom:tenantId': tenantId } } },
      http: { method, path },
    },
    pathParameters,
    queryStringParameters: qs,
    body: null,
  };
}

/**
 * Return an async generator yielding a single Buffer — used to mock
 * S3 GetObject Body streams for metadata files.
 */
function makeMetadataBody(attrs = { category: 'general' }) {
  const buf = Buffer.from(JSON.stringify({ metadataAttributes: attrs }));
  return (async function* () { yield buf; })();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.DOCS_BUCKET_NAME = 'docs-bucket';
});

// ── Authorization ────────────────────────────────────────────────────────────

describe('documents handler — authorization', () => {
  it('returns 403 when caller has no relevant group', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: [] }));
    expect(res.statusCode).toBe(403);
  });

  it('allows RootAdmin to access any tenant', async () => {
    // ListObjectsV2 → empty
    mockS3Send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ groups: ['RootAdmin'], tenantId: 'any' }));
    expect(res.statusCode).not.toBe(403);
  });
});

// ── GET /documents ────────────────────────────────────────────────────────────

describe('documents handler — GET /documents', () => {
  it('returns only general category documents', async () => {
    // ListObjectsV2 → two objects: a real pdf and a metadata file (to be filtered by isHidden)
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'acme/report.pdf',               Size: 1024, LastModified: new Date('2024-01-15') },
        { Key: 'acme/invoice.pdf.metadata.json', Size: 100,  LastModified: new Date('2024-01-10') },
      ],
      IsTruncated: false,
    });
    // GetObject for 'acme/report.pdf.metadata.json' → category: general
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody({ category: 'general' }) });

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    // invoice.pdf.metadata.json is hidden, so only report.pdf passes isHidden filter
    expect(data.items).toHaveLength(1);
    expect(data.items[0].filename).toBe('report.pdf');
    expect(data.total).toBe(1);
  });

  it('excludes files where category is not "general"', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'acme/invoice.pdf', Size: 512, LastModified: new Date() },
      ],
      IsTruncated: false,
    });
    // Metadata → category: invoice (not general)
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody({ category: 'invoice' }) });

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('returns empty list when bucket has no objects', async () => {
    mockS3Send.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.items).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('includes pagination metadata in the response', async () => {
    mockS3Send.mockResolvedValueOnce({
      Contents: [
        { Key: 'acme/doc.pdf', Size: 256, LastModified: new Date() },
      ],
      IsTruncated: false,
    });
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody({ category: 'general' }) });

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({ qs: { page: '0', pageSize: '20' } }));
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('page');
    expect(data).toHaveProperty('pageSize');
  });
});

// ── DELETE /documents ─────────────────────────────────────────────────────────

describe('documents handler — DELETE /documents?key=...', () => {
  it('calls DeleteObjectCommand for 4 S3 keys (allSettled)', async () => {
    mockS3Send.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/documents',
      qs: { key: 'acme/report.pdf' },
    }));
    expect(res.statusCode).toBe(200);
    expect(mockS3Send).toHaveBeenCalledTimes(4);
    const deletedKey = JSON.parse(res.body).deleted;
    expect(deletedKey).toBe('acme/report.pdf');
  });

  it('prepends tenantId prefix when key does not already include it', async () => {
    mockS3Send.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'DELETE',
      path: '/tenants/acme/documents',
      qs: { key: 'report.pdf' },
    }));
    expect(res.statusCode).toBe(200);
    // The returned key is the bare key passed in qs
    expect(JSON.parse(res.body).deleted).toBe('report.pdf');
    // All 4 DeleteObjectCommand inputs should include the tenant prefix
    const inputKeys = mockS3Send.mock.calls.map(([cmd]) => cmd.input?.Key);
    expect(inputKeys[0]).toBe('acme/report.pdf');
    expect(inputKeys[1]).toBe('acme/report.pdf.metadata.json');
    expect(inputKeys[2]).toBe('acme/report.pdf.kb.txt');
    expect(inputKeys[3]).toBe('acme/report.pdf.kb.txt.metadata.json');
  });
});

// ── GET /documents/view-url ───────────────────────────────────────────────────

describe('documents handler — GET /documents/view-url', () => {
  it('returns a presigned URL for an existing document', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/documents/view-url',
      qs: { key: 'acme/report.pdf' },
    }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).url).toBe('https://s3.example.com/view');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when key query parameter is missing', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent({
      method: 'GET',
      path: '/tenants/acme/documents/view-url',
      qs: {},
    }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/key/i);
  });
});
