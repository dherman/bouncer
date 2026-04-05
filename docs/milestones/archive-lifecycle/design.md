# Workspace Archive Lifecycle — Design Document

**Date**: 2026-04-02

## Goal

Give users a non-destructive way to dismiss workspaces from the sidebar without permanently losing session history, and clean up the sidebar UX for workspace lifecycle states.

## Motivation

Before this change, users faced a hard choice: keep a finished workspace cluttering the sidebar, or close it and lose the history forever. Close was the only option and it was destructive — it deleted the worktree, persisted metadata, and message history in one irreversible step.

Additional UX issues compounded the problem:
- Closed workspaces lingered in the sidebar until app restart
- Suspended workspaces displayed an ugly `⏸ suspended` text badge with no clear way to resume
- The close button (`×`) was prominent despite being a destructive, irreversible operation

## Design Decisions

### Archive vs. Close

We introduced **archive** as a new first-class lifecycle state, distinct from close:

| | Archive | Close |
|---|---|---|
| Worktree | Deleted | Deleted |
| Container/proxy/sandbox | Cleaned up | Cleaned up |
| Persisted metadata (JSON) | Kept, marked `archived: true` | Deleted |
| Message history (JSONL) | Kept | Deleted |
| Visible in sidebar | No | No |
| Recoverable | Yes (future PR) | No |

Archive is the default action — it's what the user reaches for when they're done with a workspace. Close is available but deliberately harder to reach (right-click context menu with confirmation dialog).

### Archived workspaces are hidden, not dimmed

We considered showing archived workspaces in a collapsible "Archived" section of the sidebar (option A) vs. hiding them entirely and providing a separate browsing UI later (option B). We chose **option B** because:

- The sidebar is for active work; archived sessions are reference material
- A collapsible section still adds visual weight even when collapsed
- A dedicated archive browser can offer search, filtering, and read-only history viewing — features that don't belong in a sidebar

The archive browsing UI is tracked in #107.

### Archive revival is deferred

Two revival approaches were discussed:

1. **New workspace + archive context**: Create a fresh workspace with a new worktree, feeding the archived history to the agent as context
2. **Read archive from existing workspace**: Let any workspace pull in an archive for reference, decoupling retrieval from workspace creation

Both are useful and not mutually exclusive. They are deferred to #108 to keep the initial PR focused on the core lifecycle change and UX improvements.

### Resume button replaces suspended text

Suspended workspaces now show a `▶` resume button on the right side of the sidebar entry instead of `⏸ suspended` text. This is more actionable — the user sees what they can do, not just the state. Suspended workspaces are also visually dimmed (reduced opacity) to distinguish them from active workspaces.

### Close requires confirmation

Close permanently deletes all workspace data. It is accessed via right-click context menu on a workspace item and requires a `window.confirm` dialog before proceeding. This prevents accidental data loss while still being available when the user truly wants a clean slate.

## Archive Filesystem Format

All workspace data lives under the Electron `userData` directory. A typical layout with two archived workspaces and one active:

```
~/Library/Application Support/bouncer/
└── workspaces/
    ├── a1b2c3d4-5678-9abc-def0-111111111111.json            # archived workspace metadata
    ├── a1b2c3d4-5678-9abc-def0-111111111111-messages.jsonl   # archived message history
    ├── b2c3d4e5-6789-abcd-ef01-222222222222.json            # archived workspace metadata
    ├── b2c3d4e5-6789-abcd-ef01-222222222222-messages.jsonl   # archived message history
    ├── c3d4e5f6-789a-bcde-f012-333333333333.json            # active workspace metadata
    └── c3d4e5f6-789a-bcde-f012-333333333333-messages.jsonl   # active message history
```

Both files use the workspace UUID as their filename stem. An archived workspace retains both files; a closed (permanently deleted) workspace has both removed. Active and archived workspaces share the same directory and file format — the `archived` flag inside the metadata JSON is the only distinction.

### Metadata file (`{workspaceId}.json`)

Pretty-printed JSON matching the `PersistedWorkspace` interface:

