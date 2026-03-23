# Milestone 1: Live Agent Integration — Design

## Goal

Replace the echo agent with a real Claude Code instance, connected via `@zed-industries/claude-agent-acp`. By the end of this milestone, a user can open Glitter Ball, create a session, and have a real conversation with Claude Code — reading files, running terminal commands, editing code — all through the ACP-wired chat UI built in Milestone 0. No sandboxing yet; the goal is to confirm that the agent can do real work through the harness.

## Success Criteria

- Claude Code launches as a subprocess via `@zed-industries/claude-agent-acp` and completes the ACP handshake
- User can send a prompt and receive streamed responses (text, tool calls, plans) in the chat UI
- Agent can read/write files, run terminal commands, and use other tools through ACP
- Session manager creates an isolated git worktree per session and tears it down on close
- Multiple concurrent sessions work, each in its own worktree
- The echo agent remains available as a fallback for development and testing

## Non-Goals

- Seatbelt sandboxing (Milestone 2)
- Policy templates or enforcement (Milestone 3+)
- Rich tool-call rendering in the UI (nice-to-have stretch goal; functional display is enough)
- Persisting sessions across app restarts
- Custom MCP server configuration

---

## Architecture

Milestone 0 established the `SessionManager → ChildProcess → ACP` pipeline with an echo agent. Milestone 1 swaps in the real agent and adds worktree management, while keeping the same overall architecture.

```
┌──────────────────────────────────────────────────────────────┐
│                    Glitter Ball (Electron)                   │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                      React UI                          │  │
│  │  ┌───────────┐  ┌──────────────────────────────────┐   │  │
│  │  │ Session   │  │ Chat Interface                   │   │  │
│  │  │ List      │  │ • Streamed text (as in M0)       │   │  │
│  │  │           │  │ • Tool call status indicators    │   │  │
│  │  │ [+ New]   │  │ • Plan display (if present)      │   │  │
│  │  │           │  │                                  │   │  │
│  │  │ (project  │  │ ──────────────────────────────   │   │  │
│  │  │  picker)  │  │ [Type a message...        Send]  │   │  │
│  │  └───────────┘  └──────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                 │
│  ┌─────────────────────────▼──────────────────────────────┐  │
│  │         Session Manager (main process)                 │  │
│  │                                                        │  │
│  │  • Creates git worktree per session                    │  │
│  │  • Spawns agent (echo or Claude Code)                  │  │
│  │  • ACP ClientSideConnection per session                │  │
│  │  • Handles agent→client requests:                      │  │
│  │    - CreateTerminalRequest → spawns shell in worktree  │  │
│  │    - ReadTextFileRequest / WriteTextFileRequest        │  │
│  │    - RequestPermissionRequest → auto-approve (for now) │  │
│  │  • Tears down worktree on session close                │  │
│  └─────────────────────────┬──────────────────────────────┘  │
│                            │ stdio (ACP / JSON-RPC)          │
│  ┌─────────────────────────▼──────────────────────────────┐  │
│  │         Claude Code (via claude-agent-acp)             │  │
│  │                                                        │  │
│  │  AgentSideConnection (ACP)                             │  │
│  │  • Receives prompts, streams responses                 │  │
│  │  • Requests file read/write through ACP                │  │
│  │  • Requests terminal creation through ACP              │  │
│  │  • Requests permission for dangerous operations        │  │
│  │                                                        │  │
│  │  Working directory: git worktree for this session      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### What Changes from Milestone 0

| Component | M0 | M1 |
|-----------|----|----|
| Agent process | Echo agent (`src/agents/echo-agent.ts`) | Claude Code via `@zed-industries/claude-agent-acp` (echo agent kept as fallback) |
| Agent working directory | `process.cwd()` | Per-session git worktree |
| ACP Client methods | `sessionUpdate` only; `requestPermission` returns `cancelled` | `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`, `createTerminal`, `terminalOutput`, `killTerminal`, `waitForTerminalExit`, `releaseTerminal` |
| Session updates | Text chunks only | Text chunks, tool call events, plan events |
| UI rendering | Plain text messages | Text + tool call indicators + plan display |
| Session creation | Instant | User selects a project directory; worktree created from current branch |

---

## Key Design Decisions

### Agent spawning strategy

The `@zed-industries/claude-agent-acp` package is an npm package that wraps Claude Code as an ACP-compliant agent. It is spawned as a subprocess, just like the echo agent.

**Spawn command:**
```bash
npx @zed-industries/claude-agent-acp
```

The session manager will install it as a project dependency (`npm install @zed-industries/claude-agent-acp`) and resolve its binary path at runtime, similar to how it resolves the `tsx` binary for the echo agent. Using `npx` at spawn time is a fallback if local resolution fails.

**Agent selection:** The session manager gains an `agentType` parameter — `"echo"` or `"claude-code"` — so we can continue using the echo agent for development and testing. The default for new sessions switches to `"claude-code"`.

### Worktree-per-session model

Each session operates in its own git worktree, branched from the project's current HEAD. This provides:

1. **Isolation**: Sessions can't step on each other's uncommitted changes
2. **Sandbox preparation**: Milestone 2 will restrict the Seatbelt profile to the worktree path, so establishing this pattern now is essential
3. **Clean teardown**: `git worktree remove` on session close returns the repo to its prior state

**Lifecycle:**

```
Session Create:
  1. User selects project directory (or uses last-used)
  2. Validate: is it a git repository?
  3. git worktree add <worktree-path> -b bouncer/<session-id> HEAD
  4. Spawn agent with cwd = worktree path
  5. ACP NewSessionRequest with cwd = worktree path

