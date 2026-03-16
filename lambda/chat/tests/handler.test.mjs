import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock helpers ────────────────────────────────────────────────────────────

const mockRetrieve = vi.hoisted(() => vi.fn());
const mockInvokeStream = vi.hoisted(() => vi.fn());
const mockPostToConnection = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockDynamoSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: vi.fn(() => ({ send: mockRetrieve })),
  RetrieveCommand: vi.fn(input => ({ input })),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: mockInvokeStream })),
  InvokeModelWithResponseStreamCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: vi.fn(() => ({ send: mockPostToConnection })),
  PostToConnectionCommand: vi.fn(input => ({ input })),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDynamoSend })),
  GetItemCommand: vi.fn(input => ({ input })),
  PutItemCommand: vi.fn(input => ({ input })),
  QueryCommand: vi.fn(input => ({ input })),
}));

// ── Test utilities ──────────────────────────────────────────────────────────

/**
 * Build a minimal Lambda WebSocket event.
 */
function makeEvent({ text = 'hello', tenantId = 'acme', user = 'u@acme.com' } = {}) {
  return {
    requestContext: {
      connectionId: 'conn-123',
      domainName: 'api.example.com',
      stage: 'prod',
    },
    body: JSON.stringify({ text, tenantId, user }),
  };
}

/**
 * Build a Bedrock RetrieveCommand result item.
 */
function makeRetrievalResult({ tenantId = 'acme', groups = null, uri = null, text = 'chunk content' } = {}) {
  const metadata = { tenantId };
  if (groups !== null) metadata.groups = groups;
  return {
    content: { text },
    score: 0.9,
    location: { s3Location: { uri: uri || `s3://docs-bucket/${tenantId}/doc.pdf` } },
    metadata,
  };
}

/**
 * Minimal streaming response from Bedrock (one text chunk).
 */
function makeStreamResponse(text = 'answer') {
  const chunk = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
  const bytes = new TextEncoder().encode(chunk);
  return {
    body: (async function* () {
      yield { chunk: { bytes } };
    })(),
  };
}

/**
 * Stub DynamoDB: connection record + empty history + no-op PutItem.
 */