```jsonc
{
  "id": "a1b2c3d4-...",
  "repositoryId": "repo-uuid-...",      // which repo this workspace belonged to
  "acpSessionId": "session-uuid-...",    // ACP session ID (stale after archive)
  "projectDir": "/Users/.../my-repo",   // original repo root
  "agentType": "claude-code",           // "echo" | "claude-code" | "replay"
  "sandboxBackend": "safehouse",        // "safehouse" | "container" | "none"
  "worktreePath": null,                 // always null for archived workspaces
  "worktreeGitCommonDir": null,         // always null for archived workspaces
  "worktreeBranch": "dherman/feature",  // branch name preserved for reference
  "policyId": "standard",               // policy template ID
  "containerImage": null,               // Docker image if container-sandboxed
  "githubPolicy": {                     // null if no GitHub policy was active
    "repo": "owner/repo",
    "allowedPushRefs": ["refs/heads/dherman/*"],
    "ownedPrNumber": 42,
    "canCreatePr": false,
    "protectedBranches": ["main", "release/*"]
  },
  "phase": "pr-open",                   // "implementing" | "pr-open" | "ready" | null
  "prUrl": "https://github.com/owner/repo/pull/42",
  "promptCount": 7,
  "archived": true                      // distinguishes archive from active/suspended
}
```

Key difference from an active workspace's metadata: `archived` is `true`, and `worktreePath`/`worktreeGitCommonDir` are `null` (the worktree was deleted during archival). The `worktreeBranch` is preserved so a future revival can reference or recreate it.

### Message history file (`{workspaceId}-messages.jsonl`)

Append-only, one JSON object per line. Each line is a `Message`:

```jsonc
{"id":"msg-1","role":"user","text":"Fix the login bug","timestamp":1743550000000}
{"id":"msg-2","role":"agent","text":"I'll look into the auth flow...","timestamp":1743550005000,"toolCalls":[{"id":"tc-1","name":"Read","status":"completed","title":"Read src/auth.ts"}]}
```

Fields per message:
- `id` — unique message ID
- `role` — `"user"` or `"agent"`
- `text` — full message text (for agent messages, the final assembled text after streaming)
- `timestamp` — Unix epoch milliseconds
- `streaming` — omitted (only present during live streaming)
- `toolCalls` — array of tool call records (agent messages only, optional)
- `textSegments` — text segments split around tool call groups (optional)
- `parts` — ordered list of `{type: "text", index}` and `{type: "tool", toolCallId}` for interleaved rendering (optional)

The JSONL format is crash-tolerant: partial writes from a crash result in a truncated last line, which the loader skips.

## Implementation

### New status: `'archived'`

Added to the `WorkspaceSummary.status` union and `WorkspaceState.status` in the main process. The `PersistedWorkspace` type gains an `archived?: boolean` field.

### `archiveWorkspace()` method

Located in `workspace-manager.ts`. Performs the same runtime cleanup as `closeWorkspace()` (ACP session close, process kill, container removal, proxy/network teardown, worktree removal, sandbox cleanup) but instead of deleting persisted data, it re-persists the workspace metadata with `archived: true` and `worktreePath: null`. The workspace is then removed from the in-memory map so it no longer appears in `listWorkspaces()`.

### Restore skips archived

`restorePersistedWorkspaces()` checks the `archived` flag and skips those entries. Archived workspaces have no worktree and no runtime state to restore.

### Sidebar changes

- **Archive button**: An archive icon (`icon-archive.png`) replaces the `×` close button as the primary action on each workspace item
- **Resume button**: A `▶` button appears for suspended workspaces, calling `workspaces.resume(id)`
- **Context menu**: Right-click on a workspace shows a menu with "Close (delete permanently)"
- **Filtering**: Closed and archived workspaces are filtered out of the visible workspace list immediately on status change (fixes the linger bug)
- **Styling**: `.workspace-item.suspended` gets `opacity: 0.6`

### IPC plumbing

- `workspaces:archive` IPC handler in `index.ts`
- `archive()` exposed via preload on `window.bouncer.workspaces`
- `archive()` added to `BouncerAPI` type in `env.d.ts`

## Related Issues

- #105 — Original issue: cleaner workspace lifecycle
- #106 — Implementation PR
- #107 — Follow-up: archive browsing UI
- #108 — Follow-up: archive revival
