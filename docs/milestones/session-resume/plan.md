# Session Resume — Implementation Plan

**Date**: 2026-04-01

## Overview

This plan implements the design in [design.md](design.md). The work breaks into 7 steps, ordered by dependency. Each step is independently testable.

The core mechanism has been validated: a standalone script (`scripts/test-resume.ts`) confirmed that `resumeSession` works with Claude Code's ACP adapter — a fresh agent process can resume a killed session by ID and retain full conversation context, as long as the session JSONL files are on disk.

## Assumptions

- Session JSONL files are written by Claude Code to `~/.claude/projects/` (host) or `/root/.claude/projects/` (container). These files are the source of truth for session state.
- `resumeSession` is sufficient for all recovery scenarios. The `loadSession` fallback (full history replay) is deferred unless testing reveals `resumeSession` to be unreliable.
- The workspace's git worktree survives across resume — it's a directory on disk, not in-process state. Only the worktree metadata (`~/.cache/bouncer/worktrees/{id}`) needs to exist for the worktree manager to find it.
- Container sessions use a new container (same image + volumes), not Docker stop/start. This avoids Docker state issues and matches the existing `--rm` flag convention.

## Step 1: Workspace Metadata Persistence

**Goal**: Persist enough workspace state to reconstruct a `WorkspaceState` without the original agent process.

### Changes

**`src/main/workspace-store.ts`** (new file) — Persistence layer:

```typescript
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

const WORKSPACES_DIR = join(app.getPath('userData'), 'workspaces');

export interface PersistedWorkspace {
  id: string;
  repositoryId: string | null;
  acpSessionId: string;
  projectDir: string;
  agentType: AgentType;
  sandboxBackend: SandboxBackend;
  worktreePath: string | null;
  worktreeGitCommonDir: string | null;
  worktreeBranch: string | null;
  policyId: string | null;
  containerImage: string | null;
  githubPolicy: GitHubPolicy | null;
  phase: WorkspacePhase | null;
  prUrl: string | null;
  promptCount: number;
}

export async function persistWorkspace(ws: PersistedWorkspace): Promise<void>;
export async function loadPersistedWorkspaces(): Promise<PersistedWorkspace[]>;
export async function removePersistedWorkspace(id: string): Promise<void>;
```

**`src/main/workspace-manager.ts`** — Write metadata at key lifecycle points:

1. After `initializeWorkspace` completes successfully (session ID is known)
2. After policy ratchet events (branch lock, PR capture)
3. After phase transitions

Call `removePersistedWorkspace` in `closeWorkspace`.

### Testing

- Create a workspace → JSON file appears in `~/.config/bouncer/workspaces/`
- Close the workspace → JSON file is deleted
- Read the JSON file after a policy ratchet → `githubPolicy` updated

## Step 2: Message Persistence

**Goal**: Persist chat messages so the UI can display conversation history immediately after resume, without waiting for the agent to reconnect.

### Changes

**`src/main/message-store.ts`** (new file) — Append-only JSONL message log:

```typescript
const WORKSPACES_DIR = join(app.getPath('userData'), 'workspaces');

function messagesPath(workspaceId: string): string {
  return join(WORKSPACES_DIR, `${workspaceId}-messages.jsonl`);
}

export async function appendMessage(workspaceId: string, message: Message): Promise<void>;
export async function loadMessages(workspaceId: string): Promise<Message[]>;
export async function removeMessages(workspaceId: string): Promise<void>;
```

Messages are appended as complete JSON objects (one per line). On load, each line is parsed independently — a truncated final line (from a crash mid-write) is silently dropped.

**`src/main/workspace-manager.ts`** — Append messages at two points:

1. In `sendMessage`, after pushing the user message to `workspace.messages`
2. In the `sessionUpdate` handler, when a streaming agent message completes (on `message_end` or equivalent)

