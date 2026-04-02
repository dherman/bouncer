# Session Resume — Design Document

**Date**: 2026-04-01

## Goal

Allow workspaces to survive agent process crashes, container restarts, credential refreshes, and app restarts by resuming the ACP session instead of starting from scratch.

## Motivation

Today, when a workspace's agent process dies — whether from an auth failure, a crash, or the user closing and reopening the app — the workspace is lost. The user must create a new workspace, re-type their task, and wait for the agent to rebuild context. This is the single biggest UX gap in Bouncer.

Claude Code's ACP adapter (`@zed-industries/claude-agent-acp` v0.22.2) advertises full session lifecycle capabilities:

```json
{
  "loadSession": true,
  "sessionCapabilities": {
    "fork": {},
    "list": {},
    "resume": {},
    "close": {}
  }
}
```

This means we have everything we need on the protocol side. The remaining work is persistence and reconnection orchestration.

## ACP Session Operations

The ACP SDK provides five session lifecycle methods beyond `newSession`:

| Method | Stability | Purpose |
|--------|-----------|---------|
| `loadSession(sessionId, cwd, mcpServers)` | Stable | Reattach to a session by replaying its full conversation history |
| `unstable_resumeSession(sessionId, cwd, mcpServers?)` | Experimental | Reattach without replaying history (fastest) |
| `unstable_forkSession(sessionId, cwd, mcpServers?)` | Experimental | Create a new session branching from an existing one |
| `listSessions(cwd?, cursor?)` | Stable | Enumerate existing sessions, optionally filtered by `cwd` |
| `unstable_closeSession(sessionId)` | Experimental | Clean teardown of a session |

### Resume vs Load

- **`resumeSession`**: Lightweight. The agent picks up where it left off without re-processing history. Best for crash recovery and credential refresh — the conversation context is the same, just the transport died.
- **`loadSession`**: Replays the full conversation. More expensive but more robust — works even if the agent's in-memory state was lost. Better for app restart recovery where the agent process is completely new.

Both require that Claude Code's session JSONL files are still on disk when the new agent process starts.

### Fork

`forkSession` creates a new session that branches from an existing one's history. This is useful for "try a different approach" workflows — fork the session at the point before the agent went down a bad path, without losing the original. Not needed for basic recovery but worth keeping in mind for future UX.

## What Needs to Persist

Today, all workspace state lives in memory. To support resume, we need to persist enough to reconstruct a workspace without the original agent process.

### Workspace Metadata (new)

A JSON file per workspace, written to `~/.config/bouncer/workspaces/{id}.json`:

```typescript
interface PersistedWorkspace {
  id: string;
  repositoryId: string | null;
  acpSessionId: string;
  projectDir: string;
  agentType: AgentType;
  sandboxBackend: SandboxBackend;
  worktreePath: string | null;
  policyId: string | null;

  // Container-specific
  containerImage: string | null;
  containerName: string | null;

  // Policy state (also on disk at /tmp/bouncer-sandbox/)
  githubPolicy: GitHubPolicy | null;
  phase: WorkspacePhase | null;
  prUrl: string | null;
}
```

Written on workspace creation and updated on state changes (policy ratchets, phase transitions, PR creation). Deleted on explicit workspace close.

### Claude Code Session Files

Claude Code stores session history as JSONL files under `~/.claude/projects/`. For session resume/load to work, these files must survive process restarts.

- **Non-container (safehouse/unsandboxed)**: Session files are already on the host filesystem. Nothing to do.
- **Container**: Session files live inside the container's filesystem, which is ephemeral. We need a bind mount.

### Container Session Volume

Add a bind mount for Claude Code's session storage:

```
-v ~/.config/bouncer/sessions/{workspaceId}:/root/.claude
```

This maps a host-side directory to the container's `~/.claude/`, which is where Claude Code stores:
- Session JSONL files (`projects/.../*.jsonl`)
- Settings and credentials

The credentials file (`~/.claude/.credentials.json`) is already written into the container at startup. With this mount, it persists across container restarts too.

