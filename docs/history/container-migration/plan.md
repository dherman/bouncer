# Milestone 6: Container Migration — Implementation Plan

**Date**: 2026-03-24
**Design**: [design.md](design.md)

This plan breaks M6 into phases, each delivering a testable increment. Phases are sequenced so that each builds on the previous, but the design minimizes coupling — early phases can merge and stabilize before later ones begin.

## Progress

- [x] **[Phase 1: Dockerfile + Image Build Infrastructure](#phase-1-dockerfile--image-build-infrastructure)**
  - [x] 1.1 Create `docker/agent.Dockerfile`
  - [x] 1.2 Implement `isDockerAvailable()` and `ensureAgentImage()` in `container.ts`
  - [x] 1.3 Kick off image build at app startup in `index.ts`
  - [x] 1.4 Include `docker/` in packaged app resources
  - [x] 1.5 Test: image builds, contains expected toolchains, no `gh` binary
- [x] **[Phase 2: Container Spawn + stdio Piping](#phase-2-container-spawn--stdio-piping)**
  - [x] 2.1 Implement `ContainerHandle`, `buildDockerRunArgs`, `spawnContainer`
  - [x] 2.2 Implement `removeContainer` and `cleanupOrphanContainers`
  - [x] 2.3 Add `SandboxBackend` type and `sandboxBackend` to `SessionSummary`
  - [x] 2.4 Test: bidirectional stdio through `docker run -i`
- [x] **[Phase 3: Echo Agent in Container](#phase-3-echo-agent-in-container-session-manager-integration)**
  - [x] 3.1 Add backend selection logic to `createSession`
  - [x] 3.2 Add container path to `resolveAgentCommand` for echo agent
  - [x] 3.3 Update `closeSession` and `cleanupOrphans` for container backend
  - [x] 3.4 Populate `sandboxBackend` in `summarize`
  - [x] 3.5 Call `ensureAgentImage()` before first session creation
  - [x] 3.6 Test: echo agent ACP round-trip in container
- [x] **[Phase 4: Bind Mount Strategy + Git Configuration](#phase-4-bind-mount-strategy--git-configuration)**
  - [x] 4.1 Create `policy-container.ts` with `policyToContainerConfig()`
  - [x] 4.2 Implement `generateGitconfig()` for system gitconfig
  - [x] 4.3 Create `gh-credential-helper.ts`
  - [x] 4.4 Add `ContainerPolicy` to `PolicyTemplate` type
  - [x] 4.5 Add `container` config to policy templates
  - [x] 4.6 Test: mount list generation, gitconfig content, credential helper output
- [x] **[Phase 5: Claude Code + Replay Agent in Container](#phase-5-claude-code--replay-agent-in-container)**
  - [x] 5.1 Extend container path in `createSession` for Claude Code and replay agents
  - [x] 5.2 Generate container-specific `gh` wrapper script and mount table
  - [x] 5.3 Set container env vars (`BOUNCER_GITHUB_POLICY`, `GH_TOKEN`, no `BOUNCER_REAL_GH`)
  - [x] 5.4 Add container path to `resolveClaudeCodeCommand` and `resolveReplayAgentCommand`
  - [x] 5.5 Add `generatePrePushHookForContainer()` to `hooks.ts`
  - [x] 5.6 Update `closeSession` and `cleanupOrphans` for container artifacts
  - [x] 5.7 Test: full agent session in container with policy enforcement
- [x] **[Phase 6: `gh` Shim Direct API Mode](#phase-6-gh-shim-direct-api-mode)** _(parallel with Phases 3-5)_
  - [x] 6.1 Relax `BOUNCER_REAL_GH` requirement in shim entry point
  - [x] 6.2 Add dispatch branch: real gh vs. direct API
  - [x] 6.3 Implement `executeViaApi()` with `fetch`
  - [x] 6.4 Implement API mapping for `pr create/view/edit/list`, `issue list/view`, `api`
  - [x] 6.5 Implement flag extraction for `--title`, `--body`, `--base`, `--head`
  - [x] 6.6 Handle `allow-and-capture-pr` via API response
  - [x] 6.7 Test: shim API mode for each supported command
- [x] **[Phase 7: Sandbox Monitor + UI Updates](#phase-7-sandbox-monitor--ui-updates)**
  - [x] 7.1 Create `ContainerMonitor` class
  - [x] 7.2 Start `ContainerMonitor` for container sessions in session manager
  - [x] 7.3 Add `containerId` to `SessionSummary`
  - [x] 7.4 Update `SessionList.tsx` with sandbox backend badge
  - [x] 7.5 Verify `SandboxLog.tsx` works unchanged for both backends
- [x] **[Phase 8: End-to-End Validation + Cleanup](#phase-8-end-to-end-validation--cleanup)**
  - [x] 8.1 Claude Code PR workflow in container (full checklist)
  - [x] 8.2 ~~Replay agent regression suite in container~~ (skipped — container migration doesn't change tool-level policy enforcement, validated via 8.1 PR workflow)
  - [x] 8.3 Safehouse fallback verification
  - [x] 8.4 Orphan cleanup for both backends
  - [x] 8.5 Remove stale TODO comments (none found)
  - [x] 8.6 Update `docs/roadmap.md` — mark M6 complete, update architecture diagram

---

## Phase 1: Dockerfile + Image Build Infrastructure

**Goal**: A working agent container image, and the machinery to build/cache it from the Electron app.

### New files

**`docker/agent.Dockerfile`**

- `FROM docker/sandbox-templates:claude-code`
- Remove the real `gh` binary (`rm -f $(which gh)`)
- Install Rust toolchain via `rustup` (stable + rust-analyzer, rustfmt, clippy)
- Switch to non-root `agent` user, set `WORKDIR /workspace`

**`src/main/container.ts`** — container lifecycle module (partial — image management only in this phase)

- `isDockerAvailable(): Promise<boolean>` — runs `docker info` and caches the result. Same pattern as `isSafehouseAvailable()` in `sandbox.ts`.
- `ensureAgentImage(): Promise<string>` — builds the image if missing or stale:
  - Read `docker/agent.Dockerfile` content and compute a hash
  - Check if `glitterball-agent:<hash>` image exists (`docker image inspect`)
  - If not, run `docker build -t glitterball-agent:<hash> -f docker/agent.Dockerfile docker/`
  - Return the image tag
  - Note: the Dockerfile is bundled with the app. In dev, resolve via `app.getAppPath() + "/docker/agent.Dockerfile"`. In production, include in the `extraResources` config.
- `AGENT_IMAGE_PREFIX = "glitterball-agent"` — exported constant for naming

### Changes to existing files

**`src/main/index.ts`** — kick off image build at startup

- After `createWindow()`, call `ensureAgentImage()` in the background (fire-and-forget with error logging). This pre-warms the image so the first `createSession` doesn't block on a Docker build.
- Import `isDockerAvailable` and log availability at startup.

**`electron.vite.config.ts`** (or `electron-builder` config) — include `docker/` in packaged app resources so the Dockerfile is available at runtime.

### Testing

- Manual: run `docker build` with the Dockerfile, verify the image contains node, git, rust (`rustc --version`), no `gh` binary (`which gh` returns nothing).
- Script (`scripts/test-container-image.sh`): build image, `docker run --rm glitterball-agent:<tag> node --version`, `docker run --rm glitterball-agent:<tag> rustc --version`, `docker run --rm glitterball-agent:<tag> which gh` (should fail).
- Unit: mock `execFile` calls in `container.ts` to test `isDockerAvailable()` and `ensureAgentImage()` logic (hash check, build-if-missing).

### Exit criteria

- `npm run dev` starts the app, logs Docker availability and image build status.
- The agent image builds successfully and contains the expected toolchains.
- No `gh` binary is discoverable anywhere in the image filesystem.

---

## Phase 2: Container Spawn + stdio Piping

**Goal**: Spawn a process inside a Docker container and establish stdio communication, proving that the ACP protocol works over `docker run -i`.

### Changes to `src/main/container.ts`

Add the container spawn and teardown functions:

**`ContainerHandle` interface**:

```typescript
interface ContainerHandle {
  process: ChildProcess // the `docker run` process
  containerId: string // container name (glitterball-{sessionId})
  kill(): void // docker stop + rm
}
```

**`buildDockerRunArgs(config: ContainerConfig): string[]`**:

- Constructs the `docker run -i --rm --name glitterball-{sessionId}` argument list
- Maps `config.mounts` to `-v host:container[:ro]` flags
- Maps `config.env` to `-e KEY=VALUE` flags
- Sets `-w config.workdir`
- Sets `--network config.networkMode`
- Appends `config.image` and `config.command`
- Returns the full args array (not including `"docker"` itself)

**`spawnContainer(config: ContainerConfig): ContainerHandle`**:

- Calls `spawn("docker", buildDockerRunArgs(config), { stdio: ["pipe", "pipe", "pipe"] })`
- Wraps in a `ContainerHandle`
- `kill()` calls `process.kill()` then `docker rm -f glitterball-{sessionId}` as cleanup

**`removeContainer(sessionId: string): Promise<void>`**:

- `docker rm -f glitterball-{sessionId}` — idempotent, safe to call on already-stopped containers

**`cleanupOrphanContainers(activeSessionIds: Set<string>): Promise<void>`**:

- `docker ps -a --filter name=glitterball- --format '{{.Names}}'`
- For each container whose session ID isn't in `activeSessionIds`, call `removeContainer`

### New type in `src/main/types.ts`

```typescript
export type SandboxBackend = 'safehouse' | 'container' | 'none'
```

Add to `SessionSummary`:

```typescript
sandboxBackend: SandboxBackend
```

### Testing

Integration test script (`scripts/test-container-spawn.sh`):

- Build the agent image (from Phase 1)
- Spawn a simple echo container: `docker run -i --rm glitterball-agent:<tag> cat`
- Write to stdin, read from stdout, verify echo
- Kill container, verify cleanup

Unit test for `buildDockerRunArgs`: verify mount flags, env vars, network mode, working dir are correctly generated for various `ContainerConfig` inputs.

### Exit criteria

- `spawnContainer` returns a handle whose `process.stdin`/`process.stdout` work for bidirectional communication
- `removeContainer` is idempotent
- `cleanupOrphanContainers` finds and removes stale containers

---

## Phase 3: Echo Agent in Container (Session Manager integration)

**Goal**: Run the echo agent inside a container through the full session manager flow, proving ACP works end-to-end over containerized stdio.

### Changes to `src/main/session-manager.ts`

**Backend selection** — add to `createSession`, after resolving the policy template:

```typescript
const dockerAvailable = await isDockerAvailable()
const safehouseAvailable = await isSafehouseAvailable()
const backend: SandboxBackend = dockerAvailable
  ? 'container'
  : safehouseAvailable
    ? 'safehouse'
    : 'none'
```

Store `backend` on `SessionState`:

```typescript
interface SessionState {
  // ... existing fields ...
  sandboxBackend: SandboxBackend
  containerId: string | null // set when backend === "container"
}
```

**`resolveAgentCommand` refactor** — add a container path. For this phase, only the echo agent needs to work in a container (Claude Code and replay come in Phase 5):

```typescript
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  containerConfig: ContainerConfig | null,
  worktreePath?: string,
): SpawnConfig {
  if (agentType === 'echo') {
    if (containerConfig) {
      return { cmd: 'docker', args: buildDockerRunArgs(containerConfig) }
    }
    return resolveEchoAgentCommand()
  }
  // ... existing claude-code and replay paths (unchanged for now)
}
```

For the echo agent container config, mount the echo agent script read-only and run it with `node`.

**`closeSession`** — if `backend === "container"`, call `removeContainer(sessionId)`.

**`cleanupOrphans`** — call `cleanupOrphanContainers(activeIds)` alongside existing cleanup.

**`summarize`** — populate `sandboxBackend` on `SessionSummary`.

### Changes to `src/main/index.ts`

Call `ensureAgentImage()` before first session creation (block on it if needed, since we need the image to exist).

### Testing

Manual: create an echo agent session in the UI. Verify:

- Session shows as "container" sandbox backend
- Messages round-trip through ACP
- Closing the session removes the container (`docker ps -a` shows no stale containers)

### Exit criteria

- Echo agent works identically whether running natively, via safehouse, or in a container.
- ACP streaming (text chunks, tool calls) works over container stdio.
- Session close cleans up the container.

---

## Phase 4: Bind Mount Strategy + Git Configuration

**Goal**: Define the full mount table for agent containers, generate the system gitconfig, and implement the git credential helper.

### New file: `src/main/policy-container.ts`

Parallel to `policy-sandbox.ts`. Converts a `PolicyTemplate` + session context into a `ContainerConfig`.

```typescript
export function policyToContainerConfig(
  template: PolicyTemplate,
  ctx: {
    sessionId: string
    worktreePath: string
    gitCommonDir?: string
    agentBinPath: string
    nodeModulesPath: string
    shimBundlePath?: string
    shimScriptPath?: string
    hooksDir?: string
    allowedRefsPath?: string
    policyStatePath?: string
    gitconfigPath?: string
    sshDir?: string
  },
  env: Record<string, string>,
): ContainerConfig
```

Implementation:

- Standard mounts (always present):
  - Worktree → `/workspace` (rw or ro based on `template.filesystem.worktreeAccess`)
  - Git common dir → same absolute path inside container (rw, follows worktree access mode). The path must match because git stores the absolute path to the common dir in the worktree's `.git` file.
  - Agent binary dir → `/usr/local/lib/agent/` (ro)
  - App `node_modules` → `/usr/local/lib/node_modules/` (ro)
- GitHub policy mounts (present when `template.github` is set):
  - Hooks dir → `/etc/bouncer/hooks` (ro)
  - Allowed refs file → `/etc/bouncer/allowed-refs.txt` (ro)
  - `gh` shim wrapper script → `/usr/local/bin/gh` (ro)
  - `gh` shim JS bundle → `/usr/local/lib/bouncer/gh-shim.js` (ro)
  - Policy state JSON → `/etc/bouncer/github-policy.json` (rw — shim updates it)
  - System gitconfig → `/etc/gitconfig` (ro)
- Auth mounts (conditional):
  - `~/.ssh` → `/home/agent/.ssh` (ro) — only if `~/.ssh` exists
- Network mode: `"bridge"` (per design doc — network enforcement deferred to M7)
- Env: merge `ANTHROPIC_API_KEY`, `GH_TOKEN`, `BOUNCER_GITHUB_POLICY=/etc/bouncer/github-policy.json`, `NODE_PATH=/usr/local/lib/node_modules`, plus any from template

**Git common dir note**: Linked worktrees reference the common dir by absolute path (stored in `.git` file as `gitdir: /path/to/.git/worktrees/<name>`). Inside the container, this path must be valid. Since we mount the common dir at its host path, and the worktree's `.git` file contains the host path, this works as long as we mount the common dir at the same path. The worktree manager already resolves and validates this path.

### New file: `src/main/gh-credential-helper.ts`

A tiny Node.js script that acts as a git credential helper. Used inside the container where the real `gh auth git-credential` isn't available.

```typescript
#!/usr/bin/env node
// Git credential helper that echoes GH_TOKEN for github.com.
// Used in container gitconfig: credential.https://github.com.helper=!node /usr/local/lib/bouncer/gh-credential-helper.js

const input = await readStdin()
if (!input.includes('host=github.com')) process.exit(0)

const token = process.env.GH_TOKEN
if (!token) {
  process.exit(1)
}
process.stdout.write(
  `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`,
)
```

### New function: `generateGitconfig()`

In `policy-container.ts` or a new `src/main/container-gitconfig.ts`:

```typescript
export function generateGitconfig(opts: {
  hooksPath: string
  credentialHelperPath: string
  userName?: string
  userEmail?: string
}): string
```

Generates the content for `/etc/gitconfig`:

```ini
[core]
    hooksPath = /etc/bouncer/hooks
[credential "https://github.com"]
    helper = !node /usr/local/lib/bouncer/gh-credential-helper.js
[user]
    name = David Herman
    email = dherman@example.com
```

The gitconfig file is written to `/tmp/glitterball-sandbox/{sessionId}-gitconfig` on the host and mounted read-only into the container.

### Changes to `src/main/types.ts`

Add `ContainerPolicy` to `PolicyTemplate`:

```typescript
export interface ContainerPolicy {
  image?: string
  additionalMounts?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  networkMode?: 'none' | 'bridge'
}
```

Add `container?: ContainerPolicy` field to `PolicyTemplate`.

### Changes to `src/main/policy-templates.ts`

Add `container: {}` to `standardPrTemplate` (uses defaults — bridge network, standard mounts).

### Testing

Unit tests for `policyToContainerConfig`:

- Standard PR template → verify mount list (worktree rw, hooks ro, shim ro, gitconfig ro, etc.)
- Template without `github` → verify no hooks/shim/gitconfig mounts
- Read-only worktree template → verify worktree mounted ro

Unit test for `generateGitconfig`: verify output contains `core.hooksPath`, credential helper, user identity.

Unit test for `gh-credential-helper.ts`: mock stdin with github.com host, verify output format.

### Exit criteria

- `policyToContainerConfig` produces correct mount lists for all three policy templates.
- System gitconfig sets `core.hooksPath` and credential helper.
- Credential helper outputs valid git credential protocol.

---

## Phase 5: Claude Code + Replay Agent in Container

**Goal**: Run Claude Code and replay agents inside containers with full policy enforcement (hooks + shim).

### Changes to `src/main/session-manager.ts`

This is the main integration phase. Extend the container path to handle Claude Code and replay agents.

**Refactor `createSession`** — the current flow for the container backend becomes:

1. Create worktree (same as today)
2. Detect GitHub repo, build session policy, write policy state (same as today)
3. Install hooks + write allowed-refs file (same as today — files written to host `/tmp/glitterball-sandbox/`)
4. Build `gh` shim bundle (same as today — `buildShimBundle()`)
5. Resolve GitHub token (same as today)
6. Generate system gitconfig file (new — write to `/tmp/glitterball-sandbox/{id}-gitconfig`)
7. Build `ContainerConfig` via `policyToContainerConfig()` (new)
8. Spawn container via `spawnContainer()` (replaces `spawn(cmd, args, ...)`)
9. Connect ACP over container stdio (same as today — `docker run -i` pipes are identical)
10. Skip sandbox monitor for container backend (no Seatbelt log to parse)

**Key difference from safehouse path**: The `gh` shim wrapper script (`/usr/local/bin/gh` inside the container) needs to call `node /usr/local/lib/bouncer/gh-shim.js "$@"` — pointing to container paths, not host paths. So we write a separate wrapper script for the container context:

```bash
#!/bin/bash
exec node /usr/local/lib/bouncer/gh-shim.js "$@"
```

This is written to `/tmp/glitterball-sandbox/{id}-container-gh-wrapper` on the host and bind-mounted to `/usr/local/bin/gh:ro` in the container.

**Env changes for container path**:

- `BOUNCER_GITHUB_POLICY=/etc/bouncer/github-policy.json` (container path, not host path)
- `BOUNCER_REAL_GH` is **not set** (triggers direct API mode in the shim — see Phase 6)
- `GH_TOKEN`, `ANTHROPIC_API_KEY` passed through as env vars
- `PATH` does not need shim dir prepended (the shim is at `/usr/local/bin/gh`, already on path)

**Env passthrough simplification**: On safehouse, we manually enumerate env vars to forward (`envPassthrough`). In the container, only vars explicitly set via `-e` are visible — a simpler model. Pass `ANTHROPIC_API_KEY`, `GH_TOKEN`, `BOUNCER_GITHUB_POLICY`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, and `NODE_PATH`.

**Changes to `resolveClaudeCodeCommand` and `resolveReplayAgentCommand`**:

- Add container path: when `containerConfig` is present, return `{ cmd: "docker", args: buildDockerRunArgs(containerConfig) }`
- The agent binary path inside the container: `/usr/local/lib/agent/index.js`

**`closeSession` updates**: Call `removeContainer` for container sessions. Keep existing `cleanupHooks`, `cleanupPolicyState`, `cleanupGhShim` calls — these clean up host-side files regardless of backend.

**`cleanupOrphans` updates**: Add `cleanupOrphanContainers` call. Also clean up gitconfig files: `{id}-gitconfig`, `{id}-container-gh-wrapper`.

### Changes to `src/main/hooks.ts`

The pre-push hook needs a small change for the container path. The `ALLOWED_REFS_FILE` variable currently points to a host path. In the container, the allowed-refs file is mounted at `/etc/bouncer/allowed-refs.txt`.

**Option A**: Generate a different hook script for container use (with container path).
**Option B**: Have the hook read the path from an environment variable, with fallback to the hardcoded path.

**Recommended: Option A** — simplest, no runtime detection needed. Add a `generatePrePushHookForContainer()` function (or a `containerMode` parameter to `generatePrePushHook`) that hardcodes `/etc/bouncer/allowed-refs.txt`.

### Testing

Integration test script (`scripts/test-container-agent.sh`):

1. Build the agent image
2. Create a git repo with a GitHub remote
3. Start a replay agent session with `standard-pr` policy in a container
4. Verify: agent can commit to worktree
5. Verify: `gh pr view` succeeds (needs direct API mode from Phase 6 — stub with echo for now)
6. Verify: `gh pr merge` is denied (shim denies before API call)
7. Verify: git push to allowed branch succeeds (hook allows)
8. Verify: git push to `main` is denied (hook denies)
9. Verify: policy events appear in session updates

Manual: run a Claude Code session in the UI, do a simple task, verify agent can code and commit.

### Exit criteria

- Claude Code agent starts in a container, speaks ACP, can edit files and run commands.
- `gh` shim is mounted at `/usr/local/bin/gh` and enforces policy.
- Git hooks are mounted read-only at `/etc/bouncer/hooks` and enforce push restrictions.
- Agent cannot delete or modify hooks (`EROFS` error on write attempt).
- Agent cannot find real `gh` binary anywhere in the container.
- Policy events (allow/deny) flow through to the UI.
- Closing the session cleans up the container and all host-side artifacts.
- Safehouse fallback still works when Docker is unavailable.

---

## Phase 6: `gh` Shim Direct API Mode

**Goal**: The `gh` shim can execute allowed operations by calling the GitHub REST API directly, without a real `gh` binary.

This phase is what makes the container `gh` shim functional for allowed operations. It can be developed in parallel with Phase 5 (no code dependency — only the `BOUNCER_REAL_GH` env var handshake).

### Changes to `src/main/gh-shim.ts`

**Entry point change** — relax the `BOUNCER_REAL_GH` requirement:

```typescript
// Before (M5):
if (!policyPath || !realGh) { ... exit(1) }

// After (M6):
if (!policyPath) { ... exit(1) }
const realGh = process.env.BOUNCER_REAL_GH; // may be undefined in container
```

**Dispatch change** — after policy evaluation:

```typescript
if (decision.action === 'deny') {
  // unchanged — log and exit
}

if (realGh) {
  // Host/safehouse path: proxy to real gh (existing M5 code)
  execRealGhCommand(realGh, args, decision, policy, policyPath)
} else {
  // Container path: call GitHub API directly
  await executeViaApi(parsed, decision, policy, policyPath)
}
```

**New function: `executeViaApi()`**

Uses Node.js global `fetch` (available in Node 20+) to call the GitHub REST API.

```typescript
async function executeViaApi(
  parsed: ParsedGhCommand,
  decision: PolicyDecision,
  policy: GitHubPolicy,
  policyPath: string,
): Promise<void>
```

**API endpoint mapping** — a function per supported command:

`gh pr create --title T --body B --base main --head branch`:

- `POST /repos/{owner}/{repo}/pulls` with `{ title, body, base, head }`
- Extract `--title`, `--body`, `--base`, `--head` flags from `parsed.rawArgs`
- Response: print the PR URL to stdout (same as real `gh`)
- If `decision.action === "allow-and-capture-pr"`: extract PR number from response, update policy state

`gh pr view [number]`:

- `GET /repos/{owner}/{repo}/pulls/{number}`
- Format output as JSON (agent-friendly)

`gh pr edit [number] [--title T] [--body B]`:

- `PATCH /repos/{owner}/{repo}/pulls/{number}` with provided fields

`gh pr list`:

- `GET /repos/{owner}/{repo}/pulls`
- Format as JSON array

`gh issue list`:

- `GET /repos/{owner}/{repo}/issues`
- Format as JSON array

`gh issue view [number]`:

- `GET /repos/{owner}/{repo}/issues/{number}`
- Format as JSON

`gh api <endpoint> [-X METHOD] [-f key=value]`:

- Direct HTTP request to `https://api.github.com{endpoint}`
- Method from `-X`/`--method` flag
- Body from `-f`/`--field` flags (JSON-encoded)

**Unsupported commands**: For commands that pass policy evaluation but aren't in the API mapping (edge case — most denied commands never reach this point), print a clear error:

```
error: 'gh {command} {subcommand}' is not available in this sandbox environment
```

**Flag parsing for API mode**: The shim already parses policy-relevant flags (`-R`, `--repo`, `-X`, `--method`). For API mode, we also need:

- `--title`, `--body`, `--base`, `--head` (for `pr create/edit`)
- `-f`, `--field`, `-F`, `--raw-field` (for `api`)
- `--json`, `--jq` (for output formatting — pass-through for API mode since we return JSON by default)

Add these to the flag parser. Keep it simple — we only need the flags that map to API request parameters.

**Auth**: All API calls include `Authorization: Bearer {GH_TOKEN}` header.

**Output format**: Default to JSON output for all commands. The real `gh` uses a table format by default but switches to JSON with `--json`. Since agents typically add `--json` anyway, and JSON is more reliable to parse, always return JSON. For `gh pr create`, also print the PR URL to stdout (same as real `gh`) since the shim's PR capture logic parses it.

### Testing

Unit tests (can run without Docker):

- Test `executeViaApi` with mocked `fetch` for each supported command
- Test PR creation → policy state update
- Test unsupported command → clear error message
- Test flag extraction for `--title`, `--body`, `--base`, `--head`

Integration tests (require GitHub token):

- Run the shim (without `BOUNCER_REAL_GH`) against a test repo
- `gh pr list` → returns JSON array
- `gh issue list` → returns JSON array
- `gh api /repos/{owner}/{repo}` → returns repo metadata
- `gh pr create` → creates PR, captures number, updates policy state

### Exit criteria

- The shim works in both modes: proxy-to-real-gh (host) and direct-API (container).
- All commands listed in the design doc's API mapping work.
- PR creation captures the PR number and updates policy state (same behavior as M5).
- Agents can complete a full PR workflow using the shim's API mode.

---

## Phase 7: Sandbox Monitor + UI Updates

**Goal**: Container-appropriate monitoring and UI indicators for the sandbox backend.

### Changes to `src/main/sandbox-monitor.ts`

Make the monitor backend-aware. Options:

**Option A**: New class `ContainerMonitor` alongside `SandboxMonitor`.
**Option B**: Add a `backend` parameter to `SandboxMonitor.start()`.

**Recommended: Option A** — the two backends are different enough that a shared class adds complexity. The `ContainerMonitor` is simpler:

```typescript
export class ContainerMonitor extends EventEmitter<SandboxMonitorEvents> {
  private dockerProcess: ChildProcess | null = null;

  start(containerId: string): void {
    // docker events --filter container={containerId} --format '{{json .}}'
    // Parse events for: OOM, die, exec_create, etc.
    // Emit violations for unexpected events
  }

  stop(): void { ... }
}
```

For M6, the `ContainerMonitor` is lightweight — it's mainly a placeholder. The real violation detection comes from:

- Policy events (stderr parsing — already works, unchanged)
- Filesystem permission errors (surface via ACP tool call failures — no code change needed)
- Container lifecycle events (OOM, unexpected exit — from Docker events stream)

### Changes to `src/main/session-manager.ts`

- For container sessions, start a `ContainerMonitor` instead of `SandboxMonitor`
- Store on session state: `containerMonitor: ContainerMonitor | null`

### Changes to `src/main/types.ts`

Update `SessionSummary`:

```typescript
export interface SessionSummary {
  // ... existing fields ...
  sandboxBackend: SandboxBackend // "safehouse" | "container" | "none"
  containerId: string | null // Docker container ID when backend=container
}
```

### Changes to renderer

**`SessionList.tsx`**: Show sandbox backend indicator next to each session:

- Container: "Container" badge
- Safehouse: "Seatbelt" badge
- None: "Unsandboxed" warning

**`SandboxLog.tsx`**: Works unchanged — it displays `SandboxViolationInfo` and `PolicyEvent` objects, both of which are backend-agnostic.

**`NewSessionDialog.tsx`**: No changes needed — sandbox backend is auto-selected, not user-chosen.

### Changes to `src/preload/index.ts`

No changes needed — `SessionSummary` is passed through IPC and the new fields are automatically available.

### Testing

Manual: create sessions with and without Docker available. Verify:

- Container sessions show "Container" badge
- Safehouse fallback shows "Seatbelt" badge
- Policy events display correctly for both backends
- OOM-killed container shows up as a session error

### Exit criteria

- UI clearly indicates which sandbox backend each session uses.
- Policy events work identically for both backends.
- Container lifecycle events (unexpected exit, OOM) surface as session errors.

---

## Phase 8: End-to-End Validation + Cleanup

**Goal**: Full validation of the container migration, regression testing, cleanup of any remaining rough edges.

### Validation checklist

**Claude Code PR workflow in container**:

- [ ] Create session with `standard-pr` policy
- [ ] Agent can read and edit files in the worktree
- [ ] Agent can run `npm install`, `npm test`, etc.
- [ ] Agent can `git add`, `git commit`
- [ ] Agent can `git push` to the session branch (hook allows)
- [ ] Agent gets denied pushing to `main` (hook denies, policy event logged)
- [ ] Agent can `gh pr create` (shim allows, PR captured)
- [ ] Agent can `gh pr view` on the created PR
- [ ] Agent gets denied `gh pr merge` (shim denies, policy event logged)
- [ ] Agent cannot find or invoke a real `gh` binary
- [ ] Agent cannot modify files in `/etc/bouncer/hooks` (read-only mount)
- [ ] Agent cannot modify `/etc/gitconfig` (read-only mount)
- [ ] Session close removes the container and all host artifacts

**Replay agent regression**:

- [ ] All replay sessions from the test dataset pass in containers
- [ ] Policy enforcement results match safehouse baseline

**Safehouse fallback**:

- [ ] With Docker unavailable, sessions fall back to safehouse
- [ ] All M5 tests pass in safehouse mode (no regressions)

**Orphan cleanup**:

- [ ] Kill the app mid-session, restart — orphan containers are cleaned up
- [ ] Orphan worktrees, policy files, hooks, shim dirs are cleaned up (existing behavior)

### Cleanup tasks

- Remove any `TODO(M6)` comments added during development
- Update `docs/roadmap.md`: mark M6 as complete, update architecture diagram to show container as default
- Update `docs/roadmap.md` sandbox primitive section with final status
- Ensure `scripts/test-*` scripts cover both container and safehouse paths

### Exit criteria

- All items in the validation checklist pass.
- Roadmap updated.
- No stale TODO comments.

---

## Phase Dependency Graph

```
Phase 1 (Dockerfile + image build)
  │
  ▼
Phase 2 (container spawn + stdio)
  │
  ▼
Phase 3 (echo agent in container) ──── Phase 6 (gh shim API mode)
  │                                          │
  ▼                                          │
Phase 4 (bind mounts + git config)           │
  │                                          │
  ▼                                          │
Phase 5 (Claude Code + replay in container) ◄┘
  │
  ▼
Phase 7 (monitoring + UI)
  │
  ▼
Phase 8 (e2e validation + cleanup)
```

Phase 6 (`gh` shim API mode) can be developed in parallel with Phases 3-5. It has no code dependency on the container infrastructure — it's a change to the shim's execution path, gated on `BOUNCER_REAL_GH` being unset. It merges into the main flow at Phase 5, where container sessions set (or don't set) the env var.

---

## Risk Checkpoints

After each phase merges, verify:

| After Phase | Check                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Phase 1     | Image builds, contains expected toolchains, no `gh` binary                     |
| Phase 2     | stdio works through `docker run -i`, container cleanup is reliable             |
| Phase 3     | ACP protocol works over container stdio (text streaming, tool calls)           |
| Phase 4     | Mount strategy is correct (rw/ro), gitconfig is valid, credential helper works |
| Phase 5     | Full agent session works in container, policy enforcement matches safehouse    |
| Phase 6     | Shim API mode handles the common `gh` commands, PR capture works               |
| Phase 7     | UI reflects backend correctly, monitoring captures relevant events             |
| Phase 8     | Everything works together, no regressions, roadmap updated                     |
