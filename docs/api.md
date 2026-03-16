# Admin REST API Reference

Base URL: output of `AdminApiUrl` from CDK deploy (stored in `cdk-outputs.json`).

All endpoints require `Authorization: Bearer <idToken>` header.

---

## Tenants

### `GET /tenants`

List all tenants. **RootAdmin only.**

**Response 200**
```json
{
  "tenants": [
    {
      "tenantId": "acme",
      "name": "Acme Corp",
      "createdAt": "2024-01-15T10:00:00.000Z",
      "knowledgeBaseId": "KB123",
      "dataSourceId": "DS456",
      "docsPrefix": "acme/"
    }
  ]
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

**Response 200**
```json
{
  "users": [
    {
      "username": "admin@acme.com",
      "email": "admin@acme.com",
      "status": "CONFIRMED",
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ]
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

`businessGroups` is optional. Valid values: `financial`, `accounting`, `operations`, `marketing`, `IT`, `warehouse`, `security`, `logistics`, `sales`. Returns 400 for unknown group names.

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

## Document Upload

### `POST /tenants/{tenantId}/upload-url`

Generate presigned S3 PUT URLs for direct browser-to-S3 upload (document + metadata). **RootAdmin** or **TenantAdmin of that tenant**.

**Request body**
```json
{
  "filename": "product-manual.pdf",
  "groups": ["financial", "IT"]
}
```

`groups` is optional. When provided, documents are tagged with access groups — only users in those groups will see them in RAG results. Valid group names: `financial`, `accounting`, `operations`, `marketing`, `IT`, `warehouse`, `security`, `logistics`, `sales`.

Filenames are sanitised: characters outside `[a-zA-Z0-9._\-\s]` are replaced with `_`.

**Response 200**
```json
{
  "url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "metadataUrl": "https://s3.amazonaws.com/...product-manual.pdf.metadata.json?...",
  "key": "acme/product-manual.pdf"
}
```

Both URLs expire in 5 minutes. Upload workflow:

1. `PUT <url>` with document bytes (Content-Type: application/pdf or appropriate MIME type)
2. `PUT <metadataUrl>` with JSON body (Content-Type: application/json):
   ```json
   { "metadataAttributes": { "groups": ["financial", "IT"] } }
   ```

The metadata file enables Bedrock KB group filtering. After a successful upload, the S3 event automatically triggers a Bedrock ingestion job.

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
