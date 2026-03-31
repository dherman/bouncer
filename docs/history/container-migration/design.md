# Milestone 6: Container Migration — Design Document

**Date**: 2026-03-24

## Goal

Migrate the sandbox primitive from macOS Seatbelt (via agent-safehouse) to OrbStack containers. This strengthens M5's application-layer policy enforcement, provides cross-platform isolation, and establishes the network foundation for M7's HTTP proxy.

## Motivation

M5 implemented CLI wrappers (`gh` shim, git hooks) for application-layer policy enforcement on Seatbelt. These work but have known bypass paths that containers close:

| Bypass                                      | How it works today                                                   | How containers close it                                                             |
| ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Agent invokes real `gh` via absolute path   | Real `gh` exists on host, accessible via `/opt/homebrew/bin/gh` etc. | Real `gh` binary doesn't exist in the container — the shim _is_ `gh`                |
| Agent deletes or modifies git hooks         | Hook files are writable on the host filesystem                       | Hooks directory mounted read-only                                                   |
| Agent unsets `core.hooksPath` in git config | Agent can write to `.git/config` in the worktree                     | System-level gitconfig mounted read-only; worktree `.git/config` can be constrained |
| Agent uses `--no-verify` to skip hooks      | Git respects this flag regardless of hook presence                   | Not closed until M7 (network proxy), but container removes alternative tools        |

Beyond hardening, containers provide:

- **Cross-platform support**: Docker runs on macOS, Linux, Windows (Seatbelt is macOS-only)
- **Reproducible environments**: Same image = identical toolchain across sessions
- **No carveout problem**: Build up from a known-good base instead of subtracting from the host
- **Native network isolation**: Foundation for M7's proxy architecture

## Prerequisites

- **OrbStack installed** with Docker-compatible CLI available
- **M5 complete**: `gh` shim, git hooks, policy event parser, GitHub policy state management all working
- **Performance validated**: OrbStack bind-mount benchmarks confirm parity with native (see [investigation](../../reference/orbstack-perf-investigation.md))

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                 Glitter Ball (Electron)                  │
│                                                          │
│  ┌───────────────────────────────────────────────────┐   │
│  │          Session Manager (host)                   │   │
│  │                                                   │   │
│  │  • Builds container config from policy template   │   │
│  │  • Spawns agent container via Docker CLI/API      │   │
│  │  • Bind-mounts worktree, hooks, shim, config      │   │
│  │  • Connects to container stdio via docker attach  │   │
│  │  • Monitors container events for violations       │   │
│  └──────────┬────────────────────────────────────────┘   │
│             │ stdio (ACP / JSON-RPC)                     │
│  ┌──────────▼──────────────────────────────────────────┐ │
│  │       Docker Container (OrbStack)                   │ │
│  │                                                     │ │
│  │  /workspace (bind-mount, rw)  ← worktree            │ │
│  │  /etc/bouncer/hooks (bind-mount, ro) ← git hooks    │ │
│  │  /usr/local/bin/gh (bind-mount, ro)  ← gh shim      │ │
│  │  /etc/gitconfig (bind-mount, ro)     ← git config   │ │
│  │  ~/.ssh (bind-mount, ro)             ← SSH keys     │ │
│  │                                                     │ │
│  │  Node.js, git (from image)                          │ │
│  │  No real gh binary — shim IS gh                     │ │
│  │  Agent process speaks ACP over stdio                │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## Detailed Design

### Phase 1: Container Image

**Dockerfile** (`docker/agent.Dockerfile`):

```dockerfile
FROM docker/sandbox-templates:claude-code

USER root

# Remove the real gh CLI — replaced at runtime by our policy-enforcing shim
# via bind mount. Belt-and-suspenders: the bind mount shadows the path, but
# removing the binary ensures no fallback if mounted at a different path.
RUN rm -f $(which gh) 2>/dev/null || true

# Add Rust toolchain (not included in the base image)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    --default-toolchain stable \
    --component rust-analyzer,rustfmt,clippy
ENV PATH="/root/.cargo/bin:${PATH}"

USER agent

WORKDIR /workspace
```

Design decisions:

- **`docker/sandbox-templates:claude-code`** as base: Docker's official Claude Code sandbox image. Includes Node.js, Python 3, Go, Git, and essential dev tools. arm64-native (runs natively on Apple Silicon via OrbStack). This is a production-quality multi-toolchain base — we extend rather than build from scratch.
- **Rust added via rustup**: The base image doesn't include Rust, but many of the projects Bouncer targets use Node.js + Rust. Adding Rust (with rust-analyzer, rustfmt, clippy) makes the image viable for polyglot agent workflows without requiring per-session image variants.
- **Real `gh` binary removed**: The base image ships `gh`, which we explicitly remove. The shim is bind-mounted as `/usr/local/bin/gh` at container start (bind mount shadows the path), and the binary removal ensures no fallback exists at alternative paths. The shim _is_ `gh` inside the container.
- **No `curl`/`wget` removal**: The base image includes these (useful for Rust/toolchain operations), and removing them is not a security boundary — the agent can use Node.js `fetch`. Fully closed by M7's network proxy.
- **Non-root `agent` user**: Inherited from the base image. Defense in depth — the agent shouldn't need root.
- **No carveout problem**: Unlike Seatbelt (where safehouse must enumerate host paths for every toolchain), we start with a known-good environment. The container has its own copies of everything. Adding a toolchain means updating the Dockerfile, not discovering and whitelisting a dozen host paths.

**Image build and caching**:

- Image built at app startup if not present (or on version change)
- Tagged as `glitterball-agent:v{version}` where version comes from `package.json`
- Rebuild on Dockerfile change (content hash check)
- `docker build` runs in background during app init; sessions block on image readiness

### Phase 2: Container Lifecycle Manager

New module: `src/main/container.ts`

This replaces the safehouse integration (`sandbox.ts`) as the sandbox primitive for containerized sessions. The safehouse path remains available as a fallback for development/debugging.

```typescript
export interface ContainerConfig {
  /** Docker image to use */
  image: string
  /** Session ID (used for container naming) */
  sessionId: string
  /** Bind mounts: [hostPath, containerPath, mode] */
  mounts: Array<{
    hostPath: string
    containerPath: string
    readOnly: boolean
  }>
  /** Environment variables to set in the container */
  env: Record<string, string>
  /** Working directory inside the container */
  workdir: string
  /** Command to run */
  command: string[]
  /** Network mode (default: "none" for M6; "bridge" when M7 adds proxy) */
  networkMode: 'none' | 'bridge' | 'host'
}
```

Key functions:

```typescript
/** Check if Docker (OrbStack) is available */
export async function isDockerAvailable(): Promise<boolean>

/** Ensure the agent image is built and up to date */
export async function ensureAgentImage(): Promise<string>

/** Spawn an agent container, returning a handle with stdio streams */
export async function spawnContainer(config: ContainerConfig): Promise<ContainerHandle>

/** Stop and remove a container */
export async function removeContainer(sessionId: string): Promise<void>

/** Clean up orphan containers from previous crashes */
export async function cleanupOrphanContainers(activeSessionIds: Set<string>): Promise<void>
```

**`ContainerHandle`** provides:

- `stdin: Writable` / `stdout: Readable` / `stderr: Readable` — stdio streams for ACP
- `pid: number` — container PID (for monitoring)
- `containerId: string` — Docker container ID
- `kill(): void` — stop the container

**Spawning approach**: `docker run` with `-i` (interactive, keeps stdin open) and `--rm` (auto-remove on exit). The session manager connects via the spawned process's stdio pipes (same as today's `spawn()` call — `docker run -i` inherits stdio).

```
docker run -i --rm \
  --name glitterball-{sessionId} \
  --network none \
  -v /host/worktree:/workspace \
  -v /host/hooks:/etc/bouncer/hooks:ro \
  -v /host/gh-shim:/usr/local/bin/gh:ro \
  -v /host/gitconfig:/etc/gitconfig:ro \
  -v /host/.ssh:/home/agent/.ssh:ro \
  -e BOUNCER_GITHUB_POLICY=/etc/bouncer/policy.json \
  -e GH_TOKEN=... \
  -e ANTHROPIC_API_KEY=... \
  -w /workspace \
  glitterball-agent:v1 \
  node /usr/local/lib/agent/index.js
```

