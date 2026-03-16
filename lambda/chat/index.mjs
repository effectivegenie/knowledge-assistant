import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';

const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const bedrockClient = new BedrockRuntimeClient({});
const dynamo = new DynamoDBClient({});

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
      }
    } catch (err) {
      console.warn('Failed to fetch connection record, falling back to body values:', err.message);
    }
  }

  const user = userEmail;
  const tenantUser = `${tenantId}#${user}`;

  const isAdmin = userGroups.some(g => SYSTEM_GROUPS.includes(g));
  const businessGroups = userGroups.filter(g => !SYSTEM_GROUPS.includes(g));

  try {
    await saveMessage(tenantUser, 'user', prompt);

    const { knowledgeBaseId, docsPrefix } = await getTenantKb(tenantId);
    let context = '';
    let retrievalResults = [];

    if (knowledgeBaseId) {
      try {
        const sourcePrefix = docsPrefix && DOCS_BUCKET_NAME
          ? `s3://${DOCS_BUCKET_NAME}/${docsPrefix}`
          : null;

        if (sourcePrefix) {
          try {
            // Build filter: tenant isolation + optional group filter for non-admin users
            let filter;
            const tenantFilter = { startsWith: { key: 'x-amz-bedrock-kb-source-uri', value: sourcePrefix } };

            if (!isAdmin && businessGroups.length > 0) {
              filter = {
                andAll: [
                  tenantFilter,
                  { orAll: businessGroups.map(g => ({ listContains: { key: 'groups', value: g } })) },
                ],
              };
            } else {
              filter = tenantFilter;
            }

            const resp = await bedrockAgentClient.send(new RetrieveCommand({
              knowledgeBaseId,
              retrievalQuery: { text: prompt },
              retrievalConfiguration: {
                vectorSearchConfiguration: { numberOfResults: 5, filter },
              },
            }));
            retrievalResults = resp.retrievalResults || [];

            // If group-filtered query returned 0 results, retry without group filter
            // so untagged (legacy) documents remain accessible
            if (retrievalResults.length === 0 && !isAdmin && businessGroups.length > 0) {
              const fallbackResp = await bedrockAgentClient.send(new RetrieveCommand({
                knowledgeBaseId,
                retrievalQuery: { text: prompt },
                retrievalConfiguration: {
                  vectorSearchConfiguration: { numberOfResults: 5, filter: tenantFilter },
                },
              }));
              retrievalResults = fallbackResp.retrievalResults || [];
            }
          } catch (filterErr) {
            console.warn('RAG filter query failed, retrying without filter:', filterErr.message);
          }
        }

        // Fallback: retrieve without filter and post-filter by source URI prefix
        if (retrievalResults.length === 0) {
          const resp = await bedrockAgentClient.send(new RetrieveCommand({
            knowledgeBaseId,
            retrievalQuery: { text: prompt },
            retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 10 } },
          }));
          const all = resp.retrievalResults || [];
          retrievalResults = sourcePrefix
            ? all.filter(r => r.location?.s3Location?.uri?.startsWith(sourcePrefix))
            : all;
        }

        context = retrievalResults.map((r) => r.content.text).join('\n\n---\n\n');
      } catch (err) {
        console.error('RAG retrieve error (tenant:', tenantId, 'kb:', knowledgeBaseId, 'prefix:', docsPrefix, '):', err);
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

    // Send citations for the sources used in this response
    if (retrievalResults.length > 0) {
      const citations = retrievalResults.slice(0, 5).map(r => ({
        source: r.location?.s3Location?.uri || '',
        score: r.score ?? 0,
        excerpt: (r.content?.text || '').slice(0, 200),
      }));
      await postToConnection(apiGw, connectionId, { type: 'citations', citations });
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Chat error:', err);
    await postToConnection(apiGw, connectionId, { type: 'error', message: err.message });
    return { statusCode: 500, body: 'Error' };
  }
};