Session Close:
  1. Kill agent process
  2. git worktree remove <worktree-path> --force
  3. git branch -D bouncer/<session-id> (if branch has no unique commits)
```

**Worktree location:** Worktrees are created under a temporary directory managed by the app:

```
{app.getPath('temp')}/glitterball-worktrees/<session-id>/
```

Using a temp directory avoids cluttering the user's project directory with worktree folders, and makes cleanup straightforward.

**Branch naming:** `bouncer/<session-id>` — a dedicated namespace prevents collisions with user branches. The UUID suffix ensures uniqueness.

### ACP Client method implementations

Milestone 0 stubbed out most ACP Client interface methods. Milestone 1 implements the ones Claude Code actually uses:

#### `createTerminal(params)`

Claude Code requests terminal creation to run shell commands (`Bash` tool). The session manager spawns a shell process in the worktree directory and tracks it by terminal ID.

```typescript
async createTerminal(params: CreateTerminalParams): Promise<CreateTerminalResult> {
  const shell = spawn(process.env.SHELL || "/bin/zsh", [], {
    cwd: worktreePath,
    env: { ...process.env, ...params.env },
  });
  terminals.set(terminalId, shell);
  return { terminalId };
}
```

When the agent sends commands via `TerminalOutputRequest`, it writes to the shell's stdin. Output is collected from stdout/stderr and returned. `KillTerminalRequest` sends SIGTERM. `WaitForTerminalExitRequest` waits for the process to exit. `ReleaseTerminalRequest` cleans up the tracking state.

#### `readTextFile(params)` / `writeTextFile(params)`

These pass through to the filesystem. In Milestone 1 they operate without restriction. In Milestone 2, the Seatbelt profile will enforce filesystem boundaries at the OS level, making these safe by construction.

```typescript
async readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult> {
  const content = await fs.readFile(params.uri, "utf-8");
  return { content };
}

