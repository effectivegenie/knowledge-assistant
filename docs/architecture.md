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

The entire stack is defined in [`iac/knowledge-assistant-stack.ts`](../iac/knowledge-assistant-stack.ts) using AWS CDK v2 and the `@cdklabs/generative-ai-cdk-constructs` library for Bedrock constructs.

Key CDK resources:
- `bedrock.VectorKnowledgeBase` — shared KB with S3 Vectors backend
- `bedrock.S3DataSource` — one per tenant, with `inclusionPrefixes`
- `s3vectors.VectorBucket` / `VectorIndex` — Titan Text Embeddings v2 (1024 dims)
