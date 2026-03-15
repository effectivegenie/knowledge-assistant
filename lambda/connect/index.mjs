import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const decodeJwtPayload = (token) => {
  const segment = token.split('.')[1];
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(base64, 'base64').toString());
};

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = decodeJwtPayload(token);
  } catch {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const expectedIssuer = `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`;
  const now = Math.floor(Date.now() / 1000);
  const clientId = process.env.APP_CLIENT_ID;

  const isValidIssuer = payload.iss === expectedIssuer;
  const isNotExpired = payload.exp > now;
  const isValidAudience = payload.aud === clientId || payload.client_id === clientId;

  if (!isValidIssuer || !isNotExpired || !isValidAudience) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const tenantId = payload['custom:tenantId'] || 'default';
  const groups = payload['cognito:groups'] || [];

  await ddb.send(new PutCommand({
    TableName: process.env.CONNECTIONS_TABLE,
    Item: {
      connectionId: event.requestContext.connectionId,
      userId: payload.sub,
      email: payload.email || 'unknown',
      tenantId,
      groups,
      connectedAt: new Date().toISOString(),
    },
  }));

  return { statusCode: 200, body: 'Connected' };
};
