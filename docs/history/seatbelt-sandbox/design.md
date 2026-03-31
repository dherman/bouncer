# Milestone 2: Seatbelt Sandbox — Design

## Goal

Wrap the agent process in a macOS Seatbelt sandbox that confines it to its git worktree. By the end of this milestone, every Claude Code session launched from Glitter Ball runs inside a `sandbox-exec` profile that enforces filesystem boundaries at the OS level — and we have empirical data on what legitimate operations the sandbox breaks and how to accommodate them.

## Success Criteria

- Agent process (and all its children) run inside a Seatbelt sandbox with a deny-default filesystem policy
- Agent can read and write freely within its worktree directory
- Agent can read (but not write) system paths required for normal operation (system binaries, libraries, shared frameworks, etc.)
- Agent can read the specific dotfiles it needs (`~/.gitconfig`, `~/.claude/`, etc.)
- Sandbox violations are detected and surfaced in the UI as a live event log
- At least one real coding task completes successfully under the sandbox (e.g., "add a function to a file and commit it")
- A document of empirical findings: what broke, what we allowed, and what remains unresolved

## Non-Goals

- Policy templates or user-configurable policies (Milestone 3)
- Deterministic test agent or batch validation (Milestone 4)
- Application-layer policies like git branch restrictions (Milestone 5)
- Network sandboxing or proxy-based domain allowlisting (Milestone 6)
- Production-quality SBPL profiles — we're iterating toward a working profile, not a hardened one

---

## Architecture

Milestone 1 established the pipeline: `SessionManager → spawn(agent) → ACP over stdio`. Milestone 2 inserts `sandbox-exec` into that spawn path, wrapping the agent process (and all its children) in a Seatbelt sandbox. A parallel log monitor watches for sandbox violations.

