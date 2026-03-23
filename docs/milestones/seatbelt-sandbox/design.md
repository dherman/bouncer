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

| Component | M1 | M2 |
|-----------|----|----|
| Agent spawning | `spawn("node", [agentBin], { cwd: worktree })` | `spawn("safehouse", [...sandboxArgs, "--", "node", agentBin], { cwd: worktree })` via agent-safehouse |
| Filesystem enforcement | None (agent has full access) | Seatbelt profile: deny-default, allow worktree read/write, allow system read-only |
| Network enforcement | None | Deny all network (as a starting constraint; Milestone 6 adds proxy-based allowlisting) |
| Violation detection | None | `SandboxMonitor` tails macOS unified log for `Sandbox` events |
| UI | Chat only | Chat + sandbox event log panel |
| Session state | No sandbox info | Adds `sandboxProfile` path and `sandboxPid` for log correlation |

### Key Architectural Insight: Claude Code Handles Tools Internally

As discovered in Milestone 1 ([sdk-deviations.md](../history/live-agent-integration/sdk-deviations.md)), Claude Code executes its Bash, Read, Write, and Edit tools within the agent process itself. It does **not** delegate tool execution to the ACP client.

This means:
- **All tool execution inherits the sandbox.** When Claude Code runs `git commit` or `python3 script.py`, those child processes are spawned from within the sandboxed process tree and automatically inherit all Seatbelt constraints.
- **We don't need ACP-level interception for OS-level policies.** The sandbox enforces the boundary regardless of what the agent does internally.
- **ACP-level interception becomes relevant in Milestone 5+** for application-layer semantics (e.g., "don't push to main") that can't be expressed as filesystem or network rules.

---

## Key Design Decisions

### Deny-default posture

The SBPL profile starts with `(deny default)` and explicitly allows only what's needed. This is the standard approach used by Claude Code's own sandbox, Cursor, and Codex. It ensures that any path we haven't considered is blocked by default, and we discover gaps empirically.

### Parameterized profiles

The SBPL profile is a template with parameters injected at spawn time via `sandbox-exec -D KEY=VALUE`. This keeps the profile file generic and reusable across sessions.

Parameters:
- `WORKTREE` — absolute path to the session's git worktree (read-write)
- `HOME` — user's home directory (selective read-only access)
- `TMPDIR` — temporary directory (read-write for the session's `/tmp` subdirectory)

### Profile generation vs. static profile

We generate the `.sb` profile file at session creation time rather than using a single static file. This allows:
- Injecting session-specific allowed paths (e.g., worktree location)
- Iterating on the profile in code (TypeScript) rather than editing raw SBPL
- Adding conditional rules based on session context (future: policy templates in Milestone 3)

However, the generated profile is written to disk so it can be inspected for debugging. Profiles are stored at:
```
{app.getPath('temp')}/glitterball-sandbox/<session-id>.sb
```

### Network: deny all (for now)

The Milestone 2 profile blocks all network access. This is intentionally restrictive — many agent operations (git push, npm install, web research) will fail. This is by design:

1. It gives us a clean baseline to understand what network access the agent actually needs
2. It validates that the sandbox can enforce network boundaries
3. Milestone 6 adds the proxy-based network layer that opens up controlled network access

For testing during this milestone, we'll use coding tasks that don't require network access (local file editing, local git operations, running existing tests).

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
  workdir: string;
  writableDirs: string[];
  readOnlyDirs: string[];
  envPassthrough: string[];
  policyOutputPath: string;
}

export function defaultSandboxConfig(params: {
  sessionId: string;
  worktreePath: string;
  gitCommonDir?: string;
}): SandboxConfig;

export function buildSafehouseArgs(
  config: SandboxConfig,
  command: string[],
): string[];

export async function isSafehouseAvailable(): Promise<boolean>;
```

### 2. Sandbox Monitor (`src/main/sandbox-monitor.ts`) [NEW]

Monitors the macOS unified log for sandbox violation events and emits them to the session manager.

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface SandboxViolation {
  timestamp: Date;
  pid: number;
  processName: string;
  operation: string;   // e.g., "file-write-data", "network-outbound"
  path?: string;       // filesystem path, if applicable
  raw: string;         // raw log line for debugging
}

export class SandboxMonitor extends EventEmitter {
  private logProcess: ChildProcess | null = null;

  /**
   * Start monitoring for sandbox violations from a given PID.
   * The monitor watches for violations from this PID and all its descendants.
   */
  start(pid: number): void;

  /** Stop monitoring. */
  stop(): void;
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
function resolveClaudeCodeCommand(
  cwd: string,
  sandboxConfig: SandboxConfig | null,
): SpawnConfig {
  const require = createRequire(app.getAppPath() + "/");
  const binPath = require.resolve(
    "@zed-industries/claude-agent-acp/dist/index.js"
  );

  if (sandboxConfig) {
    const args = buildSafehouseArgs(sandboxConfig, ["node", binPath]);
    return { cmd: "safehouse", args, cwd };
  }

  return { cmd: "node", args: [binPath], cwd };
}
```

