дAlways use Context7 when generating code that depends on external libraries, APIs, or frameworks.

Use Context7 to retrieve the latest official documentation and API signatures before generating code.

Prefer Context7 documentation over model memory when writing code.

Always plan before coding.

Write production-grade code.

Prefer simplicity.

Generate tests for new code.

## Documentation

When adding a significant new feature or performing refactoring, update the relevant files in `docs/`:

| Change | Update |
|---|---|
| New Lambda endpoint | `docs/api.md` |
| Auth / Cognito changes | `docs/auth.md` |
| RAG / Bedrock changes | `docs/rag.md` |
| Multi-tenancy / DynamoDB schema | `docs/multi-tenancy.md` |
| Frontend components or hooks | `docs/frontend.md` |
| AWS services / data flow | `docs/architecture.md` |