```
┌──────────────────────────────────────────────────────────────┐
│                    Glitter Ball (Electron)                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                      React UI                          │  │
│  │  ┌───────────┐  ┌──────────────────────────────────┐   │  │
│  │  │ Session   │  │ Chat Interface                   │   │  │
│  │  │ List      │  │ (streamed via ACP, as in M1)     │   │  │
│  │  │           │  │                                  │   │  │
│  │  │           │  │ ────────────────────────────     │   │  │
│  │  │ (sandbox  │  │ Sandbox Event Log        [NEW]  │   │  │
│  │  │  status   │  │ ✓ file-read  /usr/bin/git       │   │  │
│  │  │  badge)   │  │ ✗ file-write /usr/local/...     │   │  │
│  │  │           │  │ ✗ network-outbound blocked      │   │  │
│  │  └───────────┘  └──────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                 │
│  ┌─────────────────────────▼──────────────────────────────┐  │
│  │         Session Manager (main process)                 │  │
│  │                                                        │  │
│  │  • Creates git worktree per session (unchanged)        │  │
│  │  • Generates .sb profile via SandboxProfileGenerator   │  │  [NEW]
│  │  • Spawns agent via sandbox-exec -f profile.sb         │  │  [NEW]
│  │  • ACP ClientSideConnection (unchanged)                │  │
│  │  • SandboxMonitor: tails unified log for violations    │  │  [NEW]
│  │  • Emits sandbox events to UI                          │  │  [NEW]
│  │  └────────────────────────────────────────────────────┘  │
│  │                            │ stdio (ACP / JSON-RPC)       │
│  │  ┌─────────────────────────▼──────────────────────────┐  │
│  │  │     sandbox-exec -D WORKTREE=... -f profile.sb     │  │  [NEW]
│  │  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │  │     Claude Code (via claude-agent-acp)       │  │  │
│  │  │  │                                              │  │  │
│  │  │  │  All tool execution (Bash, Read, Write,      │  │  │
│  │  │  │  Edit) happens inside the sandbox.           │  │  │
│  │  │  │  All child processes (git, node, python,     │  │  │
│  │  │  │  etc.) inherit sandbox constraints.          │  │  │
│  │  │  └──────────────────────────────────────────────┘  │  │
│  │  └────────────────────────────────────────────────────┘  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### What Changes from Milestone 1

| Component              | M1                                             | M2                                                                                                    |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Agent spawning         | `spawn("node", [agentBin], { cwd: worktree })` | `spawn("safehouse", [...sandboxArgs, "--", "node", agentBin], { cwd: worktree })` via agent-safehouse |
| Filesystem enforcement | None (agent has full access)                   | Seatbelt profile: deny-default, allow worktree read/write, allow system read-only                     |
| Network enforcement    | None                                           | Deny all network (as a starting constraint; Milestone 6 adds proxy-based allowlisting)                |
| Violation detection    | None                                           | `SandboxMonitor` tails macOS unified log for `Sandbox` events                                         |
| UI                     | Chat only                                      | Chat + sandbox event log panel                                                                        |
| Session state          | No sandbox info                                | Adds `sandboxProfile` path and `sandboxPid` for log correlation                                       |

### Key Architectural Insight: Claude Code Handles Tools Internally

As discovered in Milestone 1 ([sdk-deviations.md](../history/live-agent-integration/sdk-deviations.md)), Claude Code executes its Bash, Read, Write, and Edit tools within the agent process itself. It does **not** delegate tool execution to the ACP client.

This means:

- **All tool execution inherits the sandbox.** When Claude Code runs `git commit` or `python3 script.py`, those child processes are spawned from within the sandboxed process tree and automatically inherit all Seatbelt constraints.
- **We don't need ACP-level interception for OS-level policies.** The sandbox enforces the boundary regardless of what the agent does internally.
- **ACP-level interception becomes relevant in Milestone 5+** for application-layer semantics (e.g., "don't push to main") that can't be expressed as filesystem or network rules.

---

## Key Design Decisions

### Delegate to agent-safehouse

Rather than maintaining our own SBPL profiles, we delegate sandbox profile generation to [agent-safehouse](https://agent-safehouse.dev) — an open-source CLI tool with curated, community-tested macOS Seatbelt profiles. This is a fully reversible decision (Apache 2.0 licensed) that saves us from duplicating substantial platform-specific knowledge.

Agent-safehouse uses a deny-default posture with modular, composable profile layers (system runtime, toolchains, agent-specific state, git integration, etc.) and handles the session-specific parameterization via CLI flags (`--workdir`, `--add-dirs`, `--env-pass`).

Our session manager spawns `safehouse [...flags] -- node <agent-bin>` instead of calling `sandbox-exec` directly. Safehouse handles `sandbox-exec` internally, and stdio passes through transparently for ACP JSON-RPC.

### Session-specific sandbox configuration

Each session provides safehouse with:

- `--workdir=<worktree>` — enables git root auto-detection and worktree handling
- `--add-dirs=<worktree>` — grants read-write access to the session's worktree
- `--add-dirs=<gitCommonDir>` — grants write access to the parent repo's `.git` (needed for git operations from linked worktrees)
- `--env-pass=ANTHROPIC_API_KEY,...` — passes specific environment variables through safehouse's sanitized environment
- `--output=<path>` — persists the policy file so we control its lifecycle (cleanup on session close)

Policy files are stored at `{tmpdir}/glitterball-sandbox/<session-id>.sb` for inspection and debugging.

### Network policy

Safehouse's default network policy allows full network access. For Milestone 2 we accept this default — the primary focus is filesystem sandboxing. Milestone 6 will add proxy-based network control, potentially using safehouse's `--append-profile` to inject a deny-network overlay combined with localhost proxy exceptions.

### Extensibility via `--append-profile`

If we discover that safehouse's default profile needs adjustment for specific workflows, we can use `--append-profile` to overlay custom SBPL rules. Appended profiles are loaded last and can further restrict (deny) or extend (allow) the base profile. This gives us an escape hatch without forking safehouse.

### Sandbox violation monitoring strategy

We use **both** detection methods described in the [seatbelt reference](../../reference/seatbelt-reference.md):

1. **macOS unified log stream** — a `SandboxMonitor` process tails the log for `Sandbox` events matching the agent's PID tree. This gives comprehensive, real-time visibility into every blocked operation.

2. **EPERM errors in ACP responses** — when a tool call fails with "Operation not permitted," we can correlate it with sandbox enforcement. This is a secondary signal that helps connect violations to specific agent actions.

The log stream approach is primary because it catches violations from all child processes (git, node, python, etc.), not just the top-level agent.

---

## Components

### 1. Sandbox Integration (`src/main/sandbox.ts`) [NEW]

Rather than generating SBPL profiles directly, we delegate to **[agent-safehouse](https://agent-safehouse.dev)** — an open-source CLI tool that maintains curated, community-tested macOS Seatbelt profiles for agent sandboxing. This avoids duplicating the substantial work of enumerating system runtime paths, Mach IPC services, device nodes, toolchain caches, and agent-specific state directories.

**What safehouse provides:**

- System runtime permissions (binaries, libraries, Mach IPC, PTY, devices)
- Toolchain-specific paths (Node.js, Rust, Python, etc.)
- Agent-specific state directories (Claude Code, Cursor, etc.)
- Git worktree detection and cross-worktree read access
- Shell init files, SSH config, XDG directories
- Ongoing community maintenance as macOS and agent tooling evolve

**What we provide on top:**

- Session-specific writable paths (worktree, git common dir) via `--add-dirs`
- Environment variable passthrough for ACP via `--env-pass`
- Policy file lifecycle management (persist via `--output`, clean up on session close)

**Integration model:** The session manager spawns `safehouse` as the command wrapper:

```
safehouse --output=<policy-path> --workdir=<worktree> --add-dirs=<worktree> \
  --env-pass=ANTHROPIC_API_KEY,NODE_OPTIONS -- node <agent-bin>
