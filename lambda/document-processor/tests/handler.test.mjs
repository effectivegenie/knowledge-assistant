import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockS3Send       = vi.hoisted(() => vi.fn());
const mockTextractSend = vi.hoisted(() => vi.fn());
const mockBedrockSend  = vi.hoisted(() => vi.fn());
const mockDynamoSend   = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-textract', () => ({
  TextractClient: vi.fn(() => ({ send: mockTextractSend })),
  AnalyzeExpenseCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand:   vi.fn(i => ({ input: i })),
  QueryCommand:     vi.fn(i => ({ input: i })),
  GetItemCommand:   vi.fn(i => ({ input: i })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeS3Event(key, bucket = 'docs-bucket') {
  return {
    Records: [{
      s3: {
        bucket: { name: bucket },
        object: { key: encodeURIComponent(key) },
      },
    }],
  };
}

function makeMetadataResponse(category = 'invoice', groups = ['general']) {
  const body = JSON.stringify({ metadataAttributes: { tenantId: 'acme', groups, category } });
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  return {
    Body: (async function* () { yield bytes; })(),
  };
}

function makeTextractResponse(fields = {}) {
  const summaryFields = Object.entries(fields).map(([type, value]) => ({
    Type: { Text: type },
    ValueDetection: { Text: value, Confidence: 90 },
  }));
  return { ExpenseDocuments: [{ SummaryFields: summaryFields }] };
}

function makeLLMResponse(normalized) {
  const text = JSON.stringify(normalized);
  const body = JSON.stringify({ content: [{ text }] });
  return { body: new TextEncoder().encode(body) };
}

function stubDynamo() {
  mockDynamoSend.mockImplementation(cmd => {
    // GetItem for tenant profile
    if (cmd.input?.TableName === process.env.TENANTS_TABLE) {
      return Promise.resolve({ Item: { tenantId: { S: 'acme' }, legalName: { S: 'Acme Ltd' } } });
    }
    // QueryCommand for dedup check — returns no results
    if (cmd.input?.IndexName === 'dedupIndex') {
      return Promise.resolve({ Count: 0, Items: [] });
    }
    // PutItemCommand
    return Promise.resolve({});
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.INVOICES_TABLE = 'invoices';
  process.env.TENANTS_TABLE  = 'tenants';
  process.env.MODEL_ID       = 'eu.anthropic.claude-haiku-test';
});

function makeSnsEvent(key, bucket = 'docs-bucket') {
  const s3Event = makeS3Event(key, bucket);
  return {
    Records: [{
      EventSource: 'aws:sns',
      Sns: { Message: JSON.stringify(s3Event) },
    }],
  };
}

// ── Core flow ────────────────────────────────────────────────────────────────

describe('document-processor — core extraction flow', () => {
  it('skips .metadata.json files', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/invoice.pdf.metadata.json'));
    expect(mockTextractSend).not.toHaveBeenCalled();
  });

  it('processes SNS-wrapped OBJECT_CREATED event', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));
    const { handler } = await import('../index.mjs');
    await handler(makeSnsEvent('acme/orphan.pdf'));
    // metadata not found → skips Textract (same as direct S3 no-metadata test)
    expect(mockTextractSend).not.toHaveBeenCalled();
  });

  it('skips documents with category != invoice', async () => {
    mockS3Send.mockResolvedValue(makeMetadataResponse('general'));
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/report.pdf'));
    expect(mockTextractSend).not.toHaveBeenCalled();
  });

  it('skips documents with no metadata file', async () => {
    mockS3Send.mockRejectedValue(new Error('NoSuchKey'));
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/orphan.pdf'));
    expect(mockTextractSend).not.toHaveBeenCalled();
  });

  it('processes invoice file and saves extracted record', async () => {
    stubDynamo();
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockResolvedValue(makeTextractResponse({
      INVOICE_RECEIPT_ID: 'INV-001',
      INVOICE_RECEIPT_DATE: '2024-01-15',
      VENDOR_NAME: 'Supplier Ltd',
      TOTAL: '1190.00',
    }));
    const normalized = { documentType: 'invoice', direction: 'incoming', invoiceNumber: 'INV-001', issueDate: '2024-01-15', dueDate: null, supplierName: 'Supplier Ltd', supplierVatNumber: 'BG123', clientName: 'Acme Ltd', clientVatNumber: 'BG999', amountNet: 1000, amountVat: 190, amountTotal: 1190, confidence: 0.9 };
    mockBedrockSend.mockResolvedValue(makeLLMResponse(normalized));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/invoice.pdf'));

    expect(res.statusCode).toBe(200);
    expect(mockDynamoSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            status:       { S: 'extracted' },
            documentType: { S: 'invoice' },
            invoiceNumber: { S: 'INV-001' },
            amountTotal:  { N: '1190' },
          }),
        }),
      }),
    );
  });
});

