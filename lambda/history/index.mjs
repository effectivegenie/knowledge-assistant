import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const db = new DynamoDBClient({});
const CHAT_TABLE = process.env.CHAT_TABLE;
const HISTORY_LIMIT = 20;

export const handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  if (!connectionId) return { statusCode: 400, body: 'Missing connectionId' };

  const endpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  const apiGw = new ApiGatewayManagementApiClient({ endpoint });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const user = body.user;
  const tenantId = body.tenantId || 'default';
  if (!user) return { statusCode: 400, body: 'Missing user' };

  const tenantUser = `${tenantId}#${user}`;

  if (body.action === 'history') {
    const resp = await db.send(new QueryCommand({
      TableName: CHAT_TABLE,
      KeyConditionExpression: 'tenantUser = :u',
      FilterExpression: 'isDeleted = :d',
      ExpressionAttributeValues: {
        ':u': { S: tenantUser },
        ':d': { N: '0' },
      },
      ScanIndexForward: false,
      Limit: HISTORY_LIMIT,
    }));

    const messages = (resp.Items || []).map(item => ({
      role: item.role.S,
      text: item.text.S,
      timestamp: item.timestamp.S,
    })).reverse();

    await apiGw.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ type: 'history', messages }),
    }));

    return { statusCode: 200 };
  }

  if (body.action === 'clear_history') {
    const resp = await db.send(new QueryCommand({
      TableName: CHAT_TABLE,
      KeyConditionExpression: 'tenantUser = :u',
      FilterExpression: 'isDeleted = :d',
      ExpressionAttributeValues: {
        ':u': { S: tenantUser },
        ':d': { N: '0' },
      },
      ScanIndexForward: false,
      Limit: HISTORY_LIMIT,
    }));

    const items = resp.Items || [];
    if (items.length > 0) {
      await Promise.all(items.map(item =>
        db.send(new UpdateItemCommand({
          TableName: CHAT_TABLE,
          Key: { tenantUser: item.tenantUser, timestamp: item.timestamp },
          UpdateExpression: 'SET isDeleted = :d',
          ExpressionAttributeValues: { ':d': { N: '1' } },
        }))
      ));
    }

    return { statusCode: 200 };
  }

  return { statusCode: 400, body: 'Unknown action' };
};
