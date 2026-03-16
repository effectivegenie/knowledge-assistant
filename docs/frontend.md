# Frontend Components & Hooks

## Tech Stack

- **React 18** + **TypeScript**
- **Vite** (build + dev server)
- **Ant Design 5** (UI components)
- **recharts** (bar charts in InvoicesPage Stats tab)
- **amazon-cognito-identity-js** (Cognito auth)

## Configuration

`frontend/src/config.ts` — must be updated with CDK outputs after each deploy:

```ts
export const config: AppConfig = {
  cognito: {
    userPoolId: 'us-east-1_XXXXXXX',
    userPoolClientId: 'XXXXXXXXXXXXXXXXXXXXXXXXXX',
    region: 'us-east-1',
  },
  websocket: { url: 'wss://XXXXXXX.execute-api.us-east-1.amazonaws.com/prod' },
  adminApiUrl: 'https://XXXXXXX.execute-api.us-east-1.amazonaws.com',
};
```

`adminApiUrl` is also exported as `export const adminApiUrl` for direct import in pages.

## Auth (`frontend/src/auth/`)

### `cognito.ts`

Wraps `amazon-cognito-identity-js` with Promise-based helpers:

| Function | Description |
|---|---|
| `signIn(email, password)` | Returns `CognitoUserSession` or `'NEW_PASSWORD_REQUIRED'` |
| `completeNewPassword(newPassword)` | Completes the new-password challenge (admin-created users) |
| `signOut()` | Signs out the current user |
| `getCurrentSession()` | Returns the current session or `null` |
| `getIdToken()` | Returns the raw JWT ID token string |

A module-level `_pendingUser` variable holds the `CognitoUser` object during a `NEW_PASSWORD_REQUIRED` challenge.

### `AuthContext.tsx`

React context providing:

```ts
interface AuthContextValue {
  user: { email: string; tenantId: string; groups: string[] } | null;
  idToken: string | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  signOut: () => void;
}
```

On mount, `AuthContext` calls `getCurrentSession()` to restore an existing Cognito session. The ID token is refreshed automatically by the SDK.

## Hooks

### `useWebSocket` (`frontend/src/hooks/useWebSocket.ts`)

Manages the WebSocket lifecycle and chat message state.

```ts
const { messages, isConnected, sendMessage, clearMessages, historyLoaded } = useWebSocket();
```

| Return value | Type | Description |
|---|---|---|
| `messages` | `ChatMessage[]` | All messages in the current session |
| `isConnected` | `boolean` | WebSocket open state |
| `sendMessage(text)` | `function` | Send a user message |
| `clearMessages()` | `function` | Clear chat (soft-deletes in DynamoDB) |
| `historyLoaded` | `boolean` | True once history response received |

**Connection lifecycle:**
1. Opens WebSocket with `?token=<idToken>` on mount / when `idToken` changes
2. On open: sends `{ action: 'history' }` to restore previous messages
3. On close: exponential backoff reconnect (1s → 2s → 4s → ... → 30s max)
4. Closes cleanly on unmount or when `idToken` becomes null

**`ChatMessage` type:**

```ts
interface Citation {
  source: string;   // S3 URI
  score: number;    // Bedrock relevance score 0–1
  excerpt: string;  // First 200 chars of retrieved chunk
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  citations?: Citation[];
}
```

**Message types received:**

| Type | Behaviour |
|---|---|
| `history` | Restores previous messages from DynamoDB |
| `chunk` | Appends text to the last streaming assistant message |
| `end` | Marks the last assistant message as done streaming |
| `citations` | Attaches source citations to the last completed assistant message |
| `error` | Appends error text to the last assistant message |

## Pages

### `App.tsx`

Root component. Contains:
- Login / new-password forms (shown when `user === null`)
- Top header with hamburger menu button
- Left navigation `Drawer` (312px) with menu items
- Routing logic: `view` state switches between `chat`, `admin`, `tenant-admin`, `invoices`

