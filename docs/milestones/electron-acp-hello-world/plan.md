# Milestone 0: Electron + ACP Hello World — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable steps. Each step has a clear done condition. The plan is informed by the actual API surfaces of `@agentclientprotocol/sdk` (v0.16.x) and `electron-vite`.

---

## Step 1: Project Scaffolding

### 1.1 Initialize electron-vite project

```bash
cd /Users/dherman/Code/bouncer
npm create @quick-start/electron@latest . -- --template react
```

If the scaffolder conflicts with existing files (`docs/`, `data/`, etc.), initialize in a temp directory and move the relevant files in. The goal is to end up with:

```
bouncer/
├── electron/
│   ├── main/
│   │   └── index.ts
│   └── preload/
│       └── index.ts
├── src/                      # renderer (React)
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── data/                     # (existing, preserve)
├── scripts/                  # (existing, preserve)
└── docs/                     # (existing, preserve)
```

### 1.2 Install ACP SDK

```bash
npm install @agentclientprotocol/sdk
```

The SDK has a peer dependency on `zod` (^3.25.0 || ^4.0.0). Install it if not pulled in automatically:

```bash
npm install zod
```

### 1.3 Verify baseline

```bash
npm run dev
```

Confirm the Electron app launches and shows the default React template page. This validates the toolchain before we change anything.

**Done when:** Electron window opens with React content, `npm run build` succeeds cleanly.

---

## Step 2: Echo Agent

Build the echo agent as a standalone Node script before touching any Electron code. This is the fastest way to discover the real ACP SDK API surface and work through any surprises.

### 2.1 Create agent source file

Create `electron/agents/echo-agent.ts`. This script will be run as a child process — it reads JSON-RPC from stdin and writes to stdout.

```typescript
import * as acp from "@agentclientprotocol/sdk";
import { Writable, Readable } from "node:stream";

// Create the ndJson stream over stdio
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

// Create the agent-side connection
new acp.AgentSideConnection(
  (connection) => ({
    async initialize(params) {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "bouncer-echo-agent", version: "0.1.0" },
        agentCapabilities: { streaming: true },
      };
    },

    async newSession(params) {
      return {
        sessionId: crypto.randomUUID(),
      };
    },

    async prompt(params) {
      // Extract text from the prompt content blocks
      const userText = params.prompt
        .filter((block): block is acp.TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");

      const reply = `Echo: ${userText}`;

      // Stream in small chunks to exercise the streaming path
      const chunkSize = 10;
      for (let i = 0; i < reply.length; i += chunkSize) {
        const chunk = reply.slice(i, i + chunkSize);
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: { type: "agent_message_chunk", text: chunk },
        });
        await new Promise((r) => setTimeout(r, 50));
      }

      return { stopReason: "end_turn" };
    },

    // Stubs for required interface methods
    async loadSession(params) {
      throw new Error("Not implemented");
    },
    async authenticate(params) {
      return {};
    },
    async setSessionMode(params) {
      return {};
    },
    async cancel(params) {
      return {};
    },
  }),
  stream
);

process.stderr.write("Echo agent started\n");
```

> **Important:** The exact API may differ from the above. The `Agent` interface returned from the `AgentSideConnection` callback may have additional required methods, or the types may be slightly different. Adapt based on what TypeScript reports. The critical discovery questions are:
>
> 1. What methods does the `Agent` interface require?
> 2. How does `connection.sessionUpdate()` actually work — is it a method on the connection, or passed via a callback/context?
> 3. What is the exact shape of `StopReason` — string literal union or enum?
>
> Expect to spend some time reading the SDK's `.d.ts` files in `node_modules/@agentclientprotocol/sdk/dist/`.

### 2.2 Build the agent

Add a build script for the agent. Options:

**Option A (recommended for dev): Run directly with tsx**
```bash
npx tsx electron/agents/echo-agent.ts
```

**Option B: Build with esbuild**
Add to `package.json`:
```json
{
  "scripts": {
    "build:agent": "esbuild electron/agents/echo-agent.ts --bundle --platform=node --outfile=dist-electron/agents/echo-agent.js --format=esm"
  }
}
```

**Option C: electron-vite utility process pattern**
Import with `?modulePath` suffix in main process code. This lets electron-vite handle the bundling automatically. Prefer this if it works, but it may complicate things since we want stdio transport, not Electron's `utilityProcess` message channel.

For M0, Option A (tsx during dev) is simplest. We can optimize the build later.

### 2.3 Manual smoke test

