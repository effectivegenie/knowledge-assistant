# Knowledge Assistant

A multi-tenant AI-powered knowledge base assistant built on AWS. Each tenant gets isolated document storage, a dedicated Bedrock data source, and RAG-augmented chat via WebSocket.

## Documentation

| Topic | File |
|---|---|
| System Architecture | [docs/architecture.md](docs/architecture.md) |
| Authentication & Authorization | [docs/auth.md](docs/auth.md) |
| Multi-Tenancy Design | [docs/multi-tenancy.md](docs/multi-tenancy.md) |
| Admin REST API Reference | [docs/api.md](docs/api.md) |
| RAG Pipeline | [docs/rag.md](docs/rag.md) |
| Frontend Components & Hooks | [docs/frontend.md](docs/frontend.md) |
| AI Development Prompt Templates | [docs/prompts.md](docs/prompts.md) |

## Quick Start

### Prerequisites

- Node.js 20+
- AWS CLI configured with appropriate permissions
- AWS CDK v2 installed globally (`npm i -g aws-cdk`)

### Deploy

```bash
npm install
npm run deploy           # deploys CDK stack, outputs cdk-outputs.json
npm run deploy:frontend  # builds and uploads frontend to S3/CloudFront
```

After deploy, copy values from `cdk-outputs.json` into `frontend/src/config.ts`.

### Local Development

```bash
cd frontend
npm install
npm run dev
```

## Project Structure

```
├── bin/                    CDK app entry point
├── docs/                   Project documentation
├── frontend/               React + Vite frontend
│   └── src/
│       ├── auth/           Cognito auth utilities and context
│       ├── components/     ChatWidget
│       ├── hooks/          useWebSocket
│       └── pages/          AdminPage, TenantAdminPage
├── infrastructure/         AWS CDK stack (decomposed by domain)
│   ├── constructs/         One Construct per infrastructure domain
│   └── knowledge-assistant-stack.ts  Root stack (composes all constructs)
├── lambda/
│   ├── admin/              Root admin CRUD (tenants, users)
│   ├── chat/               WebSocket message handler + RAG
│   ├── connect/            WebSocket $connect (JWT validation)
│   ├── disconnect/         WebSocket $disconnect
│   ├── history/            Chat history + clear
│   ├── pre-token-gen/      Cognito pre-token-generation trigger
│   ├── sync/               S3 → Bedrock KB ingestion trigger
│   └── tenant-admin/       Tenant admin (users CRUD, file upload)
└── scripts/                Deploy helper scripts
```

## Testing

```bash
# Lambda unit tests (from project root)
npm test

# Frontend tests
cd frontend && npm test
```
