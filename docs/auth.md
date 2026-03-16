# Authentication & Authorization

## Cognito User Pool

All users are stored in a single Cognito User Pool. Self sign-up is disabled — users are created by admins only.

### Custom Attributes

| Attribute | Type | Purpose |
|---|---|---|
| `custom:tenantId` | String | Identifies which tenant the user belongs to |

### Groups

#### System Groups

| Group | Purpose |
|---|---|
| `RootAdmin` | Full access — can create/delete tenants, manage any tenant's users |
| `TenantAdmin` | Can manage users within their own tenant only; automatically assigned all 11 business groups |

#### Business Groups

Users can belong to one or more of the following business domain groups. These control which documents they can retrieve via RAG.

| Group | Domain |
|---|---|
| `financial` | Financial department |
| `accounting` | Accounting department |
| `operations` | Operations department |
| `marketing` | Marketing department |
| `IT` | IT department |
| `warehouse` | Warehouse department |
| `security` | Security department |
| `logistics` | Logistics department |
| `sales` | Sales department |
| `design` | Design department |
| `HR` | Human Resources department |

RootAdmin and TenantAdmin bypass all group-based document filters — they can access all documents regardless of group tagging.

## Pre-Token Generation Trigger

`lambda/pre-token-gen/index.js` is invoked by Cognito before issuing an ID token. It injects `custom:tenantId` into the token claims so the frontend and Lambda authorizers can read it without an extra Cognito lookup.

```js
claimsToAddOrOverride['custom:tenantId'] = userAttributes['custom:tenantId']
```

## WebSocket Authentication

API Gateway WebSocket does not natively support JWT authorizers on `$connect`. Instead, the client passes the ID token as a query parameter:

```
wss://...execute-api.../prod?token=<idToken>
```

The `connect` Lambda (`lambda/connect/index.mjs`) fully verifies the JWT using Cognito's JWKS endpoint:

1. Decodes the JWT header → extracts `kid` (key ID) and `alg`
2. Validates claims: `iss` matches `https://cognito-idp.{region}.amazonaws.com/{userPoolId}`, `exp > now`, `aud`/`client_id` matches the App Client ID
3. Fetches JWKS from `https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json` (cached at module level for Lambda container lifetime)
4. Finds the JWK matching `kid`; on cache miss triggers one forced refresh (handles key rotation)
5. Verifies the RSA-SHA256 cryptographic signature using Node.js `crypto.createVerify`
6. On success: stores `connectionId`, `userId`, `email`, `tenantId`, `groups` in DynamoDB

> **Security**: The connect Lambda performs full cryptographic signature verification using Cognito's public JWKS. Tokens with forged payloads or signed by unknown keys are rejected.

## HTTP API Authorization

The Admin HTTP API uses API Gateway's built-in JWT authorizer (`HttpJwtAuthorizer`) backed by Cognito. Authorization header: `Bearer <idToken>`.

Claims are forwarded to Lambda via `event.requestContext.authorizer.jwt.claims`.

### Authorization Matrix

| Endpoint | RootAdmin | TenantAdmin | Regular User |
|---|---|---|---|
| `GET /tenants` | ✅ | ❌ | ❌ |
| `POST /tenants` | ✅ | ❌ | ❌ |
| `PUT /tenants/{id}` | ✅ | ❌ | ❌ |
| `DELETE /tenants/{id}` | ✅ | ❌ | ❌ |
| `GET /tenants/{id}/users` | ✅ | ✅ (own tenant) | ❌ |
| `POST /tenants/{id}/users` | ✅ | ✅ (own tenant) | ❌ |
| `DELETE /tenants/{id}/users/{u}` | ✅ | ✅ (own tenant) | ❌ |
| `PUT /tenants/{id}/users/{u}` | ✅ | ✅ (own tenant) | ❌ |
| `POST /tenants/{id}/upload-url` | ✅ | ✅ (own tenant) | ❌ |

### Group Parsing

Cognito groups can arrive in different formats depending on whether the claim came from the pre-token-gen trigger or the raw Cognito token. The `parseGroups` helper in both admin lambdas handles:

- Array: `["RootAdmin", "TenantAdmin"]`
- JSON string: `'["RootAdmin"]'`
- Bracket format: `'[RootAdmin]'` (unquoted, API GW serialization)
- Space/comma-separated: `'RootAdmin TenantAdmin'`

## Frontend Auth Flow

```mermaid
sequenceDiagram
    actor User
    participant App as React App
    participant Cognito as Amazon Cognito
    participant API as HTTP / WebSocket API

    User->>App: enter email + password
    App->>Cognito: signIn(email, password)
    alt Normal login
        Cognito-->>App: CognitoUserSession (idToken)
    else Admin-created user
        Cognito-->>App: NEW_PASSWORD_REQUIRED
        App->>User: show change-password form
        User->>App: submit new password
        App->>Cognito: completeNewPassword(newPassword)
        Cognito-->>App: CognitoUserSession (idToken)
    end
    App->>App: AuthContext stores idToken
    App->>API: HTTP requests with Authorization: Bearer <idToken>
    App->>API: WebSocket connect ?token=<idToken>
```
