# Admin REST API Reference

Base URL: output of `AdminApiUrl` from CDK deploy (stored in `cdk-outputs.json`).

All endpoints require `Authorization: Bearer <idToken>` header.

---

## Tenants

### `GET /tenants`

List all tenants. **RootAdmin only.**

**Query parameters**

| Parameter | Default | Description |
|---|---|---|
| `page` | `0` | Zero-based page index |
| `pageSize` | `20` | Items per page |
| `sortBy` | `name` | Field to sort by |
| `sortOrder` | `asc` | `asc` or `desc` |
| `search` | — | Optional. Filters by `tenantId` or `name` (case-insensitive) |

**Response 200**
```json
{
  "items": [
    {
      "tenantId": "acme",
      "name": "Acme Corp",
      "createdAt": "2024-01-15T10:00:00.000Z",
      "knowledgeBaseId": "KB123",
      "dataSourceId": "DS456",
      "docsPrefix": "acme/"
    }
  ],
  "total": 1,
  "page": 0,
  "pageSize": 20
}
```

---

### `POST /tenants`

Create a new tenant with an initial admin user. **RootAdmin only.**

**Request body**
```json
{
  "tenantId": "acme",
  "name": "Acme Corp",
  "adminEmail": "admin@acme.com",
  "temporaryPassword": "TempPass1"
}
```

**Response 200**
```json
{
  "tenantId": "acme",
  "name": "Acme Corp",
  "knowledgeBaseId": "KB123",
  "dataSourceId": "DS456"
}
```

---

### `PUT /tenants/{tenantId}`

Update tenant display name. **RootAdmin only.**

**Request body**
```json
{ "name": "Acme Corporation" }
```

**Response 200**
```json
{ "tenantId": "acme", "name": "Acme Corporation" }
```

---

### `DELETE /tenants/{tenantId}`

Delete tenant and all associated resources (S3, Bedrock data source, chat history, Cognito users). **RootAdmin only.**

**Response 200**
```json
{ "deleted": "acme" }
```

---

## Tenant Users

### `GET /tenants/{tenantId}/users`

List users belonging to a tenant. **RootAdmin** or **TenantAdmin of that tenant**.

**Query parameters**

| Parameter | Default | Description |
|---|---|---|
| `page` | `0` | Zero-based page index |
| `pageSize` | `20` | Items per page |
| `sortBy` | `email` | Field to sort by |
| `sortOrder` | `asc` | `asc` or `desc` |
| `search` | — | Optional. Filters by `email` or `status` (case-insensitive) |

**Response 200**
```json
{
  "items": [
    {
      "username": "admin@acme.com",
      "email": "admin@acme.com",
      "status": "CONFIRMED",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 0,
  "pageSize": 20
}
```

User `status` values: `CONFIRMED`, `FORCE_CHANGE_PASSWORD`, `UNCONFIRMED`.

---

### `POST /tenants/{tenantId}/users`

Create a new user in the tenant. **RootAdmin** or **TenantAdmin of that tenant**.

**Request body**
```json
{
  "email": "user@acme.com",
  "temporaryPassword": "TempPass1",
  "businessGroups": ["financial", "IT"]
}
```

`businessGroups` is optional. Valid values: `financial`, `accounting`, `operations`, `marketing`, `IT`, `warehouse`, `security`, `logistics`, `sales`, `design`, `HR`. Returns 400 for unknown group names.

The user is created with `MessageAction: SUPPRESS` (no welcome email). The user must change their password on first login.

**Response 200**
```json
{ "email": "user@acme.com", "tenantId": "acme", "businessGroups": ["financial", "IT"] }
```

---

### `DELETE /tenants/{tenantId}/users/{username}`

Permanently delete a Cognito user. **RootAdmin** or **TenantAdmin of that tenant**.

**Response 200**
```json
{ "deleted": "user@acme.com" }
```

---

### `PUT /tenants/{tenantId}/users/{username}`