Test the agent in isolation by piping JSON-RPC messages to it:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test"},"clientCapabilities":{}}}' | npx tsx electron/agents/echo-agent.ts
```

If the agent doesn't handle single-shot stdin well (it likely expects a long-lived stream), write a small test script instead:

```typescript
// scripts/test-echo-agent.ts
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import { Writable, Readable } from "node:stream";

const agent = spawn("npx", ["tsx", "electron/agents/echo-agent.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const stream = acp.ndJsonStream(
  Writable.toWeb(agent.stdin),
  Readable.toWeb(agent.stdout)
);

const connection = new acp.ClientSideConnection(
  (agentInterface) => ({
    async sessionUpdate(params) {
      console.log("Stream update:", JSON.stringify(params.update));
    },
    // Stub other Client methods...
    async readTextFile(params) { throw new Error("Not implemented"); },
    async writeTextFile(params) { throw new Error("Not implemented"); },
    async requestPermission(params) { throw new Error("Not implemented"); },
    async createTerminal(params) { throw new Error("Not implemented"); },
    async terminalOutput(params) { throw new Error("Not implemented"); },
    async killTerminal(params) { throw new Error("Not implemented"); },
    async waitForTerminalExit(params) { throw new Error("Not implemented"); },
    async releaseTerminal(params) { throw new Error("Not implemented"); },
  }),
  stream
);

// Drive the protocol
const initResp = await connection.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientInfo: { name: "test-harness", version: "0.1.0" },
  clientCapabilities: {},
});
console.log("Initialized:", initResp);

const sessionResp = await connection.newSession({
  cwd: process.cwd(),
  mcpServers: [],
});
console.log("Session:", sessionResp.sessionId);

const promptResp = await connection.prompt({
  sessionId: sessionResp.sessionId,
  prompt: [{ type: "text", text: "Hello world" }],
});
console.log("Prompt done:", promptResp);

agent.kill();
```

Run with:
```bash
npx tsx scripts/test-echo-agent.ts
```

**Done when:** The test script prints streamed `agent_message_chunk` updates containing "Echo: Hello world", followed by a prompt response with `stopReason: "end_turn"`.

> **Note on API discovery:** This step is where we'll learn the most about the real ACP SDK API. The test script above is a best guess. If the `Client` interface requires different methods, if `sessionUpdate` has a different shape, or if there are required handshake steps we're missing, this is where we'll find out. Document any deviations from the design doc's pseudocode for reference in later milestones.

---

## Step 3: Session Manager

### 3.1 Define shared types

Create `electron/main/types.ts` with the types shared between main process and renderer:

```typescript
export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  streaming?: boolean; // true while agent is still sending chunks
}

export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
}

export type SessionUpdate =
  | { sessionId: string; type: "status-change"; status: SessionSummary["status"] }
  | { sessionId: string; type: "message"; message: Message }
  | { sessionId: string; type: "stream-chunk"; messageId: string; text: string }
  | { sessionId: string; type: "stream-end"; messageId: string };