async writeTextFile(params: WriteTextFileParams): Promise<void> {
  await fs.writeFile(params.uri, params.content, "utf-8");
}
```

#### `requestPermission(params)`

Claude Code asks for user permission before certain operations. For Milestone 1, we auto-approve all requests to remove friction and validate that the agent can do real work. This is the method that Milestone 2+ will hook into for policy enforcement.

```typescript
async requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
  // M1: auto-approve everything. M2+ will evaluate against sandbox policy.
  return { outcome: { outcome: "approved" } };
}
```

### Session update handling

Claude Code sends richer `SessionNotification` updates than the echo agent. Beyond `agent_message_chunk` (text), we need to handle:

| `sessionUpdate` variant | Content | How we handle it |
|------------------------|---------|-----------------|
| `agent_message_chunk` | `TextContent` | Append to streaming message (same as M0) |
| `agent_message_chunk` | `ToolCallContent` | Track tool call status; emit UI update |
| `plan_update` | Plan entries with status | Display plan progress in UI |
| `agent_message_start` | New message boundary | Create new agent message in history |
| `agent_message_end` | Message complete | Finalize message, mark streaming=false |

The session manager's `sessionUpdate` handler in the `Client` implementation needs to dispatch on both the `sessionUpdate` discriminator and the `content.type` within it.

### Project selection

Milestone 0 had no concept of a project — sessions just used `process.cwd()`. Milestone 1 introduces project selection:

1. **"New Session" prompts for a directory** via Electron's native `dialog.showOpenDialog({ properties: ['openDirectory'] })`
2. The selected directory is validated as a git repository
3. The directory path is stored on the session and passed through to worktree creation and `NewSessionRequest`
4. **Recent projects** are remembered in memory (not persisted for now) for quick re-selection

This is a minimal viable UX. Later milestones might add a dedicated project management panel.

### Environment and authentication

Claude Code requires an Anthropic API key (or OAuth session) to function. The session manager inherits the user's environment when spawning the agent process, so `ANTHROPIC_API_KEY` (or Claude Code's OAuth tokens in `~/.claude.json`) are available automatically.

No special authentication handling is needed in the harness — Claude Code manages its own auth. If auth fails, it will surface as an error in the ACP response, which the session manager will display in the UI.

---

## Components

### 1. Worktree Manager (`src/main/worktree-manager.ts`)

New module responsible for git worktree lifecycle. Extracted from the session manager to keep responsibilities clean.

```typescript
export interface WorktreeInfo {
  path: string;           // Absolute path to the worktree
  branch: string;         // Branch name (bouncer/<session-id>)
  projectDir: string;     // Original project directory
}

export class WorktreeManager {
  /** Create a worktree for a session. */
  async create(sessionId: string, projectDir: string): Promise<WorktreeInfo>;

  /** Remove a worktree and optionally delete its branch. */
  async remove(info: WorktreeInfo): Promise<void>;

  /** Validate that a directory is a git repository. */
  async validateGitRepo(dir: string): Promise<boolean>;
}
```

**Implementation details:**

- Uses `child_process.execFile` to run git commands (not a git library — keeps dependencies minimal and behavior identical to what Claude Code itself uses)
- `create()` runs `git worktree add <path> -b bouncer/<id> HEAD` in the project directory
- `remove()` runs `git worktree remove <path> --force`, then `git branch -D <branch>` if the branch has no commits beyond the base
- `validateGitRepo()` runs `git rev-parse --git-dir` and checks the exit code
- Error handling: if worktree creation fails (e.g., dirty working tree, git not found), the error propagates to session creation which marks the session as `error`

### 2. Session Manager (updated: `src/main/session-manager.ts`)

The existing session manager gains:

**New fields on `SessionState`:**
```typescript
interface SessionState {
  // ... existing fields from M0 ...
  agentType: "echo" | "claude-code";
  projectDir: string;
  worktree: WorktreeInfo | null;    // null for echo agent sessions
  terminals: Map<string, ChildProcess>;
}
```

**New/modified methods:**

- `createSession(projectDir: string, agentType?: AgentType)` — now takes a project directory and optional agent type
- `resolveAgentCommand()` becomes `resolveAgentCommand(agentType, worktreePath)` — returns the correct spawn config for echo or Claude Code
- The `Client` implementation passed to `ClientSideConnection` gains real implementations for terminal and file methods (see [ACP Client method implementations](#acp-client-method-implementations) above)

**Agent spawning for Claude Code:**

```typescript
function resolveClaudeCodeCommand(worktreePath: string): SpawnConfig {
  // Resolve the claude-agent-acp binary from node_modules
  const require = createRequire(app.getAppPath() + "/");
  const binPath = require.resolve("@zed-industries/claude-agent-acp/bin");
  return {
    cmd: process.execPath,
    args: [binPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    cwd: worktreePath,
  };
}
```

The agent process is spawned with `cwd` set to the worktree path, so Claude Code operates within the worktree by default. Additionally, `NewSessionRequest` passes `cwd: worktreePath` at the ACP level.

### 3. Terminal Manager (inline in session manager)

Rather than a separate module, terminal management is implemented as part of the `Client` interface within the session manager. Each session maintains a `terminals: Map<string, TerminalState>` tracking active terminals.

```typescript
interface TerminalState {
  id: string;
  process: ChildProcess;
  output: string;           // Accumulated stdout+stderr
  exitCode: number | null;
}
```

The terminal's `cwd` is set to the session's worktree path. stdout and stderr are merged and accumulated in `output`, which is returned when the agent calls `terminalOutput()`.

### 4. Types (updated: `src/main/types.ts`)

Extended to support richer session updates:

```typescript
export type AgentType = "echo" | "claude-code";

export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
  agentType: AgentType;
  projectDir: string;
}

