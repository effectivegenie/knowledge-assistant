import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockS3Send      = vi.hoisted(() => vi.fn());
const mockBedrockSend = vi.hoisted(() => vi.fn());
const mockDynamoSend  = vi.hoisted(() => vi.fn());
const mockRandomUUID  = vi.hoisted(() => vi.fn().mockReturnValue('test-uuid'));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn(i => ({ input: i })),
  PutObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand:   vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient:  vi.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand:  vi.fn(i => ({ input: i })),
  QueryCommand:    vi.fn(i => ({ input: i })),
  GetItemCommand:  vi.fn(i => ({ input: i })),
}));

vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeVisionResponse(fields) {
  const text = JSON.stringify(fields);
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })) };
}

function makeS3Body(buf) {
  return (async function* () { yield buf; })();
}

function makeMetadataBody(attrs = { category: 'general', tenantId: 'acme' }) {
  return makeS3Body(Buffer.from(JSON.stringify({ metadataAttributes: attrs })));
}

function makeS3Record(key, bucket = 'docs-bucket') {
  return {
    s3: {
      bucket: { name: bucket },
      object: { key: encodeURIComponent(key).replace(/%2F/g, '/') },
    },
  };
}

function makeEvent(records) {
  return { Records: records };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.INVOICES_TABLE  = 'invoices';
  process.env.CONTRACTS_TABLE = 'contracts';
  process.env.TENANTS_TABLE   = 'tenants';
  process.env.MODEL_ID        = 'test-model';
});

// ── Skip sidecar files ───────────────────────────────────────────────────────

describe('doc-classifier handler — skip sidecar files', () => {
  it('skips .metadata.json files without calling Bedrock or DynamoDB', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/doc.pdf.metadata.json')]));
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('skips .kb.txt sidecar files without calling Bedrock or DynamoDB', async () => {
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/doc.pdf.kb.txt')]));
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});

// ── Skip already-categorised files ──────────────────────────────────────────

describe('doc-classifier handler — skip already-categorised files', () => {
  it('skips when category is already "invoice"', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody({ category: 'invoice' }) });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/invoice.pdf')]));
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('skips when category is already "contract"', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody({ category: 'contract' }) });
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/contract.pdf')]));
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('skips when no metadata file is found', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey'));
    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/doc.pdf')]));
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});

// ── Auto-detect invoice ──────────────────────────────────────────────────────

describe('doc-classifier handler — auto-detect invoice', () => {
  it('saves review_needed invoice record and updates metadata when classified as invoice', async () => {
    // metadata read
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    // doc bytes for vision
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });
    // metadata PUT (update category)
    mockS3Send.mockResolvedValueOnce({});

    // tenant profile
    mockDynamoSend.mockResolvedValueOnce({ Item: { legalName: { S: 'Acme Ltd' }, vatNumber: { S: 'BG123' }, aliases: { L: [] } } });
    // dedup check → no duplicate
    mockDynamoSend.mockResolvedValueOnce({ Count: 0 });
    // PutItem
    mockDynamoSend.mockResolvedValueOnce({});

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      category:          'invoice',
      documentType:      'invoice',
      direction:         'incoming',
      invoiceNumber:     'INV-100',
      issueDate:         '2024-03-01',
      supplierVatNumber: 'BG-SUP',
      amountTotal:       1190,
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/mystery.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item?.invoiceId);
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
    expect(putCall[0].input.Item.autoDetected).toEqual({ BOOL: true });
    expect(putCall[0].input.Item.invoiceNumber).toEqual({ S: 'INV-100' });
    expect(putCall[0].input.Item.deduplicationKey).toEqual({ S: 'BG-SUP#INV-100' });
    expect(putCall[0].input.Item.invoiceId).toEqual({ S: 'test-uuid' });

    // metadata should be updated with 'invoice' category
    const putS3Call = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Body);
    const body = JSON.parse(putS3Call[0].input.Body);
    expect(body.metadataAttributes.category).toBe('invoice');
  });

  it('skips saving when duplicate invoice exists', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('bytes')) });

    mockDynamoSend.mockResolvedValueOnce({ Item: {} }); // tenant profile
    mockDynamoSend.mockResolvedValueOnce({ Count: 1 }); // duplicate found

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      category:          'invoice',
      invoiceNumber:     'INV-DUP',
      supplierVatNumber: 'BG-DUP',
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/dup.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item?.invoiceId);
    expect(putCall).toBeUndefined();
  });
});

// ── Auto-detect contract ─────────────────────────────────────────────────────

describe('doc-classifier handler — auto-detect contract', () => {
  it('saves review_needed contract record and updates metadata when classified as contract', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });
    mockS3Send.mockResolvedValueOnce({}); // metadata PUT

    mockDynamoSend.mockResolvedValueOnce({ Item: { legalName: { S: 'Acme Ltd' }, aliases: { L: [] } } });
    mockDynamoSend.mockResolvedValueOnce({ Count: 0 }); // no duplicate
    mockDynamoSend.mockResolvedValueOnce({});           // PutItem

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      category:        'contract',
      documentType:    'contract',
      contractNumber:  'CTR-200',
      clientVatNumber: 'BG-CLIENT',
      contractType:    'services',
      endDate:         '2025-12-31',
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/agreement.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item?.contractId);
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
    expect(putCall[0].input.Item.autoDetected).toEqual({ BOOL: true });
    expect(putCall[0].input.Item.contractNumber).toEqual({ S: 'CTR-200' });
    expect(putCall[0].input.Item.deduplicationKey).toEqual({ S: 'BG-CLIENT#CTR-200' });

    const putS3Call = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Body);
    expect(JSON.parse(putS3Call[0].input.Body).metadataAttributes.category).toBe('contract');
  });
});

// ── Classified as "other" ────────────────────────────────────────────────────

describe('doc-classifier handler — other category', () => {
  it('does not write to DynamoDB when document is classified as "other"', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('bytes')) });

    mockDynamoSend.mockResolvedValueOnce({ Item: {} }); // tenant profile

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({ category: 'other' }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/report.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item?.invoiceId || cmd.input?.Item?.contractId);
    expect(putCall).toBeUndefined();
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe('doc-classifier handler — error handling', () => {
  it('continues processing without crashing when Bedrock throws', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockRejectedValueOnce(new Error('Bedrock unavailable'));

    mockDynamoSend.mockResolvedValueOnce({ Item: {} }); // tenant profile

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/fail.pdf')]));
    expect(res.statusCode).toBe(200);
    // No fallback record — document stays in general Documents
    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item?.invoiceId || cmd.input?.Item?.contractId);
    expect(putCall).toBeUndefined();
  });
});

// ── SNS-wrapped events ───────────────────────────────────────────────────────

describe('doc-classifier handler — SNS-wrapped events', () => {
  it('processes records wrapped in an SNS message', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('bytes')) });
    mockS3Send.mockResolvedValueOnce({});

    mockDynamoSend.mockResolvedValueOnce({ Item: {} });
    mockDynamoSend.mockResolvedValueOnce({ Count: 0 });
    mockDynamoSend.mockResolvedValueOnce({});

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({ category: 'invoice', documentType: 'invoice', direction: 'incoming' }));

    const snsWrapped = {
      Records: [{
        EventSource: 'aws:sns',
        Sns: { Message: JSON.stringify({ Records: [makeS3Record('acme/wrapped.pdf')] }) },
      }],
    };

    const { handler } = await import('../index.mjs');
    const res = await handler(snsWrapped);
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });
});