## Recovery Flow

### Scenario 1: Credential Refresh (Container Restart)

The most common recovery case. OAuth tokens expire, the agent fails auth, and the container needs to restart with fresh credentials.

```
1. Agent process exits with auth error
2. Workspace transitions to status: "error", errorKind: "auth"
3. UI shows "Session expired — Reconnect" button
4. User clicks Reconnect (or: auto-reconnect on app foreground)
5. Main process:
   a. Reads persisted workspace metadata
   b. Extracts fresh credentials from macOS keychain
   c. Writes credentials to session volume
   d. Spawns new container with same bind mounts
   e. ACP handshake (initialize)
   f. Calls resumeSession(savedSessionId, cwd)
   g. Restores policy artifacts (hooks, gh shim, proxy)
   h. Workspace transitions to status: "ready"
6. UI restores chat history from persisted messages
7. Agent continues where it left off
```

### Scenario 2: App Restart

User quits and reopens Bouncer. All in-memory state is gone.

```
1. App starts, reads all persisted workspace files from ~/.config/bouncer/workspaces/
2. For each persisted workspace:
   a. Show in sidebar as "suspended" (new status)
   b. User clicks to resume (or: auto-resume on workspace focus)
3. Resume flow:
   a. Recreate worktree if needed (git worktree add)
   b. Spawn new agent process / container
   c. ACP handshake
   d. Call loadSession(savedSessionId, cwd, mcpServers)
      (loadSession rather than resumeSession — agent process is brand new)
   e. Restore policy, proxy, monitors
   f. Workspace transitions to "ready"
4. Chat history loaded from persisted messages
```

### Scenario 3: Agent Crash (Non-Auth)

Agent exits unexpectedly with a non-auth error.

```
1. Agent process exits with non-zero code
2. Workspace transitions to status: "error"
3. UI shows "Agent crashed — Restart" button
4. User clicks Restart
5. Same flow as Scenario 1, but without credential refresh step
```

## Message Persistence

Chat messages are currently stored in-memory (`workspace.messages: Message[]`). For resume to feel seamless, the user needs to see their conversation history after reconnection.

Two options:

### Option A: Persist messages to disk (recommended)

Append messages to a JSONL file at `~/.config/bouncer/workspaces/{id}-messages.jsonl`. This is simple, append-only, and doesn't depend on ACP.

- Written: on every new message (user or agent)
- Read: on workspace restore, before ACP reconnection
- The renderer gets messages immediately, even before the agent is back

### Option B: Reconstruct from ACP session notifications

After `loadSession`, the agent replays the conversation, which triggers `sessionUpdate` notifications. We could reconstruct messages from these.

- Pro: No separate persistence needed
- Con: Slow (must wait for full replay), and `resumeSession` doesn't replay at all
- Con: Tool call details and streaming state are hard to reconstruct exactly

**Decision**: Option A. Simple, fast, independent of ACP.

## Workspace Lifecycle Changes

### New Statuses

```typescript
type WorkspaceStatus =
  | 'initializing'  // Agent process starting, ACP handshake in progress
  | 'ready'         // Agent connected and responsive
  | 'error'         // Agent died, awaiting user action
  | 'suspended'     // Persisted but no running agent (after app restart)
  | 'resuming'      // Reconnecting to a previous session
  | 'closed';       // Explicitly closed by user, metadata deleted
```

### State Machine

```
                    ┌──────────────┐
         ┌────────►│ initializing │
         │         └──────┬───────┘
         │                │ success
         │                ▼
         │         ┌──────────────┐
    new  │    ┌───►│    ready     │◄────────┐
  session│    │    └──────┬───────┘         │
         │    │           │ crash/auth      │ success
         │    │           ▼                 │
         │    │    ┌──────────────┐  ┌──────┴───────┐
         │    │    │    error     ├─►│   resuming   │
         │    │    └──────┬───────┘  └──────────────┘
         │    │           │                 ▲
         │    │           │                 │
         │    │    ┌──────▼───────┐         │
         │    └────┤  suspended   ├─────────┘
         │         └──────┬───────┘
         │                │ close
         │                ▼
         │         ┌──────────────┐
         └────────►│   closed     │
                   └──────────────┘
```