// ── Status assignment ────────────────────────────────────────────────────────

describe('document-processor — status based on confidence', () => {
  it('saves extracted when confidence >= 0.7', async () => {
    stubDynamo();
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockResolvedValue(makeTextractResponse({ INVOICE_RECEIPT_ID: 'INV-001' }));
    mockBedrockSend.mockResolvedValue(makeLLMResponse({ documentType: 'invoice', direction: 'incoming', invoiceNumber: 'INV-001', issueDate: '2024-01-15', supplierVatNumber: 'BG1', amountTotal: 100, confidence: 0.85 }));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/inv.pdf'));

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall[0].input.Item.status).toEqual({ S: 'extracted' });
  });

  it('saves review_needed when confidence < 0.7', async () => {
    stubDynamo();
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockResolvedValue(makeTextractResponse({}));
    mockBedrockSend.mockResolvedValue(makeLLMResponse({ documentType: 'invoice', direction: 'incoming', confidence: 0.4 }));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/unclear.pdf'));

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
  });
});

// ── Duplicate detection ───────────────────────────────────────────────────────

describe('document-processor — duplicate detection', () => {
  it('skips saving when duplicate found', async () => {
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockResolvedValue(makeTextractResponse({ INVOICE_RECEIPT_ID: 'INV-001' }));
    mockBedrockSend.mockResolvedValue(makeLLMResponse({ documentType: 'invoice', direction: 'incoming', invoiceNumber: 'INV-001', supplierVatNumber: 'BG123', confidence: 0.9 }));

    // Tenant profile + dedup check returns existing record
    mockDynamoSend.mockImplementation(cmd => {
      if (cmd.input?.TableName === process.env.TENANTS_TABLE) return Promise.resolve({ Item: {} });
      if (cmd.input?.IndexName === 'dedupIndex') return Promise.resolve({ Count: 1, Items: [{}] });
      return Promise.resolve({});
    });

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/dup.pdf'));

    // PutItemCommand must NOT have been called
    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall).toBeUndefined();
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe('document-processor — error resilience', () => {
  it('saves fallback review_needed record when Textract fails', async () => {
    stubDynamo();
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockRejectedValue(new Error('Textract service error'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/broken.pdf'));

    expect(res.statusCode).toBe(200);
    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall).toBeDefined();
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
    expect(putCall[0].input.Item.confidence).toEqual({ N: '0' });
  });

  it('saves fallback record when LLM normalization fails', async () => {
    stubDynamo();
    mockS3Send.mockResolvedValue(makeMetadataResponse('invoice'));
    mockTextractSend.mockResolvedValue(makeTextractResponse({ TOTAL: '100' }));
    mockBedrockSend.mockRejectedValue(new Error('Bedrock error'));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/llm-fail.pdf'));

    const putCall = mockDynamoSend.mock.calls.find(([cmd]) => cmd.input?.Item);
    expect(putCall).toBeDefined();
    expect(putCall[0].input.Item.status).toEqual({ S: 'review_needed' });
  });
});
