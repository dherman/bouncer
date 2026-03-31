# Milestone 8: Workspaces Sidebar — Design Document

**Date**: 2026-03-26

## Goal

Redesign the sidebar and session creation workflow around the concept of **Workspaces** — grouped under persistent **Repositories** — replacing the flat session list and modal dialog. This makes the app's primary abstraction match what users actually work with: a repo that spawns multiple sandboxed working copies.

## Motivation

The current UI has two friction points:

1. **Flat session list**: Sessions are displayed as an unstructured list. There's no visual grouping by project/repo, and when working with multiple repos the sidebar becomes hard to navigate.

2. **Modal creation dialog**: Every new session requires selecting a project directory, agent type, and policy through a modal. In practice, most sessions for a given repo use the same settings (Standard PR, Claude Code). The dialog adds ceremony without value for the common case.

The workspace model fixes both:

- **Repositories** are top-level sidebar entries, persisted across app restarts. Each repo stores default settings (GitHub URL, default workspace type/policy).
- **Workspaces** are indented under their repo. Creating one is a single click — it inherits the repo's defaults. No dialog needed for the common case.
- The rename from "sessions" to "workspaces" also better reflects the reality: each entry isn't just a chat session, it's a containerized working copy with a policy envelope, git worktree, and sandbox.

## Terminology

| Old term           | New term                  | Notes                                                         |
| ------------------ | ------------------------- | ------------------------------------------------------------- |
| Session            | Workspace                 | A sandboxed agent environment (container + worktree + policy) |
| Session list       | Workspaces sidebar        | The left panel                                                |
| New Session dialog | (removed for common case) | Quick-create via "+" button on repo                           |
| — (new)            | Repository                | A persisted project entry in the sidebar                      |

**Internal code naming**: The `SessionManager`, `SessionState`, `SessionSummary` types will be renamed to use "workspace" terminology. This is a mechanical rename — the behavior is unchanged.

## Data Model

### Repository (new, persisted)

```typescript
interface Repository {
  id: string // UUID
  name: string // Display name (e.g., "bouncer")
  localPath: string // Path to the git repo on disk
  githubRepo: string | null // e.g., "anthropics/bouncer" (auto-detected from git remote)
  defaultPolicyId: string // e.g., "standard-pr"
  defaultAgentType: AgentType // e.g., "claude-code"
  createdAt: number // Timestamp
}
```

Repositories are persisted to `~/.config/bouncer/repositories.json`. This file is read at app startup and written whenever repos are added, removed, or edited.

### Workspace (renamed from Session)

The existing `SessionState` / `SessionSummary` types are renamed but structurally unchanged, with one addition:

```typescript
interface WorkspaceSummary {
  // ... all existing SessionSummary fields, renamed ...
  repositoryId: string // Links workspace to its parent repository
}
```

Workspaces remain ephemeral (in-memory, not persisted across app restarts). A workspace belongs to exactly one repository.

### Persistence Strategy

Only repositories are persisted. Workspaces are ephemeral — when the app restarts, the sidebar shows repos (from `repositories.json`) but no workspaces until the user creates new ones. This matches the current behavior where sessions don't survive app restarts.

**File location**: `~/.config/bouncer/repositories.json`

```json
[
  {
    "id": "abc-123",
    "name": "bouncer",
    "localPath": "/Users/dherman/Code/bouncer",
    "githubRepo": "anthropics/bouncer",
    "defaultPolicyId": "standard-pr",
    "defaultAgentType": "claude-code",
    "createdAt": 1711411200000
  }
]
```

**Why `~/.config/bouncer`**: Standard macOS/Linux config directory. Electron's `app.getPath('userData')` would also work but puts it under `~/Library/Application Support/Bouncer` on macOS, which is less discoverable. Using `~/.config/bouncer` is explicit and portable.

## Sidebar Design

### Layout

