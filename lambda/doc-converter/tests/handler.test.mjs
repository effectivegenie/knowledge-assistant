import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockS3Send      = vi.hoisted(() => vi.fn());
const mockBedrockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client:         vi.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn(i => ({ input: i })),
  PutObjectCommand: vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand:   vi.fn(i => ({ input: i })),
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

function makeSnsEvent(key, bucket = 'docs-bucket') {
  const s3Event = makeS3Event(key, bucket);
  return {
    Records: [{
      EventSource: 'aws:sns',
      Sns: { Message: JSON.stringify(s3Event) },
    }],
  };
}

function makeDocBytesResponse(content = 'fake document bytes') {
  const bytes = Buffer.from(content);
  return { Body: (async function* () { yield bytes; })() };
}

function makeMetadataResponse(content = '{"metadataAttributes":{"tenantId":"acme","groups":["general"],"category":"general"}}') {
  const bytes = Buffer.from(content);
  return { Body: (async function* () { yield bytes; })() };
}

function makeVisionResponse(text = 'Extracted document text') {
  const body = JSON.stringify({ content: [{ text }] });
  return { body: new TextEncoder().encode(body) };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.MODEL_ID = 'eu.anthropic.claude-haiku-test';
});

// ── Skip logic ────────────────────────────────────────────────────────────────

describe('doc-converter — skip logic', () => {
  it('skips .metadata.json files', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/report.pdf.metadata.json'));
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('skips .kb.txt files to prevent infinite loop', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/report.pdf.kb.txt'));
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('skips Word documents', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/report.docx'));
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('skips plain text files', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/notes.txt'));
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('skips CSV files', async () => {
    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/data.csv'));
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });
});

// ── PDF / image conversion ────────────────────────────────────────────────────

describe('doc-converter — PDF/image conversion', () => {
  it('converts PDF and saves .kb.txt file', async () => {
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())    // GetObject PDF
      .mockResolvedValueOnce({})                        // PutObject .kb.txt
      .mockResolvedValueOnce(makeMetadataResponse())    // GetObject .metadata.json
      .mockResolvedValueOnce({});                       // PutObject .kb.txt.metadata.json
    mockBedrockSend.mockResolvedValue(makeVisionResponse('Invoice content'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/invoice.pdf'));

    expect(res.statusCode).toBe(200);
    const putKb = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Key?.endsWith('.kb.txt') && !cmd.input?.Key?.endsWith('.metadata.json'));
    expect(putKb).toBeDefined();
    expect(putKb[0].input.Key).toBe('acme/invoice.pdf.kb.txt');
    expect(putKb[0].input.Body).toBe('Invoice content');
    expect(putKb[0].input.ContentType).toBe('text/plain; charset=utf-8');
  });

  it('sends PDF as document content block to Bedrock', async () => {
    mockS3Send.mockResolvedValue(makeDocBytesResponse());
    mockBedrockSend.mockResolvedValue(makeVisionResponse('text'));
    mockS3Send.mockResolvedValueOnce(makeDocBytesResponse()).mockResolvedValue({});

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/doc.pdf'));

    const reqBody = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    expect(reqBody.messages[0].content[0].type).toBe('document');
    expect(reqBody.messages[0].content[0].source.media_type).toBe('application/pdf');
  });

  it('sends PNG as image content block to Bedrock', async () => {
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())
      .mockResolvedValue({});
    mockBedrockSend.mockResolvedValue(makeVisionResponse('Scanned text'));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/scan.png'));

    const reqBody = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    expect(reqBody.messages[0].content[0].type).toBe('image');
    expect(reqBody.messages[0].content[0].source.media_type).toBe('image/png');
  });

  it('sends JPEG as image content block to Bedrock', async () => {
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())
      .mockResolvedValue({});
    mockBedrockSend.mockResolvedValue(makeVisionResponse('Photo text'));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/photo.jpg'));

    const reqBody = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    expect(reqBody.messages[0].content[0].type).toBe('image');
    expect(reqBody.messages[0].content[0].source.media_type).toBe('image/jpeg');
  });

  it('copies .metadata.json to .kb.txt.metadata.json preserving content', async () => {
    const metaContent = '{"metadataAttributes":{"tenantId":"acme","groups":["HR","general"],"category":"general"}}';
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(makeMetadataResponse(metaContent))
      .mockResolvedValueOnce({});
    mockBedrockSend.mockResolvedValue(makeVisionResponse('text'));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/report.pdf'));

    const metaPut = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Key?.endsWith('.kb.txt.metadata.json'));
    expect(metaPut).toBeDefined();
    expect(metaPut[0].input.Key).toBe('acme/report.pdf.kb.txt.metadata.json');
    expect(metaPut[0].input.Body).toBe(metaContent);
  });

  it('proceeds and saves .kb.txt even when metadata file not found', async () => {
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('NoSuchKey'));  // metadata missing
    mockBedrockSend.mockResolvedValue(makeVisionResponse('text'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/noMeta.pdf'));

    expect(res.statusCode).toBe(200);
    const kbPut = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Key?.endsWith('.kb.txt') && !cmd.input?.Key?.endsWith('.metadata.json'));
    expect(kbPut).toBeDefined();
  });

  it('handles SNS-wrapped OBJECT_CREATED event', async () => {
    mockS3Send
      .mockResolvedValueOnce(makeDocBytesResponse())
      .mockResolvedValue({});
    mockBedrockSend.mockResolvedValue(makeVisionResponse('Scanned text'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeSnsEvent('acme/scan.jpg'));

    expect(res.statusCode).toBe(200);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe('doc-converter — error resilience', () => {
  it('does not throw and skips saving when Vision fails', async () => {
    mockS3Send.mockResolvedValueOnce(makeDocBytesResponse());
    mockBedrockSend.mockRejectedValue(new Error('Bedrock service error'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/broken.pdf'));

    expect(res.statusCode).toBe(200);
    const kbPut = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Key?.endsWith('.kb.txt'));
    expect(kbPut).toBeUndefined();
  });

  it('does not throw when S3 read fails', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('S3 read error'));

    const { handler } = await import('../index.mjs');
    const res = await handler(makeS3Event('acme/unreadable.pdf'));

    expect(res.statusCode).toBe(200);
  });

  it('skips saving when Vision returns only whitespace', async () => {
    mockS3Send.mockResolvedValueOnce(makeDocBytesResponse());
    mockBedrockSend.mockResolvedValue(makeVisionResponse('   \n  '));

    const { handler } = await import('../index.mjs');
    await handler(makeS3Event('acme/blank.pdf'));

    const kbPut = mockS3Send.mock.calls.find(([cmd]) => cmd.input?.Key?.endsWith('.kb.txt'));
    expect(kbPut).toBeUndefined();
  });

  it('gracefully handles empty SNS message without throwing', async () => {
    const { handler } = await import('../index.mjs');
    await expect(
      handler({ Records: [{ EventSource: 'aws:sns', Sns: { Message: '{}' } }] })
    ).resolves.not.toThrow();
  });
});
