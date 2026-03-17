import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

const INVOICES_TABLE  = process.env.INVOICES_TABLE;
const CONTRACTS_TABLE = process.env.CONTRACTS_TABLE;
const TENANTS_TABLE   = process.env.TENANTS_TABLE;
const MODEL_ID        = process.env.MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const SUPPORTED_MEDIA_TYPES = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  bmp:  'image/png',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function checkDuplicateInvoice(tenantId, deduplicationKey) {
  try {
    const resp = await dynamo.send(new QueryCommand({
      TableName: INVOICES_TABLE,
      IndexName: 'dedupIndex',
      KeyConditionExpression: 'tenantId = :tid AND deduplicationKey = :dk',
      ExpressionAttributeValues: { ':tid': { S: tenantId }, ':dk': { S: deduplicationKey } },
      Limit: 1,
    }));
    return (resp.Count || 0) > 0;
  } catch (err) {
    log.warn('Invoice dedup check failed, proceeding', { tenantId, deduplicationKey, error: err.message });
    return false;
  }
}

async function checkDuplicateContract(tenantId, deduplicationKey) {
  try {
    const resp = await dynamo.send(new QueryCommand({
      TableName: CONTRACTS_TABLE,
      IndexName: 'dedupIndex',
      KeyConditionExpression: 'tenantId = :tid AND deduplicationKey = :dk',
      ExpressionAttributeValues: { ':tid': { S: tenantId }, ':dk': { S: deduplicationKey } },
      Limit: 1,
    }));
    return (resp.Count || 0) > 0;
  } catch (err) {
    log.warn('Contract dedup check failed, proceeding', { tenantId, deduplicationKey, error: err.message });
    return false;
  }
}

// ── Classify + extract via Bedrock Vision ─────────────────────────────────────

async function classifyAndExtract(bucket, key, tenantProfile) {
  const s3Resp   = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const docBytes = await streamToBuffer(s3Resp.Body);

  const ext       = key.split('.').pop()?.toLowerCase() ?? '';
  const mediaType = SUPPORTED_MEDIA_TYPES[ext] ?? 'application/pdf';
  const isPdf     = mediaType === 'application/pdf';

  log.debug('Classifier vision call', { key, ext, mediaType, sizeKb: Math.round(docBytes.length / 1024) });

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docBytes.toString('base64') } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: docBytes.toString('base64') } };

  const prompt = `You are a document classification and data extraction assistant. Examine this document carefully.

Our company identity (the tenant using this system):
- Legal name: ${tenantProfile.legalName || 'unknown'}
- VAT number: ${tenantProfile.vatNumber || 'unknown'}
- Bulstat: ${tenantProfile.bulstat || 'unknown'}
- Aliases: ${tenantProfile.aliases.join(', ') || 'none'}

Read ALL text in the document, including Cyrillic (Bulgarian) characters.

Step 1 — Classify the document:
- "invoice" if it is an invoice (фактура), proforma invoice (проформа), or credit note (кредитно известие)
- "contract" if it is a contract (договор), amendment (анекс/допълнително споразумение), or annex
- "other" for anything else (report, manual, letter, etc.)

Step 2 — If "invoice", extract:
- documentType: "invoice", "proforma", or "credit_note"
- direction: "incoming" (our company is the buyer) or "outgoing" (our company is the seller)
- invoiceNumber, issueDate (YYYY-MM-DD), dueDate (YYYY-MM-DD)
- supplierName, supplierVatNumber, clientName, clientVatNumber
- amountNet, amountVat, amountTotal (numbers only, strip currency symbols)

Step 3 — If "contract", extract:
- documentType: "contract", "amendment", or "annex"
- contractNumber, signingDate (YYYY-MM-DD), startDate (YYYY-MM-DD), endDate (YYYY-MM-DD or null if indefinite)
- clientName, clientVatNumber (the party that is NOT our company)
- counterpartyName, counterpartyVatNumber (our company as it appears in the contract)
- value (number only), currency ("BGN", "EUR", or "USD")
- contractType: "services", "rental", "supply", "employment", "nda", "framework", or "other"

Return null for any field that is absent or illegible.

Return ONLY valid JSON (no markdown, no explanation). Use this exact shape:
{"category":"invoice","documentType":"invoice","direction":"incoming","invoiceNumber":null,"issueDate":null,"dueDate":null,"supplierName":null,"supplierVatNumber":null,"clientName":null,"clientVatNumber":null,"amountNet":null,"amountVat":null,"amountTotal":null}

or for contracts:
{"category":"contract","documentType":"contract","contractNumber":null,"signingDate":null,"startDate":null,"endDate":null,"clientName":null,"clientVatNumber":null,"counterpartyName":null,"counterpartyVatNumber":null,"value":null,"currency":null,"contractType":null}

or simply:
{"category":"other"}`;

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

  const body  = JSON.parse(new TextDecoder().decode(response.body));
  const text  = body.content?.[0]?.text || '{}';
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

// ── Save helpers ──────────────────────────────────────────────────────────────