Update business group assignments for a user. **RootAdmin** or **TenantAdmin of that tenant**.

**Request body**
```json
{
  "businessGroups": ["financial", "IT"]
}
```

**Response 200**
```json
{ "username": "user@acme.com", "businessGroups": ["financial", "IT"] }
```

---

## Document Upload

### `POST /tenants/{tenantId}/upload-url`

Generate presigned S3 PUT URLs for direct browser-to-S3 upload (document + metadata). **RootAdmin** or **TenantAdmin of that tenant**.

**Request body**
```json
{
  "filename": "product-manual.pdf",
  "groups": ["financial", "IT"],
  "category": "general"
}
```

`groups` is optional. When provided, documents are tagged with access groups — only users in those groups will see them in RAG results. Valid group names: `financial`, `accounting`, `operations`, `marketing`, `IT`, `warehouse`, `security`, `logistics`, `sales`, `design`, `HR`. Use `general` for documents accessible to all users regardless of group membership.

`category` is optional. Valid values: `general` (default), `invoice`, or `contract`. When set to `invoice`, the invoice-processor Lambda runs and saves an InvoicesTable record. When set to `contract`, the contract-processor Lambda runs and saves a ContractsTable record. Any unknown value falls back to `general`.

Filenames are sanitised server-side: characters outside `[a-zA-Z0-9._\-\s]` are replaced with `_`. The frontend additionally transliterates Cyrillic characters to Latin before sending the filename.

**Response 200**
```json
{
  "url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "metadataUrl": "https://s3.amazonaws.com/...product-manual.pdf.metadata.json?...",
  "key": "acme/product-manual.pdf",
  "category": "general"
}
```

Both URLs expire in 5 minutes. Upload workflow:

1. `PUT <url>` with document bytes (Content-Type: application/pdf or appropriate MIME type)
2. `PUT <metadataUrl>` with JSON body (Content-Type: application/json):
   ```json
   { "metadataAttributes": { "tenantId": "acme", "groups": ["financial", "IT"], "category": "general" } }
   ```

`tenantId` in metadata enables KB-level tenant isolation. The metadata file enables Bedrock KB group filtering. After a successful upload, the S3 event triggers Bedrock ingestion. If `category` is `invoice` or `contract`, the respective processor Lambda also runs for data extraction.

---

## Invoices

All invoice endpoints require **RootAdmin** or **TenantAdmin of that tenant**.

### `GET /tenants/{tenantId}/invoices`

List invoices with optional filtering and pagination.

**Query parameters**

| Parameter | Description |
|---|---|
| `page` | Zero-based page index (default: `0`) |
| `pageSize` | Items per page, max 100 (default: `20`) |
| `status` | Filter by status: `pending`, `extracted`, `review_needed`, `confirmed`, `paid`, `rejected` |
| `direction` | Filter by `incoming` or `outgoing` |
| `documentType` | Filter by `invoice`, `proforma`, or `credit_note` |
| `dateFrom` | Filter by issue date `>=` (YYYY-MM-DD) |
| `dateTo` | Filter by issue date `<=` (YYYY-MM-DD) |
| `search` | Case-insensitive match against `invoiceNumber`, `supplierName`, `clientName` |

**Response 200**
```json
{
  "items": [
    {
      "invoiceId": "uuid",
      "tenantId": "acme",
      "status": "confirmed",
      "documentType": "invoice",
      "direction": "incoming",
      "invoiceNumber": "INV-001",
      "issueDate": "2024-01-15",
      "dueDate": "2024-02-15",
      "supplierName": "Supplier Ltd",
      "supplierVatNumber": "BG123456789",
      "clientName": "Acme Ltd",
      "clientVatNumber": "BG999999999",
      "amountNet": 1000,
      "amountVat": 190,
      "amountTotal": 1190,
      "confidence": 0.92,
      "extractedAt": "2024-01-15T12:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 0,
  "pageSize": 20
}
```

