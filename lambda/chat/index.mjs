import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const bedrockClient = new BedrockRuntimeClient({});
const dynamo = new DynamoDBClient({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const CHAT_TABLE = process.env.CHAT_TABLE;
const TENANTS_TABLE = process.env.TENANTS_TABLE;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const DEFAULT_KNOWLEDGE_BASE_ID = process.env.DEFAULT_KNOWLEDGE_BASE_ID;
const DOCS_BUCKET_NAME = process.env.DOCS_BUCKET_NAME;
const MODEL_PROVIDER = process.env.MODEL_PROVIDER || 'bedrock';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const HISTORY_LIMIT = 20;

const SYSTEM_GROUPS = ['RootAdmin', 'TenantAdmin'];

const postToConnection = async (apiGw, connectionId, data) => {
  await apiGw.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: JSON.stringify(data),
  }));
};

async function getTenantKb(tenantId) {
  if (!TENANTS_TABLE) return { knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID, docsPrefix: null };
  const resp = await dynamo.send(new GetItemCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId: { S: String(tenantId || 'default') } },
  }));
  return {
    knowledgeBaseId: resp.Item?.knowledgeBaseId?.S || DEFAULT_KNOWLEDGE_BASE_ID,
    docsPrefix: resp.Item?.docsPrefix?.S || null,
  };
}

async function saveMessage(tenantUser, role, text) {
  await dynamo.send(new PutItemCommand({
    TableName: CHAT_TABLE,
    Item: {
      tenantUser: { S: String(tenantUser) },
      timestamp: { S: new Date().toISOString() },
      role: { S: role },
      text: { S: text ?? '' },
      isDeleted: { N: '0' },
    },
  }));
}

async function getHistory(tenantUser) {
  const result = await dynamo.send(new QueryCommand({
    TableName: CHAT_TABLE,
    KeyConditionExpression: 'tenantUser = :u',
    FilterExpression: 'isDeleted = :d',
    ExpressionAttributeValues: {
      ':u': { S: String(tenantUser) },
      ':d': { N: '0' },
    },
    ScanIndexForward: false,
    Limit: HISTORY_LIMIT,
  }));

  return (result.Items || []).map(i => ({
    role: i.role.S === 'ai' ? 'assistant' : i.role.S,
    content: i.text.S,
  })).reverse();
}