```

Safehouse handles `sandbox-exec` internally, and stdio passes through transparently for ACP JSON-RPC.

**Fallback:** When `safehouse` is not installed, the session manager falls back to unsandboxed execution with a warning. This keeps the app functional on Linux or on macOS without safehouse installed.

```typescript
export interface SandboxConfig {
  workdir: string
  writableDirs: string[]
  readOnlyDirs: string[]
  envPassthrough: string[]
  policyOutputPath: string
}

export function defaultSandboxConfig(params: {
  sessionId: string
  worktreePath: string
  gitCommonDir?: string
}): SandboxConfig

export function buildSafehouseArgs(config: SandboxConfig, command: string[]): string[]

export async function isSafehouseAvailable(): Promise<boolean>
```

### 2. Sandbox Monitor (`src/main/sandbox-monitor.ts`) [NEW]

Monitors the macOS unified log for sandbox violation events and emits them to the session manager.

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface SandboxViolation {
  timestamp: Date
  pid: number
  processName: string
  operation: string // e.g., "file-write-data", "network-outbound"
  path?: string // filesystem path, if applicable
  raw: string // raw log line for debugging
}

export class SandboxMonitor extends EventEmitter {
  private logProcess: ChildProcess | null = null

  /**
   * Start monitoring for sandbox violations from a given PID.
   * The monitor watches for violations from this PID and all its descendants.
   */
  start(pid: number): void

  /** Stop monitoring. */
  stop(): void
}
```

**Implementation approach:**

The monitor spawns `log stream` as a child process:

```bash
log stream --style ndjson --predicate 'sender=="Sandbox"'
```

Using `--style ndjson` gives us one JSON object per log line, which is easier to parse than the default compact format. Each line is parsed and filtered:

1. **PID filtering**: Check if the violation's PID is in the agent's process tree. Since `log stream` doesn't support PID-tree filtering natively, we periodically refresh the set of known child PIDs using `pgrep -P <pid>` or by tracking PIDs from the log itself.

2. **Event extraction**: Parse the log message to extract operation type, path, and other details. Seatbelt log messages follow a consistent format: `Sandbox: <process>(<pid>) deny(<count>) <operation> <path>`.

3. **Emission**: Emit `violation` events that the session manager forwards to the UI.

**Lifecycle**: One `SandboxMonitor` instance per session. Started after the sandboxed agent process is spawned. Stopped when the session closes. The `log stream` process is killed on stop.