Invoice `status` lifecycle: `pending` → `extracted` | `review_needed` → `confirmed` | `rejected` → `paid`

---

### `PUT /tenants/{tenantId}/invoices/{invoiceId}`

Update invoice status and optionally correct extracted fields. Returns 404 if invoice does not exist.

**Request body**
```json
{
  "status": "confirmed",
  "invoiceNumber": "INV-001",
  "documentType": "invoice",
  "direction": "incoming",
  "issueDate": "2024-01-15",
  "dueDate": "2024-02-15",
  "supplierName": "Supplier Ltd",
  "supplierVatNumber": "BG123456789",
  "clientName": "Acme Ltd",
  "clientVatNumber": "BG999999999",
  "amountNet": 1000.00,
  "amountVat": 200.00,
  "amountTotal": 1200.00
}
```

Only `status` is required. All other fields are optional — omit them to leave them unchanged.

`direction` must be `incoming` or `outgoing`. `documentType` must be `invoice`, `proforma`, or `credit_note`.

When `status` is set to `confirmed` or `paid`, a timestamp (`confirmedAt` / `paidAt`) is automatically recorded. When both `supplierVatNumber` and `invoiceNumber` are provided, the deduplication key is recomputed.

**Response 200**
```json
{ "invoiceId": "uuid", "status": "confirmed" }
```

---

### `DELETE /tenants/{tenantId}/invoices/{invoiceId}`

Delete invoice record from DynamoDB and all associated S3 files (original, `.metadata.json`, `.kb.txt`, `.kb.txt.metadata.json`).

**Auth**: TenantAdmin or RootAdmin

**Response 200**
```json
{ "invoiceId": "uuid", "deleted": true }
```

Returns 404 if invoice not found.

---

### `GET /tenants/{tenantId}/invoices/{invoiceId}/view-url`

Generate a presigned S3 GET URL (TTL: 600 s) for the original uploaded document.

**Response 200**
```json
{ "url": "https://s3.amazonaws.com/...?X-Amz-Signature=..." }
```

---

### `GET /tenants/{tenantId}/invoices/stats`

Compute financial aggregates. Only `invoice` and `credit_note` documents with status `confirmed` or `paid` contribute to totals. Proforma invoices are excluded.

**Query parameters**: optional `dateFrom` / `dateTo` (YYYY-MM-DD) to restrict the date range.

**Response 200**
```json
{
  "totals": {
    "income": 50000,
    "expenses": 20000,
    "net": 30000,
    "unpaid": 10000
  },
  "byMonth": [
    { "month": "2024-01", "income": 10000, "expenses": 5000 },
    { "month": "2024-02", "income": 15000, "expenses": 8000 }
  ]
}
```

- `income` — sum of `amountTotal` for outgoing invoices (confirmed + paid)
- `expenses` — sum of `amountTotal` for incoming invoices (confirmed + paid)
- `net` — `income - expenses`
- `unpaid` — sum of `amountTotal` for confirmed (not yet paid) invoices regardless of direction

---

### `GET /tenants/{tenantId}/profile`

Get tenant legal identity used by the invoice extraction pipeline to determine invoice direction.

**Response 200**
```json
{
  "legalName": "Acme Ltd",
  "vatNumber": "BG123456789",
  "bulstat": "123456789",
  "aliases": ["Acme", "ACME Corp"]
}
```

---

### `PUT /tenants/{tenantId}/profile`

Update tenant legal identity.

**Request body**
```json
{
  "legalName": "Acme Ltd",
  "vatNumber": "BG123456789",
  "bulstat": "123456789",
  "aliases": ["Acme", "ACME Corp"]
}
```

**Response 200** — same shape as GET.

---

## Contracts

All contracts endpoints require **RootAdmin** or **TenantAdmin of that tenant**.

### `GET /tenants/{tenantId}/contracts`

List contracts for tenant. Supports pagination and filtering.

**Query parameters**