async function updateMetadataCategory(bucket, key, existingMetadata, newCategory) {
  try {
    const updated = {
      ...existingMetadata,
      metadataAttributes: { ...existingMetadata.metadataAttributes, category: newCategory },
    };
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${key}.metadata.json`,
      Body: JSON.stringify(updated),
      ContentType: 'application/json',
    }));
    log.debug('Metadata category updated', { key, newCategory });
  } catch (err) {
    log.warn('Failed to update metadata category', { key, error: err.message });
  }
}

async function saveInvoice(tenantId, docId, key, bucket, result, extractedAt) {
  const deduplicationKey = result.supplierVatNumber && result.invoiceNumber
    ? `${result.supplierVatNumber}#${result.invoiceNumber}`
    : null;

  if (deduplicationKey && await checkDuplicateInvoice(tenantId, deduplicationKey)) {
    log.info('Duplicate auto-detected invoice — skipping', { tenantId, deduplicationKey });
    return;
  }

  const item = {
    tenantId:     { S: tenantId },
    invoiceId:    { S: docId },
    status:       { S: 'review_needed' },
    documentType: { S: result.documentType || 'invoice' },
    direction:    { S: result.direction    || 'incoming' },
    s3Key:        { S: key },
    s3Bucket:     { S: bucket },
    confidence:   { N: '0' },
    extractedAt:  { S: extractedAt },
    autoDetected: { BOOL: true },
  };

  if (result.invoiceNumber)     item.invoiceNumber     = { S: result.invoiceNumber };
  if (result.issueDate)         item.issueDate         = { S: result.issueDate };
  if (result.dueDate)           item.dueDate           = { S: result.dueDate };
  if (result.supplierName)      item.supplierName      = { S: result.supplierName };
  if (result.supplierVatNumber) item.supplierVatNumber = { S: result.supplierVatNumber };
  if (result.clientName)        item.clientName        = { S: result.clientName };
  if (result.clientVatNumber)   item.clientVatNumber   = { S: result.clientVatNumber };
  if (result.amountNet  != null) item.amountNet        = { N: String(result.amountNet) };
  if (result.amountVat  != null) item.amountVat        = { N: String(result.amountVat) };
  if (result.amountTotal != null) item.amountTotal     = { N: String(result.amountTotal) };
  if (deduplicationKey)          item.deduplicationKey = { S: deduplicationKey };

  await dynamo.send(new PutItemCommand({ TableName: INVOICES_TABLE, Item: item }));
  log.info('Auto-detected invoice saved', { tenantId, docId, documentType: result.documentType });
}

async function saveContract(tenantId, docId, key, bucket, result, extractedAt) {
  const deduplicationKey = result.clientVatNumber && result.contractNumber
    ? `${result.clientVatNumber}#${result.contractNumber}`
    : null;

  if (deduplicationKey && await checkDuplicateContract(tenantId, deduplicationKey)) {
    log.info('Duplicate auto-detected contract — skipping', { tenantId, deduplicationKey });
    return;
  }

  const item = {
    tenantId:     { S: tenantId },
    contractId:   { S: docId },
    status:       { S: 'review_needed' },
    documentType: { S: result.documentType || 'contract' },
    direction:    { S: 'contract' },
    s3Key:        { S: key },
    s3Bucket:     { S: bucket },
    confidence:   { N: '0' },
    extractedAt:  { S: extractedAt },
    autoDetected: { BOOL: true },
  };

  if (result.contractNumber)        item.contractNumber        = { S: result.contractNumber };
  if (result.signingDate)           item.signingDate           = { S: result.signingDate };
  if (result.startDate)             item.startDate             = { S: result.startDate };
  if (result.endDate)               item.endDate               = { S: result.endDate };
  if (result.clientName)            item.clientName            = { S: result.clientName };
  if (result.clientVatNumber)       item.clientVatNumber       = { S: result.clientVatNumber };
  if (result.counterpartyName)      item.counterpartyName      = { S: result.counterpartyName };
  if (result.counterpartyVatNumber) item.counterpartyVatNumber = { S: result.counterpartyVatNumber };
  if (result.contractType)          item.contractType          = { S: result.contractType };
  if (result.currency)              item.currency              = { S: result.currency };
  if (result.value != null)         item.value                 = { N: String(result.value) };
  if (deduplicationKey)             item.deduplicationKey      = { S: deduplicationKey };

  await dynamo.send(new PutItemCommand({ TableName: CONTRACTS_TABLE, Item: item }));
  log.info('Auto-detected contract saved', { tenantId, docId, documentType: result.documentType });
}

// ── SNS unwrap ────────────────────────────────────────────────────────────────

function extractS3Records(event) {
  const first = (event.Records || [])[0];
  if (!first) return [];
  if (first.EventSource === 'aws:sns') {
    const inner = JSON.parse(first.Sns?.Message || '{}');
    return inner.Records || [];
  }
  return event.Records || [];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  for (const record of extractS3Records(event)) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (key.endsWith('.metadata.json') || key.endsWith('.kb.txt')) {
      log.debug('Skipping sidecar file', { key });
      continue;
    }

    const tenantId    = key.split('/')[0];
    const docId       = randomUUID();
    const extractedAt = new Date().toISOString();

    log.info('Document received by classifier', { bucket, key, tenantId });

    const metadata = await readMetadata(bucket, key);
    if (!metadata) {
      log.warn('No metadata — skipping classification', { key });
      continue;
    }

    const category = metadata.metadataAttributes?.category;
    if (category === 'invoice' || category === 'contract') {
      log.debug('Category already set — dedicated processor will handle', { key, category });
      continue;
    }

    try {
      const tenantProfile = await getTenantProfile(tenantId);

      log.debug('Starting classify+extract', { bucket, key });
      const result = await classifyAndExtract(bucket, key, tenantProfile);
      log.info('Classification result', { tenantId, docId, category: result.category });

      if (result.category === 'invoice') {
        await saveInvoice(tenantId, docId, key, bucket, result, extractedAt);
        await updateMetadataCategory(bucket, key, metadata, 'invoice');
      } else if (result.category === 'contract') {
        await saveContract(tenantId, docId, key, bucket, result, extractedAt);
        await updateMetadataCategory(bucket, key, metadata, 'contract');
      } else {
        log.debug('Document classified as other — no action', { key });
      }
    } catch (err) {
      log.error('Classification failed', { tenantId, docId, key, error: err.message });
      // No fallback record — document remains visible in general Documents tab
    }
  }

  return { statusCode: 200 };
};