function stubDynamo({ tenantId = 'acme', email = 'u@acme.com', groups = [] } = {}) {
  mockDynamoSend.mockImplementation(cmd => {
    const input = cmd.input ?? cmd;
    // GetItem — could be connections table or tenants table
    if (input.TableName === process.env.CONNECTIONS_TABLE) {
      return Promise.resolve({
        Item: {
          connectionId: { S: 'conn-123' },
          tenantId: { S: tenantId },
          email: { S: email },
          groups: { L: groups.map(g => ({ S: g })) },
        },
      });
    }
    if (input.TableName === process.env.TENANTS_TABLE) {
      return Promise.resolve({
        Item: {
          tenantId: { S: tenantId },
          knowledgeBaseId: { S: 'kb-1' },
          docsPrefix: { S: `${tenantId}/` },
        },
      });
    }
    // QueryCommand for chat history
    if (input.KeyConditionExpression) return Promise.resolve({ Items: [] });
    // PutItemCommand
    return Promise.resolve({});
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.CONNECTIONS_TABLE = 'connections';
  process.env.TENANTS_TABLE = 'tenants';
  process.env.CHAT_TABLE = 'chat';
  process.env.DOCS_BUCKET_NAME = 'docs-bucket';
  process.env.MODEL_ID = 'model-id';
  mockPostToConnection.mockResolvedValue({});
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('chat handler — tenant isolation (primary KB filter)', () => {
  it('uses equals tenantId filter as primary retrieval', async () => {
    stubDynamo({ groups: ['financial'] });
    mockRetrieve.mockResolvedValue({ retrievalResults: [makeRetrievalResult()] });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const retrieveCall = mockRetrieve.mock.calls.find(
      ([cmd]) => cmd.input?.retrievalConfiguration?.vectorSearchConfiguration?.filter?.equals,
    );
    expect(retrieveCall).toBeDefined();
    expect(retrieveCall[0].input.retrievalConfiguration.vectorSearchConfiguration.filter.equals)
      .toEqual({ key: 'tenantId', value: 'acme' });
  });

  it('falls back to unfiltered retrieval when KB filter returns 0 results', async () => {
    stubDynamo({ groups: [] });
    // First call (equals filter) returns empty; second call (no filter) returns a result
    mockRetrieve
      .mockResolvedValueOnce({ retrievalResults: [] })
      .mockResolvedValueOnce({ retrievalResults: [makeRetrievalResult()] });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockRetrieve).toHaveBeenCalledTimes(2);

    const fallbackCall = mockRetrieve.mock.calls[1];
    // Second call must have no filter
    expect(fallbackCall[0].input.retrievalConfiguration.vectorSearchConfiguration.filter).toBeUndefined();
  });
});

describe('chat handler — group access control (Lambda post-filter)', () => {
  it('allows docs whose groups array contains the user group', async () => {
    stubDynamo({ groups: ['financial'] });
    const results = [
      makeRetrievalResult({ groups: ['financial', 'IT'], uri: 's3://docs-bucket/acme/fin.pdf', text: 'fin content' }),
      makeRetrievalResult({ groups: ['IT'], uri: 's3://docs-bucket/acme/it.pdf', text: 'it content' }),
    ];
    mockRetrieve.mockResolvedValue({ retrievalResults: results });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => {
        try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; }
      },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    const sources = citations.map(c => c.source);
    expect(sources).toContain('s3://docs-bucket/acme/fin.pdf');
    expect(sources).not.toContain('s3://docs-bucket/acme/it.pdf');
  });

  it('allows docs tagged with general regardless of user groups', async () => {
    stubDynamo({ groups: ['financial'] });
    mockRetrieve.mockResolvedValue({
      retrievalResults: [
        makeRetrievalResult({ groups: ['general'], uri: 's3://docs-bucket/acme/general.pdf', text: 'general' }),
      ],
    });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    expect(citations[0].source).toBe('s3://docs-bucket/acme/general.pdf');
  });

  it('allows docs with no groups metadata (legacy backward compat)', async () => {
    stubDynamo({ groups: ['financial'] });
    mockRetrieve.mockResolvedValue({
      retrievalResults: [makeRetrievalResult({ groups: null, uri: 's3://docs-bucket/acme/legacy.pdf' })],
    });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    expect(citations[0].source).toBe('s3://docs-bucket/acme/legacy.pdf');
  });

  it('handles groups metadata as a JSON string (S3 Vectors serialisation)', async () => {
    stubDynamo({ groups: ['HR'] });
    mockRetrieve.mockResolvedValue({
      retrievalResults: [
        makeRetrievalResult({ groups: '["HR","general"]', uri: 's3://docs-bucket/acme/hr.pdf', text: 'hr content' }),
      ],
    });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    expect(citations[0].source).toBe('s3://docs-bucket/acme/hr.pdf');
  });

  it('strips extra quotes Bedrock wraps around array elements', async () => {
    // S3 Vectors returns: ['"HR"', '"general"'] — each element has extra quotes
    stubDynamo({ groups: ['design'] });
    mockRetrieve.mockResolvedValue({
      retrievalResults: [
        {
          content: { text: 'design doc' },
          score: 0.8,
          location: { s3Location: { uri: 's3://docs-bucket/acme/design.pdf' } },
          metadata: { tenantId: 'acme', groups: ['"design"', '"general"'] },
        },
      ],
    });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    expect(citations[0].source).toBe('s3://docs-bucket/acme/design.pdf');
  });
});

describe('chat handler — admin bypass', () => {
  it('admin user skips group filter and sees all tenant docs', async () => {
    stubDynamo({ groups: ['TenantAdmin'] });
    const results = [
      makeRetrievalResult({ groups: ['financial'], uri: 's3://docs-bucket/acme/fin.pdf', text: 'fin' }),
      makeRetrievalResult({ groups: ['IT'], uri: 's3://docs-bucket/acme/it.pdf', text: 'it' }),
    ];
    mockRetrieve.mockResolvedValue({ retrievalResults: results });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
    const { citations } = JSON.parse(citationsCall[0].input.Data);
    const sources = citations.map(c => c.source);
    expect(sources).toContain('s3://docs-bucket/acme/fin.pdf');
    expect(sources).toContain('s3://docs-bucket/acme/it.pdf');
  });

  it('RootAdmin skips group filter', async () => {
    stubDynamo({ groups: ['RootAdmin'] });
    mockRetrieve.mockResolvedValue({
      retrievalResults: [makeRetrievalResult({ groups: ['security'] })],
    });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const citationsCall = mockPostToConnection.mock.calls.find(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(citationsCall).toBeDefined();
  });
});

describe('chat handler — citations', () => {
  it('sends citations event after end event', async () => {
    stubDynamo({ groups: [] });
    mockRetrieve.mockResolvedValue({ retrievalResults: [makeRetrievalResult()] });
    mockInvokeStream.mockResolvedValue(makeStreamResponse('answer text'));

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const sentTypes = mockPostToConnection.mock.calls.map(([cmd]) => {
      try { return JSON.parse(cmd.input.Data).type; } catch { return null; }
    });
    const endIdx = sentTypes.lastIndexOf('end');
    const citIdx = sentTypes.indexOf('citations');
    expect(citIdx).toBeGreaterThan(endIdx);
  });

  it('does not send citations when RAG returns no results', async () => {
    stubDynamo({ groups: [] });
    mockRetrieve.mockResolvedValue({ retrievalResults: [] });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent());

    const hasCitations = mockPostToConnection.mock.calls.some(
      ([cmd]) => { try { return JSON.parse(cmd.input.Data).type === 'citations'; } catch { return false; } },
    );
    expect(hasCitations).toBe(false);
  });
});

describe('chat handler — identity from connection record', () => {
  it('uses tenantId from CONNECTIONS_TABLE, not from event body', async () => {
    // Connection record has tenantId 'real-tenant', body has 'fake-tenant'
    mockDynamoSend.mockImplementation(cmd => {
      const input = cmd.input ?? cmd;
      if (input.TableName === process.env.CONNECTIONS_TABLE) {
        return Promise.resolve({
          Item: {
            connectionId: { S: 'conn-123' },
            tenantId: { S: 'real-tenant' },
            email: { S: 'u@real.com' },
            groups: { L: [] },
          },
        });
      }
      if (input.TableName === process.env.TENANTS_TABLE) {
        return Promise.resolve({
          Item: {
            tenantId: { S: 'real-tenant' },
            knowledgeBaseId: { S: 'kb-1' },
            docsPrefix: { S: 'real-tenant/' },
          },
        });
      }
      if (input.KeyConditionExpression) return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });

    mockRetrieve.mockResolvedValue({ retrievalResults: [] });
    mockInvokeStream.mockResolvedValue(makeStreamResponse());

    const { handler } = await import('../index.mjs');
    await handler(makeEvent({ tenantId: 'fake-tenant' }));

    const retrieveCall = mockRetrieve.mock.calls[0];
    expect(retrieveCall[0].input.retrievalConfiguration.vectorSearchConfiguration.filter.equals.value)
      .toBe('real-tenant');
  });
});
