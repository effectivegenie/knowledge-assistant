# Multi-Tenancy Design

## Tenant Model

Each tenant is an isolated workspace with:
- Its own S3 prefix (`{tenantId}/`) in the shared docs bucket
- A dedicated Bedrock S3DataSource with `inclusionPrefixes: ['{tenantId}/']`
- Its own Bedrock ingestion job history
- Cognito users tagged with `custom:tenantId`
- Chat history partitioned by `{tenantId}#{userId}` in DynamoDB

## DynamoDB Schemas

### TenantsTable

| Attribute | Type | Notes |
|---|---|---|
| `tenantId` | S (PK) | e.g. `acme` |
| `name` | S | Display name, e.g. `Acme Corp` |
| `knowledgeBaseId` | S | Bedrock KB ID (shared, same for all tenants) |
| `dataSourceId` | S | Bedrock data source ID (unique per tenant) |
| `docsPrefix` | S | S3 prefix, e.g. `acme/` |
| `createdAt` | S | ISO timestamp |

### ChatHistoryTable

| Attribute | Type | Notes |
|---|---|---|
| `tenantUser` | S (PK) | `{tenantId}#{userEmail}` |
| `timestamp` | S (SK) | ISO timestamp |
| `role` | S | `user` or `ai` |
| `text` | S | Message content |
| `isDeleted` | N | Soft delete flag (0 = active, 1 = deleted) |
| `ttl` | N | DynamoDB TTL (optional) |

### ConnectionsTable

| Attribute | Type | Notes |
|---|---|---|
| `connectionId` | S (PK) | API Gateway WebSocket connection ID |
| `userId` | S | Cognito `sub` |
| `email` | S | User email |
| `tenantId` | S | Tenant ID from JWT |
| `groups` | L | Cognito groups |
| `connectedAt` | S | ISO timestamp |

## Tenant Lifecycle

### Creation (`POST /tenants`)

1. Validate `tenantId`, `name`, `adminEmail`, `temporaryPassword`
2. Write tenant record to **DynamoDB TenantsTable** (sets `docsPrefix`, `knowledgeBaseId`, `dataSourceId`)
3. Create Bedrock **S3DataSource** with `inclusionPrefixes: ['{tenantId}/']` and `dataDeletionPolicy: RETAIN`
4. Upload placeholder file to **S3** at `{tenantId}/.keep` to initialize the prefix
5. Call **StartIngestionJob** to sync the new data source
6. Create **Cognito user** (admin) with `custom:tenantId` attribute
7. Add user to **TenantAdmin** Cognito group

> **Order matters**: DynamoDB is written before S3 to avoid the race condition where the S3 event fires the sync Lambda before the tenant record exists.

### Deletion (`DELETE /tenants/{id}`)

Cleanup happens in this order to avoid orphaned resources:

1. **S3**: Delete all objects under `{tenantId}/` prefix (paginated with `ListObjectsV2`)
2. **Bedrock**: Delete the tenant's data source (`DeleteDataSourceCommand`) — non-fatal if fails
3. **DynamoDB**: Soft-scan ChatHistoryTable for `tenantUser` prefix `{tenantId}#`, delete matching items
4. **DynamoDB**: Delete tenant record from TenantsTable
5. **Cognito**: List and delete all users with `custom:tenantId = {tenantId}`

## RAG Isolation

Each tenant's documents are isolated at two levels:

### Level 1 — Bedrock Data Source

Each tenant has its own S3DataSource with `inclusionPrefixes`. Bedrock only indexes files under `{tenantId}/` for that data source.

### Level 2 — Retrieval Filter

At query time, the chat Lambda applies a `startsWith` filter on the `x-amz-bedrock-kb-source-uri` metadata attribute:

```js
filter: { startsWith: { key: 'x-amz-bedrock-kb-source-uri', value: `s3://${bucket}/{tenantId}/` } }
```

**Fallback**: If the filter throws (S3 Vectors backend limitation) or returns 0 results, the Lambda retries without the filter and applies the prefix check in code:

```js
all.filter(r => r.location?.s3Location?.uri?.startsWith(sourcePrefix))
```

This double-layer approach ensures cross-tenant data leakage cannot occur even if one mechanism fails.
