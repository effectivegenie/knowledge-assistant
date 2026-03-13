import { BedrockAgentRuntimeClient, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

const bedrockAgentClient = new BedrockAgentRuntimeClient({});
const bedrockClient = new BedrockRuntimeClient({});
const dynamo = new DynamoDBClient({});

const CHAT_TABLE = process.env.CHAT_TABLE;
const MODEL_PROVIDER = process.env.MODEL_PROVIDER || 'bedrock';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const HISTORY_LIMIT = 20;

const postToConnection = async (apiGw, connectionId, data) => {
  await apiGw.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: JSON.stringify(data),
  }));
};

async function saveMessage(user, role, text) {
  await dynamo.send(new PutItemCommand({
    TableName: CHAT_TABLE,
    Item: {
      userName: { S: String(user) },
      timestamp: { S: new Date().toISOString() },
      role: { S: role },
      text: { S: text ?? '' },
      isDeleted: { N: '0' },
    },
  }));
}

async function getHistory(user) {
  const result = await dynamo.send(new QueryCommand({
    TableName: CHAT_TABLE,
    KeyConditionExpression: 'userName = :u',
    FilterExpression: 'isDeleted = :d',
    ExpressionAttributeValues: {
      ':u': { S: String(user) },
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
  const user = body.user || 'anonymous';
  const connectionId = event.requestContext.connectionId;
  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  try {
    await saveMessage(user, 'user', prompt);

    let context = '';
    try {
      const retrieveResponse = await bedrockAgentClient.send(new RetrieveCommand({
        knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: prompt },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 5 } },
      }));
      context = (retrieveResponse.retrievalResults || [])
        .map((r) => r.content.text)
        .join('\n\n---\n\n');
    } catch {
      context = '';
    }

    const history = await getHistory(user);

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
      await saveMessage(user, 'ai', assistantMessage);
    }

    await postToConnection(apiGw, connectionId, { type: 'end' });
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Chat error:', err);
    await postToConnection(apiGw, connectionId, { type: 'error', message: err.message });
    return { statusCode: 500, body: 'Error' };
  }
};