export const handler = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const prompt = body.text || body.data?.prompt;
  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  // Fetch authoritative connection record — don't trust client-supplied body for identity
  let tenantId = body.tenantId || 'default';
  let userGroups = [];
  let userEmail = body.user || 'anonymous';

  if (CONNECTIONS_TABLE) {
    try {
      const connItem = await dynamo.send(new GetItemCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId: { S: connectionId } },
      }));
      if (connItem.Item) {
        tenantId = connItem.Item.tenantId?.S || tenantId;
        userGroups = (connItem.Item.groups?.L || []).map(g => g.S);
        userEmail = connItem.Item.email?.S || userEmail;
        log.debug('Connection record fetched', { connectionId, tenantId, email: userEmail, groupCount: userGroups.length });
      } else {
        log.warn('Connection record not found, using body values', { connectionId });
      }
    } catch (err) {
      log.warn('Failed to fetch connection record, falling back to body values', { connectionId, error: err.message });
    }
  }

  const user = userEmail;
  const tenantUser = `${tenantId}#${user}`;

  const isAdmin = userGroups.some(g => SYSTEM_GROUPS.includes(g));
  const businessGroups = userGroups.filter(g => !SYSTEM_GROUPS.includes(g));

  log.info('Chat message received', { connectionId, tenantId, email: user, isAdmin, businessGroupCount: businessGroups.length });

  try {
    await saveMessage(tenantUser, 'user', prompt);

    const { knowledgeBaseId, docsPrefix } = await getTenantKb(tenantId);
    let context = '';
    let retrievalResults = [];

    if (knowledgeBaseId) {
      log.debug('RAG retrieval starting', { tenantId, knowledgeBaseId, isAdmin, businessGroups });
      try {
        // S3 Vectors only supports: equals, notEquals, greaterThan/LessThan, in, notIn.
        // startsWith and listContains are OpenSearch Serverless only — do NOT use them.
        //
        // Tenant isolation: use equals filter on the custom 'tenantId' metadata attribute
        // (stored in .metadata.json alongside each document).
        //
        // Group access control: post-filter in Lambda by inspecting result metadata.groups.
        // This avoids needing unsupported listContains and correctly handles multi-value groups.

        // Retrieve more candidates when we'll post-filter by groups
        const needsGroupFilter = !isAdmin && businessGroups.length > 0;
        const numberOfResults = needsGroupFilter ? 20 : 5;

        const filter = { equals: { key: 'tenantId', value: tenantId } };

        const resp = await bedrockAgentClient.send(new RetrieveCommand({
          knowledgeBaseId,
          retrievalQuery: { text: prompt },
          retrievalConfiguration: {
            vectorSearchConfiguration: { numberOfResults, filter },
          },
        }));

        let results = resp.retrievalResults || [];
        log.debug('RAG raw results', { tenantId, count: results.length, needsGroupFilter });

        if (needsGroupFilter) {
          // Post-filter: keep docs whose groups overlap with the user's groups or 'general'
          const allowedGroups = new Set([...businessGroups, 'general']);
          const filtered = results.filter(r => {
            const docGroups = r.metadata?.groups;
            if (!docGroups) return false; // no metadata → not accessible to group-restricted users
            const docGroupList = Array.isArray(docGroups) ? docGroups : [String(docGroups).split(',')];
            return docGroupList.some(g => allowedGroups.has(String(g).trim()));
          });
          log.info('RAG post-group-filter', { tenantId, before: results.length, after: filtered.length, businessGroups });
          results = filtered.slice(0, 5);
        } else {
          results = results.slice(0, 5);
        }

        retrievalResults = results;
        log.info('RAG retrieval complete', { tenantId, resultCount: retrievalResults.length });
        context = retrievalResults.map(r => r.content.text).join('\n\n---\n\n');
      } catch (err) {
        log.error('RAG retrieve error', { tenantId, knowledgeBaseId, error: err.message });
        context = '';
      }
    }

    const history = await getHistory(tenantUser);

    const systemMessage = context
      ? `You are a helpful knowledge base assistant. Use the following context to answer questions.\n\nContext:\n${context}\n\nIf the context doesn't contain relevant information, say so. Write in the same language as the user's question.`
      : "You are a helpful assistant. Answer questions clearly and concisely. Write in the same language as the user's question.";

    const messages = [
      ...history,
      { role: 'user', content: prompt },
    ];

    let assistantMessage = '';

    log.debug('Invoking model', { provider: MODEL_PROVIDER, historyLength: history.length, hasContext: context.length > 0 });

    if (MODEL_PROVIDER === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set');
      }

      const openAiMessages = [
        { role: 'system', content: systemMessage },
        ...messages,
      ];

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: openAiMessages,
          max_tokens: 4096,
          stream: false,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`OpenAI error: ${resp.status} ${text}`);
      }

      const data = await resp.json();
      assistantMessage = data.choices?.[0]?.message?.content || '';

      if (assistantMessage) {
        await postToConnection(apiGw, connectionId, { type: 'chunk', content: assistantMessage });
      }
      log.info('OpenAI response sent', { connectionId, tenantId, responseLength: assistantMessage.length });
    } else {
      const requestBody = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system: systemMessage,
        messages,
      });

      const response = await bedrockClient.send(new InvokeModelWithResponseStreamCommand({
        modelId: process.env.MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: requestBody,
      }));

      for await (const ev of response.body) {
        if (ev.chunk?.bytes) {
          const parsed = JSON.parse(new TextDecoder().decode(ev.chunk.bytes));
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            assistantMessage += parsed.delta.text;
            await postToConnection(apiGw, connectionId, { type: 'chunk', content: parsed.delta.text });
          }
        }
      }
    }

    if (assistantMessage.trim()) {
      await saveMessage(tenantUser, 'ai', assistantMessage);
    }

    await postToConnection(apiGw, connectionId, { type: 'end' });
    log.info('Chat response complete', { connectionId, tenantId, responseLength: assistantMessage.length });

    // Send citations for the sources used in this response
    if (retrievalResults.length > 0) {
      const citations = retrievalResults.slice(0, 5).map(r => ({
        source: r.location?.s3Location?.uri || '',
        score: r.score ?? 0,
        excerpt: (r.content?.text || '').slice(0, 200),
      }));
      await postToConnection(apiGw, connectionId, { type: 'citations', citations });
      log.info('Citations sent', { connectionId, tenantId, citationCount: citations.length });
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    log.error('Chat handler error', { connectionId, tenantId: tenantId ?? 'unknown', error: err.message });
    await postToConnection(apiGw, connectionId, { type: 'error', message: err.message });
    return { statusCode: 500, body: 'Error' };
  }
};
