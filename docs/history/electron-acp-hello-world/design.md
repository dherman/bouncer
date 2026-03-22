# Milestone 0: Electron + ACP Hello World — Design

## Goal

Validate the Electron + ACP plumbing end-to-end: a user types a message in the UI, it travels over ACP to a child process, and a response streams back into the chat panel. No Claude Code, no sandboxing, no worktrees — just the skeleton that everything else builds on.

## Success Criteria

- Electron app launches and shows a two-panel UI (session list + chat)
- User can create a session and send a message
- Message is delivered to a trivial echo agent via ACP over stdio
- Agent's response streams back and renders in the chat panel
- Multiple sessions can coexist (switching between them shows separate histories)

## Non-Goals

- Claude Code integration (Milestone 1)
- Seatbelt sandboxing (Milestone 2)
- Policy templates or enforcement (Milestone 3+)
- Persistence across app restarts (nice-to-have, not required)
- Production-quality UI (functional is enough)

---

## Architecture

```
┌────────────────────────────────────────────────────┐
│                 Electron Main Process              │
│                                                    │
│  SessionManager                                    │
│  ├── sessions: Map<sessionId, SessionState>        │
│  ├── spawnAgent(): ChildProcess                    │
│  └── ClientSideConnection (per session)            │
│        ├── InitializeRequest →                     │
│        ├── NewSessionRequest →                     │
│        ├── PromptRequest →                         │
│        └── ← SessionNotification (streaming)       │
│                      │                             │
│                      │ stdio (JSON-RPC / newline-  │
│                      │        delimited)           │
│                      ▼                             │
│  ┌─────────────────────────────────────────────┐   │
│  │         Echo Agent (child process)          │   │
│  │                                             │   │
│  │  AgentSideConnection                        │   │
│  │  ├── handles InitializeRequest              │   │
│  │  ├── handles NewSessionRequest              │   │
│  │  └── handles PromptRequest:                 │   │
│  │        streams back SessionNotification     │   │
│  │        with echoed text content             │   │
│  └─────────────────────────────────────────────┘   │
│                                                    │
│  IPC (contextBridge)                               │
│  ├── sessions:list                                 │
│  ├── sessions:create                               │
│  ├── sessions:sendMessage(sessionId, text)         │
│  └── sessions:onUpdate(callback)                   │
│                                                    │
└──────────────────────┬─────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────┐
│               Electron Renderer Process            │
│                                                    │
│  React App                                         │
│  ├── <SessionList />                               │
│  │     click → sessions:create / select            │
│  ├── <ChatPanel />                                 │
│  │     renders message history                     │
│  │     streams incoming SessionNotifications       │
│  └── <MessageInput />                              │
│        submit → sessions:sendMessage               │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Key Design Decisions

**One agent process per session.** Each session spawns its own echo agent child process. This mirrors the Milestone 1+ architecture where each session spawns a sandboxed Claude Code process. The `SessionManager` owns the lifecycle of these processes.

**ACP over stdio.** The main process communicates with each agent via stdin/stdout using newline-delimited JSON-RPC, exactly as the ACP spec prescribes. The agent writes logs to stderr (forwarded to Electron's console for debugging).

**IPC via contextBridge.** The renderer process cannot access Node APIs directly (Electron security best practice: `nodeIntegration: false`, `contextIsolation: true`). All communication between renderer and main goes through a typed `contextBridge` API exposed in a preload script.

**Session state lives in main process memory.** No database or file persistence for M0. The `SessionManager` holds an in-memory map of sessions, each containing the message history and a reference to the agent process. This is throwaway scaffolding — persistence can be added later if needed.

---

## Components

### 1. Echo Agent (`src/agents/echo-agent.ts`)

A standalone Node.js script that speaks ACP on the agent side. This is our test double for Claude Code in later milestones.

**Responsibilities:**
- Create an `AgentSideConnection` from `@agentclientprotocol/sdk`
- Handle `InitializeRequest`: return capabilities (name, version, supported features)
- Handle `NewSessionRequest`: create a session, return session ID
- Handle `PromptRequest`: extract the user's message text, stream it back as a `SessionNotification` containing `TextContent`, then send `PromptResponse` with `StopReason.EndTurn`

**Behavior:**
- Echoes the user's message prefixed with `Echo: `
- Streams the response in small chunks (simulating token-by-token streaming) with short delays between chunks, so we can validate the streaming UI
- Logs lifecycle events to stderr

```typescript
// Pseudocode for the echo agent
import { AgentSideConnection, StopReason } from "@agentclientprotocol/sdk";

const connection = new AgentSideConnection(process.stdin, process.stdout);

connection.onInitialize(async (params) => {
  return {
    name: "glitterball-echo-agent",
    version: "0.1.0",
    // ... capabilities
  };
});

connection.onNewSession(async (params) => {
  return { sessionId: crypto.randomUUID() };
});

connection.onPrompt(async (params, { sendUpdate, signal }) => {
  const userText = extractTextFromPrompt(params);
  const reply = `Echo: ${userText}`;

  // Stream in chunks to exercise the streaming path
  for (const chunk of chunkString(reply, 10)) {
    sendUpdate({ type: "text", text: chunk });
    await delay(50);
  }

  return { stopReason: StopReason.EndTurn };
});

