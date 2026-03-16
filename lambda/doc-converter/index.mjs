import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const MODEL_ID = process.env.MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const SUPPORTED_MEDIA_TYPES = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif:  'image/tiff',
};

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function extractS3Records(event) {
  const first = (event.Records || [])[0];
  if (!first) return [];
  if (first.EventSource === 'aws:sns') {
    const inner = JSON.parse(first.Sns?.Message || '{}');
    return inner.Records || [];
  }
  return event.Records || [];
}

async function extractTextFromDocument(bucket, key, mediaType) {
  const s3Resp  = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const docBytes = await streamToBuffer(s3Resp.Body);

  const isPdf = mediaType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: docBytes.toString('base64') } }
    : { type: 'image',    source: { type: 'base64', media_type: mediaType,          data: docBytes.toString('base64') } };

  const prompt = `Extract all text content from this document. Preserve structure as plain text — include all headings, paragraphs, lists, and table data. Read ALL text accurately, including Cyrillic (Bulgarian) characters. Output only the extracted text with no additional commentary.`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content?.[0]?.text || '';
}

export const handler = async (event) => {
  for (const record of extractS3Records(event)) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Skip metadata sidecar files and already-converted KB text files (prevent infinite loop)
    if (key.endsWith('.metadata.json') || key.endsWith('.kb.txt')) {
      log.debug('Skipping file', { key });
      continue;
    }

    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = SUPPORTED_MEDIA_TYPES[ext];
    if (!mediaType) {
      log.debug('Not a PDF or image — skipping KB text conversion', { key, ext });
      continue;
    }

    log.info('Converting document to KB text', { bucket, key, ext, mediaType });

    try {
      const extractedText = await extractTextFromDocument(bucket, key, mediaType);

      if (!extractedText.trim()) {
        log.warn('Vision returned empty text — skipping', { bucket, key });
        continue;
      }

      const kbKey = `${key}.kb.txt`;

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: kbKey,
        Body: extractedText,
        ContentType: 'text/plain; charset=utf-8',
      }));
      log.info('Saved KB text file', { bucket, kbKey, chars: extractedText.length });

      // Copy .metadata.json so the .kb.txt inherits tenant isolation and group access
      try {
        const metaResp    = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${key}.metadata.json` }));
        const metaContent = await streamToString(metaResp.Body);
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${kbKey}.metadata.json`,
          Body: metaContent,
          ContentType: 'application/json',
        }));
        log.debug('Copied metadata to KB text file', { metaKey: `${kbKey}.metadata.json` });
      } catch (metaErr) {
        log.warn('No metadata file found — KB text will be indexed without tenant metadata', { key, error: metaErr.message });
      }

    } catch (err) {
      log.error('Doc conversion failed', { bucket, key, error: err.message });
      // Non-fatal: original file stays in S3; KB ingestion simply won't happen for this file
    }
  }

  return { statusCode: 200 };
};