```
┌─────────────────────────────────┐
│  Workspaces           [+ Repo]  │  ← Header with "Add repository" button
├─────────────────────────────────┤
│  ▶ bouncer                [+]   │  ← Repo entry (collapsed, no active workspaces)
│  ▼ my-service             [+]   │  ← Repo entry (expanded)
│    ● fix-auth-bug              │  ← Workspace (active, ready)
│    ○ add-logging               │  ← Workspace (initializing)
│    ◌ refactor-api              │  ← Workspace (closed)
│  ▶ infra-tools            [+]   │  ← Repo entry
│                                 │
│  (empty state when no repos)    │
└─────────────────────────────────┘
```

### Repo entry

- **Left**: Disclosure triangle (▶/▼) to expand/collapse workspace list
- **Center**: Repo name (derived from directory name, editable in settings)
- **Right**: "+" button to create a new workspace with repo defaults
- **Context menu** (right-click): Settings, Remove
- Repos auto-expand when they have active (non-closed) workspaces

### Workspace entry

- Indented under its parent repo
- Same visual structure as current session items: status dot, label, status text, close button
- Label: branch name when available, otherwise short ID
- Badges: same as current (sandbox backend, policy, GitHub repo/PR, violations)

### Interactions

| Action           | Trigger                      | Behavior                                                                      |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| Add repository   | Click [+ Repo] header button | Opens directory browser → creates repo entry with auto-detected settings      |
| Create workspace | Click [+] on repo row        | Immediately creates workspace with repo defaults. No dialog.                  |
| Select workspace | Click workspace row          | Shows workspace chat panel (same as current session select)                   |
| Close workspace  | Click × on workspace row     | Closes workspace (same as current session close)                              |
| Repo settings    | Right-click repo → Settings  | Opens a settings panel/dialog for editing repo defaults                       |
| Remove repo      | Right-click repo → Remove    | Removes repo from sidebar (closes active workspaces first, with confirmation) |
| Collapse/expand  | Click disclosure triangle    | Toggles workspace list visibility                                             |

## Add Repository Flow

1. User clicks [+ Repo] in the sidebar header
2. System opens a native directory browser (`dialog.showOpenDialog`)
3. User selects a directory containing a git repo
4. System validates it's a git repo (`git rev-parse --git-dir`)
5. System auto-detects:
   - **Name**: directory basename (e.g., `/Users/dherman/Code/bouncer` → "bouncer")
   - **GitHub repo**: parsed from `git remote get-url origin` (e.g., `git@github.com:anthropics/bouncer.git` → "anthropics/bouncer")
   - **Default policy**: `standard-pr`
   - **Default agent type**: `claude-code`
6. Repository entry is added to the sidebar and persisted to `repositories.json`

No confirmation dialog needed — the user selected the directory, and all other settings have sensible defaults that can be changed later via repo settings.

## Create Workspace Flow (Quick Create)

1. User clicks [+] on a repo row
2. System calls `WorkspaceManager.createWorkspace(repositoryId)` which:
   - Looks up repo settings (local path, default policy, default agent type)
   - Creates a git worktree (same as current `createSession`)
   - Sets up sandbox (container/safehouse, same as current)
   - Sets up policy enforcement (hooks, shim, proxy, same as current)
3. New workspace appears under the repo in the sidebar, auto-selected
4. Workspace is ready for chat

This replaces the current flow of: click "New Session" → modal dialog → select directory → select agent type → select policy → click "Create".

## Repository Settings

Accessible via right-click context menu on a repo entry. Opens an inline panel or small dialog with:

- **Name**: Editable text (display name)
- **Local path**: Read-only display (set at add time)
- **GitHub repo**: Auto-detected, editable override
- **Default workspace type**: Dropdown/radio — policy template selector (Standard PR, Research Only, Permissive)
- **Default agent type**: Dropdown/radio — Claude Code, Echo (dev)

Changes are saved immediately to `repositories.json`.

Replay agent type is intentionally excluded from the repo settings UI — it's a dev/testing tool that doesn't make sense as a repo default. It can be accessed through a separate mechanism if needed (e.g., dev menu).

## Architecture Changes

### New: RepositoryStore (main process)

A new module responsible for CRUD operations on the repository list.

