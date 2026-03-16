import { DynamoDBClient, QueryCommand, UpdateItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});

const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};

const INVOICES_TABLE  = process.env.INVOICES_TABLE;
const TENANTS_TABLE   = process.env.TENANTS_TABLE;
const DOCS_BUCKET_NAME = process.env.DOCS_BUCKET_NAME;

const VALID_STATUSES  = ['pending', 'extracted', 'review_needed', 'confirmed', 'paid', 'rejected'];
const SYSTEM_GROUPS   = ['RootAdmin', 'TenantAdmin'];

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
    if (value.S !== undefined)    result[key] = value.S;
    else if (value.N !== undefined) result[key] = Number(value.N);
    else if (value.BOOL !== undefined) result[key] = value.BOOL;
    else if (value.L !== undefined) result[key] = value.L.map(i => i.S ?? i.N ?? i.BOOL ?? null);
    else if (value.NULL)          result[key] = null;
  }
  return result;
}

async function queryAllInvoices(tenantId, dateFrom, dateTo) {
  const items = [];
  let lastKey;

  if (dateFrom || dateTo) {
    // Use dateIndex GSI for date-range queries
    do {
      const resp = await dynamo.send(new QueryCommand({
        TableName: INVOICES_TABLE,
        IndexName: 'dateIndex',
        KeyConditionExpression: 'tenantId = :tid AND issueDate BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':tid':  { S: tenantId },
          ':from': { S: dateFrom || '0000-00-00' },
          ':to':   { S: dateTo   || '9999-12-31' },
        },
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(resp.Items || []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
  } else {
    // Full tenant scan via main table PK
    do {
      const resp = await dynamo.send(new QueryCommand({
        TableName: INVOICES_TABLE,
        KeyConditionExpression: 'tenantId = :tid',
        ExpressionAttributeValues: { ':tid': { S: tenantId } },
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(resp.Items || []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
  }

  return items.map(unmarshalItem);
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

  log.debug('Invoices request', { method, path, tenantIdFromPath });

  if (!tenantIdFromPath) return jsonResponse(404, { error: 'Not found' });
  if (!isRootAdmin && (!isTenantAdmin || userTenantId !== tenantIdFromPath)) {
    log.warn('Invoices access denied', { method, path, userTenantId, tenantIdFromPath });
    return jsonResponse(403, { error: 'Forbidden' });
  }

  // ── GET /tenants/{tenantId}/profile ────────────────────────────────────────
  if (method === 'GET' && path.endsWith('/profile')) {
    try {
      const resp = await dynamo.send(new GetItemCommand({
        TableName: TENANTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath } },
      }));
      const item = resp.Item || {};
      return jsonResponse(200, {
        legalName: item.legalName?.S || '',
        vatNumber: item.vatNumber?.S || '',
        bulstat:   item.bulstat?.S   || '',
        aliases:   (item.aliases?.L || []).map(a => a.S),
      });
    } catch (err) {
      log.error('Failed to get tenant profile', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to get profile' });
    }
  }

  // ── PUT /tenants/{tenantId}/profile ────────────────────────────────────────
  if (method === 'PUT' && path.endsWith('/profile')) {
    const { legalName, vatNumber, bulstat, aliases } = parseBody(event);
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: TENANTS_TABLE,
        Key: { tenantId: { S: tenantIdFromPath } },
        UpdateExpression: 'SET legalName = :ln, vatNumber = :vn, bulstat = :b, aliases = :a',
        ExpressionAttributeValues: {
          ':ln': { S: legalName || '' },
          ':vn': { S: vatNumber || '' },
          ':b':  { S: bulstat   || '' },
          ':a':  { L: (Array.isArray(aliases) ? aliases : []).map(s => ({ S: String(s) })) },
        },
      }));
      log.info('Tenant profile updated', { tenantId: tenantIdFromPath });
      return jsonResponse(200, { tenantId: tenantIdFromPath, legalName, vatNumber, bulstat, aliases });
    } catch (err) {
      log.error('Failed to update tenant profile', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to update profile' });
    }
  }

  // ── GET /tenants/{tenantId}/invoices/stats ─────────────────────────────────
  if (method === 'GET' && path.endsWith('/invoices/stats')) {
    const dateFrom = qs.dateFrom || null;
    const dateTo   = qs.dateTo   || null;
    try {
      const all = await queryAllInvoices(tenantIdFromPath, dateFrom, dateTo);
      // Only invoice + credit_note contribute to financial stats (not proforma)
      const financial = all.filter(i =>
        ['invoice', 'credit_note'].includes(i.documentType) &&
        ['confirmed', 'paid'].includes(i.status)
      );

      // Aggregate by month
      const byMonthMap = {};
      for (const inv of financial) {
        const month = (inv.issueDate || '').slice(0, 7); // YYYY-MM
        if (!month) continue;
        if (!byMonthMap[month]) byMonthMap[month] = { month, income: 0, expenses: 0 };
        const amount = inv.amountTotal || 0;
        if (inv.direction === 'outgoing') byMonthMap[month].income   += amount;
        else                              byMonthMap[month].expenses += amount;
      }
      const byMonth = Object.values(byMonthMap).sort((a, b) => a.month.localeCompare(b.month));

      const income   = financial.filter(i => i.direction === 'outgoing').reduce((s, i) => s + (i.amountTotal || 0), 0);
      const expenses = financial.filter(i => i.direction === 'incoming').reduce((s, i) => s + (i.amountTotal || 0), 0);
      const unpaid   = all.filter(i =>
        ['invoice', 'credit_note'].includes(i.documentType) &&
        i.status === 'confirmed'
      ).reduce((s, i) => s + (i.amountTotal || 0), 0);

      log.info('Stats computed', { tenantId: tenantIdFromPath, financialCount: financial.length });
      return jsonResponse(200, {
        byMonth,
        totals: { income, expenses, net: income - expenses, unpaid },
      });
    } catch (err) {
      log.error('Failed to compute stats', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to compute stats' });
    }
  }

  // ── GET /tenants/{tenantId}/invoices/{invoiceId}/view-url ──────────────────
  const invoiceIdMatch = path.match(/\/invoices\/([^/]+)\/view-url$/);
  if (method === 'GET' && invoiceIdMatch) {
    const invoiceId = pathParams.invoiceId || invoiceIdMatch[1];
    try {
      const resp = await dynamo.send(new GetItemCommand({
        TableName: INVOICES_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, invoiceId: { S: invoiceId } },
      }));
      if (!resp.Item) return jsonResponse(404, { error: 'Invoice not found' });
      const inv = unmarshalItem(resp.Item);
      const bucket = inv.s3Bucket || DOCS_BUCKET_NAME;
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: inv.s3Key }),
        { expiresIn: 600 },
      );
      return jsonResponse(200, { url });
    } catch (err) {
      log.error('Failed to generate view URL', { tenantId: tenantIdFromPath, invoiceId, error: err.message });
      return jsonResponse(500, { error: 'Failed to generate view URL' });
    }
  }

  // ── PUT /tenants/{tenantId}/invoices/{invoiceId} ───────────────────────────
  const invoiceId = pathParams.invoiceId || path.match(/\/invoices\/([^/]+)$/)?.[1];
  if (method === 'PUT' && invoiceId && !path.endsWith('/profile')) {
    const body = parseBody(event);
    const { status } = body;
    if (!VALID_STATUSES.includes(status)) {
      return jsonResponse(400, { error: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
    }
    if (body.direction && !['incoming', 'outgoing'].includes(body.direction)) {
      return jsonResponse(400, { error: 'Invalid direction. Valid: incoming, outgoing' });
    }
    if (body.documentType && !['invoice', 'proforma', 'credit_note'].includes(body.documentType)) {
      return jsonResponse(400, { error: 'Invalid documentType. Valid: invoice, proforma, credit_note' });
    }

    try {
      const setFragments = ['#s = :s'];
      const exprNames    = { '#s': 'status' };
      const exprValues   = { ':s': { S: status } };

      if (status === 'confirmed') { setFragments.push('confirmedAt = :ts'); exprValues[':ts'] = { S: new Date().toISOString() }; }
      if (status === 'paid')      { setFragments.push('paidAt = :ts');      exprValues[':ts'] = { S: new Date().toISOString() }; }

      const stringFields  = ['invoiceNumber', 'issueDate', 'dueDate', 'supplierName', 'supplierVatNumber', 'clientName', 'clientVatNumber', 'documentType', 'direction'];
      const numericFields = ['amountNet', 'amountVat', 'amountTotal'];

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
      const effectiveVat    = body.supplierVatNumber || null;
      const effectiveInvNum = body.invoiceNumber     || null;
      if (effectiveVat && effectiveInvNum) {
        setFragments.push('deduplicationKey = :dk');
        exprValues[':dk'] = { S: `${effectiveVat}#${effectiveInvNum}` };
      }

      await dynamo.send(new UpdateItemCommand({
        TableName: INVOICES_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, invoiceId: { S: invoiceId } },
        UpdateExpression: `SET ${setFragments.join(', ')}`,
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ConditionExpression: 'attribute_exists(invoiceId)',
      }));
      log.info('Invoice updated', { tenantId: tenantIdFromPath, invoiceId, status });
      return jsonResponse(200, { invoiceId, status, ...Object.fromEntries(stringFields.concat(numericFields).map(k => [k, body[k] ?? undefined]).filter(([,v]) => v != null)) });
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return jsonResponse(404, { error: 'Invoice not found' });
      log.error('Failed to update invoice', { tenantId: tenantIdFromPath, invoiceId, error: err.message });
      return jsonResponse(500, { error: 'Failed to update invoice' });
    }
  }

  // ── DELETE /tenants/{tenantId}/invoices/{invoiceId} ───────────────────────
  if (method === 'DELETE' && invoiceId && !path.endsWith('/profile')) {
    try {
      const getResp = await dynamo.send(new GetItemCommand({
        TableName: INVOICES_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, invoiceId: { S: invoiceId } },
      }));
      if (!getResp.Item) {
        log.warn('Invoice not found for deletion', { tenantId: tenantIdFromPath, invoiceId });
        return jsonResponse(404, { error: 'Invoice not found' });
      }
      const inv = unmarshalItem(getResp.Item);
      const bucket = inv.s3Bucket || DOCS_BUCKET_NAME;
      const s3Key  = inv.s3Key;

      await dynamo.send(new DeleteItemCommand({
        TableName: INVOICES_TABLE,
        Key: { tenantId: { S: tenantIdFromPath }, invoiceId: { S: invoiceId } },
      }));

      if (s3Key) {
        const keysToDelete = [
          s3Key,
          `${s3Key}.metadata.json`,
          `${s3Key}.kb.txt`,
          `${s3Key}.kb.txt.metadata.json`,
        ];
        await Promise.allSettled(
          keysToDelete.map(k => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }))),
        );
      }

      log.info('Invoice deleted', { tenantId: tenantIdFromPath, invoiceId });
      return jsonResponse(200, { invoiceId, deleted: true });
    } catch (err) {
      log.error('Failed to delete invoice', { tenantId: tenantIdFromPath, invoiceId, error: err.message });
      return jsonResponse(500, { error: 'Failed to delete invoice' });
    }
  }

  // ── GET /tenants/{tenantId}/invoices ───────────────────────────────────────
  if (method === 'GET' && path.endsWith('/invoices')) {
    const page     = Math.max(0, parseInt(qs.page     || '0',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(qs.pageSize || '20', 10)));
    const statusFilter    = qs.status      || null;
    const directionFilter = qs.direction   || null;
    const typeFilter      = qs.documentType || null;
    const dateFrom        = qs.dateFrom    || null;
    const dateTo          = qs.dateTo      || null;
    const search          = (qs.search || '').toLowerCase().trim();

    try {
      let items = await queryAllInvoices(tenantIdFromPath, dateFrom, dateTo);

      if (statusFilter)    items = items.filter(i => i.status      === statusFilter);
      if (directionFilter) items = items.filter(i => i.direction   === directionFilter);
      if (typeFilter)      items = items.filter(i => i.documentType === typeFilter);
      if (search)          items = items.filter(i =>
        (i.invoiceNumber  || '').toLowerCase().includes(search) ||
        (i.supplierName   || '').toLowerCase().includes(search) ||
        (i.clientName     || '').toLowerCase().includes(search)
      );

      // Sort by issueDate descending (most recent first)
      items.sort((a, b) => (b.issueDate || b.extractedAt || '').localeCompare(a.issueDate || a.extractedAt || ''));

      const total = items.length;
      const paged = items.slice(page * pageSize, (page + 1) * pageSize);
      log.info('Invoices listed', { tenantId: tenantIdFromPath, total, page, pageSize });
      return jsonResponse(200, { items: paged, total, page, pageSize });
    } catch (err) {
      log.error('Failed to list invoices', { tenantId: tenantIdFromPath, error: err.message });
      return jsonResponse(500, { error: 'Failed to list invoices' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