Tool call messages are persisted as part of the agent message (they're already embedded in the message parts array).

**On restore**: Load messages before spawning the agent. The renderer gets them immediately via the existing `getMessages` IPC call.

### Open detail

Agent messages stream incrementally. We should persist the **final** agent message (after `stream-end`), not intermediate chunks. This means appending once when the agent finishes responding, not on every chunk.

### Testing

- Send a message → JSONL file grows by two lines (user + agent response)
- Kill the app process → relaunch → `loadMessages` returns the full history
- Truncate the last line of the JSONL → `loadMessages` returns all complete messages

## Step 3: Container Session Volume

**Goal**: Make Claude Code's session JSONL files survive container restarts by bind-mounting a host directory.

### Changes

**`src/main/workspace-manager.ts`** — In the container config construction (around line 700, inside `policyToContainerConfig` call):

Add a new mount:

```typescript
{
  hostPath: join(app.getPath('userData'), 'sessions', id),
  containerPath: '/root/.claude',
  readOnly: false,
}
```

Create the host directory before spawning the container:

```typescript
await mkdir(join(app.getPath('userData'), 'sessions', id), { recursive: true });
```

The existing credentials file write (`claudeCredentialsPath`) should write into this directory instead of `/tmp/bouncer-sandbox/`, since it needs to be at `/root/.claude/.credentials.json` inside the container. This simplifies the mount — one directory covers both credentials and sessions.

**`src/main/workspace-manager.ts`** — In `closeWorkspace`, add cleanup:

```typescript
await rm(join(app.getPath('userData'), 'sessions', workspaceId), {
  recursive: true,
  force: true,
}).catch(() => {});
```

### Non-container sessions

For safehouse/unsandboxed sessions, Claude Code writes to `~/.claude/` on the host directly. Session files already persist. No changes needed.

### Testing

- Start a container workspace, send a message, kill the container
- Check `~/Library/Application Support/bouncer/sessions/{id}/` on the host → session JSONL exists
- Spawn a new container with the same mount → Claude Code can see the session

## Step 4: Resume Flow (Core)

**Goal**: Implement the `resumeWorkspace` method that respawns the agent and reconnects via `resumeSession`.

### Changes

**`src/main/workspace-manager.ts`** — New status values and `resumeWorkspace` method:

Update `WorkspaceState.status` type:

```typescript
status: 'initializing' | 'ready' | 'error' | 'suspended' | 'resuming' | 'closed';
```

New method:

```typescript
async resumeWorkspace(workspaceId: string): Promise<void> {
  const workspace = this.workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (workspace.status !== 'error' && workspace.status !== 'suspended') {
    throw new Error(`Cannot resume workspace in status: ${workspace.status}`);
  }

  const savedSessionId = workspace.acpSessionId;
  workspace.status = 'resuming';
  this.emit('workspace-update', { workspaceId, type: 'status-change', status: 'resuming' });

  // The resume flow reuses most of initializeWorkspace, but:
  // - Skips worktree creation (already exists)
  // - Skips policy artifact installation (already on disk)
  // - Calls resumeSession instead of newSession
  // - Restores promptCount from persisted metadata

  // 1. Respawn agent process (container or safehouse)
  //    Same logic as initializeWorkspace for process spawning
  // 2. Set up ACP connection (same stream/handler setup)
  // 3. ACP handshake (initialize)
  // 4. Call connection.unstable_resumeSession({ sessionId: savedSessionId, cwd })
  // 5. Restore workspace to ready
}
```

The bulk of the work is extracting the "spawn agent + set up ACP" portion of `initializeWorkspace` into a shared helper, so it can be called from both `initializeWorkspace` (new session) and `resumeWorkspace` (resume session).

### Refactoring `initializeWorkspace`

Split `initializeWorkspace` into phases:

1. **`setupPolicyAndSandbox`** — Policy template resolution, safehouse config, GitHub policy, hooks, gh shim. Skipped on resume (artifacts already exist).
2. **`spawnAndConnect`** — Spawn agent process, set up ACP stream, create connection, register handlers. Shared between new and resume.
3. **`startSession`** — Either `newSession` or `resumeSession`. The only difference between new and resume paths.
4. **`startMonitors`** — Sandbox monitor, container monitor. Shared.

### Credential refresh on resume

For container sessions, re-extract credentials from macOS keychain and write to the session volume before spawning. This handles the auth-recovery scenario where the resume is triggered by expired credentials.

For non-container sessions, credentials are already in the host keychain. No action needed.

### Error handling

If `resumeSession` fails (e.g., session JSONL is missing or corrupt):
- Log the error
- Transition workspace to `error` with a message: "Could not resume session — session data may be lost"
- The user can close the workspace and create a new one

### Testing

- Create workspace → send message → kill agent → `resumeWorkspace` → send another message referencing earlier context → agent remembers
- Same flow but kill the container → resume spawns new container → agent still remembers
- Resume with missing session file → workspace transitions to error with clear message

## Step 5: App Restart Recovery

**Goal**: On app launch, restore persisted workspaces as "suspended" and allow the user to resume them.

### Changes

**`src/main/workspace-manager.ts`** — New method and startup hook:

```typescript
async restorePersistedWorkspaces(): Promise<void> {
  const persisted = await loadPersistedWorkspaces();
  for (const pw of persisted) {
    // Validate: does the worktree still exist? Does the session volume exist?
    const worktreeExists = pw.worktreePath
      ? await stat(pw.worktreePath).then(() => true, () => false)
      : true;

    if (!worktreeExists) {
      // Worktree was cleaned up (e.g., manual git worktree remove)
      await removePersistedWorkspace(pw.id);
      continue;
    }

    // Create a minimal WorkspaceState in suspended status
    const workspace: WorkspaceState = {
      id: pw.id,
      repositoryId: pw.repositoryId,
      acpSessionId: pw.acpSessionId,
      agentProcess: null!,
      connection: null!,
      messages: await loadMessages(pw.id),
      status: 'suspended',
      agentType: pw.agentType,
      projectDir: pw.projectDir,
      worktree: pw.worktreePath ? {
        path: pw.worktreePath,
        gitCommonDir: pw.worktreeGitCommonDir!,
        branch: pw.worktreeBranch!,
      } : null,
      sandboxBackend: pw.sandboxBackend,
      // ... remaining fields initialized to null/defaults
    };
    this.workspaces.set(pw.id, workspace);
  }
}
```

Called from `src/main/index.ts` during app startup, before the window is shown.

**`src/main/index.ts`** — Add restore call:

```typescript
// After WorkspaceManager construction, before window creation:
await workspaceManager.restorePersistedWorkspaces();
```

**Orphan cleanup adjustment**: The existing `cleanupOrphans` runs at startup and removes worktrees/containers/networks for session IDs not in the active workspace map. After restore, the suspended workspaces *are* in the map, so their worktrees won't be cleaned up. However, their containers and networks *will* be gone (container was `--rm`). This is correct — `resumeWorkspace` creates fresh containers.

### IPC changes

**`src/preload/index.ts`** — Add `resume` method:

```typescript
resume: (workspaceId: string) => ipcRenderer.invoke('workspace:resume', workspaceId),
```

**`src/main/index.ts`** — Add IPC handler:

```typescript
ipcMain.handle('workspace:resume', async (_event, workspaceId: string) => {
  await workspaceManager.resumeWorkspace(workspaceId);
});
```

### Testing

- Create workspace → send messages → quit app → relaunch → workspace appears in sidebar as "suspended" with message history visible
- Click resume → workspace reconnects → agent retains context
- Create workspace → close it explicitly → quit → relaunch → workspace does NOT appear (metadata was deleted)
- Workspace with deleted worktree → silently removed from persisted list on startup

## Step 6: Graceful Close with `closeSession`

**Goal**: When the user explicitly closes a workspace, call `closeSession` before killing the agent to give Claude Code a chance to flush session state.

### Changes

**`src/main/workspace-manager.ts`** — In `closeWorkspace`, before killing the process:

```typescript
// Graceful ACP close — best-effort, don't block on failure
if (workspace.connection && workspace.status !== 'error' && workspace.status !== 'suspended') {
  try {
    await Promise.race([
      workspace.connection.unstable_closeSession({ sessionId: workspace.acpSessionId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    // Agent may already be dead — proceed with cleanup
  }
}
```

The 3-second timeout prevents a hung agent from blocking workspace closure.

Also clean up the session volume and persisted files:

```typescript
await removePersistedWorkspace(workspaceId);
await removeMessages(workspaceId);
if (workspace.sandboxBackend === 'container') {
  await rm(join(app.getPath('userData'), 'sessions', workspaceId), {
    recursive: true, force: true,
  }).catch(() => {});
}
```

### Testing

- Close a running workspace → `closeSession` called → process killed → all artifacts removed
- Close a workspace with dead agent → `closeSession` times out → cleanup proceeds

## Step 7: UI Changes

**Goal**: Surface suspended/resuming states and the reconnect action in the UI.

### Changes

**`src/renderer/src/components/WorkspacesSidebar.tsx`**:

- Render suspended workspaces with a "paused" icon/badge
- Show workspace count includes suspended workspaces

**`src/renderer/src/components/ChatPanel.tsx`**:

- When `status === 'suspended'`: show message history (loaded from disk) with a "Resume" button at the bottom
- When `status === 'resuming'`: show spinner with "Reconnecting..." (same as initializing treatment)
- When `status === 'error'` and `canResume` is true: show "Reconnect" (primary) and "Close" (secondary) buttons instead of just "Close"
- After successful resume: append a system message divider: "Session resumed — [timestamp]"

**`src/renderer/src/types.ts`** — Update `WorkspaceStatus` type to include `'suspended'` and `'resuming'`.

**`src/preload/index.ts`** — Expose `resume` method (covered in step 5).

### Testing

- Suspended workspace → sidebar shows paused indicator → click → chat shows history + Resume button
- Click Resume → spinner → messages load → "Session resumed" divider → agent responds
- Error workspace → Reconnect button → resume flow → back to ready
- Close button on suspended workspace → hard delete, removed from sidebar

## Dependency Graph

```
Step 1 (workspace metadata)
  ↓
Step 2 (message persistence) ←── independent of 1, but uses same directory
  ↓
Step 3 (container session volume) ←── independent of 1-2
  ↓
Step 4 (resume flow) ←── depends on 1 (reads metadata), 2 (loads messages), 3 (session files exist)
  ↓
Step 5 (app restart) ←── depends on 1 (loads persisted workspaces), 4 (resume method)
  ↓
Step 6 (graceful close) ←── depends on 1 (deletes metadata), 2 (deletes messages)
  ↓
Step 7 (UI) ←── depends on 4-5 (suspended/resuming states), 6 (close semantics)
```

Steps 1, 2, and 3 are independent and can be done in parallel. Step 4 is the core integration point. Steps 5-7 build on top.

## Files Changed Summary

| File | Steps | Nature of Change |
|------|-------|------------------|
| `src/main/workspace-store.ts` | 1 | **New**: persist/load/remove workspace metadata |
| `src/main/message-store.ts` | 2 | **New**: append/load/remove message JSONL |
| `src/main/workspace-manager.ts` | 1-6 | Persist metadata at lifecycle points; refactor `initializeWorkspace` into phases; add `resumeWorkspace` and `restorePersistedWorkspaces`; graceful close; new status values |
| `src/main/index.ts` | 5 | Call `restorePersistedWorkspaces` at startup; add `workspace:resume` IPC handler |
| `src/preload/index.ts` | 5 | Expose `resume` method |
| `src/renderer/src/types.ts` | 7 | Add `'suspended'` and `'resuming'` to status type |
| `src/renderer/src/components/WorkspacesSidebar.tsx` | 7 | Suspended workspace rendering |
| `src/renderer/src/components/ChatPanel.tsx` | 7 | Resume button, reconnecting spinner, system message divider |
