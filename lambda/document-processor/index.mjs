import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { TextractClient, AnalyzeExpenseCommand } from '@aws-sdk/client-textract';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const s3       = new S3Client({});
const textract = new TextractClient({});
const bedrock  = new BedrockRuntimeClient({});
const dynamo   = new DynamoDBClient({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const INVOICES_TABLE      = process.env.INVOICES_TABLE;
const TENANTS_TABLE       = process.env.TENANTS_TABLE;
const MODEL_ID            = process.env.MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const CONFIDENCE_THRESHOLD = 0.7;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
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
      TableName: INVOICES_TABLE,
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

async function extractWithTextract(bucket, key) {
  const resp = await textract.send(new AnalyzeExpenseCommand({
    Document: { S3Object: { Bucket: bucket, Name: key } },
  }));

  const fields = {};
  const confidences = [];

  for (const doc of (resp.ExpenseDocuments || [])) {
    for (const field of (doc.SummaryFields || [])) {
      const type  = field.Type?.Text;
      const value = field.ValueDetection?.Text;
      const conf  = field.ValueDetection?.Confidence;
      if (type && value) {
        fields[type] = value;
        if (conf != null) confidences.push(conf / 100);
      }
    }
  }

  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;

  return { fields, avgConfidence };
}

async function normalizeWithLLM(textractFields, tenantProfile) {
  const prompt = `You are an invoice data extraction assistant. Extract structured invoice data from Textract fields.

Tenant identity (company using this system):
- Legal name: ${tenantProfile.legalName || 'unknown'}
- VAT number: ${tenantProfile.vatNumber || 'unknown'}
- Bulstat: ${tenantProfile.bulstat || 'unknown'}
- Aliases: ${tenantProfile.aliases.join(', ') || 'none'}

Textract extracted fields:
${JSON.stringify(textractFields, null, 2)}

Instructions:
1. documentType: "invoice", "proforma", or "credit_note"
2. direction: "incoming" (we are the buyer) or "outgoing" (we are the seller) — match tenant identity to vendor/receiver fields
3. Parse dates to YYYY-MM-DD format
4. Parse amounts to numbers only (strip EUR, spaces, commas)
5. confidence: 0–1, based on completeness of invoiceNumber, issueDate, amountTotal, supplierVatNumber

Return ONLY valid JSON (no markdown):
{"documentType":"invoice","direction":"incoming","invoiceNumber":null,"issueDate":null,"dueDate":null,"supplierName":null,"supplierVatNumber":null,"clientName":null,"clientVatNumber":null,"amountNet":null,"amountVat":null,"amountTotal":null,"confidence":0.5}`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content?.[0]?.text || '{}';
  // Strip any accidental markdown fences
  const clean = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(clean);
}

async function saveFallbackRecord(tenantId, invoiceId, key, bucket, extractedAt) {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: INVOICES_TABLE,
      Item: {
        tenantId:     { S: tenantId },
        invoiceId:    { S: invoiceId },
        status:       { S: 'review_needed' },
        documentType: { S: 'invoice' },
        direction:    { S: 'incoming' },
        s3Key:        { S: key },
        s3Bucket:     { S: bucket },
        confidence:   { N: '0' },
        extractedAt:  { S: extractedAt },
      },
    }));
    log.warn('Saved fallback review_needed record', { tenantId, invoiceId });
  } catch (err) {
    log.error('Failed to save fallback record', { tenantId, invoiceId, error: err.message });
  }
}

export const handler = async (event) => {
  for (const record of (event.Records || [])) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    if (key.endsWith('.metadata.json')) {
      log.debug('Skipping metadata file', { key });
      continue;
    }

    const tenantId    = key.split('/')[0];
    const invoiceId   = randomUUID();
    const extractedAt = new Date().toISOString();

    log.info('Document received', { bucket, key, tenantId });

    const metadata = await readMetadata(bucket, key);
    if (!metadata) {
      log.warn('No metadata — skipping document processing', { key });
      continue;
    }

    const category = metadata.metadataAttributes?.category;
    if (category !== 'invoice') {
      log.debug('Not an invoice category, skipping', { key, category });
      continue;
    }

    try {
      const tenantProfile = await getTenantProfile(tenantId);

      log.debug('Starting Textract extraction', { bucket, key });
      const { fields, avgConfidence: textractConfidence } = await extractWithTextract(bucket, key);
      log.debug('Textract complete', { tenantId, fields: Object.keys(fields).length, textractConfidence });

      log.debug('Starting LLM normalization', { tenantId, invoiceId });
      const normalized = await normalizeWithLLM(fields, tenantProfile);
      log.debug('LLM normalization complete', { tenantId, invoiceId, documentType: normalized.documentType, direction: normalized.direction });

      const confidence       = normalized.confidence ?? textractConfidence;
      const status           = confidence >= CONFIDENCE_THRESHOLD ? 'extracted' : 'review_needed';
      const deduplicationKey = normalized.supplierVatNumber && normalized.invoiceNumber
        ? `${normalized.supplierVatNumber}#${normalized.invoiceNumber}`
        : null;

      if (deduplicationKey && await checkDuplicate(tenantId, deduplicationKey)) {
        log.info('Duplicate invoice — skipping', { tenantId, deduplicationKey });
        continue;
      }

      const item = {
        tenantId:     { S: tenantId },
        invoiceId:    { S: invoiceId },
        status:       { S: status },
        documentType: { S: normalized.documentType || 'invoice' },
        direction:    { S: normalized.direction    || 'incoming' },
        s3Key:        { S: key },
        s3Bucket:     { S: bucket },
        confidence:   { N: String(confidence) },
        extractedAt:  { S: extractedAt },
      };

      if (normalized.invoiceNumber)     item.invoiceNumber     = { S: normalized.invoiceNumber };
      if (normalized.issueDate)         item.issueDate         = { S: normalized.issueDate };
      if (normalized.dueDate)           item.dueDate           = { S: normalized.dueDate };
      if (normalized.supplierName)      item.supplierName      = { S: normalized.supplierName };
      if (normalized.supplierVatNumber) item.supplierVatNumber = { S: normalized.supplierVatNumber };
      if (normalized.clientName)        item.clientName        = { S: normalized.clientName };
      if (normalized.clientVatNumber)   item.clientVatNumber   = { S: normalized.clientVatNumber };
      if (normalized.amountNet  != null) item.amountNet        = { N: String(normalized.amountNet) };
      if (normalized.amountVat  != null) item.amountVat        = { N: String(normalized.amountVat) };
      if (normalized.amountTotal != null) item.amountTotal     = { N: String(normalized.amountTotal) };
      if (deduplicationKey)              item.deduplicationKey = { S: deduplicationKey };

      await dynamo.send(new PutItemCommand({ TableName: INVOICES_TABLE, Item: item }));
      log.info('Invoice saved', { tenantId, invoiceId, status, documentType: normalized.documentType, confidence });

    } catch (err) {
      log.error('Invoice processing failed', { tenantId, invoiceId, key, error: err.message });
      await saveFallbackRecord(tenantId, invoiceId, key, bucket, extractedAt);
    }
  }

  return { statusCode: 200 };
};
