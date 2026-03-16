Always use Context7 when generating code that depends on external libraries, APIs, or frameworks.

Use Context7 to retrieve the latest official documentation and API signatures before generating code.

Prefer Context7 documentation over model memory when writing code.

Always plan before coding.

Write production-grade code.

Prefer simplicity.

Generate tests for new code and adapt existing tests to the changes.

## Logging

Use structured JSON logging in all Lambda functions. Define a module-level `log` helper at the top of each file:

```js
const log = {
  info:  (msg, ctx = {}) => console.log(JSON.stringify({ level: 'INFO',  msg, ...ctx })),
  warn:  (msg, ctx = {}) => console.warn(JSON.stringify({ level: 'WARN',  msg, ...ctx })),
  debug: (msg, ctx = {}) => console.log(JSON.stringify({ level: 'DEBUG', msg, ...ctx })),
  error: (msg, ctx = {}) => console.error(JSON.stringify({ level: 'ERROR', msg, ...ctx })),
};
```

Log levels:
- **DEBUG** — internal state useful for troubleshooting (parsed values, cache status, filters applied, model selection)
- **INFO** — key business events (connection established, user/tenant created, job started, response sent)
- **WARN** — non-fatal unexpected states (403 attempts, RAG fallbacks triggered, missing records, retries)
- **ERROR** — failures that break the operation (exceptions caught, AWS API errors, data integrity issues)

Never log sensitive data (passwords, raw JWT tokens, full prompt/response text).

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