| Parameter | Description |
|---|---|
| `page` | Zero-based page index (default: `0`) |
| `pageSize` | Items per page (default: `20`) |
| `status` | Filter by status |
| `contractType` | Filter by contract type |
| `search` | Case-insensitive match against `contractNumber`, `clientName`, `counterpartyName` |

**Response 200**
```json
{ "items": [...], "total": 0, "page": 0, "pageSize": 20 }
```

---

### `GET /tenants/{tenantId}/contracts/stats`

Aggregated stats for confirmed contracts.

**Response 200**
```json
{
  "active": 10,
  "expiringSoon": 2,
  "expired": 3,
  "pending": 4,
  "total": 15
}
```

- `active`: confirmed contracts with `endDate` > 30 days away or no `endDate`
- `expiringSoon`: confirmed contracts expiring within 30 days
- `expired`: confirmed contracts with `endDate` in the past
- `pending`: contracts with status `extracted` or `review_needed`
- `total`: total confirmed contracts

---

### `PUT /tenants/{tenantId}/contracts/{contractId}`

Update status and/or editable fields. Returns 404 if contract does not exist.

**Request body**
```json
{
  "status": "confirmed",
  "contractNumber": "CTR-001",
  "signingDate": "2024-01-15"
}
```

Only `status` is required. All other fields are optional.

Valid statuses: `pending`, `extracted`, `review_needed`, `confirmed`, `rejected`.
Valid contractTypes: `services`, `rental`, `supply`, `employment`, `nda`, `framework`, `other`.

**Response 200**
```json
{ "contractId": "uuid", "status": "confirmed" }
```

---

### `DELETE /tenants/{tenantId}/contracts/{contractId}`

Delete contract record from DynamoDB and all associated S3 files.

**Response 200**
```json
{ "contractId": "uuid", "deleted": true }
```

---

### `GET /tenants/{tenantId}/contracts/{contractId}/view-url`

Returns presigned S3 GET URL (600 s TTL) for the original contract document.

**Response 200**
```json
{ "url": "https://..." }
```

---

## General Documents

All documents endpoints require **RootAdmin** or **TenantAdmin of that tenant**.

### `GET /tenants/{tenantId}/documents`

List general documents (`category=general`) from the tenant S3 bucket.

Fetches all S3 objects under the tenant prefix, reads each `.metadata.json`, and keeps only those with `category=general`.

**Query parameters**

| Parameter | Description |
|---|---|
| `page` | Zero-based page index (default: `0`) |
| `pageSize` | Items per page (default: `20`) |
| `search` | Case-insensitive match against `filename` |

**Response 200**
```json
{
  "items": [
    {
      "key": "product-manual.pdf",
      "fullKey": "acme/product-manual.pdf",
      "size": 204800,
      "lastModified": "2024-01-15T10:00:00.000Z",
      "filename": "product-manual.pdf"
    }
  ],
  "total": 1,
  "page": 0,
  "pageSize": 20
}
```

---

### `DELETE /tenants/{tenantId}/documents?key={key}`

Delete a document and all its sidecars (`.metadata.json`, `.kb.txt`, `.kb.txt.metadata.json`) from S3.

**Query parameter**: `key` (required) — the S3 key relative to tenant prefix or full key.

**Response 200**
```json
{ "deleted": "acme/product-manual.pdf" }
```

---

### `GET /tenants/{tenantId}/documents/view-url?key={key}`

Returns presigned S3 GET URL (600 s TTL) for a general document.

**Query parameter**: `key` (required)

**Response 200**
```json
{ "url": "https://..." }
```

---

## Error Responses

All errors return JSON:

```json
{ "error": "Human-readable message", "detail": "Optional SDK error detail" }
```

| Status | Meaning |
|---|---|
| 400 | Bad request (missing fields, Cognito error) |
| 403 | Forbidden (insufficient group membership) |
| 404 | Route not matched |
| 500 | Internal error (AWS SDK failure, misconfiguration) |