connection.listen();
```

> **Note:** The exact API surface of `AgentSideConnection` may differ from the pseudocode above. The first implementation task should be to read the actual SDK source/docs and adjust. The ACP TypeScript SDK is at `@agentclientprotocol/sdk`.

### 2. Session Manager (`src/main/session-manager.ts`)

Runs in the Electron main process. Manages session lifecycle and ACP connections.

**State per session:**
```typescript
interface SessionState {
  id: string;
  agentProcess: ChildProcess;
  connection: ClientSideConnection;
  messages: Message[];       // in-memory history for the UI
  status: "initializing" | "ready" | "error" | "closed";
}
```

**Lifecycle:**
1. **Create session**: Spawn echo agent as child process → create `ClientSideConnection` over its stdio → send `InitializeRequest` → send `NewSessionRequest` → mark session `ready`
2. **Send message**: Send `PromptRequest` with user text → listen for `SessionNotification` updates → accumulate into message history → forward to renderer via IPC
3. **Close session**: Send cancel if a turn is in progress → kill child process → clean up state

**Error handling:**
- If the agent process exits unexpectedly, mark the session as `error` and surface it in the UI
- If `InitializeRequest` fails or times out (~5s), mark session as `error`

### 3. Preload / IPC Bridge (`src/main/preload.ts`)

Exposes a typed API to the renderer via `contextBridge.exposeInMainWorld`:

```typescript
// Exposed as window.glitterball
interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(): Promise<SessionSummary>;
    sendMessage(sessionId: string, text: string): Promise<void>;
    onUpdate(callback: (update: SessionUpdate) => void): () => void; // returns unsubscribe
  };
}

interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
}

interface SessionUpdate {
  sessionId: string;
  type: "message" | "status-change" | "stream-chunk";
  // ... payload varies by type
}
```

The main process registers `ipcMain.handle` handlers that delegate to the `SessionManager`. The renderer calls them through the preload bridge.

### 4. React UI (`src/renderer/`)

Minimal two-panel layout. No routing library, no state management library — just React state and the IPC bridge.

**Components:**

**`<App />`** — Top-level layout. Holds `activeSessionId` state. Subscribes to `glitterball.sessions.onUpdate` for live updates.

**`<SessionList />`** — Left panel. Shows sessions with status indicators. "New Session" button at top. Click to select.

**`<ChatPanel />`** — Right panel. Shows messages for the active session. Each message rendered as a simple bubble (user right-aligned, agent left-aligned). As `stream-chunk` updates arrive, appends text to the in-progress agent message. When the turn completes (`message` update), finalizes the message.

**`<MessageInput />`** — Text input + submit button at bottom of chat panel. Disabled while a turn is in progress (waiting for agent response). Calls `glitterball.sessions.sendMessage`.

**Styling:** Minimal CSS. Plain layout that works — no component library. We'll likely adopt one in later milestones if the UI grows.

---

## Tech Stack & Project Setup

### Dependencies

| Package | Purpose |
|---------|---------|
| `electron` | App shell |
| `@agentclientprotocol/sdk` | ACP client + agent connections |
| `react`, `react-dom` | UI |
| `typescript` | Type safety throughout |
| `electron-forge` or `electron-vite` | Build tooling (bundling, dev server, HMR for renderer) |

**Build tooling choice:** `electron-vite` is the lighter option — it uses Vite for the renderer (fast HMR) and esbuild/Vite for main/preload. `electron-forge` is more opinionated and heavier. Recommend **`electron-vite`** for this spike given the preference for fast iteration.

### Project Structure

```
bouncer/
├── package.json
├── tsconfig.json
├── electron.vite.config.ts
├── src/
│   ├── agents/
│   │   └── echo-agent.ts          # Standalone ACP echo agent
│   ├── main/
│   │   ├── index.ts               # Electron main entry (creates window)
│   │   ├── session-manager.ts     # Session lifecycle + ACP client
│   │   └── preload.ts             # contextBridge IPC
│   └── renderer/
│       ├── index.html
│       ├── index.tsx               # React entry
│       ├── App.tsx                 # Top-level layout
│       ├── components/
│       │   ├── SessionList.tsx
│       │   ├── ChatPanel.tsx
│       │   └── MessageInput.tsx
│       └── styles/
│           └── main.css
├── data/                           # (existing) research dataset
├── scripts/                        # (existing) extraction scripts
└── docs/                           # (existing) documentation
```

### TypeScript Configuration

Three tsconfig files (standard electron-vite pattern):
- `tsconfig.json` — base config with shared compiler options
- `tsconfig.main.json` — extends base, targets Node (main + preload + agents)
- `tsconfig.renderer.json` — extends base, targets DOM (React)

---

## ACP Protocol Flow

The exact sequence of ACP messages for a single user turn:

```
Main Process (Client)                    Echo Agent (Agent)
       │                                        │
       │──── InitializeRequest ────────────────►│
       │◄─── InitializeResponse ────────────────│
       │                                        │
       │──── NewSessionRequest ────────────────►│
       │◄─── NewSessionResponse ────────────────│
       │                                        │
       │  [user types "Hello world"]            │
       │                                        │
       │──── PromptRequest ────────────────────►│
       │     { messages: [                      │
       │       { role: "user",                  │
       │         parts: [{ text: "Hello" }] }   │
       │     ]}                                 │
       │                                        │
       │◄─── SessionNotification ───────────────│
       │     { text: "Echo" }                   │
       │◄─── SessionNotification ───────────────│
       │     { text: ": Hello" }                │
       │◄─── SessionNotification ───────────────│
       │     { text: " world" }                 │
       │                                        │
       │◄─── PromptResponse ────────────────────│
       │     { stopReason: "end_turn" }         │
       │                                        │