**Why `docker run -i` instead of the Docker Engine API**: Simplicity. We already have a working pattern of spawning a child process and connecting to its stdio. `docker run -i` preserves that pattern exactly — the child process is `docker`, its stdin/stdout are piped to the container's stdin/stdout, and ACP works unchanged. The Docker Engine API (via REST or a Node.js client library) would require managing container lifecycle, attaching to streams, and handling connection state — more complexity for no benefit at this stage. We can migrate to the API later if needed (e.g., for concurrent container management at scale).

### Phase 3: Bind Mount Strategy

The mount strategy maps the current Seatbelt config concepts (writable dirs, read-only dirs, env passthrough) to container bind mounts.

| Host Path                                             | Container Path                      | Mode          | Purpose                             |
| ----------------------------------------------------- | ----------------------------------- | ------------- | ----------------------------------- |
| Worktree (`/tmp/glitterball-worktrees/{id}`)          | `/workspace`                        | read-write    | Agent's working directory           |
| Git common dir (parent repo's `.git`)                 | Resolved at runtime                 | read-write    | Linked worktree refs/metadata       |
| Git hooks dir (`/tmp/glitterball-sandbox/{id}-hooks`) | `/etc/bouncer/hooks`                | **read-only** | Pre-push hook (tamper-proof)        |
| `gh` shim script                                      | `/usr/local/bin/gh`                 | **read-only** | Policy-enforcing GitHub CLI         |
| `gh` shim Node.js bundle                              | `/usr/local/lib/bouncer/gh-shim.js` | **read-only** | Shim implementation                 |
| GitHub policy state                                   | `/etc/bouncer/github-policy.json`   | read-write    | Shim reads/updates PR state         |
| System gitconfig                                      | `/etc/gitconfig`                    | **read-only** | `core.hooksPath`, credential helper |
| User's `~/.ssh`                                       | `/home/agent/.ssh`                  | **read-only** | Git SSH authentication              |
| Agent binary (`claude-agent-acp`)                     | `/usr/local/lib/agent/`             | **read-only** | ACP agent entry point               |
| App `node_modules`                                    | `/usr/local/lib/node_modules/`      | **read-only** | Agent dependencies                  |

**Git common dir handling**: Linked worktrees store refs and metadata in the parent repo's `.git` directory. The worktree manager already resolves this path and validates it's under the project dir. In the container, we mount it at the same relative position so git can find it. The existing `gitCommonDir` validation (ensuring it's under the project root) prevents sandbox escape via symlinked common dirs.

**The `core.hooksPath` hardening**: We generate a gitconfig file that sets `core.hooksPath=/etc/bouncer/hooks` and mount it as `/etc/gitconfig` (read-only). The agent can still set `core.hooksPath` in the worktree's `.git/config` (which overrides system config), but we can make the worktree's `.git/config` include a read-only bouncer config via `include.path`. Full hook bypass prevention requires M7's network proxy.

**Credential flow**: The `gh` shim needs `GH_TOKEN` to authenticate API calls. Git push needs credentials for HTTPS push. Both are injected as environment variables (same as M5). SSH keys are mounted read-only for repos that use SSH transport, though HTTPS with credential helper is preferred (same reasoning as M5 — SSH socket access is simpler in a container than under Seatbelt, but HTTPS with token is more portable).

### Phase 4: Session Manager Integration

The session manager's `createSession` flow changes to support both sandbox backends:

```typescript
type SandboxBackend = 'safehouse' | 'container' | 'none'
```

**Backend selection logic**:

1. If Docker is available → use `"container"`
2. Else if safehouse is available → use `"safehouse"` (fallback)
3. Else → `"none"` (unsandboxed, with warning)

This preserves the existing safehouse path for development on machines without Docker/OrbStack, while defaulting to containers when available.

**Changes to `resolveAgentCommand`**: For the container backend, the function returns a `SpawnConfig` where `cmd` is `"docker"` and `args` is the `docker run` invocation. The ACP connection setup (stdio piping, ndJson stream, ClientSideConnection) remains identical — the agent's stdin/stdout are transparently tunneled through Docker.

**Changes to `resolveClaudeCodeCommand`**:

```typescript
function resolveClaudeCodeCommand(
  cwd: string,
  sandboxConfig: SandboxConfig | null, // Seatbelt path
  containerConfig: ContainerConfig | null, // Container path
): SpawnConfig {
  if (containerConfig) {
    return buildDockerRunCommand(containerConfig)
  }
  if (sandboxConfig) {
    const args = buildSafehouseArgs(sandboxConfig, ['node', binPath])
    return { cmd: 'safehouse', args, cwd }
  }
  return { cmd: 'node', args: [binPath], cwd }
}
```

**Changes to `closeSession`**: Stop and remove the container instead of (or in addition to) killing the child process. Container cleanup is idempotent (`docker rm -f` is safe to call on already-stopped containers).

**Changes to `cleanupOrphans`**: Find and remove containers matching the `glitterball-*` naming pattern that don't correspond to active sessions.

### Phase 5: Policy Template Updates

`PolicyTemplate` gains a container config section:

```typescript
export interface PolicyTemplate {
  id: string
  name: string
  description: string
  filesystem: FilesystemPolicy
  network: NetworkPolicy
  env: EnvPolicy
  // Existing — kept for safehouse fallback
  safehouseIntegrations: string[]
  appendProfile?: string
  // New — container configuration
  container?: ContainerPolicy
  // Existing
  github?: GitHubPolicy
}

export interface ContainerPolicy {
  /** Base image (default: glitterball-agent) */
  image?: string
  /** Additional bind mounts beyond the standard set */
  additionalMounts?: Array<{
    hostPath: string
    containerPath: string
    readOnly: boolean
  }>
  /** Network mode override (default: "none") */
  networkMode?: 'none' | 'bridge'
  /** Additional packages to install (triggers image variant) */
  additionalPackages?: string[]
}
```

A new function `policyToContainerConfig()` (in a new `policy-container.ts` module, parallel to the existing `policy-sandbox.ts`) converts a `PolicyTemplate` + session context into a `ContainerConfig`:

```typescript
export function policyToContainerConfig(
  template: PolicyTemplate,
  context: {
    sessionId: string
    worktreePath: string
    gitCommonDir?: string
    agentBinPath: string
    nodeModulesPath: string
    shimDir?: string
    hooksDir?: string
    policyStatePath?: string
    gitconfigPath?: string
  },
): ContainerConfig
```

### Phase 6: Sandbox Violation Detection

Seatbelt violations are currently detected by parsing the macOS unified log (`log stream --predicate 'sender=="Sandbox"'`). This mechanism is Seatbelt-specific and doesn't apply to containers.

**Container violation detection approaches**:

1. **Docker events**: `docker events --filter container=glitterball-{id}` emits lifecycle events (OOM kills, exec attempts, etc.) but not fine-grained access denials.

2. **seccomp audit logging**: Docker supports custom seccomp profiles that can log (rather than kill on) denied syscalls. This is the closest analog to Seatbelt violation logging, but requires a custom seccomp profile and parsing audit logs.

3. **AppArmor/SELinux denials**: On Linux, these produce log entries similar to Seatbelt. Not applicable to OrbStack on macOS.

4. **Filesystem permission errors**: The simplest approach — mount directories read-only and let the container produce `EROFS` / `EACCES` errors naturally. The agent (or its tools) will surface these errors through ACP as tool call failures.

**Recommended approach for M6**: Start with (4) — filesystem permission errors surface naturally through ACP tool call results, and the policy event parser already captures `gh` shim and git hook denials. This provides sufficient observability for the milestone. Seccomp audit logging (2) can be added later if we need visibility into blocked operations that don't surface through ACP.

**Changes to `SandboxMonitor`**: The existing class becomes backend-aware:

- For safehouse: existing unified log parsing (unchanged)
- For containers: monitors Docker events + stderr policy events (already implemented in M5)
- The `PolicyEvent` type and `parsePolicyEvent()` function work unchanged — they parse the same stderr format regardless of whether the agent runs under Seatbelt or in a container

### Phase 7: `gh` Shim Adaptations

The M5 `gh` shim (`src/main/gh-shim.ts`) needs minor changes for the container environment:

**Path changes**: The shim currently references host paths for policy state (`BOUNCER_GITHUB_POLICY`) and the real `gh` binary (`BOUNCER_REAL_GH`). In the container:

- `BOUNCER_GITHUB_POLICY` points to `/etc/bouncer/github-policy.json` (bind-mounted)
- `BOUNCER_REAL_GH` is **not set** — there is no real `gh` binary. The shim must handle this case: if `BOUNCER_REAL_GH` is unset, the shim uses Node.js `fetch` to call the GitHub API directly for allowed operations, rather than proxying through `gh`.

This is a meaningful change to the shim's architecture. Today, the shim acts as a gate in front of the real `gh` binary: parse args → check policy → exec real `gh` or deny. In the container, the shim must **be** the `gh` implementation for allowed operations.

**Options for the container `gh` shim**:

| Approach                                  | Pros                                                            | Cons                                                                            |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **A: Direct API calls via `fetch`**       | No external dependencies; shim is self-contained                | Must reimplement `gh` output formats; only a subset of `gh` commands are needed |
| **B: Install real `gh` at a hidden path** | Shim architecture unchanged; full `gh` compatibility            | Partially defeats the purpose — agent could discover the hidden binary          |
| **C: Two-phase shim**                     | Gate + API for common ops; fallback warning for unsupported ops | Moderate complexity; covers the realistic use case                              |

**Recommended: Approach A (direct API calls) for the common operations, with a clear error for unsupported commands.**

The agent realistically uses a small subset of `gh` commands: `pr create`, `pr view`, `pr edit`, `pr list`, `issue list`, `issue view`, and `api`. These all map directly to GitHub REST API calls. The shim already parses the `gh` subcommand grammar and knows the policy-relevant intent — extending it to make the API call (instead of exec-ing `gh`) is a natural evolution.

This approach also means the shim's API calling logic is **exactly** what M7's network proxy will need to understand. Building it now creates a reusable policy engine.

**Implementation sketch**:

```typescript
// In the shim, after policy check passes:
if (process.env.BOUNCER_REAL_GH) {
  // Host/Seatbelt path: proxy to real gh
  execRealGh(args)
} else {
  // Container path: call GitHub API directly
  await callGitHubApi(parsedCommand, process.env.GH_TOKEN)
}
```

The `callGitHubApi` function maps `gh` subcommands to REST API calls:

- `gh pr create` → `POST /repos/{owner}/{repo}/pulls`
- `gh pr view {n}` → `GET /repos/{owner}/{repo}/pulls/{n}`
- `gh pr edit {n}` → `PATCH /repos/{owner}/{repo}/pulls/{n}`
- `gh pr list` → `GET /repos/{owner}/{repo}/pulls`
- `gh issue list` → `GET /repos/{owner}/{repo}/issues`
- `gh issue view {n}` → `GET /repos/{owner}/{repo}/issues/{n}`
- `gh api {path}` → direct HTTP request (method from `--method`/`-X` flag)

Output formatting should match `gh` defaults (JSON where possible, since that's what agents parse most reliably).

### Phase 8: Git Configuration

Git operations require careful configuration in the container:

**Authentication**: Two paths:

1. **HTTPS with token** (preferred): Set `GH_TOKEN` env var. Configure credential helper in the mounted gitconfig: `credential.https://github.com.helper=!node /usr/local/lib/bouncer/gh-credential-helper.js`. This is a small script that echoes the token — simpler than depending on `gh auth git-credential` (which requires the real `gh` binary).
2. **SSH**: Mount `~/.ssh` read-only. SSH agent forwarding requires `SSH_AUTH_SOCK` to be accessible, which doesn't work across the container boundary. Instead, mount the SSH key directly and configure `GIT_SSH_COMMAND` to use it without passphrase prompting (or rely on the key being unencrypted / agent-forwarded via OrbStack's integration).

**Gitconfig layering**:

```
/etc/gitconfig (read-only, Bouncer-managed):
  core.hooksPath = /etc/bouncer/hooks
  credential.https://github.com.helper = !node /usr/local/lib/bouncer/gh-credential-helper.js
  user.name = {from host}
  user.email = {from host}

/workspace/.git/config (worktree-local, writable by agent):
  remote.origin.url = https://github.com/{owner}/{repo}.git
  ... (standard worktree config)
```

The system gitconfig being read-only means the agent can't unset `core.hooksPath` at the system level. It can override it at the local level (`.git/config`), which is a known gap closed by M7.

### Phase 9: Networking

**M6 network posture**: `--network none` by default for `standard-pr` policy. This means:

- No outbound network access from the container
- `git push` over HTTPS won't work directly from inside the container

**The network gap**: With `--network none`, the agent can't `git push` or `npm install`. This is too restrictive for practical use. Options:

| Approach                                           | Description                                                | M6 feasibility                                          |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| **A: `--network none` + host-side execution**      | Agent's `git push` is intercepted and executed on the host | High complexity; breaks ACP's execution model           |
| **B: `--network bridge` with no proxy**            | Agent has full network access                              | Defeats network isolation; no better than Seatbelt      |
| **C: `--network bridge` with DNS-based filtering** | Allow only specific domains via container DNS config       | Moderate; provides basic domain allowlisting            |
| **D: `--network bridge`, defer proxy to M7**       | Full network in M6; proxy in M7                            | Simple; accepts that M6 doesn't improve network posture |

**Recommended: Approach D** — use `--network bridge` (default Docker networking) for M6. The primary value of M6 is filesystem isolation (hardening CLI wrappers), not network isolation. Network enforcement is M7's scope. Attempting DNS-based filtering in M6 would be half-measure that delays the milestone without providing a real security boundary.

For `standard-pr` sessions that don't need arbitrary network access, the practical network usage is:

- `git push` to `github.com` (HTTPS)
- `gh` API calls to `api.github.com` (handled by the shim, which makes the call from inside the container)
- Potentially `npm install` / package registry access

All of these require network access. M7 constrains _which_ network access is allowed.

### Phase 10: Testing Strategy

**Unit tests**:

- `container.ts`: Mock `docker` CLI, test config generation, mount path resolution
- `policy-container.ts`: Test policy template → container config conversion
- `gh-shim.ts`: Test direct API call path (no `BOUNCER_REAL_GH`)

**Integration tests** (require OrbStack):

- Container lifecycle: start, attach stdio, stop, remove
- Bind mount verification: read-write worktree, read-only hooks/shim
- ACP over container stdio: send message → receive response
- Git operations: commit, push to allowed branch, push to denied branch
- `gh` shim: `gh pr view`, `gh pr create`, denied operations
- Policy event parsing: same stderr format works through container stdio
- Orphan cleanup: containers from crashed sessions are cleaned up

**Regression tests**:

- All M5 policy enforcement tests pass in the container environment
- Replay agent works in container (deterministic test coverage)

**Manual validation**:

- Claude Code session in container: full PR workflow (create branch → commit → push → create PR → iterate)
- Verify read-only mounts: agent cannot modify hooks, shim, or system gitconfig
- Verify `gh` bypass is closed: no real `gh` binary (removed from base image + shim bind-mounted)

## Implementation Phases

### Phase A: Foundation (container lifecycle + image)

1. Create `docker/agent.Dockerfile`
2. Implement `src/main/container.ts` (image build, container spawn/stop/cleanup)
3. Add `isDockerAvailable()` check
4. Integration test: spawn container, verify stdio piping

### Phase B: Session Manager integration

5. Add `SandboxBackend` type and selection logic
6. Implement `policy-container.ts` (policy template → container config)
7. Update `resolveAgentCommand` for container backend
8. Update `createSession` / `closeSession` / `cleanupOrphans`
9. Integration test: echo agent in container via ACP

### Phase C: Mount strategy + git configuration

10. Implement bind mount generation (worktree, common dir, hooks, shim, gitconfig)
11. Generate read-only system gitconfig with `core.hooksPath` and credential helper
12. Implement `gh-credential-helper.js` (token echo for git HTTPS auth)
13. Integration test: git commit + push from container

### Phase D: `gh` shim direct API mode

14. Add `callGitHubApi()` to `gh-shim.ts` for container path
15. Implement API call mapping for the `gh` subcommand subset (`pr create/view/edit/list`, `issue list/view`, `api`)
16. Integration test: `gh pr create`, `gh pr view` without real `gh` binary

### Phase E: Sandbox monitoring + UI

17. Update `SandboxMonitor` for container backend (Docker events + stderr)
18. Update `SessionSummary` to indicate sandbox backend (`sandboxBackend: "safehouse" | "container" | "none"`)
19. UI: display container status (image, container ID) in session details

### Phase F: End-to-end validation

20. Full Claude Code PR workflow in container
21. Replay agent regression suite in container
22. Safehouse fallback path still works
23. Orphan cleanup for both backends

## Files Changed

| File                               | Change                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `docker/agent.Dockerfile`          | **New** — agent container image                                              |
| `src/main/container.ts`            | **New** — container lifecycle management                                     |
| `src/main/policy-container.ts`     | **New** — policy template → container config                                 |
| `src/main/gh-credential-helper.ts` | **New** — token-based git credential helper for containers                   |
| `src/main/session-manager.ts`      | **Modified** — sandbox backend selection, container spawn path               |
| `src/main/gh-shim.ts`              | **Modified** — direct API call path when `BOUNCER_REAL_GH` unset             |
| `src/main/sandbox-monitor.ts`      | **Modified** — backend-aware monitoring                                      |
| `src/main/types.ts`                | **Modified** — `ContainerPolicy`, `SandboxBackend`, updated `SessionSummary` |
| `src/main/policy-templates.ts`     | **Modified** — add `container` config to templates                           |
| `src/main/index.ts`                | **Modified** — image build at startup, Docker availability check             |

## Risks and Mitigations

| Risk                                                        | Likelihood | Impact                                                          | Mitigation                                                                                   |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| OrbStack not installed on user's machine                    | Medium     | Session falls back to safehouse or unsandboxed                  | Graceful degradation with warning; safehouse path preserved                                  |
| Container startup latency impacts UX                        | Low        | OrbStack is fast (~500ms), but could be slower with image pull  | Build image at app startup; cache aggressively                                               |
| Agent binary path resolution differs in container           | Medium     | ESM imports fail if `node_modules` tree isn't mounted correctly | Mount entire `node_modules` tree read-only (same approach as safehouse)                      |
| `gh` shim direct API mode has lower fidelity than real `gh` | Medium     | Agent gets unexpected output format, retries                    | Match `gh` JSON output format for the supported subset; clear error for unsupported commands |
| Git common dir mount leaks access to parent repo            | Low        | Agent could read/write parent repo files                        | Existing validation ensures common dir is under project root                                 |
| Docker socket access from container                         | Low        | Agent could escape via Docker socket                            | Docker socket is never mounted; `--network none` or `--network bridge` without socket        |

## Open Questions

1. **Image variants vs. single image**: The base image (`docker/sandbox-templates:claude-code` + Rust) covers Node.js, Python, Go, and Rust. Should we support additional image variants for specialized toolchains (Java, Ruby, etc.), or keep a single "kitchen sink" image? Single image is simpler and avoids image selection logic. Variants reduce image size for sessions that don't need everything. Defer until image size becomes a practical problem.

2. **OrbStack-specific features**: OrbStack supports running containers as "Linux machines" with tighter macOS integration (e.g., Rosetta for x86 emulation, shared /Users mount). Should we use any OrbStack-specific APIs, or stick to the Docker-compatible surface? Recommend: Docker-compatible only, to preserve portability.

3. **Container resource limits**: Should we set CPU/memory limits on agent containers? Useful for preventing runaway processes but adds configuration surface. Defer unless we see resource exhaustion in practice.

4. **Warm container pool**: Should we pre-start containers to reduce session creation latency? OrbStack is fast enough that this is likely unnecessary, but worth measuring. Defer unless startup latency is a problem.

## Non-Goals

- **Network proxy** — that's M7
- **Custom seccomp profiles** — not needed for M6; default Docker seccomp is sufficient
- **Multi-container sessions** — one container per session is sufficient
- **Remote container execution** — containers run locally via OrbStack
- **Windows/Linux host support** — OrbStack is macOS-only; Docker Desktop support is a future consideration
