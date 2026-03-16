import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createVerify, createPublicKey } from 'crypto';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// Module-level JWKS cache — lives for the Lambda container lifetime
let cachedJwks = null;

async function fetchJwks(jwksUri) {
  const resp = await fetch(jwksUri);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  cachedJwks = await resp.json();
  return cachedJwks;
}

async function getJwks(jwksUri, forceRefresh = false) {
  if (!forceRefresh && cachedJwks) return cachedJwks;
  return fetchJwks(jwksUri);
}

export const verifyJwt = async (token) => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(Buffer.from(headerB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

  const { kid, alg } = header;
  if (alg !== 'RS256') throw new Error(`Unsupported algorithm: ${alg}`);

  const expectedIssuer = `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`;
  const now = Math.floor(Date.now() / 1000);
  const clientId = process.env.APP_CLIENT_ID;

  if (payload.iss !== expectedIssuer) throw new Error('Invalid issuer');
  if (payload.exp <= now) throw new Error('Token expired');
  if (payload.aud !== clientId && payload.client_id !== clientId) throw new Error('Invalid audience');

  const jwksUri = `${expectedIssuer}/.well-known/jwks.json`;

  // Find key by kid; retry with cache refresh if not found (handles key rotation)
  let jwks = await getJwks(jwksUri);
  let jwk = jwks.keys?.find(k => k.kid === kid);
  if (!jwk) {
    jwks = await getJwks(jwksUri, true);
    jwk = jwks.keys?.find(k => k.kid === kid);
  }
  if (!jwk) throw new Error(`Unknown key ID: ${kid}`);

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  const verify = createVerify('RSA-SHA256');
  verify.update(signingInput);
  if (!verify.verify(publicKey, signature)) {
    throw new Error('Invalid signature');
  }

  return payload;
};

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = await verifyJwt(token);
  } catch {
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
