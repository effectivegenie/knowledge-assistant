# Frontend Components & Hooks

## Tech Stack

- **React 18** + **TypeScript**
- **Vite** (build + dev server)
- **Ant Design 5** (UI components)
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

**Message types received:**

| Type | Behaviour |
|---|---|
| `history` | Restores previous messages from DynamoDB |
| `chunk` | Appends text to the last streaming assistant message |
| `end` | Marks the last assistant message as done streaming |
| `error` | Appends error text to the last assistant message |

## Pages

### `App.tsx`

Root component. Contains:
- Login / new-password forms (shown when `user === null`)
- Top header with hamburger menu button
- Left navigation `Drawer` (312px) with menu items
- Routing logic: `view` state switches between `chat`, `tenantAdmin`, `admin`

**Views:**
- `chat` — `ChatWidget`
- `tenantAdmin` — `TenantAdminPage` (visible to `TenantAdmin` and `RootAdmin`)
- `admin` — `AdminPage` (visible to `RootAdmin` only)

### `AdminPage.tsx`

Root admin interface (RootAdmin only).

- Tenant table with Create / Edit / Delete / Users actions
- **Create Drawer**: `tenantId`, `name`, `adminEmail`, `temporaryPassword`
- **Edit Drawer**: change display `name`
- **Users Drawer** (600px): list tenant users with Add / Delete
- **Nested Add User Drawer**: `email`, `temporaryPassword`

### `TenantAdminPage.tsx`

Tenant admin interface (TenantAdmin + RootAdmin).

- User table for the current tenant
- **Add User Drawer**: `email`, `temporaryPassword`
- **Upload Documents Drawer**: Ant Design `Dragger` with `customRequest`
  - Calls `POST /tenants/{id}/upload-url` → receives presigned S3 URL
  - PUTs file directly to S3 with XHR (tracks upload progress)
  - Supports multiple files, drag-and-drop

## Components

### `ChatWidget.tsx`

Main chat interface.

- Renders the empty state (logo + prompt) when no messages
- Renders message bubbles: user (right, `#dce7f3` background) and assistant (left, logo avatar 60px)
- Streaming: assistant bubble grows as `chunk` events arrive; blinking cursor shown during streaming
- Typing indicator (3-dot bounce) shown while assistant bubble is empty and streaming
- Input: `TextArea` (auto-resize 1–4 rows), `Enter` to send, `Shift+Enter` for newline
- Clear button (`DeleteOutlined`) appears once messages exist

## Brand Colors

| Token | Hex | Usage |
|---|---|---|
| Primary navy | `#1e3a5f` | Headers, titles, drawer backgrounds |
| Gold accent | `#e6a800` | Drawer border, icon accents |
| Light blue | `#dce7f3` | User message bubble background |
| Background | `#f0f4fb` | Page background |