**Views:**
- `chat` — `ChatWidget` (all authenticated users)
- `admin` — `AdminPage` (RootAdmin only)
- `tenant-admin` — `TenantAdminPage` (TenantAdmin only)
- `invoices` — `InvoicesPage` (TenantAdmin only)

### `AdminPage.tsx`

Root admin interface (RootAdmin only).

- Tenant table with Create / Edit / Delete / Users actions
- **Create Drawer**: `tenantId`, `name`, `adminEmail`, `temporaryPassword`
- **Edit Drawer**: change display `name`
- **Users Drawer** (600px): list tenant users with Add / Delete
- **Nested Add User Drawer**: `email`, `temporaryPassword`

### `TenantAdminPage.tsx`

Tenant admin interface (TenantAdmin only).

- User table for the current tenant with search, sort and pagination
- **Edit Groups Drawer**: change `businessGroups` for an existing user
- **Add User Drawer**: `email`, `temporaryPassword`, `businessGroups` (multi-select, optional)
  - `businessGroups` are passed to `POST /tenants/{id}/users` and assigned in Cognito
- **Upload Documents Drawer**: Ant Design `Dragger`
  - **Category selector**: `general` (default, knowledge base only) or `invoice` (triggers Textract extraction pipeline)
  - **Group selector** (multi-select): controls which business groups can access the uploaded documents
  - Calls `POST /tenants/{id}/upload-url` with `{ filename, groups, category }` → receives `{ url, metadataUrl, key, category }`
  - PUTs metadata JSON `{ metadataAttributes: { tenantId, groups, category } }` to `metadataUrl` **before** the document to avoid race conditions
  - PUTs file directly to S3 with XHR
  - Supports multiple files, drag-and-drop

### `InvoicesPage.tsx`

Invoice Intelligence UI (TenantAdmin only). Four tabs:

**Invoices tab**
- Table of all invoices (extracted / confirmed / paid / rejected)
- Search bar + status / direction filters + date range picker
- Row selection for bulk confirm of `extracted` invoices
- Click eye icon → **Invoice Details Drawer**: full extracted fields + "View original document" presigned link

**Pending Review tab**
- Table of `review_needed` invoices (low confidence extraction)
- Click eye icon → **Review Drawer**: extracted data + presigned document link
- Footer actions: **"Yes, it's an invoice"** (→ `confirmed`) / **"Not an invoice"** (→ `rejected`)
- Bulk confirm button for selected records

**Stats tab**
- Date range picker for period filtering
- KPI cards: Income, Expenses, Net, Unpaid (confirmed but not yet paid)
- recharts `BarChart` — income vs expenses grouped by month

**Company Profile tab**
- Form for tenant legal identity: `legalName`, `vatNumber`, `bulstat`, `aliases` (comma-separated)
- Saved to TenantsTable via `PUT /tenants/{id}/profile`
- Used by the document-processor Lambda to determine invoice direction (incoming/outgoing)

## Components

### `ChatWidget.tsx`

Main chat interface.

- Renders the empty state (logo + prompt) when no messages
- Renders message bubbles: user (right, `#dce7f3` background) and assistant (left, logo avatar 60px)
- Streaming: assistant bubble grows as `chunk` events arrive; blinking cursor shown during streaming
- Typing indicator (3-dot bounce) shown while assistant bubble is empty and streaming
- **Citations**: after streaming ends, a collapsible "Sources" panel appears below each assistant message that has citations. Shows filename (from S3 URI), relevance score badge, and short excerpt.
- Input: `TextArea` (auto-resize 1–4 rows), `Enter` to send, `Shift+Enter` for newline
- Clear button (`DeleteOutlined`) appears once messages exist

## Brand Colors

| Token | Hex | Usage |
|---|---|---|
| Primary navy | `#1e3a5f` | Headers, titles, drawer backgrounds |
| Gold accent | `#e6a800` | Drawer border, icon accents |
| Light blue | `#dce7f3` | User message bubble background |
| Background | `#f0f4fb` | Page background |
