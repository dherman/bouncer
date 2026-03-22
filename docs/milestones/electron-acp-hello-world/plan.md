# Milestone 0: Electron + ACP Hello World — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition. The plan is informed by the actual API surfaces of `@agentclientprotocol/sdk` (v0.16.x) and `electron-vite`.

## Progress

- [ ] **[Phase 1: Project Scaffolding](#phase-1-project-scaffolding)**
  - [ ] 1.1 Initialize electron-vite project
  - [ ] 1.2 Install ACP SDK
  - [ ] 1.3 Verify baseline (app launches, build succeeds)
- [ ] **[Phase 2: Echo Agent](#phase-2-echo-agent)**
  - [ ] 2.1 Create `electron/agents/echo-agent.ts`
  - [ ] 2.2 Set up agent build/run mechanism
  - [ ] 2.3 Write `scripts/test-echo-agent.ts` test harness
  - [ ] 2.4 Smoke test: streamed echo response works end-to-end over ACP stdio
  - [ ] 2.5 Document any SDK API deviations from design doc pseudocode
- [ ] **[Phase 3: Session Manager](#phase-3-session-manager)**
  - [ ] 3.1 Define shared types (`electron/main/types.ts`)
  - [ ] 3.2 Implement `SessionManager.createSession()` (spawn agent, ACP handshake)
  - [ ] 3.3 Implement `SessionManager.sendMessage()` (prompt + streaming)
  - [ ] 3.4 Implement `SessionManager.listSessions()` and `closeSession()`
  - [ ] 3.5 Wire IPC event emitter into SessionManager
  - [ ] 3.6 Verify from main process (console.log) before adding UI
- [ ] **[Phase 4: IPC Bridge](#phase-4-ipc-bridge)**
  - [ ] 4.1 Implement preload script with `contextBridge` API
  - [ ] 4.2 Add type declarations for renderer (`src/env.d.ts`)
  - [ ] 4.3 Register `ipcMain.handle` handlers in main process
  - [ ] 4.4 Verify: `window.bouncer.sessions.create()` works from renderer dev console
- [ ] **[Phase 5: React UI](#phase-5-react-ui)**
  - [ ] 5.1 App layout: two-panel flexbox (session list + chat)
  - [ ] 5.2 `<SessionList />` component with status indicators
  - [ ] 5.3 `<ChatPanel />` component with streaming message rendering
  - [ ] 5.4 `<MessageInput />` component (Enter to send, disabled during turns)
  - [ ] 5.5 Wire `onUpdate` handler for SessionUpdate events
  - [ ] 5.6 Minimal CSS styling
  - [ ] 5.7 Full flow test: launch → create session → send message → see streamed echo
- [ ] **[Phase 6: Edge Cases & Polish](#phase-6-edge-cases--polish)**
  - [ ] 6.1 Agent crash handling (error state in UI)
  - [ ] 6.2 Session switching (independent message histories)
  - [ ] 6.3 Close session action (kill agent, update UI)
  - [ ] 6.4 Input disabled during agent turns
  - [ ] 6.5 Empty states (no sessions, no messages, error state)
- [ ] **[Verification](#verification-checklist)** — all manual checks pass

---

## Phase 1: Project Scaffolding

### 1.1 Initialize electron-vite project

- [ ] Run scaffolder or manually set up electron-vite

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

- [ ] Install `@agentclientprotocol/sdk` and peer dependencies

```bash
npm install @agentclientprotocol/sdk
```

The SDK has a peer dependency on `zod` (^3.25.0 || ^4.0.0). Install it if not pulled in automatically:

```bash
npm install zod
```

### 1.3 Verify baseline

- [ ] `npm run dev` launches Electron with React content
- [ ] `npm run build` succeeds cleanly

```bash
npm run dev
```

Confirm the Electron app launches and shows the default React template page. This validates the toolchain before we change anything.

---

## Phase 2: Echo Agent

Build the echo agent as a standalone Node script before touching any Electron code. This is the fastest way to discover the real ACP SDK API surface and work through any surprises.

### 2.1 Create agent source file

- [ ] Create `electron/agents/echo-agent.ts`

This script will be run as a child process — it reads JSON-RPC from stdin and writes to stdout.

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

- [ ] Choose and set up a build/run mechanism for the agent

Options:

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

### 2.3 Write test harness

- [ ] Create `scripts/test-echo-agent.ts`

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

### 2.4 Smoke test

- [ ] Test script prints streamed `agent_message_chunk` updates containing "Echo: Hello world"
- [ ] Prompt response returns with `stopReason: "end_turn"`

### 2.5 Document SDK deviations

- [ ] Note any differences between design doc pseudocode and actual SDK API

> **Note on API discovery:** This phase is where we'll learn the most about the real ACP SDK API. The test script above is a best guess. If the `Client` interface requires different methods, if `sessionUpdate` has a different shape, or if there are required handshake steps we're missing, this is where we'll find out. Document any deviations from the design doc's pseudocode for reference in later milestones.

---

## Phase 3: Session Manager

### 3.1 Define shared types

- [ ] Create `electron/main/types.ts`

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

### 3.2 Implement `SessionManager.createSession()`

- [ ] Create `electron/main/session-manager.ts`
- [ ] Spawn echo agent as child process
- [ ] Create `ndJsonStream` + `ClientSideConnection` over child's stdio
- [ ] Send `InitializeRequest` then `NewSessionRequest`
- [ ] Store `SessionState`, mark as `ready`
- [ ] Listen for `exit`/`error` on child process → mark session `error`

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

**`createSession()` flow:**
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

### 3.3 Implement `SessionManager.sendMessage()`

- [ ] Look up session, verify status is `ready`
- [ ] Create user `Message` + placeholder agent `Message` (streaming), emit IPC events
- [ ] Call `connection.prompt()`, handle streaming chunks via `Client.sessionUpdate`
- [ ] On prompt completion, finalize agent message and emit `stream-end`

**`sendMessage()` flow:**
1. Look up session, verify status is `ready`
2. Create a user `Message`, push to `messages[]`, emit IPC event
3. Create an agent `Message` (empty, `streaming: true`), push to `messages[]`, emit IPC event
4. Call `connection.prompt({ sessionId: acpSessionId, prompt: [{ type: "text", text }] })`
   - The `Client.sessionUpdate` callback handles streaming chunks — each chunk appends to the agent message text and emits an IPC `stream-chunk` event
5. When `prompt()` resolves, mark the agent message as `streaming: false`, emit `stream-end`

### 3.4 Implement `listSessions()` and `closeSession()`

- [ ] `listSessions()`: return summaries from in-memory map
- [ ] `closeSession()`: kill child process, mark session as `closed`

### 3.5 Wire IPC event emitter

- [ ] SessionManager receives emitter callback in constructor
- [ ] In `electron/main/index.ts`, pass `mainWindow.webContents.send` as the emitter

```typescript
class SessionManager {
  constructor(private emit: (channel: string, data: SessionUpdate) => void) {}
}
```

### 3.6 Verify from main process

- [ ] Create-session + send-message flow works end-to-end via console.log (before adding UI)

---

## Phase 4: IPC Bridge

### 4.1 Preload script

- [ ] Update `electron/preload/index.ts` with `contextBridge.exposeInMainWorld`

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

### 4.2 Type declarations for renderer

- [ ] Create `src/env.d.ts` with `BouncerAPI` interface and `Window` augmentation

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

- [ ] Register `ipcMain.handle` handlers that delegate to `SessionManager`

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

### 4.4 Verify from renderer

- [ ] `window.bouncer.sessions.create()` works from renderer dev console

---

## Phase 5: React UI

### 5.1 App layout

- [ ] Replace scaffolded `src/App.tsx` with two-panel layout
- [ ] Set up state: `sessions`, `activeSessionId`, `messagesBySession`, `streamingText`
- [ ] Subscribe to `bouncer.sessions.onUpdate()` on mount

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

### 5.2 SessionList component

- [ ] Create `src/components/SessionList.tsx`
- [ ] Render session entries with status indicators (green=ready, yellow=initializing, red=error, gray=closed)
- [ ] "New Session" button
- [ ] Click to select

```typescript
interface Props {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}
```

### 5.3 ChatPanel component

- [ ] Create `src/components/ChatPanel.tsx`
- [ ] Render message bubbles (user right/blue, agent left/gray)
- [ ] Render in-progress streaming text with cursor indicator
- [ ] Auto-scroll to bottom on new messages

```typescript
interface Props {
  messages: Message[];
  streamingText: Map<string, string>;
  onSendMessage: (text: string) => void;
  disabled: boolean;
}
```

### 5.4 MessageInput component

- [ ] Create `src/components/MessageInput.tsx`
- [ ] Text input + Send button
- [ ] Submit on Enter key or button click
- [ ] Clear input after send
- [ ] Disabled while agent is responding

```typescript
interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}
```

### 5.5 Wire `onUpdate` handler

- [ ] Handle `status-change`, `message`, `stream-chunk`, `stream-end` events in `<App />`

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

- [ ] Flexbox two-column layout (session list ~200px, chat panel fills rest)
- [ ] Message bubble styling (padding, border-radius, max-width ~70%)
- [ ] User messages: blue background, white text, right-aligned
- [ ] Agent messages: light gray background, dark text, left-aligned
- [ ] Input bar pinned to bottom of chat panel

### 5.7 Full flow test

- [ ] Launch app → create session → send message → see "Echo: ..." stream in character by character

---

## Phase 6: Edge Cases & Polish

### 6.1 Agent crash handling

- [ ] `SessionManager` listens for `exit` event on child process
- [ ] Marks session status as `error`, emits `status-change`
- [ ] UI shows error indicator and disables input

### 6.2 Session switching

- [ ] Clicking a different session swaps `activeSessionId` and renders its messages
- [ ] In-progress streaming for background sessions continues and is stored

### 6.3 Close session

- [ ] Close button (X) on each session in the list
- [ ] Calls `bouncer.sessions.closeSession(id)` → kills agent, marks closed
- [ ] UI shows closed indicator, disables input

### 6.4 Input disabled during turns

- [ ] Disable text input and Send button while agent is streaming
- [ ] Show "Agent is responding..." indicator
- [ ] Re-enable when `stream-end` arrives

### 6.5 Empty states

- [ ] No sessions: "Create a new session to get started"
- [ ] Session selected but no messages: "Send a message to begin"
- [ ] Session in error state: "Session disconnected" with close option

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

| Phase | Description | Depends On | Key Risk |
|------|-------------|------------|----------|
| 1 | Project scaffolding | — | electron-vite conflicts with existing files |
| 2 | Echo agent | Phase 1 (for deps) | ACP SDK API surface unknowns |
| 3 | Session manager | Phase 2 | Stdio transport in Electron main process |
| 4 | IPC bridge | Phase 3 | contextBridge typing ceremony |
| 5 | React UI | Phase 4 | Streaming state management |
| 6 | Edge cases | Phase 5 | Agent lifecycle edge cases |

The **highest-risk phase is 2** (echo agent) because it's our first real contact with the ACP SDK. Everything after that builds incrementally on known foundations. If Phase 2 reveals that the SDK works differently than documented, update the design doc before proceeding.