```typescript
// src/main/repository-store.ts

export interface Repository { ... }

export class RepositoryStore {
  private repos: Repository[] = [];
  private configPath: string;  // ~/.config/bouncer/repositories.json

  async load(): Promise<void>;           // Read from disk
  async save(): Promise<void>;           // Write to disk
  list(): Repository[];                  // Return all repos
  get(id: string): Repository | null;
  async add(localPath: string): Promise<Repository>;  // Auto-detect settings
  async update(id: string, changes: Partial<Repository>): Promise<void>;
  async remove(id: string): Promise<void>;
}
```

### Renamed: SessionManager → WorkspaceManager

Mechanical rename of:

- `SessionManager` → `WorkspaceManager`
- `SessionState` → `WorkspaceState`
- `SessionSummary` → `WorkspaceSummary`
- `createSession()` → `createWorkspace()`
- `closeSession()` → `closeWorkspace()`
- etc.

Plus the new `repositoryId` field on `WorkspaceState`/`WorkspaceSummary`, and a new creation path that takes a `repositoryId` instead of raw `(projectDir, agentType, policyId)`:

```typescript
// New primary creation method
async createWorkspace(repositoryId: string): Promise<WorkspaceSummary> {
  const repo = this.repoStore.get(repositoryId);
  if (!repo) throw new Error(`Repository not found: ${repositoryId}`);
  return this._createWorkspace(repo.localPath, repo.defaultAgentType, repo.defaultPolicyId, repositoryId);
}

// Existing creation logic, now internal
private async _createWorkspace(
  projectDir: string,
  agentType: AgentType,
  policyId: string,
  repositoryId: string,
): Promise<WorkspaceSummary> { ... }
```

### IPC Changes

**New channels**:

- `repositories:list` → `Repository[]`
- `repositories:add` → `(localPath: string) => Repository`
- `repositories:update` → `(id: string, changes: Partial<Repository>) => void`
- `repositories:remove` → `(id: string) => void`

**Renamed channels**:

- `sessions:list` → `workspaces:list`
- `sessions:create` → `workspaces:create` (now takes `repositoryId` instead of `(projectDir, agentType, policyId)`)
- `sessions:sendMessage` → `workspaces:sendMessage`
- `sessions:close` → `workspaces:close`
- `sessions:getSandboxViolations` → `workspaces:getSandboxViolations`
- `session-update` → `workspace-update`

**Preload bridge**: `window.glitterball` or `window.bouncer` API updated to match.

### Renderer Changes

**Removed**:

- `NewSessionDialog.tsx` — no longer needed for the common case

**Renamed**:

- `SessionList.tsx` → `WorkspacesSidebar.tsx`

**New/modified**:

- `WorkspacesSidebar.tsx` — two-level hierarchy (repos → workspaces)
- `RepoSettingsPanel.tsx` — inline settings for a repository (or small dialog)
- `App.tsx` — state management updated for repos + workspaces

### Preload Bridge Rename

The preload API can be renamed from `window.glitterball` to `window.bouncer` as part of this milestone, since we're touching all the IPC channels anyway.

## Migration and Compatibility

- No data migration needed — sessions are ephemeral and don't persist
- `repositories.json` is new; first run creates it empty
- The `~/.config/bouncer/` directory is created on first write

## Non-Goals

- **Workspace persistence across restarts**: Workspaces remain ephemeral. Persisting running containers across app restarts is a future consideration.
- **Multi-repo workspaces**: Each workspace belongs to exactly one repo.
- **Workspace templates/presets**: Beyond repo defaults, no per-workspace configuration at creation time. Can be added later if needed.
- **Drag-and-drop reordering**: Repos are displayed in creation order. Reordering is a polish item.
- **Search/filter**: With a small number of repos/workspaces, search isn't needed yet.

## Open Questions

1. **Should we support overriding repo defaults at workspace creation time?** The [+] button uses defaults. If the user occasionally wants a different policy for one workspace, they could: (a) change repo settings, create, change back; (b) we add a long-press or modifier-click for "create with options"; (c) we add a workspace settings panel. Recommendation: start with just the defaults, add override mechanism if users need it.

2. **Should closing all workspaces auto-collapse the repo?** Probably yes — collapsed repos take less space. But keep it expanded briefly so the user sees the workspace was closed.

3. **Should we rename the preload API from `glitterball` to `bouncer`?** Good opportunity since we're touching all channels. Low risk since it's internal.
