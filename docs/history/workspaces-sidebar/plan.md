# Milestone 8: Workspaces Sidebar — Implementation Plan

**Date**: 2026-03-26
**Design**: [design.md](design.md)

This plan breaks M8 into phases, each delivering a testable increment. The rename from "session" to "workspace" is done early (Phase 1) so all subsequent work uses the new terminology.

## Progress

- [x] **[Phase 1: Terminology Rename (session → workspace)](#phase-1-terminology-rename)**
  - [x] 1.1 Rename types: `SessionSummary` → `WorkspaceSummary`, `SessionState` → `WorkspaceState`, etc.
  - [x] 1.2 Rename `SessionManager` class → `WorkspaceManager`, method names (`createSession` → `createWorkspace`, etc.)
  - [x] 1.3 Rename IPC channels: `sessions:*` → `workspaces:*`, `session-update` → `workspace-update`
  - [x] 1.4 Rename preload API: `window.glitterball.sessions.*` → `window.bouncer.workspaces.*`
  - [x] 1.5 Rename renderer state: `activeSessionId` → `activeWorkspaceId`, `messagesBySession` → `messagesByWorkspace`, etc.
  - [x] 1.6 Rename components: `SessionList` → `WorkspacesSidebar`, update imports
  - [x] 1.7 Rename CSS classes: `.session-*` → `.workspace-*`
  - [x] 1.8 Verify: app builds and runs identically to before the rename
- [x] **[Phase 2: Repository Store (persistence layer)](#phase-2-repository-store)**
  - [x] 2.1 Create `Repository` type in `types.ts`
  - [x] 2.2 Create `src/main/repository-store.ts` with `RepositoryStore` class
  - [x] 2.3 Implement `load()` / `save()` to `~/.config/bouncer/repositories.json`
  - [x] 2.4 Implement `add()` with auto-detection (name from dirname, GitHub repo from git remote)
  - [x] 2.5 Implement `update()`, `remove()`, `list()`, `get()`
  - [x] 2.6 Wire into `index.ts`: create store, load at startup
  - [x] 2.7 Test: add/remove/update repos, verify persistence across restart
- [x] **[Phase 3: Repository IPC + Preload Bridge](#phase-3-repository-ipc)**
  - [x] 3.1 Add IPC handlers: `repositories:list`, `repositories:add`, `repositories:update`, `repositories:remove`
  - [x] 3.2 Update preload to expose `window.bouncer.repositories.*`
  - [x] 3.3 Test: renderer can list/add/remove repos via IPC
- [x] **[Phase 4: Workspace–Repository Link](#phase-4-workspace-repository-link)**
  - [x] 4.1 Add `repositoryId` field to `WorkspaceState` and `WorkspaceSummary`
  - [x] 4.2 Add `createWorkspaceFromRepo(repositoryId)` method to `WorkspaceManager`
  - [x] 4.3 Update preload: `workspaces.create(repositoryId)` replaces `sessions.create(projectDir, agentType, policyId)`
  - [x] 4.4 Keep legacy `createWorkspace(projectDir, agentType, policyId, repositoryId)` as internal method
  - [x] 4.5 Test: creating a workspace via repository ID produces a working workspace
- [x] **[Phase 5: Sidebar UI — Repository Hierarchy](#phase-5-sidebar-ui)**
  - [x] 5.1 Rewrite `WorkspacesSidebar.tsx` with two-level hierarchy (repos → workspaces)
  - [x] 5.2 Add "Workspaces" header with [+ Repo] button
  - [x] 5.3 Implement repo rows: name, disclosure triangle, [+] quick-create button
  - [x] 5.4 Implement workspace rows: indented, status dot, label, badges, close button
  - [x] 5.5 Implement collapse/expand state per repo
  - [x] 5.6 Wire [+ Repo] to directory browser → `repositories.add()`
  - [x] 5.7 Wire [+] on repo row to `workspaces.create(repositoryId)`
  - [x] 5.8 Update `App.tsx` state management for repos + grouped workspaces
  - [x] 5.9 Update CSS for hierarchy layout (indentation, repo rows, header)
  - [x] 5.10 Test: full flow — add repo, create workspace, chat, close workspace
- [x] **[Phase 6: Remove NewSessionDialog](#phase-6-remove-dialog)**
  - [x] 6.1 Remove `NewSessionDialog.tsx`
  - [x] 6.2 Remove dialog state and handlers from `App.tsx`
  - [x] 6.3 `dialog.selectDirectory` kept — still used by [+ Repo] flow
  - [x] 6.4 Clean up dead code
- [x] **[Phase 7: Repository Settings](#phase-7-repo-settings)**
  - [x] 7.1 Create `RepoSettings.tsx` component (modal dialog)
  - [x] 7.2 Show: name (editable), local path (read-only), GitHub repo (editable), default policy (selector), default agent type (selector)
  - [x] 7.3 Wire save to `repositories.update()`
  - [x] 7.4 Add right-click context menu on repo rows (Settings, Remove)
  - [x] 7.5 Wire Remove to `repositories.remove()` with active workspace cleanup
  - [x] 7.6 Test: change repo defaults, create workspace, verify it uses updated defaults
- [x] **[Phase 8: Polish + Validation](#phase-8-polish)**
  - [x] 8.1 Auto-expand repo when creating a workspace (auto-expands when hasActive)
  - [x] 8.2 Auto-select newly created workspace
  - [x] 8.3 Empty state when no repos ("Add a repository to get started")
  - [x] 8.4 Handle removed/moved directories gracefully (error surfaces at workspace creation)
  - [x] 8.5 Update `docs/roadmap.md` — add M8, mark complete
  - [x] 8.6 Full end-to-end validation: add repo → create workspace → PR workflow → close

---

## Phase 1: Terminology Rename

**Goal**: Replace "session" terminology with "workspace" throughout the codebase. Pure refactor — zero behavior change.

This is the largest phase by file count but the simplest conceptually. It's a mechanical find-and-replace with type checking to catch any misses.

### Rename map

| Old                             | New                                        |
| ------------------------------- | ------------------------------------------ |
| `SessionSummary`                | `WorkspaceSummary`                         |
| `SessionState`                  | `WorkspaceState`                           |
| `SessionManager`                | `WorkspaceManager`                         |
| `SessionUpdate`                 | `WorkspaceUpdate`                          |
| `SessionSummary['status']`      | `WorkspaceSummary['status']`               |
| `activeSessionId`               | `activeWorkspaceId`                        |
| `messagesBySession`             | `messagesByWorkspace`                      |
| `violationsBySession`           | `violationsByWorkspace`                    |
| `policyEventsBySession`         | `policyEventsByWorkspace`                  |
| `streamingTextRef`              | (unchanged — not session-specific in name) |
| `session-update` (IPC channel)  | `workspace-update`                         |
| `sessions:list`                 | `workspaces:list`                          |
| `sessions:create`               | `workspaces:create`                        |
| `sessions:sendMessage`          | `workspaces:sendMessage`                   |
| `sessions:close`                | `workspaces:close`                         |
| `sessions:getSandboxViolations` | `workspaces:getSandboxViolations`          |
| `sessions:loadReplayData`       | `workspaces:loadReplayData`                |
| `window.glitterball`            | `window.bouncer`                           |
| `SessionList` component         | `WorkspacesSidebar` component              |
| `NewSessionDialog` component    | (kept for now, renamed in Phase 6)         |
| `.session-list` CSS             | `.workspaces-sidebar`                      |
| `.session-item` CSS             | `.workspace-item`                          |
| `.new-session-btn` CSS          | `.new-workspace-btn`                       |

### Files changed

| File                                                                    | Change                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/main/types.ts`                                                     | Rename types                                                              |
| `src/main/session-manager.ts` → `src/main/workspace-manager.ts`         | Rename file + class + methods                                             |
| `src/main/index.ts`                                                     | Update imports and references                                             |
| `src/preload/index.ts`                                                  | Rename API surface (`glitterball` → `bouncer`, `sessions` → `workspaces`) |
| `src/preload/index.d.ts`                                                | Update type declarations                                                  |
| `src/renderer/src/App.tsx`                                              | Rename state vars, IPC references, component usage                        |
| `src/renderer/src/components/SessionList.tsx` → `WorkspacesSidebar.tsx` | Rename file + component                                                   |
| `src/renderer/src/components/ChatPanel.tsx`                             | Update prop types if referencing session types                            |
| `src/renderer/src/components/MessageInput.tsx`                          | Update prop types if referencing session types                            |
| `src/renderer/src/components/NewSessionDialog.tsx`                      | Update imports (keep component for now)                                   |
| `src/renderer/src/index.css`                                            | Rename CSS classes                                                        |

### Approach

Use TypeScript's compiler as a safety net:

1. Rename the types first (in `types.ts`) — this breaks all consumers
2. Fix each consumer file — TypeScript errors guide the work
3. Rename IPC channels (string literals — must grep for these)
4. Rename CSS classes (also string literals — grep)
5. Build, verify no errors, run the app

### Exit criteria

- `npm run build` succeeds with zero errors
- App runs and behaves identically to before
- No remaining references to "session" in code (except `acpSessionId` in ACP protocol layer, which is external terminology)

---

## Phase 2: Repository Store

**Goal**: A persistence layer for repository entries, read/written to `~/.config/bouncer/repositories.json`.

### New type in `src/main/types.ts`

```typescript
export interface Repository {
  id: string
  name: string
  localPath: string
  githubRepo: string | null
  defaultPolicyId: string
  defaultAgentType: AgentType
  createdAt: number
}
```

### New file: `src/main/repository-store.ts`

```typescript
export class RepositoryStore {
  private repos: Repository[] = []
  private configPath: string

  constructor(configDir?: string) {
    // Default: ~/.config/bouncer
    this.configPath = path.join(configDir ?? path.join(os.homedir(), '.config', 'bouncer'), 'repositories.json')
  }

  async load(): Promise<void>
  async save(): Promise<void>
  list(): Repository[]
  get(id: string): Repository | null
  async add(localPath: string): Promise<Repository>
  async update(id: string, changes: Partial<Omit<Repository, 'id' | 'createdAt'>>): Promise<void>
  async remove(id: string): Promise<void>
}
```

**`add(localPath)`** implementation:

1. Validate: `git -C {localPath} rev-parse --git-dir` (must be a git repo)
2. Auto-detect name: `path.basename(localPath)`
3. Auto-detect GitHub repo: `git -C {localPath} remote get-url origin` → parse `github.com:owner/repo` or `github.com/owner/repo`
4. Set defaults: `defaultPolicyId = "standard-pr"`, `defaultAgentType = "claude-code"`
5. Generate UUID, create `Repository`, append to list, save

**`save()`** implementation:

- `fs.mkdir(path.dirname(configPath), { recursive: true })` (ensure dir exists)
- `fs.writeFile(configPath, JSON.stringify(repos, null, 2))`
- Atomic write (write to temp file, rename) for crash safety

**`load()`** implementation:

- If file doesn't exist → empty list (first run)
- Parse JSON, validate shape, populate `repos`

### Changes to `src/main/index.ts`

```typescript
const repoStore = new RepositoryStore();
await repoStore.load();
const workspaceManager = new WorkspaceManager(repoStore, ...);
```

### Testing

- Unit: `RepositoryStore` with temp config directory — add, list, remove, save/load roundtrip
- Unit: GitHub repo URL parsing (SSH and HTTPS formats)
- Manual: add a repo, restart app, verify repo is still there

### Exit criteria

- Repos persist across app restarts
- Auto-detection correctly identifies repo name and GitHub URL
- Invalid paths (not git repos) are rejected with a clear error

---

## Phase 3: Repository IPC + Preload Bridge

**Goal**: Expose repository CRUD to the renderer process.

### Changes to `src/main/index.ts`

Add IPC handlers:

```typescript
ipcMain.handle('repositories:list', () => repoStore.list())
ipcMain.handle('repositories:add', (_, localPath: string) => repoStore.add(localPath))
ipcMain.handle('repositories:update', (_, id: string, changes) => repoStore.update(id, changes))
ipcMain.handle('repositories:remove', (_, id: string) => repoStore.remove(id))
```

### Changes to preload

```typescript
bouncer: {
  repositories: {
    list: () => ipcRenderer.invoke('repositories:list'),
    add: (localPath: string) => ipcRenderer.invoke('repositories:add', localPath),
    update: (id: string, changes: Partial<Repository>) => ipcRenderer.invoke('repositories:update', id, changes),
    remove: (id: string) => ipcRenderer.invoke('repositories:remove', id),
  },
  workspaces: { ... },
  policies: { ... },
  dialog: { ... },
}
```

### Exit criteria

- Renderer can call `window.bouncer.repositories.list()` and get back the persisted repo list
- Add/update/remove from renderer persists to disk

---

## Phase 4: Workspace–Repository Link

**Goal**: Workspaces are created via a repository ID, inheriting the repo's default settings.

### Changes to `src/main/types.ts`

Add to `WorkspaceSummary`:

```typescript
repositoryId: string
```

### Changes to `src/main/workspace-manager.ts`

New public method:

```typescript
async createWorkspace(repositoryId: string): Promise<WorkspaceSummary> {
  const repo = this.repoStore.get(repositoryId);
  if (!repo) throw new Error(`Repository not found: ${repositoryId}`);
  return this._createWorkspaceInternal(repo.localPath, repo.defaultAgentType, repo.defaultPolicyId, repositoryId);
}
```

The existing `createSession(projectDir, agentType, policyId)` becomes `_createWorkspaceInternal(...)` with the additional `repositoryId` parameter.

### Changes to IPC

`workspaces:create` handler now takes `(repositoryId: string)` instead of `(projectDir, agentType, policyId)`.

### Changes to preload

```typescript
workspaces: {
  create: (repositoryId: string) => ipcRenderer.invoke('workspaces:create', repositoryId),
  ...
}
```

### Exit criteria

- `workspaces.create(repoId)` creates a workspace using the repo's defaults
- `WorkspaceSummary.repositoryId` is populated

---

## Phase 5: Sidebar UI — Repository Hierarchy

**Goal**: Replace the flat session list with a two-level repo → workspace hierarchy.

This is the most visible phase. The sidebar gains repository grouping, disclosure triangles, and quick-create buttons.

### Changes to `WorkspacesSidebar.tsx`

Complete rewrite. New component structure:

```tsx
function WorkspacesSidebar({ repos, workspaces, activeWorkspaceId, ... }) {
  return (
    <div className="workspaces-sidebar">
      <div className="sidebar-header">
        <span>Workspaces</span>
        <button onClick={onAddRepo}>+ Repo</button>
      </div>
      {repos.map(repo => (
        <RepoGroup
          key={repo.id}
          repo={repo}
          workspaces={workspaces.filter(w => w.repositoryId === repo.id)}
          activeWorkspaceId={activeWorkspaceId}
          onCreateWorkspace={() => onCreateWorkspace(repo.id)}
          onSelectWorkspace={onSelectWorkspace}
          onCloseWorkspace={onCloseWorkspace}
        />
      ))}
      {repos.length === 0 && <EmptyState />}
    </div>
  );
}

function RepoGroup({ repo, workspaces, ... }) {
  const [expanded, setExpanded] = useState(true);
  const hasActive = workspaces.some(w => w.status !== 'closed');
  // Auto-expand when workspaces exist
  // Render: disclosure triangle, repo name, [+] button, workspace list
}
```

### Changes to `App.tsx`

New state:

```typescript
const [repos, setRepos] = useState<Repository[]>([])
```

On mount:

```typescript
window.bouncer.repositories.list().then(setRepos)
```

New handlers:

```typescript
async function handleAddRepo() {
  const dir = await window.bouncer.dialog.selectDirectory()
  if (!dir) return
  const repo = await window.bouncer.repositories.add(dir)
  setRepos((prev) => [...prev, repo])
}

async function handleCreateWorkspace(repositoryId: string) {
  const ws = await window.bouncer.workspaces.create(repositoryId)
  // ... same as current session creation handling
}
```

### CSS changes

New classes for the hierarchy layout:

- `.sidebar-header` — fixed top bar with title and add button
- `.repo-group` — container for a repo and its workspaces
- `.repo-row` — the repository entry (flex: triangle, name, + button)
- `.workspace-item` — workspace entry (indented under repo)
- `.repo-row .create-btn` — the [+] button on repo rows

### Exit criteria

- Sidebar shows repos with workspaces grouped underneath
- [+ Repo] opens directory browser and adds repo
- [+] on repo creates workspace with defaults
- Workspace selection, closing, badges all work as before

---

## Phase 6: Remove NewSessionDialog

**Goal**: Clean up the now-unused session creation dialog.

### Files removed

- `src/renderer/src/components/NewSessionDialog.tsx`

### Changes

- `App.tsx`: remove `showNewSession` state, dialog rendering, `handleCreateSession` handler
- `index.ts`: optionally remove `dialog:selectDirectory` IPC if not used elsewhere (still needed for [+ Repo])

Actually, `dialog.selectDirectory` is still needed for the [+ Repo] flow. Keep it.

### Exit criteria

- No modal dialog anywhere in the app
- Clean build, no dead imports

---

## Phase 7: Repository Settings

**Goal**: Users can view and edit repository settings (default policy, agent type, GitHub repo, name).

### New component: `RepoSettings.tsx`

A small inline panel or popover that opens when the user right-clicks a repo and selects "Settings".

Contents:

- **Name**: text input (saves on blur/enter)
- **Local path**: read-only, monospace text
- **GitHub repo**: text input (auto-detected, editable)
- **Default policy**: radio buttons or dropdown (from policy template list)
- **Default agent type**: radio buttons (Claude Code, Echo)

### Context menu

Add a right-click context menu to repo rows:

- "Settings" → opens settings panel
- "Remove" → confirmation dialog if active workspaces exist, then `repositories.remove(id)`

Electron context menus can be done via:

- `onContextMenu` event → IPC to main → `Menu.buildFromTemplate().popup()`
- Or: pure renderer-side context menu component

Recommend renderer-side for simplicity — no IPC round-trip, easier to style consistently.

### Exit criteria

- Right-click on repo shows context menu
- Settings panel lets user change name, GitHub repo, default policy, default agent type
- Changes persist and affect subsequent workspace creation

---

## Phase 8: Polish + Validation

**Goal**: Edge cases, empty states, and full end-to-end validation.

### Polish items

- **Auto-expand**: When a workspace is created, auto-expand its repo group
- **Auto-select**: When a workspace is created, auto-select it
- **Empty state**: When no repos exist, show "Add a repository to get started" with a prominent button
- **Stale repos**: If a repo's `localPath` no longer exists, show a warning indicator on the repo row. Don't auto-remove (the user may have unmounted a drive temporarily).
- **Repo deduplication**: Prevent adding the same path twice

### Validation checklist

- [ ] Fresh start (no `repositories.json`): empty state shown, add repo works
- [ ] Add repo: directory browser opens, repo appears in sidebar
- [ ] Quick-create workspace: [+] on repo creates workspace, appears under repo, auto-selected
- [ ] Multiple repos: workspaces grouped correctly under their repos
- [ ] Workspace lifecycle: create → chat → close, all working
- [ ] Full PR workflow: create workspace → agent codes → pushes → creates PR
- [ ] Repo settings: change default policy → new workspace uses updated policy
- [ ] Remove repo: confirmation if active workspaces, then removed from sidebar and disk
- [ ] Persistence: close app, reopen, repos still there
- [ ] Collapse/expand: disclosure triangles work, auto-expand on workspace creation

### Exit criteria

- All validation checklist items pass
- Roadmap updated with M8

---

## Phase Dependency Graph

```
Phase 1 (terminology rename)
  │
  ▼
Phase 2 (repository store)
  │
  ▼
Phase 3 (repository IPC)
  │
  ▼
Phase 4 (workspace–repo link)
  │
  ▼
Phase 5 (sidebar UI) ───► Phase 6 (remove dialog)
  │
  ▼
Phase 7 (repo settings)
  │
  ▼
Phase 8 (polish + validation)
```

All phases are sequential — each builds on the previous. Phase 6 can happen any time after Phase 5.

---

## Risk Checkpoints

| After Phase | Check                                               |
| ----------- | --------------------------------------------------- |
| Phase 1     | App builds and runs identically (pure refactor)     |
| Phase 2     | Repos persist to disk and survive restart           |
| Phase 3     | Renderer can CRUD repos via IPC                     |
| Phase 4     | Workspace creation via repo ID works end-to-end     |
| Phase 5     | Sidebar shows grouped hierarchy, quick-create works |
| Phase 6     | Dialog removed, no dead code                        |
| Phase 7     | Settings changes affect new workspace creation      |
| Phase 8     | Full PR workflow, edge cases handled                |

---

## Estimated Scope

| Phase                   | Files changed         | Complexity            |
| ----------------------- | --------------------- | --------------------- |
| Phase 1 (rename)        | ~15 files             | Low (mechanical)      |
| Phase 2 (repo store)    | 3 new/modified        | Low                   |
| Phase 3 (IPC)           | 3 modified            | Low                   |
| Phase 4 (link)          | 4 modified            | Low                   |
| Phase 5 (sidebar UI)    | 3 modified            | Medium (main UI work) |
| Phase 6 (remove dialog) | 2 modified, 1 deleted | Low                   |
| Phase 7 (repo settings) | 2 new/modified        | Medium                |
| Phase 8 (polish)        | 3 modified            | Low                   |
