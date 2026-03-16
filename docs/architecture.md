# System Architecture

## Overview

Knowledge Assistant is a serverless, multi-tenant RAG (Retrieval-Augmented Generation) platform built entirely on AWS managed services.

```
Browser
  │
  ├── HTTPS ──► CloudFront ──► S3 (frontend static assets)
  │
  ├── WSS ────► API Gateway WebSocket ──► Lambda (connect / chat / history / disconnect)
  │
  └── HTTPS ──► API Gateway HTTP ──────► Lambda (admin / tenant-admin)
```

## AWS Services

| Service | Purpose |
|---|---|
| **CloudFront + S3** | Frontend hosting (React/Vite SPA) |
| **API Gateway WebSocket** | Real-time streaming chat |
| **API Gateway HTTP** | Admin REST API (tenants, users, uploads) |
| **Lambda (Node.js 20)** | All compute — stateless handlers |
| **Amazon Cognito** | User pool, authentication, group-based RBAC |
| **Amazon Bedrock** | Knowledge base management + Claude inference |
| **S3 Vectors** | Vector store for Bedrock embeddings |
| **DynamoDB** | Chat history, connections, tenant registry |
| **S3 (docs bucket)** | Tenant document storage (source for Bedrock) |

## Data Flow — Chat Message

```
1. Browser opens WebSocket (sends JWT as ?token= query param)
2. $connect Lambda validates JWT, stores connectionId in DynamoDB
3. User sends { action: "sendMessage", text, user, tenantId }
4. Chat Lambda:
   a. Saves user message to ChatHistoryTable
   b. Looks up tenant's knowledgeBaseId + docsPrefix from TenantsTable
   c. Calls Bedrock Retrieve with source URI filter (fallback: unfiltered + post-filter)
   d. Assembles system prompt with context
   e. Streams response from Claude via InvokeModelWithResponseStream
   f. Pushes each chunk back over WebSocket (PostToConnection)
   g. Saves assistant message to ChatHistoryTable
5. Browser streams chunks into the assistant bubble
```

## Data Flow — Document Ingestion

```
1. Browser calls POST /tenants/{id}/upload-url  (tenant-admin Lambda)
2. Lambda returns a presigned S3 PUT URL (5 min TTL)
3. Browser PUTs the file directly to S3 under {tenantId}/{filename}
4. S3 fires OBJECT_CREATED or OBJECT_REMOVED event → sync Lambda
5. sync Lambda looks up tenant's dataSourceId in TenantsTable
6. Calls Bedrock StartIngestionJob → vectors are created/removed
```

## Lambda Functions

| Lambda | Trigger | Responsibility |
|---|---|---|
| `connect` | WS `$connect` | JWT validation, store connectionId |
| `disconnect` | WS `$disconnect` | Remove connectionId |
| `chat` | WS `sendMessage` | RAG retrieval + LLM streaming |
| `history` | WS `history` / `clear_history` | Load/soft-delete chat history |
| `admin` | HTTP API | Tenant CRUD, full delete cleanup |
| `tenant-admin` | HTTP API | User CRUD, presigned upload URLs |
| `sync` | S3 events | Start Bedrock ingestion job |
| `pre-token-gen` | Cognito trigger | Inject `custom:tenantId` into ID token |

## Infrastructure as Code

The stack is defined in `infrastructure/` using AWS CDK v2 and `@cdklabs/generative-ai-cdk-constructs`. Each domain is encapsulated in its own CDK `Construct`:

| Construct file | Responsibility |
|---|---|
| `constructs/storage.construct.ts` | S3 docs bucket (with CORS) + frontend bucket |
| `constructs/auth.construct.ts` | Cognito User Pool, groups, pre-token-gen Lambda |
| `constructs/knowledge-base.construct.ts` | S3 Vectors index, Bedrock KB, default data source |
| `constructs/database.construct.ts` | DynamoDB — connections, chat history, tenants |
| `constructs/compute.construct.ts` | All Lambda functions + IAM policies + S3 event triggers |
| `constructs/websocket-api.construct.ts` | API Gateway WebSocket + routes + Lambda permissions |
| `constructs/admin-api.construct.ts` | HTTP API defined via **OpenAPI 3.0 spec** (see below) |
| `constructs/frontend.construct.ts` | CloudFront distribution with OAC |
| `knowledge-assistant-stack.ts` | Root stack — composes all constructs, emits CfnOutputs |

## Admin API — OpenAPI Integration

The Admin HTTP API (`AdminApiConstruct`) is defined using an OpenAPI 3.0 spec passed directly to `CfnApi.body`. This means:

- Routes, integrations, CORS, and the JWT authorizer are all declared in the spec — no separate `CfnRoute` / `CfnIntegration` / `HttpJwtAuthorizer` resources
- The spec includes request/response schema definitions for all endpoints
- `x-amazon-apigateway-integration` extensions bind each operation to the correct Lambda (admin or tenant-admin) with `payloadFormatVersion: "2.0"`
- The JWT authorizer is declared as `securitySchemes.cognitoJwt` with `x-amazon-apigateway-authorizer`
- `$default` stage with `autoDeploy: true` is used (no manual deployment resource needed)

The full human-readable API reference is in [`docs/api.md`](api.md).

Key CDK resources:
- `bedrock.VectorKnowledgeBase` — shared KB with S3 Vectors backend
- `bedrock.S3DataSource` — one per tenant, with `inclusionPrefixes`
- `s3vectors.VectorBucket` / `VectorIndex` — Titan Text Embeddings v2 (1024 dims)
