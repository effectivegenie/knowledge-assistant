import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDynamoSend  = vi.hoisted(() => vi.fn());
const mockBedrockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient:  vi.fn(() => ({ send: mockDynamoSend })),
  GetItemCommand:  vi.fn(i => ({ input: i })),
}));

vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient:      vi.fn(() => ({ send: mockBedrockSend })),
  StartIngestionJobCommand: vi.fn(i => ({ input: i })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDirectS3Event(key, bucket = 'docs-bucket', eventType = 'ObjectCreated:Put') {
  return {
    Records: [{
      eventName: eventType,
      s3: {
        bucket: { name: bucket },
        object: { key: encodeURIComponent(key) },
      },
    }],
  };
}

function makeSnsWrappedS3Event(key, bucket = 'docs-bucket') {
  const s3Event = makeDirectS3Event(key, bucket);
  return {
    Records: [{
      EventSource: 'aws:sns',
      Sns: {
        Message: JSON.stringify(s3Event),
      },
    }],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.TENANTS_TABLE              = 'tenants';
  process.env.DEFAULT_KNOWLEDGE_BASE_ID  = 'kb-default';
  process.env.DEFAULT_DATA_SOURCE_ID     = 'ds-default';
});

// ── Direct S3 event ───────────────────────────────────────────────────────────

describe('sync handler — direct S3 event', () => {
  it('starts ingestion job for known tenant', async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { knowledgeBaseId: { S: 'kb-acme' }, dataSourceId: { S: 'ds-acme' } },
    });
    mockBedrockSend.mockResolvedValue({});

    const { handler } = await import('../index.mjs');
    await handler(makeDirectS3Event('acme/doc.pdf'));

    expect(mockBedrockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ knowledgeBaseId: 'kb-acme', dataSourceId: 'ds-acme' }),
      }),
    );
  });

  it('falls back to default KB when tenant not in DynamoDB', async () => {
    mockDynamoSend.mockResolvedValue({ Item: undefined });
    mockBedrockSend.mockResolvedValue({});

    const { handler } = await import('../index.mjs');
    await handler(makeDirectS3Event('acme/doc.pdf'));

    expect(mockBedrockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ knowledgeBaseId: 'kb-default', dataSourceId: 'ds-default' }),
      }),
    );
  });
});

// ── SNS-wrapped S3 event (fanout pattern) ────────────────────────────────────

describe('sync handler — SNS-wrapped S3 event', () => {
  it('unwraps SNS envelope and starts ingestion job', async () => {
    mockDynamoSend.mockResolvedValue({
      Item: { knowledgeBaseId: { S: 'kb-acme' }, dataSourceId: { S: 'ds-acme' } },
    });
    mockBedrockSend.mockResolvedValue({});

    const { handler } = await import('../index.mjs');
    await handler(makeSnsWrappedS3Event('acme/invoice.pdf'));

    expect(mockBedrockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ knowledgeBaseId: 'kb-acme', dataSourceId: 'ds-acme' }),
      }),
    );
  });

  it('gracefully handles empty SNS message without throwing', async () => {
    mockBedrockSend.mockResolvedValue({});
    const { handler } = await import('../index.mjs');
    // Should not throw even when SNS message contains no S3 records
    await expect(
      handler({ Records: [{ EventSource: 'aws:sns', Sns: { Message: '{}' } }] })
    ).resolves.not.toThrow();
  });
});
