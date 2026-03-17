import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockS3Send      = vi.hoisted(() => vi.fn());
const mockBedrockSend = vi.hoisted(() => vi.fn());
const mockDynamoSend  = vi.hoisted(() => vi.fn());
const mockRandomUUID  = vi.hoisted(() => vi.fn().mockReturnValue('test-uuid'));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn(i => ({ input: i })),
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mocked Bedrock response wrapping the given fields object as a
 * stringified JSON content block — matching the real Bedrock response shape.
 */
function makeVisionResponse(fields) {
  const text = JSON.stringify(fields);
  const responseBody = JSON.stringify({ content: [{ text }] });
  return { body: new TextEncoder().encode(responseBody) };
}

/**
 * Return an async generator that yields the given Buffer — used to mock
 * S3 GetObject Body streams.
 */
function makeS3Body(buf) {
  return (async function* () { yield buf; })();
}

function makeMetadataBody(attrs = { category: 'contract', tenantId: 'acme' }) {
  return makeS3Body(Buffer.from(JSON.stringify({ metadataAttributes: attrs })));
}

/** Build a minimal direct S3 event record. */
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
  process.env.CONTRACTS_TABLE  = 'contracts';
  process.env.TENANTS_TABLE    = 'tenants';
  process.env.MODEL_ID         = 'test-model';
});

// ── Skip .metadata.json files ─────────────────────────────────────────────────

describe('contract-processor handler — skip metadata files', () => {
  it('skips .metadata.json files without calling Bedrock or DynamoDB', async () => {
    const { handler } = await import('../index.mjs');
    const event = makeEvent([makeS3Record('acme/contract.pdf.metadata.json')]);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('skips .kb.txt sidecar files without calling Bedrock or DynamoDB', async () => {
    const { handler } = await import('../index.mjs');
    const event = makeEvent([makeS3Record('acme/contract.pdf.kb.txt')]);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});

// ── Skip non-contract categories ─────────────────────────────────────────────

describe('contract-processor handler — category filtering', () => {
  it('skips when metadata category is not "contract"', async () => {
    // First S3 call: metadata file → category = 'invoice'
    mockS3Send.mockResolvedValueOnce({
      Body: makeMetadataBody({ category: 'invoice', tenantId: 'acme' }),
    });
    const { handler } = await import('../index.mjs');
    const event = makeEvent([makeS3Record('acme/invoice.pdf')]);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('skips when no metadata file is found (readMetadata returns null)', async () => {
    // S3 throws for the metadata file
    mockS3Send.mockRejectedValueOnce(new Error('NoSuchKey'));
    const { handler } = await import('../index.mjs');
    const event = makeEvent([makeS3Record('acme/contract.pdf')]);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});

// ── Successful extraction ─────────────────────────────────────────────────────

describe('contract-processor handler — successful extraction', () => {
  it('saves contract with status "extracted" when confidence >= 0.7', async () => {
    // S3 call 1: metadata file
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    // S3 call 2: document bytes for vision extraction
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });

    // DynamoDB GetItem for tenant profile
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        tenantId:  { S: 'acme' },
        legalName: { S: 'Acme Ltd' },
        vatNumber: { S: 'BG123' },
        bulstat:   { S: '123' },
        aliases:   { L: [] },
      },
    });
    // DynamoDB QueryCommand for dedup check → no duplicates
    mockDynamoSend.mockResolvedValueOnce({ Count: 0 });
    // DynamoDB PutItemCommand for saving contract
    mockDynamoSend.mockResolvedValueOnce({});

    // Bedrock vision response — high confidence
    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      documentType:          'contract',
      contractNumber:        'CTR-001',
      signingDate:           '2024-01-15',
      startDate:             '2024-02-01',
      endDate:               '2025-01-31',
      clientName:            'Client Corp',
      clientVatNumber:       'BG999',
      counterpartyName:      'Acme Ltd',
      counterpartyVatNumber: 'BG123',
      value:                 50000,
      currency:              'BGN',
      contractType:          'services',
      confidence:            0.9,
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/contract.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall[0].input.Item.status).toEqual({ S: 'extracted' });
    expect(putCall[0].input.Item.contractId).toEqual({ S: 'test-uuid' });
    expect(putCall[0].input.Item.contractNumber).toEqual({ S: 'CTR-001' });
    expect(putCall[0].input.Item.deduplicationKey).toEqual({ S: 'BG999#CTR-001' });
  });

  it('saves with status "review_needed" when confidence < 0.7', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });

    // Tenant profile
    mockDynamoSend.mockResolvedValueOnce({ Item: {} });
    // No dedup (no clientVatNumber + contractNumber → skips dedup query)
    mockDynamoSend.mockResolvedValueOnce({});  // PutItem

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      documentType:   'contract',
      contractNumber: null,
      signingDate:    null,
      endDate:        null,
      clientVatNumber: null,
      confidence:     0.4,
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/contract.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
  });
});

// ── Fallback record ───────────────────────────────────────────────────────────

describe('contract-processor handler — fallback on Vision failure', () => {
  it('saves fallback review_needed record when Vision extraction throws', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    // S3 doc fetch throws
    mockS3Send.mockRejectedValueOnce(new Error('InternalError'));

    // Tenant profile fetch
    mockDynamoSend.mockResolvedValueOnce({ Item: {} });
    // Fallback PutItem
    mockDynamoSend.mockResolvedValueOnce({});

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/contract.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
    expect(putCall[0].input.Item.contractId).toEqual({ S: 'test-uuid' });
    expect(putCall[0].input.Item.confidence).toEqual({ N: '0' });
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('contract-processor handler — deduplication', () => {
  it('skips saving when dedupIndex returns Count >= 1', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });

    // Tenant profile
    mockDynamoSend.mockResolvedValueOnce({ Item: {} });
    // Dedup check → duplicate found
    mockDynamoSend.mockResolvedValueOnce({ Count: 1 });

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      documentType:    'contract',
      contractNumber:  'CTR-DUP',
      clientVatNumber: 'BG-DUP',
      confidence:      0.85,
    }));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent([makeS3Record('acme/contract.pdf')]));
    expect(res.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall).toBeUndefined();
  });
});

// ── SNS-wrapped events ────────────────────────────────────────────────────────

describe('contract-processor handler — SNS-wrapped S3 events', () => {
  it('processes records wrapped in an SNS message', async () => {
    mockS3Send.mockResolvedValueOnce({ Body: makeMetadataBody() });
    mockS3Send.mockResolvedValueOnce({ Body: makeS3Body(Buffer.from('fake bytes')) });

    // Tenant profile
    mockDynamoSend.mockResolvedValueOnce({ Item: {} });
    // PutItem
    mockDynamoSend.mockResolvedValueOnce({});

    mockBedrockSend.mockResolvedValueOnce(makeVisionResponse({
      documentType: 'contract',
      confidence:   0.8,
    }));

    const innerEvent = {
      Records: [makeS3Record('acme/contract.pdf')],
    };

    const snsWrappedEvent = {
      Records: [{
        EventSource: 'aws:sns',
        Sns: { Message: JSON.stringify(innerEvent) },
      }],
    };

    const { handler } = await import('../index.mjs');
    const res = await handler(snsWrappedEvent);
    expect(res.statusCode).toBe(200);
    // Bedrock should have been called → extraction happened
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });
});