**Fallback if `ndjson` is unavailable**: Fall back to `--style compact` and regex-parse the output.

### 3. Session Manager (updated: `src/main/session-manager.ts`)

The session manager gains sandbox orchestration logic.

**Changes to `createSession()`:**

```typescript
async createSession(projectDir: string, agentType: AgentType = "claude-code") {
  // ... (unchanged: create worktree) ...

  // NEW: Build sandbox config
  const sandboxConfig = defaultSandboxConfig({
    sessionId: id,
    worktreePath: worktree.path,
    gitCommonDir: worktree.gitCommonDir,  // parent repo's .git dir
  });

  // ... spawn agent via safehouse (see below) ...

  // NEW: Start sandbox monitor
  const monitor = new SandboxMonitor();
  monitor.on("violation", (violation) => {
    this.emit("session-update", {
      sessionId: id,
      type: "sandbox-violation",
      violation,
    });
  });
  monitor.start(agentProcess.pid);
}
```

**Changes to agent spawning:**

The `resolveClaudeCodeCommand()` function is updated to wrap the command in `safehouse`:

```typescript
function resolveClaudeCodeCommand(cwd: string, sandboxConfig: SandboxConfig | null): SpawnConfig {
  const require = createRequire(app.getAppPath() + '/')
  const binPath = require.resolve('@zed-industries/claude-agent-acp/dist/index.js')

  if (sandboxConfig) {
    const args = buildSafehouseArgs(sandboxConfig, ['node', binPath])
    return { cmd: 'safehouse', args, cwd }
  }

  return { cmd: 'node', args: [binPath], cwd }
}
```

Safehouse handles `sandbox-exec` internally, and stdio passes through transparently for ACP JSON-RPC. The spawn call barely changes — just a different command. ACP connection setup and error handling remain identical.

**Changes to `SessionState`:**

```typescript
interface SessionState {
  // ... existing fields ...
  sandboxProfilePath: string | null
  sandboxMonitor: SandboxMonitor | null
  sandboxViolations: SandboxViolation[]
}
```

**Changes to `closeSession()`:**

```typescript
async closeSession(sessionId: string) {
  const session = this.sessions.get(sessionId);
  // ... existing close logic ...

  // NEW: Stop sandbox monitor
  session.sandboxMonitor?.stop();

  // NEW: Clean up profile file
  if (session.sandboxProfilePath) {
    await rm(session.sandboxProfilePath, { force: true });
  }
}
```

### 4. Types (updated: `src/main/types.ts`)

New types for sandbox events:

```typescript
export interface SandboxViolationInfo {
  timestamp: number
  operation: string
  path?: string
  processName: string
}

export type SessionUpdate =
  // ... existing variants ...
  {
    sessionId: string
    type: 'sandbox-violation'
    violation: SandboxViolationInfo
  }
```

### 5. IPC Bridge (updated: `src/preload/index.ts`)

Add a method to query sandbox state:

```typescript
sessions: {
  // ... existing methods ...
  getSandboxViolations: (sessionId: string) =>
    ipcRenderer.invoke("sessions:getSandboxViolations", sessionId),
};
```

### 6. React UI (updated: `src/renderer/`)

**Sandbox event log**: A new panel (collapsible, below or beside the chat) showing sandbox violations in real time. Each entry shows:

- Timestamp
- Operation (e.g., `file-write-data`, `network-outbound`)
- Path (if applicable)
- Process name (e.g., `git`, `node`, `python3`)

Color-coded: red for denied operations. The panel auto-scrolls as new events arrive.

**Session list badge**: Sessions running under sandbox show a shield icon or "sandboxed" badge. If violations are occurring, the badge may show a count.

**Sandbox status in chat**: When a tool call fails with EPERM, the chat can annotate the tool call with a "blocked by sandbox" indicator, correlating with the violation log.

---

## Iteration Plan

Agent-safehouse provides a comprehensive starting profile. The iteration process for Milestone 2 is:

1. **Run a real coding task** under safehouse
2. **Observe what breaks** — via sandbox violations in the log and EPERM errors in agent output
3. **Categorize each issue**:
   - **Expected and acceptable**: e.g., agent tried to write outside worktree → working as intended
   - **Fixable via safehouse flags**: add `--add-dirs`, `--add-dirs-ro`, or `--enable` integrations
   - **Needs `--append-profile`**: custom SBPL overlay for edge cases safehouse doesn't cover
   - **Application-layer gap**: e.g., agent tried to `git push` (allowed by filesystem rules but semantically restricted) → note for Milestone 5
4. **Update `defaultSandboxConfig()`** or add safehouse flags, and repeat

Most friction areas identified in the original design (`.gitconfig`, SSH keys, npm caches, dyld cache, temp files, Mach IPC, Claude Code state, git worktree common dir) are already handled by agent-safehouse's curated profiles.

---

## Implementation Plan

See the detailed [implementation plan](plan.md) for phase-by-phase breakdown with code samples and done conditions.

---

## Risks and Open Questions

### Agent-safehouse as a runtime dependency

We depend on `safehouse` being installed on the developer's machine. If it's missing, agent sessions run unsandboxed.

**Mitigation**: Graceful degradation — the session manager checks `isSafehouseAvailable()` and falls back to unsandboxed spawning with a warning. The Homebrew install is straightforward (`brew install eugene1g/safehouse/agent-safehouse`). This is also a fully reversible decision — if safehouse becomes unmaintained, we can vendor the profiles or revert to our own SBPL generation.

### Safehouse environment sanitization

Safehouse sanitizes the environment by default, passing through only a curated whitelist. If the agent needs environment variables we haven't listed in `--env-pass`, it will silently miss them.

**Mitigation**: The `--env-pass` flag lets us add specific variables. We start with `ANTHROPIC_API_KEY`, `NODE_OPTIONS`, `NODE_PATH`, and common git/editor vars. Phase 5 empirical testing will reveal any missing variables.

### `log stream` reliability and performance

The `log stream` command is a real-time tail of the macOS unified log. The `--predicate` filter reduces volume, but format stability is undocumented.

**Mitigation**: The monitor is informational, not load-bearing. The sandbox enforces boundaries at the kernel level regardless. If log monitoring proves unreliable, we can fall back to EPERM detection in tool call results.

### PID-tree tracking

`log stream` doesn't filter by PID tree natively. Short-lived processes may appear in the log before we've discovered their PID.

**Mitigation**: Accept that some violations may be missed or misattributed. The monitor is a best-effort debugging tool, not a security enforcement mechanism.

### `sandbox-exec` deprecation

`sandbox-exec` is marked deprecated but remains functional on macOS 15.x. Claude Code, Cursor, Codex, and agent-safehouse all rely on it in production.

**Mitigation**: This is a known ecosystem-wide risk. If Apple removes `sandbox-exec`, both Bouncer and agent-safehouse will need to adapt. By depending on agent-safehouse, we share this burden with the community rather than bearing it alone.

### `open` command escaping the sandbox

Processes launched via `LaunchServices.framework` (the `open` command) may not inherit the sandbox.

**Mitigation**: Edge case — coding agents rarely use `open`. Can be addressed via `--append-profile` with a deny rule for `/usr/bin/open`, or in Milestone 5 (application-layer policies).

---

## What This Unblocks

Completing Milestone 2 gives us:

- **Validated OS-level sandboxing** for coding agent sessions, with empirical data on what works and what breaks
- **A working safehouse integration** that Milestone 3 parameterizes into policy templates (using `--append-profile` for per-template overrides, or `--enable` for optional integrations)
- **A sandbox monitor** that Milestone 3 uses for policy violation alerting and Milestone 4 uses for batch testing
- **An iteration methodology** (run task → observe violations → adjust safehouse flags) that scales to testing more policies in Milestone 4
- **Empirical findings** documenting the real-world friction of filesystem sandboxing for coding agents — directly answering the roadmap's open question: "What legitimate operations does Seatbelt break?"
- **Community alignment** with agent-safehouse, sharing the maintenance burden for platform-specific sandbox rules rather than maintaining our own