### Close Semantics

When the user explicitly closes a workspace:

1. Call `unstable_closeSession(sessionId)` if the agent is still connected
2. Kill the agent process / container
3. Delete persisted workspace metadata and messages
4. Clean up worktree, policy artifacts, session volume
5. Remove from sidebar

This is a hard delete — the workspace cannot be recovered.

## IPC API Changes

### New Methods

```typescript
// Resume a workspace that's in error or suspended state
workspaces.resume(workspaceId: string): Promise<void>

// Get all workspaces including suspended ones (already works, needs suspended support)
workspaces.list(): Promise<WorkspaceSummary[]>
```

### WorkspaceSummary Changes

```typescript
interface WorkspaceSummary {
  id: string;
  status: WorkspaceStatus;  // Now includes 'suspended' and 'resuming'
  // ... existing fields ...
  canResume: boolean;        // True if session files exist and resume is possible
}
```

## UI Changes

### Workspace Sidebar

- **Suspended workspaces**: Show with a "paused" indicator. Clicking opens the chat panel with history and a "Resume" button.
- **Error workspaces with resume**: Show the existing error banner but replace "Close" with "Reconnect" (primary) and "Close" (secondary).
- **Resuming state**: Show a spinner with "Reconnecting..." text, similar to the initializing state.

### Chat Panel

- On resume, show persisted messages immediately
- Append a system message: "Session resumed" with a timestamp
- The agent's next response appears below the divider

## Implementation Sequence

1. **Workspace metadata persistence** — Write/read `PersistedWorkspace` JSON files. Update on state changes.

2. **Message persistence** — Append-only JSONL file per workspace. Load on restore.

3. **Container session volume** — Add `~/.claude` bind mount to container config. Verify session files survive container restart.

4. **Resume flow for auth recovery** — `resumeSession` path: respawn agent, ACP handshake, resume session, restore policy. Wire up "Reconnect" button.

5. **App restart recovery** — Load persisted workspaces on startup as "suspended". Wire up resume-on-click.

6. **`loadSession` fallback** — If `resumeSession` fails (e.g., agent state too stale), fall back to `loadSession` which replays history.

7. **Graceful close** — Call `closeSession` before killing the agent. Clean up persisted files.

8. **UI polish** — Suspended/resuming states in sidebar, system message divider, auto-resume on foreground.

## Open Questions

1. **`resumeSession` reliability**: This is an experimental (`unstable_`) API. Does it work reliably with Claude Code today, or should we default to `loadSession` and treat `resumeSession` as an optimization? Need to test empirically.

2. **Session staleness**: How old can a session be before resume/load stops working? Claude Code may have its own session expiry. If sessions expire, we need to detect this and fall back to creating a new workspace with a message like "Session expired — starting fresh."

3. **Container identity**: When we restart a container, should it be the same container name (stop + start) or a new container with the same volumes? New container is simpler and avoids Docker state issues, but means we need to re-inject all environment and config.

4. **Auto-resume vs manual**: Should suspended workspaces auto-resume on app start, or wait for user interaction? Auto-resume is smoother but spawns potentially many agent processes at once. Manual is safer and lets the user decide which workspaces are still relevant.

5. **Message truncation**: For long-running workspaces, the message JSONL file could get large. Should we cap it (e.g., keep last 1000 messages) or let it grow? The renderer already virtualizes the message list, so rendering isn't the bottleneck — disk and load time are.

## Non-Goals

- **Live migration**: Moving a running session between machines or containers without interruption
- **Multi-device sync**: Syncing workspace state across multiple Macs
- **Session branching UX**: Exposing `forkSession` in the UI (future work)
- **Automatic retry loops**: If resume fails, we surface the error — we don't retry in a loop
- **Backward compatibility**: Workspaces created before this feature won't be resumable (no persisted metadata)
