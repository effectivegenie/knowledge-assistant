import { S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const DOCS_BUCKET_NAME = process.env.DOCS_BUCKET_NAME;

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(data),
  };
}

function parseGroups(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try { return JSON.parse(raw); } catch {}
      return raw.slice(1, -1).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    }
    return raw.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function isHidden(key) {
  return key.endsWith('.metadata.json') || key.endsWith('.kb.txt') || key.endsWith('.kb.txt.metadata.json');
}

async function fetchMetadataCategory(bucket, key) {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${key}.metadata.json` }));
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(text)?.metadataAttributes?.category ?? null;
  } catch {
    return null;
  }
}

async function chunkAll(items, fn, chunkSize = 50) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const batch = items.slice(i, i + chunkSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export const handler = async (event) => {
  const claims        = event.requestContext?.authorizer?.jwt?.claims || {};
  const groups        = parseGroups(claims['cognito:groups']);
  const userTenantId  = claims['custom:tenantId'] || '';
  const isTenantAdmin = groups.includes('TenantAdmin');
  const isRootAdmin   = groups.includes('RootAdmin');

  const path       = event.requestContext?.http?.path || event.path || '';
  const method     = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};
  const qs         = event.queryStringParameters || {};

  const tenantIdFromPath = pathParams.tenantId || path.match(/^\/tenants\/([^/]+)/)?.[1] || null;

  log.debug('Documents request', { method, path, tenantIdFromPath });

  if (!tenantIdFromPath) return jsonResponse(404, { error: 'Not found' });
  if (!isRootAdmin && (!isTenantAdmin || userTenantId !== tenantIdFromPath)) {
    log.warn('Documents access denied', { method, path, userTenantId, tenantIdFromPath });
    return jsonResponse(403, { error: 'Forbidden' });
  }

  // ── GET /tenants/{tenantId}/documents/view-url ─────────────────────────────
  if (method === 'GET' && path.endsWith('/documents/view-url')) {
    const key = qs.key;
    if (!key) return jsonResponse(400, { error: 'Missing required query parameter: key' });

    const prefix = `${tenantIdFromPath}/`;
    const fullKey = key.startsWith(prefix) ? key : `${prefix}${key}`;

    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: fullKey }),
        { expiresIn: 600 },
      );
      log.info('Document view URL generated', { tenantId: tenantIdFromPath, key: fullKey });
      return jsonResponse(200, { url });
    } catch (err) {
      log.error('Failed to generate document view URL', { tenantId: tenantIdFromPath, key: fullKey, error: err.message });
      return jsonResponse(500, { error: 'Failed to generate view URL' });
    }
  }

  // ── DELETE /tenants/{tenantId}/documents ───────────────────────────────────
  if (method === 'DELETE' && qs.key) {
    const key = qs.key;
    const prefix = `${tenantIdFromPath}/`;
    const fullKey = key.startsWith(prefix) ? key : `${prefix}${key}`;

    const keysToDelete = [
      fullKey,
      `${fullKey}.metadata.json`,
      `${fullKey}.kb.txt`,
      `${fullKey}.kb.txt.metadata.json`,
    ];

    try {
      await Promise.allSettled(
        keysToDelete.map(k =>
          s3.send(new DeleteObjectCommand({ Bucket: DOCS_BUCKET_NAME, Key: k })),
        ),
      );
      log.info('Document deleted', { tenantId: tenantIdFromPath, key: fullKey });
      return jsonResponse(200, { deleted: key });
    } catch (err) {
      log.error('Failed to delete document', { tenantId: tenantIdFromPath, key: fullKey, error: err.message });
      return jsonResponse(500, { error: 'Failed to delete document' });
    }
  }

  // ── GET /tenants/{tenantId}/documents ──────────────────────────────────────
  if (method === 'GET' && path.endsWith('/documents')) {
    const page     = Math.max(0, parseInt(qs.page     || '0',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(qs.pageSize || '20', 10)));
    const search   = (qs.search || '').toLowerCase().trim();

    try {
      // Collect all objects under tenantId/ prefix
      const allObjects = [];
      let continuationToken;
      do {
        const params = {
          Bucket: DOCS_BUCKET_NAME,
          Prefix: `${tenantIdFromPath}/`,
          MaxKeys: 1000,
        };
        if (continuationToken) params.ContinuationToken = continuationToken;

        const resp = await s3.send(new ListObjectsV2Command(params));
        allObjects.push(...(resp.Contents || []));
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : null;
      } while (continuationToken);

      log.debug('S3 objects listed', { tenantId: tenantIdFromPath, total: allObjects.length });

      // Filter out hidden/metadata keys
      const prefix = `${tenantIdFromPath}/`;
      const visible = allObjects.filter(obj => !isHidden(obj.Key));

      // Fetch category for each visible object in parallel (batches of 50)
      const categories = await chunkAll(visible, obj => fetchMetadataCategory(DOCS_BUCKET_NAME, obj.Key));

      // Keep general category documents and files with no metadata (null = missing/failed metadata upload)
      // Exclude explicitly categorised invoice/contract files which are managed in their own pages
      const general = visible
        .map((obj, i) => ({ obj, category: categories[i] }))
        .filter(({ category }) => category === 'general' || category === null)
        .map(({ obj }) => obj);

      log.debug('General documents filtered', { tenantId: tenantIdFromPath, count: general.length });

      // Sort by LastModified descending
      general.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

      // Build item list
      let items = general.map(obj => {
        const relativeKey = obj.Key.startsWith(prefix) ? obj.Key.slice(prefix.length) : obj.Key;
        return {
          key: relativeKey,
          fullKey: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
          filename: relativeKey.split('/').pop(),
        };
      });

      // Client-side search by filename
      if (search) {
        items = items.filter(item => item.filename.toLowerCase().includes(search));
      }

      const total = items.length;
      const paged = items.slice(page * pageSize, (page + 1) * pageSize);

      log.info('Documents listed', { tenantId: tenantIdFromPath, total, page, pageSize });
      return jsonResponse(200, { items: paged, total, page, pageSize });
    } catch (err) {
      log.error('Failed to list documents', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to list documents' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
