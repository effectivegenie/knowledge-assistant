import { DynamoDBClient, QueryCommand, UpdateItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const CONTRACTS_TABLE  = process.env.CONTRACTS_TABLE;
const TENANTS_TABLE    = process.env.TENANTS_TABLE;
const DOCS_BUCKET_NAME = process.env.DOCS_BUCKET_NAME;

const VALID_STATUSES       = ['pending', 'extracted', 'review_needed', 'confirmed', 'rejected'];
const VALID_CONTRACT_TYPES = ['services', 'rental', 'supply', 'employment', 'nda', 'framework', 'other'];

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return {}; }
}

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

function unmarshalItem(item) {
  if (!item) return null;
  const result = {};
  for (const [key, value] of Object.entries(item)) {
    if (value.S !== undefined)         result[key] = value.S;
    else if (value.N !== undefined)    result[key] = Number(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.L !== undefined)    result[key] = value.L.map(i => i.S ?? i.N ?? i.BOOL ?? null);
    else if (value.NULL)               result[key] = null;
  }
  return result;
}

async function queryAllContracts(tenantId) {
  const items = [];
  let lastKey;
  do {
    const resp = await dynamo.send(new QueryCommand({
      TableName: CONTRACTS_TABLE,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: { ':tid': { S: tenantId } },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(resp.Items || []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  return items.map(unmarshalItem);
}

export const handler = async (event) => {
  const claims       = event.requestContext?.authorizer?.jwt?.claims || {};
  const groups       = parseGroups(claims['cognito:groups']);
  const userTenantId = claims['custom:tenantId'] || '';
  const isTenantAdmin = groups.includes('TenantAdmin');
  const isRootAdmin   = groups.includes('RootAdmin');

  const path       = event.requestContext?.http?.path || event.path || '';
  const method     = event.requestContext?.http?.method || event.httpMethod || '';
  const pathParams = event.pathParameters || {};
  const qs         = event.queryStringParameters || {};

  const tenantIdFromPath = pathParams.tenantId || path.match(/^\/tenants\/([^/]+)/)?.[1] || null;

  log.debug('Contracts request', { method, path, tenantIdFromPath });

  if (!tenantIdFromPath) return jsonResponse(404, { error: 'Not found' });
  if (!isRootAdmin && (!isTenantAdmin || userTenantId !== tenantIdFromPath)) {
    log.warn('Contracts access denied', { method, path, userTenantId, tenantIdFromPath });
    return jsonResponse(403, { error: 'Forbidden' });
  }

  // ── GET /tenants/{tenantId}/contracts/stats ────────────────────────────────
  // IMPORTANT: stats must be matched BEFORE the generic contractId route
  if (method === 'GET' && path.endsWith('/contracts/stats')) {
    try {
      const all   = await queryAllContracts(tenantIdFromPath);
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      let active       = 0;
      let expiringSoon = 0;
      let expired      = 0;
      let pending      = 0;
      const confirmed  = all.filter(c => c.status === 'confirmed');

      for (const c of confirmed) {
        if (!c.endDate) {
          // No end date — indefinite, counts as active
          active++;
        } else if (c.endDate < today) {
          expired++;
        } else {
          // endDate >= today
          const diffDays = Math.ceil(
            (new Date(c.endDate).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24)
          );
          if (diffDays <= 30) {
            expiringSoon++;
          } else {
            active++;
          }
        }
      }

      pending = all.filter(c => c.status === 'extracted' || c.status === 'review_needed').length;

      log.info('Contract stats computed', { tenantId: tenantIdFromPath, total: confirmed.length });
      return jsonResponse(200, {
        active,
        expiringSoon,
        expired,
        pending,
        total: confirmed.length,
      });
    } catch (err) {
      log.error('Failed to compute contract stats', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to compute stats' });
    }
  }

  // ── GET /tenants/{tenantId}/contracts/{contractId}/view-url ───────────────
  const viewUrlMatch = path.match(/\/contracts\/([^/]+)\/view-url$/);
  if (method === 'GET' && viewUrlMatch) {
    const contractId = pathParams.contractId || viewUrlMatch[1];
    try {
      const resp = await dynamo.send(new GetItemCommand({
        TableName: CONTRACTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, contractId: { S: contractId } },
      }));
      if (!resp.Item) return jsonResponse(404, { error: 'Contract not found' });
      const contract = unmarshalItem(resp.Item);
      const bucket   = contract.s3Bucket || DOCS_BUCKET_NAME;
      const url      = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: contract.s3Key }),
        { expiresIn: 600 },
      );
      return jsonResponse(200, { url });
    } catch (err) {
      log.error('Failed to generate view URL', { tenantId: tenantIdFromPath, contractId, error: err.message });
      return jsonResponse(500, { error: 'Failed to generate view URL' });
    }
  }

  // Resolve contractId for the remaining routes
  const contractId = pathParams.contractId || path.match(/\/contracts\/([^/]+)$/)?.[1];

  // ── PUT /tenants/{tenantId}/contracts/{contractId} ─────────────────────────
  if (method === 'PUT' && contractId) {
    const body     = parseBody(event);
    const { status } = body;

    if (!VALID_STATUSES.includes(status)) {
      return jsonResponse(400, { error: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
    }
    if (body.contractType && !VALID_CONTRACT_TYPES.includes(body.contractType)) {
      return jsonResponse(400, { error: `Invalid contractType. Valid: ${VALID_CONTRACT_TYPES.join(', ')}` });
    }

    try {
      const setFragments = ['#s = :s'];
      const exprNames    = { '#s': 'status' };
      const exprValues   = { ':s': { S: status } };

      if (status === 'confirmed') {
        setFragments.push('confirmedAt = :ts');
        exprValues[':ts'] = { S: new Date().toISOString() };
      }

      const stringFields = [
        'contractNumber', 'signingDate', 'startDate', 'endDate',
        'clientName', 'clientVatNumber', 'counterpartyName', 'counterpartyVatNumber',
        'documentType', 'contractType', 'currency',
      ];
      const numericFields = ['value'];

      for (const k of stringFields) {
        if (body[k] != null && String(body[k]).trim() !== '') {
          setFragments.push(`${k} = :${k}`);
          exprValues[`:${k}`] = { S: String(body[k]) };
        }
      }
      for (const k of numericFields) {
        if (body[k] != null && !Number.isNaN(Number(body[k]))) {
          setFragments.push(`${k} = :${k}`);
          exprValues[`:${k}`] = { N: String(Number(body[k])) };
        }
      }

      // Recompute deduplication key if both key components are present
      const effectiveClientVat    = body.clientVatNumber    || null;
      const effectiveContractNum  = body.contractNumber     || null;
      if (effectiveClientVat && effectiveContractNum) {
        setFragments.push('deduplicationKey = :dk');
        exprValues[':dk'] = { S: `${effectiveClientVat}#${effectiveContractNum}` };
      }

      await dynamo.send(new UpdateItemCommand({
        TableName: CONTRACTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, contractId: { S: contractId } },
        UpdateExpression: `SET ${setFragments.join(', ')}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ConditionExpression: 'attribute_exists(contractId)',
      }));

      log.info('Contract updated', { tenantId: tenantIdFromPath, contractId, status });
      return jsonResponse(200, {
        contractId,
        status,
        ...Object.fromEntries(
          stringFields.concat(numericFields)
            .map(k => [k, body[k] ?? undefined])
            .filter(([, v]) => v != null)
        ),
      });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return jsonResponse(404, { error: 'Contract not found' });
      log.error('Failed to update contract', { tenantId: tenantIdFromPath, contractId, error: err.message });
      return jsonResponse(500, { error: 'Failed to update contract' });
    }
  }

  // ── DELETE /tenants/{tenantId}/contracts/{contractId} ──────────────────────
  if (method === 'DELETE' && contractId) {
    try {
      // Fetch item first to get s3Key + s3Bucket
      const getResp = await dynamo.send(new GetItemCommand({
        TableName: CONTRACTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, contractId: { S: contractId } },
      }));
      if (!getResp.Item) return jsonResponse(404, { error: 'Contract not found' });

      const contract = unmarshalItem(getResp.Item);
      const bucket   = contract.s3Bucket || DOCS_BUCKET_NAME;
      const s3Key    = contract.s3Key;

      // Delete DynamoDB record
      await dynamo.send(new DeleteItemCommand({
        TableName: CONTRACTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, contractId: { S: contractId } },
      }));

      // Delete all S3 files in parallel; ignore individual failures
      const s3Keys = [
        s3Key,
        `${s3Key}.metadata.json`,
        `${s3Key}.kb.txt`,
        `${s3Key}.kb.txt.metadata.json`,
      ];
      await Promise.allSettled(
        s3Keys.map(k => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })))
      );

      log.info('Contract deleted', { tenantId: tenantIdFromPath, contractId, s3Key });
      return jsonResponse(200, { contractId, deleted: true });
    } catch (err) {
      log.error('Failed to delete contract', { tenantId: tenantIdFromPath, contractId, error: err.message });
      return jsonResponse(500, { error: 'Failed to delete contract' });
    }
  }

  // ── GET /tenants/{tenantId}/contracts ─────────────────────────────────────
  if (method === 'GET' && path.match(/\/contracts\/?$/)) {
    const page     = Math.max(0, parseInt(qs.page     || '0',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(qs.pageSize || '20', 10)));
    const statusFilter       = qs.status        || null;
    const excludeStatus      = qs.excludeStatus || null;
    const contractTypeFilter = qs.contractType  || null;
    const search             = (qs.search || '').toLowerCase().trim();

    try {
      let items = await queryAllContracts(tenantIdFromPath);

      if (statusFilter)       items = items.filter(c => c.status       === statusFilter);
      if (excludeStatus)      items = items.filter(c => c.status       !== excludeStatus);
      if (contractTypeFilter) items = items.filter(c => c.contractType === contractTypeFilter);
      if (search) {
        items = items.filter(c =>
          (c.contractNumber   || '').toLowerCase().includes(search) ||
          (c.clientName       || '').toLowerCase().includes(search) ||
          (c.counterpartyName || '').toLowerCase().includes(search)
        );
      }

      // Sort by signingDate descending (most recent first)
      items.sort((a, b) =>
        (b.signingDate || b.extractedAt || '').localeCompare(a.signingDate || a.extractedAt || '')
      );

      const total = items.length;
      const paged = items.slice(page * pageSize, (page + 1) * pageSize);
      log.info('Contracts listed', { tenantId: tenantIdFromPath, total, page, pageSize });
      return jsonResponse(200, { items: paged, total, page, pageSize });
    } catch (err) {
      log.error('Failed to list contracts', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to list contracts' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
