import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const dynamo  = new DynamoDBClient({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const CONTRACTS_TABLE      = process.env.CONTRACTS_TABLE;
const TENANTS_TABLE        = process.env.TENANTS_TABLE;
const MODEL_ID             = process.env.MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const CONFIDENCE_THRESHOLD = 0.7;

const SUPPORTED_MEDIA_TYPES = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  bmp:  'image/png', // Bedrock doesn't accept BMP; falls back to PDF path gracefully
};

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readMetadata(bucket, key) {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${key}.metadata.json` }));
    return JSON.parse(await streamToString(resp.Body));
  } catch (err) {
    log.warn('Metadata file not found or unreadable', { bucket, key, error: err.message });
    return null;
  }
}

async function getTenantProfile(tenantId) {
  try {
    const resp = await dynamo.send(new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }));
    const item = resp.Item || {};
    return {
      legalName: item.legalName?.S || '',
      vatNumber: item.vatNumber?.S || '',
      bulstat:   item.bulstat?.S   || '',
      aliases:   (item.aliases?.L  || []).map(a => a.S),
    };
  } catch (err) {
    log.warn('Could not fetch tenant profile', { tenantId, error: err.message });
    return { legalName: '', vatNumber: '', bulstat: '', aliases: [] };
  }
}

async function checkDuplicate(tenantId, deduplicationKey) {
  try {
    const resp = await dynamo.send(new QueryCommand({
      TableName: CONTRACTS_TABLE,
      IndexName: 'dedupIndex',
      KeyConditionExpression: 'tenantId = :tid AND deduplicationKey = :dk',
      ExpressionAttributeValues: {
        ':tid': { S: tenantId },
        ':dk':  { S: deduplicationKey },
      },
      Limit: 1,
    }));
    return (resp.Count || 0) > 0;
  } catch (err) {
    log.warn('Dedup check failed, proceeding', { tenantId, deduplicationKey, error: err.message });
    return false;
  }
}

async function extractWithVision(bucket, key, tenantProfile) {
  // Fetch document bytes from S3
  const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const docBytes = await streamToBuffer(s3Resp.Body);

  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const mediaType = SUPPORTED_MEDIA_TYPES[ext] ?? 'application/pdf';
  const isPdf = mediaType === 'application/pdf';

  log.debug('Vision extraction', { key, ext, mediaType, sizeKb: Math.round(docBytes.length / 1024) });

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docBytes.toString('base64') } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: docBytes.toString('base64') } };

  const prompt = `You are a contract data extraction assistant. Examine this document carefully.

Our company identity (the tenant using this system — typically the counterparty or service provider in the contract):
- Legal name: ${tenantProfile.legalName || 'unknown'}
- VAT number: ${tenantProfile.vatNumber || 'unknown'}
- Bulstat: ${tenantProfile.bulstat || 'unknown'}
- Aliases: ${tenantProfile.aliases.join(', ') || 'none'}

Read ALL text in the document, including Cyrillic (Bulgarian) characters. Extract the following fields:

1. documentType: "contract", "amendment", or "annex"
2. contractNumber: the contract reference number or identifier; null if absent
3. signingDate: the date the contract was signed, in YYYY-MM-DD format; null if absent
4. startDate: the date the contract becomes effective, in YYYY-MM-DD format; null if absent
5. endDate: the contract expiry/termination date, in YYYY-MM-DD format; null if the contract is indefinite or no end date is stated
6. clientName: the name of the client party (the party that is NOT our company); null if absent
7. clientVatNumber: the VAT/tax number of the client party; null if absent
8. counterpartyName: the legal name of our company as it appears in the contract (the tenant / service provider); null if absent
9. counterpartyVatNumber: the VAT number of our company as it appears in the contract; null if absent
10. value: the total monetary value of the contract as a number only, stripping all currency symbols, spaces, and thousands separators; null if absent or not applicable
11. currency: "BGN", "EUR", or "USD"; null if not stated or not applicable
12. contractType: one of "services", "rental", "supply", "employment", "nda", "framework", "other"; null if unclear
13. confidence: 0.0–1.0 reflecting how clearly readable these four key fields are: contractNumber, signingDate, endDate, clientVatNumber. A clean, legible contract with all four fields clearly present should score ≥ 0.85.

Return null for any field that is absent or illegible.

Return ONLY valid JSON (no markdown, no explanation):
{"documentType":"contract","contractNumber":null,"signingDate":null,"startDate":null,"endDate":null,"clientName":null,"clientVatNumber":null,"counterpartyName":null,"counterpartyVatNumber":null,"value":null,"currency":null,"contractType":null,"confidence":0.5}`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content?.[0]?.text || '{}';
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

async function saveFallbackRecord(tenantId, contractId, key, bucket, extractedAt) {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: CONTRACTS_TABLE,
      Item: {
        tenantId:     { S: tenantId },
        contractId:   { S: contractId },
        status:       { S: 'review_needed' },
        documentType: { S: 'contract' },
        direction:    { S: 'contract' },
        s3Key:        { S: key },
        s3Bucket:     { S: bucket },
        confidence:   { N: '0' },
        extractedAt:  { S: extractedAt },
      },
    }));
    log.warn('Saved fallback review_needed record', { tenantId, contractId });
  } catch (err) {
    log.error('Failed to save fallback record', { tenantId, contractId, error: err.message });
  }
}

// Normalize SNS-wrapped S3 events (SNS fanout pattern)
function extractS3Records(event) {
  const first = (event.Records || [])[0];
  if (!first) return [];
  if (first.EventSource === 'aws:sns') {
    const inner = JSON.parse(first.Sns?.Message || '{}');
    return inner.Records || [];
  }
  return event.Records || [];
}

export const handler = async (event) => {
  for (const record of extractS3Records(event)) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (key.endsWith('.metadata.json') || key.endsWith('.kb.txt')) {
      log.debug('Skipping sidecar file', { key });
      continue;
    }

    const tenantId    = key.split('/')[0];
    const contractId  = randomUUID();
    const extractedAt = new Date().toISOString();

    log.info('Document received', { bucket, key, tenantId });

    const metadata = await readMetadata(bucket, key);
    if (!metadata) {
      log.warn('No metadata — skipping document processing', { key });
      continue;
    }

    const category = metadata.metadataAttributes?.category;
    if (category !== 'contract') {
      log.debug('Not a contract category, skipping', { key, category });
      continue;
    }

    try {
      const tenantProfile = await getTenantProfile(tenantId);

      log.debug('Starting Claude Vision extraction', { bucket, key });
      const normalized = await extractWithVision(bucket, key, tenantProfile);
      log.debug('Vision extraction complete', {
        tenantId, contractId,
        documentType:   normalized.documentType,
        contractNumber: normalized.contractNumber,
        confidence:     normalized.confidence,
      });

      const confidence       = normalized.confidence ?? 0;
      const status           = confidence >= CONFIDENCE_THRESHOLD ? 'extracted' : 'review_needed';
      const deduplicationKey = normalized.clientVatNumber && normalized.contractNumber
        ? `${normalized.clientVatNumber}#${normalized.contractNumber}`
        : null;

      if (deduplicationKey && await checkDuplicate(tenantId, deduplicationKey)) {
        log.info('Duplicate contract — skipping', { tenantId, deduplicationKey });
        continue;
      }

      const item = {
        tenantId:     { S: tenantId },
        contractId:   { S: contractId },
        status:       { S: status },
        documentType: { S: normalized.documentType || 'contract' },
        direction:    { S: 'contract' },
        s3Key:        { S: key },
        s3Bucket:     { S: bucket },
        confidence:   { N: String(confidence) },
        extractedAt:  { S: extractedAt },
      };

      if (normalized.contractNumber)       item.contractNumber       = { S: normalized.contractNumber };
      if (normalized.signingDate)          item.signingDate          = { S: normalized.signingDate };
      if (normalized.startDate)            item.startDate            = { S: normalized.startDate };
      if (normalized.endDate)              item.endDate              = { S: normalized.endDate };
      if (normalized.clientName)           item.clientName           = { S: normalized.clientName };
      if (normalized.clientVatNumber)      item.clientVatNumber      = { S: normalized.clientVatNumber };
      if (normalized.counterpartyName)     item.counterpartyName     = { S: normalized.counterpartyName };
      if (normalized.counterpartyVatNumber) item.counterpartyVatNumber = { S: normalized.counterpartyVatNumber };
      if (normalized.contractType)         item.contractType         = { S: normalized.contractType };
      if (normalized.currency)             item.currency             = { S: normalized.currency };
      if (normalized.value != null)        item.value                = { N: String(normalized.value) };
      if (deduplicationKey)                item.deduplicationKey     = { S: deduplicationKey };

      await dynamo.send(new PutItemCommand({ TableName: CONTRACTS_TABLE, Item: item }));
      log.info('Contract saved', { tenantId, contractId, status, documentType: normalized.documentType, confidence });

    } catch (err) {
      log.error('Contract processing failed', { tenantId, contractId, key, error: err.message });
      await saveFallbackRecord(tenantId, contractId, key, bucket, extractedAt);
    }
  }

  return { statusCode: 200 };
};
