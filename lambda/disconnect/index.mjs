import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
  await ddb.send(new DeleteCommand({
    TableName: process.env.CONNECTIONS_TABLE,
    Key: { connectionId: event.requestContext.connectionId },
  }));

  return { statusCode: 200, body: 'Disconnected' };
};