```

> **Discovery task:** The exact shapes of `PromptRequest`, `SessionNotification`, and content types need to be confirmed against the actual `@agentclientprotocol/sdk` TypeScript types. The pseudocode above is based on the [ACP reference](../../reference/acp-reference.md) but the SDK may use slightly different field names or wrappers.

---

## Implementation Plan

### Phase 1: Project Scaffolding

1. Initialize the project with `electron-vite` (or equivalent)
2. Set up TypeScript configs for main, renderer, and agents
3. Install dependencies: `electron`, `@agentclientprotocol/sdk`, `react`, `react-dom`
4. Verify the blank Electron app launches with a React "Hello World" renderer

### Phase 2: Echo Agent

5. Implement `src/agents/echo-agent.ts` as a standalone Node script
6. Manually test it: pipe JSON-RPC messages to its stdin, verify responses on stdout
7. Confirm it handles: `InitializeRequest`, `NewSessionRequest`, `PromptRequest` with streaming `SessionNotification` replies

### Phase 3: Session Manager + ACP Wiring

8. Implement `SessionManager` in the main process
9. Wire up agent spawning: `child_process.spawn("node", ["dist/agents/echo-agent.js"])` (or via tsx/ts-node during dev)
10. Wire up `ClientSideConnection` over the child's stdio
11. Implement the create-session lifecycle: spawn → initialize → new session
12. Implement the send-message lifecycle: prompt → stream notifications → finalize
13. Test from the main process (console.log the streaming responses) before wiring to UI

### Phase 4: IPC Bridge + UI

14. Implement the preload script with `contextBridge` API
15. Wire up `ipcMain.handle` handlers that call into `SessionManager`
16. Build the React UI components: `SessionList`, `ChatPanel`, `MessageInput`
17. Connect UI to IPC bridge
18. Test the full flow: launch app → create session → type message → see streamed echo response

### Phase 5: Polish & Edge Cases

19. Handle agent process crashes gracefully (show error state in UI)
20. Handle session switching (preserve message history per session)
21. Add a "close session" action (kills agent process)
22. Basic visual polish: message alignment, status indicators, input disabled during turns

---

## Risks & Open Questions

### ACP SDK API Surface

The pseudocode in this design is based on the ACP reference doc and protocol spec, not on hands-on experience with `@agentclientprotocol/sdk`. The actual TypeScript API may differ in naming, structure, or required ceremony (e.g., transport setup, capability negotiation details).

**Mitigation:** Phase 2 starts with the echo agent specifically to discover the real API surface early. If the SDK is hard to use or underdocumented, we may need to read its source.

### Streaming Granularity

The ACP spec says `SessionNotification` carries content updates, but it's not clear whether the SDK exposes a clean callback-per-notification or batches them. The UI needs to render incrementally.

**Mitigation:** The echo agent deliberately streams in small chunks with delays, so we can observe whether the client receives them one at a time or batched.

### Agent Process Lifecycle

If the echo agent process crashes or hangs, the `ClientSideConnection` needs to handle that gracefully. Unclear how the SDK surfaces transport errors (e.g., does it emit an event? throw from pending requests?).

**Mitigation:** Wrap agent interaction in try/catch, listen for `exit`/`error` events on the child process, implement a session error state.

### electron-vite vs electron-forge

Haven't used either with this specific stack. `electron-vite` is simpler but may have quirks with the agents directory (it's not main, not preload, not renderer — it's a standalone script that needs to be built and output as a runnable JS file).

**Mitigation:** The echo agent can be built as a simple esbuild target or even run via `tsx` during development. Doesn't need to be part of the Vite pipeline.

---

## What This Unblocks

Completing Milestone 0 gives us:

- **A working ACP client** in the Electron main process that Milestone 1 reuses to connect to Claude Code (swap echo agent for `@zed-industries/claude-agent-acp`)
- **A session management model** that Milestone 1 extends with worktrees and Milestone 2 extends with sandbox-exec
- **A chat UI** that Milestone 1 enhances with tool call rendering, plan display, and terminal output
- **An echo agent** that Milestone 4 evolves into a deterministic replay agent for testing sandbox policies
- **Confidence** that ACP stdio transport works reliably in an Electron context before we add real-agent complexity
