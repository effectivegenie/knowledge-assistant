import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  try {
    await ddb.send(new DeleteCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Key: { connectionId },
    }));
    log.info('WebSocket disconnected', { connectionId });
  } catch (err) {
    log.error('Failed to remove connection record', { connectionId, error: err.message });
  }

  return { statusCode: 200, body: 'Disconnected' };
};
