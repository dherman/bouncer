# Milestone 2: Seatbelt Sandbox — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition. The plan builds on the working Claude Code integration from [Milestone 1](../../history/live-agent-integration/plan.md).

## Progress

- [x] **[Phase 1: Sandbox Integration Module](#phase-1-sandbox-integration-module)**
  - [x] 1.1 Create `src/main/sandbox.ts` with types and skeleton
  - [x] 1.2 Implement `defaultSandboxConfig()`
  - [x] 1.3 Implement `buildSafehouseArgs()`
  - [x] 1.4 Implement `isSafehouseAvailable()` and cleanup helpers
  - [x] 1.5 Write `scripts/test-sandbox-profile.ts`
  - [x] 1.6 Smoke test: safehouse runs commands, enforces boundaries, stdio pipes work
- [ ] **[Phase 2: Sandboxed Agent Spawning](#phase-2-sandboxed-agent-spawning)**
  - [ ] 2.1 Update `resolveClaudeCodeCommand()` to wrap in `safehouse`
  - [ ] 2.2 Update `createSession()` to build sandbox config before spawning
  - [ ] 2.3 Update `SessionState` with sandbox fields
  - [ ] 2.4 Update `closeSession()` to clean up policy files
  - [ ] 2.5 Add `gitCommonDir` to `WorktreeInfo`
  - [ ] 2.6 Write `scripts/test-sandboxed-agent.ts`
  - [ ] 2.7 Smoke test: agent starts, ACP handshake succeeds, reads worktree
  - [ ] 2.8 Smoke test: agent writes within worktree
- [ ] **[Phase 3: Sandbox Monitor](#phase-3-sandbox-monitor)**
  - [ ] 3.1 Create `src/main/sandbox-monitor.ts` with types and skeleton
  - [ ] 3.2 Implement `log stream` spawning and line parsing
  - [ ] 3.3 Implement PID-tree filtering
  - [ ] 3.4 Wire into session manager
  - [ ] 3.5 Write `scripts/test-sandbox-monitor.ts`
  - [ ] 3.6 Smoke test: trigger a violation, verify monitor captures it
- [ ] **[Phase 4: UI Integration](#phase-4-ui-integration)**
  - [ ] 4.1 Add `SandboxViolationInfo` type and `sandbox-violation` SessionUpdate variant
  - [ ] 4.2 Add IPC handler for violation history
  - [ ] 4.3 Update preload bridge
  - [ ] 4.4 Build `<SandboxLog />` component
  - [ ] 4.5 Add sandbox badge to `<SessionList />`
  - [ ] 4.6 Wire violations into `<ChatPanel />`
  - [ ] 4.7 Full flow test: coding task with visible violations in UI
- [ ] **[Phase 5: Empirical Iteration](#phase-5-empirical-iteration)**
  - [ ] 5.1 Test: read-only task
  - [ ] 5.2 Test: file creation and editing
  - [ ] 5.3 Test: running tests / spawning subprocesses
  - [ ] 5.4 Test: git operations (add, commit)
  - [ ] 5.5 Test: network-dependent task (expect failure, document)
  - [ ] 5.6 Iterate on safehouse flags / `--append-profile` overrides based on findings
  - [ ] 5.7 Write `docs/milestones/seatbelt-sandbox/findings.md`
- [ ] **[Phase 6: Cleanup and Polish](#phase-6-cleanup-and-polish)**
  - [ ] 6.1 Graceful degradation when `safehouse` unavailable
  - [ ] 6.2 Echo agent bypass (no sandbox)
  - [ ] 6.3 Monitor crash resilience
  - [ ] 6.4 Policy file cleanup on app quit
  - [ ] 6.5 Add npm scripts for test harnesses
- [ ] **[Verification](#verification-checklist)** — all manual checks pass

---

## Phase 1: Sandbox Integration Module

> **Completed.** Originally planned as a custom SBPL profile generator. During implementation, we pivoted to delegating sandbox profile generation to [agent-safehouse](https://agent-safehouse.dev), which maintains curated, community-tested macOS Seatbelt profiles. This avoids duplicating substantial platform-specific SBPL knowledge and gives us ongoing community maintenance.

### What was built

**`src/main/sandbox.ts`** — Sandbox integration module with:
- `SandboxConfig` interface — session-specific sandbox parameters
- `defaultSandboxConfig()` — builds config with worktree write access, git common dir, env passthrough
- `buildSafehouseArgs()` — constructs safehouse CLI arguments from config
- `isSafehouseAvailable()` — cached detection of safehouse on PATH
- `ensurePolicyDir()`, `cleanupPolicy()`, `cleanupOrphanPolicies()` — policy file lifecycle

**`scripts/test-sandbox-profile.ts`** — Validation script testing 7 scenarios:
1. Safehouse CLI availability
2. `ls` in worktree via safehouse (allowed)
3. Generated policy file inspection (rule counts)
4. Write to worktree (allowed)
5. Write to home directory (blocked)
6. System binary access (allowed)
7. Stdio piping through safehouse (critical for ACP)

**Key decisions:**
- Safehouse is spawned as the command wrapper — it handles `sandbox-exec` internally
- Policy files are persisted via `--output` so we control lifecycle (cleanup on session close)
- `--workdir` enables safehouse's git root auto-detection and worktree handling
- `--add-dirs` grants write access to session-specific paths (worktree, git common dir)
- `--env-pass` controls which env vars reach the sandboxed process (ANTHROPIC_API_KEY, etc.)

**Done condition:** ✅ All 7 validation tests pass. Safehouse correctly enforces filesystem boundaries while allowing worktree operations and transparent stdio piping.

---

## Phase 2: Sandboxed Agent Spawning

Wire the sandbox module into the session manager so that Claude Code sessions launch via safehouse. This is the highest-risk phase — we're discovering whether the agent can actually operate under the sandbox's constraints.

### 2.1 Update `resolveClaudeCodeCommand()`

- [ ] Add `sandboxConfig` parameter to the function
- [ ] When sandbox is available, spawn via `safehouse` instead of bare `node`

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

  // Unsandboxed fallback
  return { cmd: "node", args: [binPath], cwd };
}
```

- [ ] Update `resolveAgentCommand()` to pass sandbox config through

```typescript
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
): SpawnConfig {
  if (agentType === "echo") {
    return resolveEchoAgentCommand(); // unchanged — no sandbox for echo
  }
  return resolveClaudeCodeCommand(cwd, sandboxConfig);
}
```

**Key detail:** The echo agent is never sandboxed. Only Claude Code sessions get the sandbox treatment.

### 2.2 Update `createSession()` to build sandbox config before spawning

- [ ] Import sandbox functions
- [ ] Build sandbox config between worktree creation and agent spawning
- [ ] Ensure policy output directory exists
- [ ] Pass `sandboxConfig` to `resolveAgentCommand()`

Insert after the worktree creation block:

```typescript
// Build sandbox config
let sandboxConfig: SandboxConfig | null = null;
if (agentType === "claude-code" && await isSafehouseAvailable()) {
  await ensurePolicyDir();
  sandboxConfig = defaultSandboxConfig({
    sessionId: id,
    worktreePath: workingDir,
    gitCommonDir: worktree?.gitCommonDir,
  });
}

// Spawn agent (sandboxed if config present)
const { cmd, args, env, cwd } = resolveAgentCommand(
  agentType,
  workingDir,
  sandboxConfig,
);
```

- [ ] Store sandbox config on the session state

### 2.3 Update `SessionState` with sandbox fields

- [ ] Add `sandboxConfig` and `sandboxViolations` to `SessionState`

```typescript
interface SessionState {
  // ... existing fields ...
  sandboxConfig: SandboxConfig | null;
  sandboxMonitor: SandboxMonitor | null;   // wired in Phase 3
  sandboxViolations: SandboxViolation[];   // populated in Phase 3
}
```

- [ ] Initialize new fields in `createSession()`

### 2.4 Update `closeSession()` to clean up policy files

- [ ] Stop the sandbox monitor (placeholder — wired in Phase 3)
- [ ] Delete the policy file via `cleanupPolicy()`

```typescript
// In closeSession():
session.sandboxMonitor?.stop();

if (session.sandboxConfig) {
  await cleanupPolicy(session.sandboxConfig.policyOutputPath);
}
```

### 2.5 Add `gitCommonDir` to `WorktreeInfo`

- [ ] Update `WorktreeInfo` interface in `worktree-manager.ts` to include `gitCommonDir`
- [ ] After worktree creation, resolve the git common dir:

```typescript
// In WorktreeManager.create():
const { stdout: commonDir } = await execFileAsync(
  "git", ["rev-parse", "--git-common-dir"],
  { cwd: worktreePath }
);
return {
  path: worktreePath,
  branch,
  projectDir,
  gitCommonDir: resolve(worktreePath, commonDir.trim()),
};
```

This is critical: linked worktrees store refs and metadata in the parent repo's `.git` directory. Without write access to the git common dir, `git commit`, `git branch`, and other git operations fail from within the worktree.

### 2.6 Write `scripts/test-sandboxed-agent.ts`

- [ ] Create standalone test script that spawns Claude Code via safehouse and runs the ACP handshake + a simple prompt

This script replicates the structure of `scripts/test-claude-agent.ts` from M1, but wraps the spawn in safehouse. It isolates sandboxed agent spawning from the full Electron app for faster iteration.

```typescript
// scripts/test-sandboxed-agent.ts
//
// Spawns Claude Code under a safehouse sandbox, runs ACP handshake,
// sends a simple prompt, and reports success/failure.
//
// Usage: npx tsx scripts/test-sandboxed-agent.ts [project-dir]
//
// Prerequisites:
//   - safehouse on PATH (brew install eugene1g/safehouse/agent-safehouse)
//   - @zed-industries/claude-agent-acp installed
//   - ANTHROPIC_API_KEY set or Claude Code OAuth active

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  defaultSandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
} from "../src/main/sandbox.js";

const require = createRequire(import.meta.url);
const worktreePath = process.argv[2] || process.cwd();
const sessionId = randomUUID();

console.log("=== Sandboxed Agent Test ===\n");

if (!await isSafehouseAvailable()) {
  console.log("safehouse not found. Install: brew install eugene1g/safehouse/agent-safehouse");
  process.exit(1);
}

// Build sandbox config
await ensurePolicyDir();
const config = defaultSandboxConfig({ sessionId, worktreePath });
console.log(`Worktree: ${worktreePath}`);
console.log(`Policy: ${config.policyOutputPath}`);

// Resolve agent binary
const agentBin = require.resolve(
  "@zed-industries/claude-agent-acp/dist/index.js"
);

// Spawn via safehouse
const args = buildSafehouseArgs(config, ["node", agentBin]);
console.log(`\nSpawning: safehouse ${args.join(" ")}\n`);

const agent = spawn("safehouse", args, {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: worktreePath,
});

agent.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
agent.on("error", (err) => console.error("Spawn error:", err));
agent.on("exit", (code) => console.log(`\nAgent exited: code ${code}`));

// ACP setup
const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

const connection = new acp.ClientSideConnection(
  (_agentInfo) => ({
    async sessionUpdate(params) {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        process.stdout.write(update.content.text);
      } else {
        console.log(`\n  [${update.sessionUpdate}]`);
      }
    },
    async requestPermission(params) {
      const opt = params.options.find((o) => o.kind === "allow_once");
      return {
        outcome: {
          outcome: "selected" as const,
          optionId: (opt ?? params.options[0]).optionId,
        },
      };
    },
  }),
  stream,
);

try {
  console.log("Initializing ACP...");
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  console.log("✓ Initialize succeeded");

  const sessionResp = await connection.newSession({
    cwd: worktreePath,
    mcpServers: [],
  });
  console.log(`✓ New session: ${sessionResp.sessionId}`);

  const prompt = "List the files in the current directory. Be brief.";
  console.log(`\nPrompt: "${prompt}"\n--- Response ---`);
  const resp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  console.log(`\n--- End (stop: ${resp.stopReason}) ---`);
  console.log("\n✓ Sandboxed agent completed successfully");
} catch (err) {
  console.error("\n✗ Error:", err);
  process.exitCode = 1;
} finally {
  agent.kill();
  await cleanupPolicy(config.policyOutputPath);
}

console.log("\n=== Done ===");
```

Add to `package.json` scripts:
```json
"test:sandboxed-agent": "tsx scripts/test-sandboxed-agent.ts"
```

### 2.7 Smoke test: agent starts and reads worktree

- [ ] `npm run test:sandboxed-agent` — agent process starts without crashing
- [ ] ACP `InitializeRequest` and `NewSessionRequest` succeed
- [ ] The simple directory listing prompt returns a response
- [ ] No unexpected errors in stderr

If the agent fails to start, safehouse logs sandbox violations to stderr — check for `Sandbox:` denial messages. If needed, use `--append-profile` to add missing rules or `--add-dirs-ro` for additional read paths.

### 2.8 Smoke test: agent writes within worktree

- [ ] Modify the test script (or send a second prompt) to test a write operation
- [ ] Suggested prompt: "Create a file called sandbox-test.txt containing 'hello from sandbox'"
- [ ] Verify the file appears in the worktree directory
- [ ] Clean up the test file afterward

**Done condition:** Claude Code can start under safehouse, read from the worktree, and write to the worktree. The ACP handshake and stdio piping work correctly through the safehouse wrapper.

---

## Phase 3: Sandbox Monitor

Build the log-stream-based violation monitor. This is informational infrastructure — safehouse enforces boundaries regardless of whether the monitor works. The monitor's job is to surface violations in the UI for debugging and research.

### 3.1 Create `src/main/sandbox-monitor.ts`

- [ ] Create the file with types and class skeleton

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export interface SandboxViolation {
  timestamp: Date;
  pid: number;
  processName: string;
  operation: string;
  path?: string;
  raw: string;
}

export class SandboxMonitor extends EventEmitter {
  private logProcess: ChildProcess | null = null;
  private rootPid: number = 0;
  private knownPids: Set<number> = new Set();
  private pidRefreshTimer: ReturnType<typeof setInterval> | null = null;

  start(pid: number): void { /* ... */ }
  stop(): void { /* ... */ }
}
```

### 3.2 Implement `log stream` spawning and line parsing

- [ ] Spawn `log stream --style ndjson --predicate 'sender=="Sandbox"'`
- [ ] Read stdout line-by-line using `readline.createInterface`
- [ ] Parse each line as JSON, extract violation details
- [ ] Fall back to compact-format regex parsing if NDJSON parsing fails

### 3.3 Implement PID-tree filtering

- [ ] Use `pgrep -P <pid>` to discover child PIDs recursively
- [ ] Refresh every 2 seconds (agent spawns short-lived subprocesses frequently)
- [ ] Over-matching is acceptable — the monitor is informational, not enforcement

### 3.4 Wire into session manager

- [ ] Import `SandboxMonitor` in `session-manager.ts`
- [ ] After spawning the sandboxed agent, create and start a `SandboxMonitor`
- [ ] Forward `violation` events as `sandbox-violation` SessionUpdate emissions
- [ ] Store violations in `session.sandboxViolations` for history queries
- [ ] Stop the monitor in `closeSession()`
- [ ] Add `getSandboxViolations(sessionId)` method to session manager

### 3.5 Write `scripts/test-sandbox-monitor.ts`

- [ ] Create standalone script that spawns a sandboxed process designed to trigger violations
- [ ] Verify the monitor catches them

Add to `package.json` scripts:
```json
"test:sandbox-monitor": "tsx scripts/test-sandbox-monitor.ts"
```

### 3.6 Smoke test

- [ ] `npm run test:sandbox-monitor` reports at least one violation
- [ ] Violation has correct fields: operation, path, processName
- [ ] Monitor stops cleanly without orphan `log` processes

**Done condition:** The monitor can detect sandbox violations from a child process and emit them as structured events.

---

## Phase 4: UI Integration

Wire sandbox events into the Electron renderer. This phase adds a violation log panel and sandbox status indicators to the existing UI.

### 4.1 Add `SandboxViolationInfo` type and `sandbox-violation` SessionUpdate variant

- [ ] Add to `src/main/types.ts`

### 4.2 Add IPC handler for violation history

- [ ] Add `sessions:getSandboxViolations` handler in `src/main/index.ts`

### 4.3 Update preload bridge

- [ ] Add `getSandboxViolations` method to `src/preload/index.ts`
- [ ] Update renderer type declarations in `src/renderer/src/env.d.ts`

### 4.4 Build `<SandboxLog />` component

- [ ] Create `src/renderer/src/components/SandboxLog.tsx`
- [ ] Collapsible panel showing violations in real time
- [ ] Color-coded, auto-scrolling, max 200 entries in UI state

### 4.5 Add sandbox badge to `<SessionList />`

- [ ] Show shield icon or "sandboxed" label for Claude Code sessions
- [ ] Violation count badge if violations are occurring

### 4.6 Wire violations into `<ChatPanel />`

- [ ] Add `<SandboxLog />` panel below chat messages
- [ ] Track violations in `App.tsx` state, keyed by session ID
- [ ] Handle `sandbox-violation` in the `handleUpdate` switch

### 4.7 Full flow test

- [ ] Launch app → create session → verify "sandboxed" badge
- [ ] Send a prompt that works within the worktree
- [ ] Trigger violations and verify they appear in the sandbox log
- [ ] Verify chat still functions normally

**Done condition:** Sandbox violations appear in the UI in real time. Sessions show sandbox status badges.

---

## Phase 5: Empirical Iteration

Run representative coding tasks under the sandbox, document what breaks, iterate, and record findings.

### 5.1 Test: read-only task

- [ ] Prompt: "Read the README.md file and summarize its contents"
- [ ] Expected: succeeds without violations
- [ ] Record: any violations, success/failure

### 5.2 Test: file creation and editing

- [ ] Prompt: "Create a new file called `src/main/sandbox-test.ts` with a simple function"
- [ ] Expected: succeeds — writing within worktree is allowed
- [ ] Record: verify file was created in worktree (not original project dir)

### 5.3 Test: running tests / spawning subprocesses

- [ ] Prompt: "Run `npm test` or list the available npm scripts and run the lint command"
- [ ] Expected: may partially succeed — depends on network/cache needs
- [ ] Record: all violations, which subprocess caused them

### 5.4 Test: git operations (add, commit)

- [ ] Prompt: "Create a new file, git add it, and commit with message 'test commit'"
- [ ] Expected: should succeed — git common dir has write access
- [ ] Record: any violations, verify commit exists

### 5.5 Test: network-dependent task

- [ ] Prompt: "Install the `lodash` package using npm"
- [ ] Expected: succeeds — safehouse allows network by default (see design doc network policy section)
- [ ] Record: whether npm install works end-to-end under the sandbox, any filesystem violations from cache writes
- [ ] Note: Milestone 6 will add network restrictions via `--append-profile` overlay or container networking

### 5.6 Iterate on safehouse configuration

- [ ] For each failed test, categorize violations:
  - **Expected/acceptable**: working as intended (e.g., network block)
  - **Fixable via safehouse flags**: add `--add-dirs`, `--add-dirs-ro`, or `--enable` integrations
  - **Needs `--append-profile`**: custom SBPL overlay for edge cases
  - **Application-layer gap**: note for Milestone 5
- [ ] Update `defaultSandboxConfig()` or add safehouse flags as needed
- [ ] Re-run failed tests to confirm fixes

### 5.7 Write `docs/milestones/seatbelt-sandbox/findings.md`

- [ ] Create findings document with test results, safehouse config evolution, and open issues

**Done condition:** At least 3 of the 5 test tasks complete successfully. All violations are categorized and documented. `findings.md` is written.

---

## Phase 6: Cleanup and Polish

### 6.1 Graceful degradation when `safehouse` unavailable

- [ ] In `createSession()`, check `isSafehouseAvailable()` before building sandbox config
- [ ] If unavailable, fall back to unsandboxed spawning with a warning
- [ ] Log: "safehouse not available — agent will run without OS-level sandboxing"

### 6.2 Echo agent bypass

- [ ] Verify echo agent sessions skip sandbox entirely
- [ ] Should already work from the `if (agentType === "claude-code")` guard

### 6.3 Monitor crash resilience

- [ ] If `log stream` process exits unexpectedly, log a warning but don't crash the session
- [ ] The sandbox still enforces boundaries even without the monitor

### 6.4 Policy file cleanup on app quit

- [ ] Ensure `closeAllSessions()` cleans up all policy files
- [ ] Add `cleanupOrphanPolicies()` call on app startup

### 6.5 Add npm scripts

- [ ] Ensure all test scripts are registered in `package.json`:

```json
{
  "scripts": {
    "test:sandbox-profile": "tsx scripts/test-sandbox-profile.ts",
    "test:sandboxed-agent": "tsx scripts/test-sandboxed-agent.ts",
    "test:sandbox-monitor": "tsx scripts/test-sandbox-monitor.ts"
  }
}
```

**Done condition:** The sandbox system handles edge cases gracefully. Echo agent is unaffected. Missing safehouse doesn't crash the app.

---

## Verification Checklist

Run these checks after all phases are complete:

- [ ] **Safehouse integration**: `npm run test:sandbox-profile` passes all validation tests
- [ ] **Sandboxed agent**: `npm run test:sandboxed-agent` completes a prompt successfully
- [ ] **Monitor detection**: `npm run test:sandbox-monitor` detects at least one violation
- [ ] **Full Electron flow**: Launch app → create Claude Code session → verify "sandboxed" badge → send prompt → see response → see sandbox log
- [ ] **Write boundary**: Agent can create/edit files within the worktree
- [ ] **Write enforcement**: Agent cannot write files outside the worktree (verify via sandbox log or EPERM in tool output)
- [ ] **Echo agent unaffected**: Echo agent sessions work without sandbox
- [ ] **Session cleanup**: Close a session → verify worktree removed, policy file removed, monitor stopped
- [ ] **Graceful degradation**: Uninstall safehouse → verify agent still launches (unsandboxed) with warning
- [ ] **Findings documented**: `docs/milestones/seatbelt-sandbox/findings.md` exists with test results

---

## File Change Summary

### New files

| File | Purpose |
|------|---------|
| `src/main/sandbox.ts` | Safehouse integration: config, arg building, availability check, cleanup |
| `src/main/sandbox-monitor.ts` | Unified log monitoring for sandbox violations |
| `src/renderer/src/components/SandboxLog.tsx` | UI component for violation log display |
| `scripts/test-sandbox-profile.ts` | Test harness for safehouse integration |
| `scripts/test-sandboxed-agent.ts` | Test harness for sandboxed agent spawning |
| `scripts/test-sandbox-monitor.ts` | Test harness for violation monitoring |
| `docs/milestones/seatbelt-sandbox/findings.md` | Empirical findings from sandbox testing |

### Modified files

| File | Changes |
|------|---------|
| `src/main/session-manager.ts` | Sandbox config, safehouse spawn, monitor lifecycle, violation tracking |
| `src/main/worktree-manager.ts` | Add `gitCommonDir` to `WorktreeInfo` |
| `src/main/types.ts` | `SandboxViolationInfo`, `sandbox-violation` SessionUpdate variant |
| `src/preload/index.ts` | `getSandboxViolations` IPC bridge method |
| `src/renderer/src/env.d.ts` | Type declarations for new IPC methods |
| `src/renderer/src/App.tsx` | Violation state management, `sandbox-violation` update handling |
| `src/renderer/src/components/ChatPanel.tsx` | `<SandboxLog />` integration |
| `src/renderer/src/components/SessionList.tsx` | Sandbox status badge |
| `package.json` | New test scripts |

### External dependencies

| Dependency | Type | Install |
|------------|------|---------|
| `agent-safehouse` | CLI tool (runtime, macOS only) | `brew install eugene1g/safehouse/agent-safehouse` |