export type SessionUpdate =
  | { sessionId: string; type: "status-change"; status: SessionSummary["status"] }
  | { sessionId: string; type: "message"; message: Message }
  | { sessionId: string; type: "stream-chunk"; messageId: string; text: string }
  | { sessionId: string; type: "stream-end"; messageId: string }
  | { sessionId: string; type: "tool-call"; messageId: string; toolCall: ToolCallInfo }
  | { sessionId: string; type: "plan-update"; plan: PlanInfo };

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  input?: Record<string, unknown>;
  output?: string;
}

export interface PlanInfo {
  entries: PlanEntry[];
}

export interface PlanEntry {
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}
```

### 5. IPC Bridge (updated: `src/preload/index.ts`)

Extended with project selection:

```typescript
contextBridge.exposeInMainWorld("glitterball", {
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
    create: (projectDir: string, agentType?: string) =>
      ipcRenderer.invoke("sessions:create", projectDir, agentType),
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
  dialog: {
    selectDirectory: () => ipcRenderer.invoke("dialog:selectDirectory"),
  },
});
```

The main process handler for `dialog:selectDirectory` uses Electron's dialog API:

```typescript
ipcMain.handle("dialog:selectDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select project directory",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

### 6. React UI (updated: `src/renderer/`)

UI changes are minimal — the primary goal is getting the agent working, not UI polish:

**Session creation flow:**
1. User clicks "New Session"
2. Directory picker dialog opens
3. On selection, session is created with `claude-code` agent type
4. Session appears in list with "initializing" status (worktree creation + ACP handshake may take a few seconds)

**Chat rendering additions:**
- **Tool call indicators**: When a `tool-call` update arrives, show a collapsed block: `🔧 Bash: git status [completed]`. Expand on click to show input/output. (Stretch goal — a simple one-line indicator is the minimum.)
- **Plan display**: If `plan-update` arrives, show a checklist of plan entries with status indicators above the chat. (Stretch goal.)
- **Text streaming**: Unchanged from M0.

**Session list enhancement:**
- Show project directory name (e.g., "bouncer") as the session label instead of a UUID
- Show agent type indicator (echo vs. Claude Code)

---

## Dependencies

### New npm packages

| Package | Purpose |
|---------|---------|
| `@zed-industries/claude-agent-acp` | Claude Code ACP adapter — spawned as the agent subprocess |

### Existing packages (no changes)

| Package | Purpose |
|---------|---------|
| `@agentclientprotocol/sdk` | ACP client connection, protocol types |
| `electron` | App shell |
| `react`, `react-dom` | UI |

### System requirements

- **git** on PATH — required for worktree management
- **Claude Code** installed — `@zed-industries/claude-agent-acp` wraps the Claude Code CLI
- **Anthropic API key or OAuth session** — Claude Code authenticates via `ANTHROPIC_API_KEY` env var or `~/.claude.json` OAuth tokens

---

## Implementation Plan

### Phase 1: Worktree Manager

1. Create `src/main/worktree-manager.ts` with `create()`, `remove()`, and `validateGitRepo()` methods
2. Write a test script (`scripts/test-worktree.ts`) that creates and removes a worktree
3. Verify: worktree appears in `git worktree list`, files are present, cleanup removes it

### Phase 2: Claude Code Agent Integration

4. Install `@zed-industries/claude-agent-acp`: `npm install @zed-industries/claude-agent-acp`
5. Discover the package's API: read its `package.json` `bin` field, entry point, and any required configuration
6. Add `resolveClaudeCodeCommand()` to session manager alongside existing `resolveAgentCommand()`
7. Write a standalone test script (`scripts/test-claude-agent.ts`) that spawns the Claude Code agent, completes the ACP handshake, and sends a simple prompt (e.g., "What directory am I in?")
8. Document any deviations from the ACP reference (similar to M0's `sdk-deviations.md`)

### Phase 3: Session Manager Updates

9. Add `agentType` and `projectDir` parameters to `createSession()`
10. Integrate `WorktreeManager`: create worktree before spawning agent, store on session state
11. Implement `createTerminal()` — spawn shell in worktree, track in session's terminal map
12. Implement `terminalOutput()`, `killTerminal()`, `waitForTerminalExit()`, `releaseTerminal()`
13. Implement `readTextFile()` and `writeTextFile()` — direct filesystem passthrough
14. Change `requestPermission()` from `cancelled` to `approved`
15. Update `closeSession()` to tear down worktree after killing agent
16. Update `sessionUpdate()` handler to dispatch on all `sessionUpdate` variants (tool calls, plans, etc.)

### Phase 4: IPC and UI Updates

17. Add `dialog:selectDirectory` IPC handler
18. Update `sessions:create` handler to pass `projectDir` and `agentType`
19. Update session creation flow in UI: directory picker → create session
20. Add tool call status display to chat panel (at minimum, a one-line indicator per tool call)
21. Update session list to show project name instead of UUID
22. Test full flow: select project → create session → chat with Claude Code → see tool calls execute

### Phase 5: Polish and Edge Cases

23. Handle agent startup failure gracefully (e.g., missing API key, Claude Code not installed)
24. Handle worktree creation failure (not a git repo, dirty state, git not found)
25. Ensure multiple concurrent sessions work (different worktrees, independent terminals)
26. Verify echo agent still works as a fallback
27. Test session close: agent killed, terminals killed, worktree removed, branch cleaned up

---

## Risks and Open Questions

### `@zed-industries/claude-agent-acp` API surface

We haven't used this package yet. Key unknowns:

- **How is it invoked?** Likely a binary entry point spawned via `node_modules/.bin/claude-agent-acp`, but the exact mechanism needs discovery.
- **What ACP Client methods does it call?** The ACP spec defines many optional methods. We need to discover which ones Claude Code actually uses and ensure we implement them. Failing to implement a required method will crash the agent or cause silent failures.
- **Does it require any configuration?** Environment variables, config files, flags?
- **What does its error behavior look like?** If auth fails, does it send an ACP error response, write to stderr, or exit?

**Mitigation:** Phase 2 is dedicated to discovery. The standalone test script will reveal the real API surface before we integrate into the session manager.

### Terminal management complexity

Claude Code's terminal model may be more complex than simple command execution:

- Does it expect a persistent shell session (like a real terminal) or one-shot command execution?
- Does it expect PTY semantics (terminal emulation, raw mode)?
- How does it handle long-running commands?
- Does it use `TERM`, `SHELL`, or other terminal environment variables?

**Mitigation:** Start with a simple `spawn()` model. If Claude Code requires PTY semantics, we can use the `node-pty` package (which Electron apps commonly use for terminal emulation). Watch for failures in Phase 3 testing and adapt.

### Worktree edge cases

- **Submodules**: If the project uses git submodules, worktrees may not initialize them automatically. May need `git submodule update --init` in the worktree.
- **Large repos**: Worktree creation is fast (it's a hardlink to the object store), but the checkout step may be slow for very large repos.
- **Dirty working tree**: `git worktree add` requires the working tree state to be clean enough to create a new branch. If the user has uncommitted changes on the same files, this may fail.
- **Concurrent worktree limits**: Git has no explicit limit, but many worktrees may degrade performance if branches diverge significantly.

**Mitigation:** Log worktree-related errors clearly. For the MVP, we'll surface git errors to the user and let them resolve (e.g., commit or stash changes before creating a session).

### Performance of session creation

Session creation now involves multiple sequential steps: directory validation → worktree creation → agent spawn → ACP handshake. This may take several seconds.

**Mitigation:** The UI already shows an "initializing" state. We can add progress indicators (e.g., "Creating worktree...", "Starting agent...", "Connecting...") if the delay is noticeable.

### File path handling in ACP

Claude Code may send file paths in `ReadTextFileRequest`/`WriteTextFileRequest` as absolute paths, relative paths, or `file://` URIs. We need to handle all forms and ensure they resolve correctly within the worktree.

**Mitigation:** Inspect the actual requests Claude Code sends in Phase 2 testing and normalize paths accordingly.

---

## What This Unblocks

Completing Milestone 1 gives us:

- **A working Claude Code integration** through ACP that Milestone 2 wraps in a Seatbelt sandbox (swap `spawn()` for `sandbox-exec ... spawn()`)
- **A worktree-per-session model** that gives Milestone 2 a clean filesystem boundary to enforce (the worktree path becomes the `WORKTREE` parameter in the SBPL profile)
- **Terminal management** that Milestone 2 can verify works under sandbox constraints
- **An auto-approve permission model** that Milestone 3 replaces with policy-based decisions
- **Real-world validation** that ACP can drive a full coding-agent workflow, giving us confidence before adding sandbox complexity