Safehouse handles `sandbox-exec` internally, and stdio passes through transparently for ACP JSON-RPC. The spawn call barely changes — just a different command. ACP connection setup and error handling remain identical.

**Changes to `SessionState`:**

```typescript
interface SessionState {
  // ... existing fields ...
  sandboxProfilePath: string | null;
  sandboxMonitor: SandboxMonitor | null;
  sandboxViolations: SandboxViolation[];
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
  timestamp: number;
  operation: string;
  path?: string;
  processName: string;
}

export type SessionUpdate =
  // ... existing variants ...
  | {
      sessionId: string;
      type: "sandbox-violation";
      violation: SandboxViolationInfo;
    };
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

## SBPL Profile: Starting Point and Iteration Plan

The initial profile will be deliberately conservative. We expect it to break things. The iteration process is:

1. **Start with the deny-default profile** described above
2. **Run a real coding task** (e.g., "add a function to src/main/foo.ts, write a test, run it")
3. **Observe what breaks** — both from sandbox violations in the log and from EPERM errors in agent output
4. **Categorize each violation**:
   - **Expected and acceptable**: e.g., agent tried to write outside worktree → working as intended
   - **Legitimate operation we need to allow**: e.g., agent needs to read `~/.npmrc` → add to read-only paths
   - **Surprising system path**: e.g., dyld cache, Spotlight metadata → investigate and allow if necessary
   - **Application-layer gap**: e.g., agent tried to `git push` (allowed by filesystem rules but semantically restricted) → note for Milestone 5
5. **Update the profile** and repeat

### Expected friction areas (from roadmap open questions)

Based on prior art from Claude Code's sandbox, Cursor's sandbox, and the roadmap's open questions:

| Area | Expected Issue | Likely Resolution |
|------|---------------|-------------------|
| `~/.gitconfig` | Git reads this for user.name, user.email, aliases | Read-only access (already in default policy) |
| SSH keys | `git` operations may need `~/.ssh/` for auth | Read-only access (already in default policy) |
| npm/pnpm cache | Package managers write to global cache dirs | Allow write to cache dir, or accept failure and note for policy templates |
| Homebrew paths | System binaries under `/opt/homebrew` | Read-only access (already in default policy) |
| macOS dyld cache | Dynamic linker shared cache at `/private/var/db/dyld/` | Read-only access (already in default policy) |
| Temp files | Various tools write to `/tmp` or `$TMPDIR` | Session-scoped tmp directory with write access |
| CoreFoundation | Mach IPC lookups for system services | Broad `mach-lookup` allow (already in profile) |
| Claude Code state | Writes to `~/.claude/` (session data, todos, etc.) | **Resolved**: write access to `~/.claude/`, `~/.cache/claude`, `~/.config/claude`, `~/.local/state/claude`, `~/.local/share/claude` (following agent-safehouse `60-agents/claude-code.sb`) |
| Git worktree common dir | Linked worktrees store refs/metadata in parent repo's `.git` | **Resolved**: `defaultPolicy()` accepts `gitCommonDir` parameter; write access to parent `.git` dir (following agent-safehouse `50-integrations-core/worktree-common-dir.sb`) |

---

## Implementation Plan

### Phase 1: Sandbox Profile Generator

1. Create `src/main/sandbox-profile.ts` with `SandboxPolicy` interface, `defaultPolicy()`, and `generateProfile()`
2. Write `writePolicyToDisk()` — stores profile at `{tmpdir}/glitterball-sandbox/<session-id>.sb`
3. Write a manual test: generate a profile, print it, visually inspect the SBPL
4. Validate the generated profile works with a trivial command: `sandbox-exec -f <profile> /bin/ls <worktree-path>` (should succeed); `sandbox-exec -f <profile> /bin/ls /Users/<user>/Desktop` (should fail with EPERM)

### Phase 2: Sandboxed Agent Spawning

5. Update `resolveClaudeCodeCommand()` to wrap in `sandbox-exec -f <profile>`
6. Update `createSession()` to generate profile before spawning agent
7. Update `SessionState` with sandbox-related fields
8. Test: create a session, verify the agent starts and completes the ACP handshake under the sandbox
9. Send a simple prompt ("What files are in this directory?") — verify the agent can read the worktree
10. Send a mutation prompt ("Create a file called test.txt with 'hello'") — verify the agent can write within the worktree
11. Document any startup failures and iterate on the profile

### Phase 3: Sandbox Monitor

12. Create `src/main/sandbox-monitor.ts` with `SandboxMonitor` class
13. Implement `log stream` spawning with NDJSON parsing
14. Implement PID-tree filtering (match violations to the agent's process tree)
15. Wire into session manager: start monitor after agent spawn, stop on session close
16. Test: trigger a known violation (e.g., agent tries to write to `/tmp` outside the session-scoped dir) and verify the monitor captures it

### Phase 4: UI Integration

17. Add `sandbox-violation` to `SessionUpdate` union type
18. Forward violations through IPC to the renderer
19. Build the sandbox event log panel in the chat UI
20. Add sandbox status badge to session list
21. Test: perform a coding task that triggers violations, verify they appear in real time in the UI

### Phase 5: Empirical Iteration

22. Run a set of representative coding tasks under the sandbox:
    - "Read the README and summarize it" (read-only)
    - "Add a new function to an existing file" (read + write within worktree)
    - "Run the existing tests" (spawns subprocesses, reads node_modules)
    - "Create a new file and commit it" (git operations)
    - "Install a package and use it" (npm/pnpm — expect network failure)
23. For each task, collect:
    - All sandbox violations from the monitor
    - Whether the task succeeded or failed
    - What profile changes were needed to make it work
24. Iterate on `defaultPolicy()` to accommodate legitimate operations
25. Document findings in `docs/milestones/seatbelt-sandbox/findings.md`

### Phase 6: Cleanup and Polish

26. Update `closeSession()` to stop monitor and clean up profile files
27. Handle edge cases: monitor process crashes, profile generation failures
28. Ensure echo agent sessions still work (no sandbox applied to echo agent)
29. Update session creation to gracefully degrade if `sandbox-exec` is unavailable (e.g., wrong OS)

---

## Risks and Open Questions

### `log stream` reliability and performance

The `log stream` command is a real-time tail of the macOS unified log. Concerns:

- **Volume**: On a busy system, `log stream` may produce high output volume. The `--predicate` filter reduces this, but we should monitor CPU/memory impact.
- **Latency**: Log entries may appear with some delay after the actual violation. The UI should not depend on real-time log delivery for functional behavior (i.e., the sandbox enforces boundaries regardless of whether the monitor sees the event).
- **Format stability**: The NDJSON output format is undocumented and could change between macOS versions.

**Mitigation**: The monitor is informational, not load-bearing. The sandbox enforces boundaries at the kernel level. If log monitoring proves unreliable, we can fall back to EPERM detection in tool call results.

### PID-tree tracking

`log stream` doesn't filter by PID tree natively. Our monitor needs to maintain a set of known child PIDs. Challenges:

- Short-lived processes may appear in the log before we've discovered their PID via `pgrep`
- Process names in log entries may not directly correspond to PIDs we're tracking

**Mitigation**: Accept that some violations may be missed or misattributed. The monitor is a best-effort debugging tool, not a security enforcement mechanism. We can also use the `eventMessage contains` predicate to filter by process name patterns common to the agent's subprocess tree.

### Claude Code writing to `~/.claude/`

As noted above, Claude Code may need write access to its own state directory. If it crashes or behaves incorrectly without write access, we'll need to open up `~/.claude/` or specific subdirectories.

**Mitigation**: Test this in Phase 2. If writes to `~/.claude/` are required, add them to the writable paths with a clear comment explaining why.

### `sandbox-exec` deprecation

`sandbox-exec` is marked deprecated but remains functional on macOS 15.x (Sequoia). Claude Code, Cursor, and Codex all rely on it in production. The risk of Apple removing it without replacement is low in the near term, but we should be aware.

**Mitigation**: This is a known risk accepted by the entire coding agent ecosystem. If Apple removes `sandbox-exec`, Bouncer (and everyone else) will need to find an alternative. Not a Milestone 2 concern.

### Mach IPC scope

The initial profile allows all `mach-lookup` operations. This is a broad permission — a malicious or compromised agent could potentially use Mach IPC to communicate with system services in unintended ways.

**Mitigation**: For Milestone 2 (a research/spike milestone), this is acceptable. If we move toward production hardening, we can audit which Mach services the agent actually uses and restrict to those. Claude Code's own sandbox takes the same broad approach.

### `open` command escaping the sandbox

As noted in the [seatbelt reference](../../reference/seatbelt-reference.md), processes launched via `LaunchServices.framework` (the `open` command) may not inherit the sandbox. If the agent runs `open` to launch an application, that application runs unsandboxed.

**Mitigation**: This is an edge case — coding agents rarely use `open`. If needed, we can block `process-exec` for `/usr/bin/open` specifically, or address it in Milestone 5 (application-layer policies).

---

## What This Unblocks

Completing Milestone 2 gives us:

- **Validated OS-level sandboxing** for coding agent sessions, with empirical data on what works and what breaks
- **A working SBPL profile** that Milestone 3 parameterizes into policy templates (standard-pr, research-only, permissive)
- **A sandbox monitor** that Milestone 3 uses for policy violation alerting and Milestone 4 uses for batch testing
- **An iteration methodology** (run task → observe violations → refine profile) that scales to testing more policies in Milestone 4
- **Empirical findings** documenting the real-world friction of filesystem sandboxing for coding agents — directly answering the roadmap's open question: "What legitimate operations does Seatbelt break?"