```

### 3.2 Implement SessionManager

Create `electron/main/session-manager.ts`:

```typescript
import { spawn, ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

interface SessionState {
  id: string;
  acpSessionId: string;  // the session ID returned by the agent
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: "initializing" | "ready" | "error" | "closed";
}
```

Key responsibilities:

**`createSession(): Promise<SessionSummary>`**
1. Generate a local session ID (`crypto.randomUUID()`)
2. Spawn the echo agent: `spawn("npx", ["tsx", "electron/agents/echo-agent.ts"], { stdio: ["pipe", "pipe", "inherit"] })`
   - In production builds, spawn `node dist-electron/agents/echo-agent.js` instead
3. Create `ndJsonStream` over the child's stdio
4. Create `ClientSideConnection`, providing a `Client` implementation that:
   - `sessionUpdate(params)`: emits IPC events to the renderer (stream chunks, messages)
   - Other methods: stub with `throw new Error("Not implemented")` for M0
5. Send `InitializeRequest`
6. Send `NewSessionRequest` with `cwd: process.cwd()`
7. Store the `SessionState`, mark as `ready`
8. Listen for `exit`/`error` on the child process → mark session as `error`

**`sendMessage(sessionId: string, text: string): Promise<void>`**
1. Look up session, verify status is `ready`
2. Create a user `Message`, push to `messages[]`, emit IPC event
3. Create an agent `Message` (empty, `streaming: true`), push to `messages[]`, emit IPC event
4. Call `connection.prompt({ sessionId: acpSessionId, prompt: [{ type: "text", text }] })`
   - The `Client.sessionUpdate` callback handles streaming chunks — each chunk appends to the agent message text and emits an IPC `stream-chunk` event
5. When `prompt()` resolves, mark the agent message as `streaming: false`, emit `stream-end`

**`listSessions(): SessionSummary[]`**
- Return summaries from the in-memory map

**`closeSession(sessionId: string): void`**
- Kill the child process, mark session as `closed`

### 3.3 Wire IPC events

The `SessionManager` needs a way to push events to the renderer. It receives a callback (or `BrowserWindow.webContents.send`) during construction:

```typescript
class SessionManager {
  constructor(private emit: (channel: string, data: SessionUpdate) => void) {}
}
```

In `electron/main/index.ts`, pass `mainWindow.webContents.send` as the emitter.

**Done when:** SessionManager compiles and the create-session + send-message flow works end-to-end in a unit test or manual console test from the main process (before adding UI).

---

## Step 4: IPC Bridge

### 4.1 Preload script

Update `electron/preload/index.ts`:

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bouncer", {
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
    create: () => ipcRenderer.invoke("sessions:create"),
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke("sessions:sendMessage", sessionId, text),
    closeSession: (sessionId: string) =>
      ipcRenderer.invoke("sessions:close", sessionId),
    onUpdate: (callback: (update: any) => void) => {
      const handler = (_event: any, update: any) => callback(update);
      ipcRenderer.on("session-update", handler);
      return () => ipcRenderer.removeListener("session-update", handler);
    },
  },
});
```

### 4.2 Type declaration for renderer

Create `src/env.d.ts` (or augment existing):

```typescript
interface BouncerAPI {
  sessions: {
    list(): Promise<import("../electron/main/types").SessionSummary[]>;
    create(): Promise<import("../electron/main/types").SessionSummary>;
    sendMessage(sessionId: string, text: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    onUpdate(callback: (update: import("../electron/main/types").SessionUpdate) => void): () => void;
  };
}

interface Window {
  bouncer: BouncerAPI;
}
```

### 4.3 Main process handlers

In `electron/main/index.ts`, after creating the window and `SessionManager`:

```typescript
import { ipcMain } from "electron";

const sessionManager = new SessionManager((channel, data) => {
  mainWindow.webContents.send(channel, data);
});

ipcMain.handle("sessions:list", () => sessionManager.listSessions());
ipcMain.handle("sessions:create", () => sessionManager.createSession());
ipcMain.handle("sessions:sendMessage", (_e, sessionId, text) =>
  sessionManager.sendMessage(sessionId, text)
);
ipcMain.handle("sessions:close", (_e, sessionId) =>
  sessionManager.closeSession(sessionId)
);
```

**Done when:** You can call `window.bouncer.sessions.create()` from the renderer dev console and see a session created (check main process logs).

---

## Step 5: React UI

### 5.1 App layout

Replace the scaffolded `src/App.tsx` with a two-panel layout:

```
┌──────────────┬─────────────────────────────────┐
│              │                                  │
│  Session     │  Chat Panel                      │
│  List        │                                  │
│              │  ┌────────────────────────────┐  │
│  [+ New]     │  │ message bubbles...         │  │
│              │  │                            │  │
│  session-1   │  │                            │  │
│  session-2   │  │                            │  │
│              │  └────────────────────────────┘  │
│              │  ┌────────────────────────────┐  │
│              │  │ Type a message...    [Send] │  │
│              │  └────────────────────────────┘  │
└──────────────┴─────────────────────────────────┘
```

State in `<App />`:
- `sessions: SessionSummary[]`
- `activeSessionId: string | null`
- `messagesBySession: Map<string, Message[]>`
- `streamingText: Map<string, string>` — in-progress agent message text, keyed by message ID

On mount:
- Call `bouncer.sessions.list()` to populate initial state
- Subscribe to `bouncer.sessions.onUpdate()` to handle live updates

### 5.2 SessionList component

```typescript
// src/components/SessionList.tsx
interface Props {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}
```

- Renders session entries with status indicator (colored dot: green=ready, yellow=initializing, red=error, gray=closed)
- "New Session" button calls `onCreate`
- Click on a session calls `onSelect`

### 5.3 ChatPanel component

```typescript
// src/components/ChatPanel.tsx
interface Props {
  messages: Message[];
  streamingText: Map<string, string>;
  onSendMessage: (text: string) => void;
  disabled: boolean; // true when no session selected or session not ready
}
```

- Renders messages as bubbles (user right-aligned with blue background, agent left-aligned with gray background)
- For messages with `streaming: true`, renders the accumulated text from `streamingText` map with a blinking cursor indicator
- Auto-scrolls to bottom on new messages
- Contains `<MessageInput />` at the bottom

### 5.4 MessageInput component

```typescript
// src/components/MessageInput.tsx
interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}
```

- Text input + Send button
- Submits on Enter key or button click
- Clears input after send
- Disabled while agent is responding (any message in active session has `streaming: true`)

### 5.5 Wiring it all together

The `<App />` `onUpdate` handler processes `SessionUpdate` events:

```typescript
function handleUpdate(update: SessionUpdate) {
  switch (update.type) {
    case "status-change":
      // Update session status in sessions[]
      break;
    case "message":
      // Append to messagesBySession
      break;
    case "stream-chunk":
      // Append text to streamingText[messageId]
      // This triggers re-render of the streaming message
      break;
    case "stream-end":
      // Finalize the message text, remove from streamingText
      // Mark the Message as streaming: false
      break;
  }
}
```

### 5.6 Minimal CSS

Plain CSS in `src/index.css`. No CSS framework. Key styles:

- Flexbox two-column layout (session list ~200px, chat panel fills rest)
- Message bubbles with padding, border-radius, max-width ~70%
- User messages: blue background, white text, right-aligned
- Agent messages: light gray background, dark text, left-aligned
- Monospace font for message text (agent output often contains code)
- Input bar pinned to bottom of chat panel

**Done when:** Full flow works — launch app, click "New Session", type a message, see "Echo: ..." stream in character by character.

---

## Step 6: Edge Cases & Polish

### 6.1 Agent crash handling

When the child process exits unexpectedly:
- `SessionManager` listens for `exit` event on the child process
- Marks session status as `error`
- Emits a `status-change` update to the renderer
- UI shows error indicator on the session and disables the input

### 6.2 Session switching

When user clicks a different session in the list:
- UI swaps `activeSessionId`
- `ChatPanel` renders the messages for the new active session
- No IPC call needed — all message history is already in renderer state
- In-progress streaming for the previous session continues in the background (the updates still arrive and get stored, they're just not visible until the user switches back)

### 6.3 Close session

Add a close button (X) on each session in the list:
- Calls `bouncer.sessions.closeSession(id)`
- `SessionManager` kills the agent process, marks session as `closed`
- UI shows closed indicator, disables input for that session

### 6.4 Input disabled during turns

While an agent response is streaming:
- Disable the text input and Send button
- Show a subtle "Agent is responding..." indicator
- Re-enable when `stream-end` arrives

### 6.5 Empty states

- No sessions yet: show "Create a new session to get started" in the chat panel area
- Session selected but no messages: show "Send a message to begin"
- Session in error state: show "Session disconnected" with option to close

**Done when:** All edge cases handled. App doesn't crash when agent dies. Multiple sessions work independently. User can't send while agent is streaming.

---

## Verification Checklist

Run through this manually before considering M0 complete:

- [ ] `npm run dev` launches the Electron app
- [ ] Click "New Session" → session appears in list with green status
- [ ] Type "Hello world" → agent responds with "Echo: Hello world" streamed progressively
- [ ] Send another message in the same session → response appears below the first
- [ ] Create a second session → it has independent message history
- [ ] Switch between sessions → each shows its own messages
- [ ] Kill the agent process externally (`kill <pid>`) → session shows error state
- [ ] Close a session via UI → session marked as closed, agent process terminated
- [ ] `npm run build` produces a working production build

---

## Sequencing Summary

| Step | Description | Depends On | Key Risk |
|------|-------------|------------|----------|
| 1 | Project scaffolding | — | electron-vite conflicts with existing files |
| 2 | Echo agent | Step 1 (for deps) | ACP SDK API surface unknowns |
| 3 | Session manager | Step 2 | Stdio transport in Electron main process |
| 4 | IPC bridge | Step 3 | contextBridge typing ceremony |
| 5 | React UI | Step 4 | Streaming state management |
| 6 | Edge cases | Step 5 | Agent lifecycle edge cases |

The **highest-risk step is 2** (echo agent) because it's our first real contact with the ACP SDK. Everything after that builds incrementally on known foundations. If Step 2 reveals that the SDK works differently than documented, update the design doc before proceeding.
