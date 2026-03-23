# Milestone 2: Seatbelt Sandbox — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition. The plan builds on the working Claude Code integration from [Milestone 1](../../history/live-agent-integration/plan.md).

## Progress

- [ ] **[Phase 1: Sandbox Profile Generator](#phase-1-sandbox-profile-generator)**
  - [ ] 1.1 Create `src/main/sandbox-profile.ts` with types and skeleton
  - [ ] 1.2 Implement `defaultPolicy()`
  - [ ] 1.3 Implement `generateProfile()` — policy to SBPL conversion
  - [ ] 1.4 Implement `writePolicyToDisk()`
  - [ ] 1.5 Write `scripts/test-sandbox-profile.ts`
  - [ ] 1.6 Smoke test: generated profile allows/denies expected operations
- [ ] **[Phase 2: Sandboxed Agent Spawning](#phase-2-sandboxed-agent-spawning)**
  - [ ] 2.1 Update `resolveClaudeCodeCommand()` to wrap in `sandbox-exec`
  - [ ] 2.2 Update `createSession()` to generate profile before spawning
  - [ ] 2.3 Update `SessionState` with sandbox fields
  - [ ] 2.4 Update `closeSession()` to clean up profile files
  - [ ] 2.5 Write `scripts/test-sandboxed-agent.ts`
  - [ ] 2.6 Smoke test: agent starts, ACP handshake succeeds, reads worktree
  - [ ] 2.7 Smoke test: agent writes within worktree
  - [ ] 2.8 Iterate on profile for any startup failures
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
  - [ ] 5.6 Profile iteration: update `defaultPolicy()` based on findings
  - [ ] 5.7 Write `docs/milestones/seatbelt-sandbox/findings.md`
- [ ] **[Phase 6: Cleanup and Polish](#phase-6-cleanup-and-polish)**
  - [ ] 6.1 Graceful degradation when `sandbox-exec` unavailable
  - [ ] 6.2 Echo agent bypass (no sandbox)
  - [ ] 6.3 Monitor crash resilience
  - [ ] 6.4 Profile file cleanup on app quit
  - [ ] 6.5 Add `test:sandbox-profile` and `test:sandbox-monitor` npm scripts
- [ ] **[Verification](#verification-checklist)** — all manual checks pass

---

## Phase 1: Sandbox Profile Generator

Build the SBPL profile generator in isolation. This module has no Electron, ACP, or process-spawning dependencies — it's pure string generation from a typed policy struct.

### 1.1 Create `src/main/sandbox-profile.ts`

- [ ] Create the file with type definitions and function signatures

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxPolicy {
  /** Paths the sandboxed process can read and write */
  writablePaths: string[];
  /** Paths the sandboxed process can read (but not write) */
  readOnlyPaths: string[];
  /** Whether to allow outbound network access */
  allowNetwork: boolean;
}

export function defaultPolicy(params: {
  worktreePath: string;
  homedir: string;
  tmpdir: string;
  sessionId: string;
}): SandboxPolicy { /* ... */ }

export function generateProfile(policy: SandboxPolicy): string { /* ... */ }

export async function writePolicyToDisk(
  sessionId: string,
  profile: string,
): Promise<string> { /* ... */ }
```

### 1.2 Implement `defaultPolicy()`

- [ ] Return a `SandboxPolicy` with the paths enumerated in the design doc

```typescript
export function defaultPolicy({
  worktreePath,
  homedir,
  tmpdir: tmpdirPath,
  sessionId,
}: {
  worktreePath: string;
  homedir: string;
  tmpdir: string;
  sessionId: string;
}): SandboxPolicy {
  return {
    writablePaths: [
      worktreePath,
      join(tmpdirPath, `glitterball-${sessionId}`),
    ],
    readOnlyPaths: [
      // System binaries and libraries
      "/usr/bin",
      "/usr/lib",
      "/usr/libexec",
      "/usr/share",
      "/bin",
      "/sbin",
      "/Library/Apple",
      "/System",
      "/private/var/db",
      "/dev",
      "/etc",
      "/private/etc",
      "/var",

      // Homebrew / user-installed tools
      "/usr/local",
      "/opt/homebrew",

      // User dotfiles
      `${homedir}/.gitconfig`,
      `${homedir}/.gitignore_global`,
      `${homedir}/.ssh`,
      `${homedir}/.claude`,
      `${homedir}/.claude.json`,
      `${homedir}/.config`,
      `${homedir}/.npm`,
      `${homedir}/.node_modules`,
      `${homedir}/.nvm`,
      `${homedir}/.cargo`,
      `${homedir}/.rustup`,
      `${homedir}/.zshrc`,
      `${homedir}/.zshenv`,
      `${homedir}/.zprofile`,
      `${homedir}/.bashrc`,
      `${homedir}/.bash_profile`,
      `${homedir}/.profile`,
    ],
    allowNetwork: false,
  };
}
```

**Key detail:** The `sessionId` is threaded into `defaultPolicy()` (not just into `writePolicyToDisk()`) because the session-scoped temp directory path depends on it.

### 1.3 Implement `generateProfile()`

- [ ] Convert a `SandboxPolicy` into a valid SBPL profile string
- [ ] Escape any special characters in paths (parentheses, quotes)

```typescript
export function generateProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    "; ── Process and system operations ────────────────────",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow iokit-open)",
    "",
  ];

  // Writable paths (read + write)
  if (policy.writablePaths.length > 0) {
    lines.push("; ── Writable paths ────────────────────────────────");
    for (const p of policy.writablePaths) {
      const escaped = escapeSbplPath(p);
      lines.push(`(allow file-read* (subpath "${escaped}"))`);
      lines.push(`(allow file-write* (subpath "${escaped}"))`);
    }
    lines.push("");
  }

  // Read-only paths
  if (policy.readOnlyPaths.length > 0) {
    lines.push("; ── Read-only paths ───────────────────────────────");
    for (const p of policy.readOnlyPaths) {
      const escaped = escapeSbplPath(p);
      // Use subpath for directories, literal for files
      if (looksLikeFile(p)) {
        lines.push(`(allow file-read* (literal "${escaped}"))`);
      } else {
        lines.push(`(allow file-read* (subpath "${escaped}"))`);
      }
    }
    lines.push("");
  }

  // Network
  if (policy.allowNetwork) {
    lines.push("; ── Network ───────────────────────────────────────");
    lines.push("(allow network*)");
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

/** Escape characters that are special in SBPL string literals. */
function escapeSbplPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Heuristic: if a path has a dot-extension in the last component or is a
 * known dotfile (e.g. ~/.gitconfig), treat it as a file (use literal match).
 * Otherwise treat as a directory (use subpath match).
 */
function looksLikeFile(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? "";
  // Dotfiles like .gitconfig, .zshrc, .claude.json
  if (lastSegment.startsWith(".") && !lastSegment.includes("/")) {
    // Dotfiles with extensions are files
    if (lastSegment.includes(".") && lastSegment !== ".") {
      // e.g., .claude.json, .gitignore_global → file
      // But .ssh, .claude, .npm, .config → directory
      const afterFirstDot = lastSegment.slice(1);
      if (!afterFirstDot.includes(".") && !afterFirstDot.includes("_")) {
        // Single-segment dotname like .ssh, .npm, .config → directory
        return false;
      }
      return true;
    }
    return false; // .ssh, .claude, .npm → directories
  }
  return false;
}
```

**The `subpath` vs `literal` distinction matters.** `(subpath "/usr/bin")` matches `/usr/bin` and everything underneath it. `(literal "~/.gitconfig")` matches only that exact path. Using `subpath` on a file path is harmless but slightly imprecise; using `literal` on a directory would miss its contents. The `looksLikeFile()` heuristic handles the common cases — dotfiles with extensions (`.gitconfig`, `.claude.json`, `.zshrc`) are files; dotdirs without extensions (`.ssh`, `.claude`, `.npm`) are directories.

**Edge case — `.gitignore_global`:** This is a file despite having no extension dot after the leading dot. The heuristic catches it via the underscore. If the heuristic is wrong for a specific path, it degrades gracefully (a `subpath` match on a file just means the rule also matches nonexistent children, which is harmless).

### 1.4 Implement `writePolicyToDisk()`

- [ ] Write the SBPL string to a file at `{tmpdir}/glitterball-sandbox/<session-id>.sb`
- [ ] Create the directory if it doesn't exist
- [ ] Return the absolute path to the written file

```typescript
const SANDBOX_PROFILE_DIR = join(tmpdir(), "glitterball-sandbox");

export async function writePolicyToDisk(
  sessionId: string,
  profile: string,
): Promise<string> {
  await mkdir(SANDBOX_PROFILE_DIR, { recursive: true });
  const profilePath = join(SANDBOX_PROFILE_DIR, `${sessionId}.sb`);
  await writeFile(profilePath, profile, "utf-8");
  return profilePath;
}
```

### 1.5 Write `scripts/test-sandbox-profile.ts`

- [ ] Create test script that generates a profile, writes it to disk, and runs validation commands

```typescript
// scripts/test-sandbox-profile.ts
//
// Generates a sandbox profile and validates it against real sandbox-exec.
//
// Usage: npx tsx scripts/test-sandbox-profile.ts [project-dir]
//
// Defaults to the current directory as the "worktree" path.

import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import {
  defaultPolicy,
  generateProfile,
  writePolicyToDisk,
} from "../src/main/sandbox-profile.js";

const execFileAsync = promisify(execFile);
const worktreePath = process.argv[2] || process.cwd();
const sessionId = randomUUID();

console.log("=== Sandbox Profile Generator Test ===\n");

// 1. Generate policy and profile
console.log(`Worktree path: ${worktreePath}`);
const policy = defaultPolicy({
  worktreePath,
  homedir: homedir(),
  tmpdir: tmpdir(),
  sessionId,
});
console.log(`\nPolicy writable paths: ${policy.writablePaths.length}`);
console.log(`Policy read-only paths: ${policy.readOnlyPaths.length}`);
console.log(`Policy allow network: ${policy.allowNetwork}`);

const profile = generateProfile(policy);
console.log(`\n--- Generated SBPL (${profile.length} chars) ---`);
console.log(profile);
console.log("--- End SBPL ---");

// 2. Write to disk
const profilePath = await writePolicyToDisk(sessionId, profile);
console.log(`\nProfile written to: ${profilePath}`);

// 3. Validate with sandbox-exec
console.log("\n--- Validation Tests ---\n");

// Test 1: ls the worktree (should succeed)
try {
  const { stdout } = await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/bin/ls", worktreePath],
  );
  console.log(`✓ ls worktree: ${stdout.trim().split("\n").length} entries`);
} catch (err: any) {
  console.log(`✗ ls worktree FAILED: ${err.message}`);
}

// Test 2: ls home directory (may fail — not all of ~ is readable)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/bin/ls", homedir()],
  );
  console.log("✗ ls ~ succeeded (should have been restricted)");
} catch {
  console.log("✓ ls ~ blocked (expected — home dir not broadly readable)");
}

// Test 3: write to worktree (should succeed)
const testFile = `${worktreePath}/.sandbox-test-${sessionId}`;
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/touch", testFile],
  );
  console.log("✓ touch in worktree succeeded");
  // Clean up
  await rm(testFile, { force: true });
} catch (err: any) {
  console.log(`✗ touch in worktree FAILED: ${err.message}`);
}

// Test 4: write outside worktree (should fail)
const badFile = `/tmp/.sandbox-test-bad-${sessionId}`;
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/touch", badFile],
  );
  console.log("✗ touch in /tmp succeeded (should have been blocked)");
  await rm(badFile, { force: true });
} catch {
  console.log("✓ touch in /tmp blocked (expected)");
}

// Test 5: read system binary (should succeed)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/which", "git"],
  );
  console.log("✓ which git succeeded");
} catch (err: any) {
  console.log(`✗ which git FAILED: ${err.message}`);
}

// Test 6: network (should fail)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/curl", "-s", "--max-time", "2", "https://example.com"],
    { timeout: 5000 },
  );
  console.log("✗ curl succeeded (should have been blocked)");
} catch {
  console.log("✓ curl blocked (expected — network denied)");
}

// Clean up profile
await rm(profilePath, { force: true });
console.log(`\nCleaned up profile: ${profilePath}`);
console.log("\n=== Done ===");
```

Add to `package.json` scripts:
```json
"test:sandbox-profile": "tsx scripts/test-sandbox-profile.ts"
```

### 1.6 Smoke test

- [ ] `npm run test:sandbox-profile` completes without errors
- [ ] All six validation tests produce the expected result (✓)
- [ ] Inspect the printed SBPL for correctness — valid S-expressions, no missing parens
- [ ] If any test fails unexpectedly, fix `generateProfile()` or `defaultPolicy()` and re-run

**Done condition:** The profile generator produces valid SBPL that correctly allows worktree access, blocks writes outside the boundary, and blocks network. All validation tests pass.

---

## Phase 2: Sandboxed Agent Spawning

Wire the profile generator into the session manager so that Claude Code sessions launch inside a Seatbelt sandbox. This is the highest-risk phase — we're discovering whether the agent can actually operate under the sandbox's constraints.

### 2.1 Update `resolveClaudeCodeCommand()`

- [ ] Add `profilePath` parameter to the function
- [ ] Change the spawn command from `node <agentBin>` to `sandbox-exec -f <profile> node <agentBin>`

```typescript
function resolveClaudeCodeCommand(
  cwd: string,
  profilePath: string | null,
): SpawnConfig {
  const require = createRequire(app.getAppPath() + "/");
  const binPath = require.resolve(
    "@zed-industries/claude-agent-acp/dist/index.js"
  );

  if (profilePath) {
    return {
      cmd: "/usr/bin/sandbox-exec",
      args: ["-f", profilePath, "node", binPath],
      cwd,
    };
  }

  // Unsandboxed fallback (e.g., non-macOS or sandbox disabled)
  return {
    cmd: "node",
    args: [binPath],
    cwd,
  };
}
```

- [ ] Update `resolveAgentCommand()` to pass the profile path through

```typescript
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  profilePath: string | null,
): SpawnConfig {
  if (agentType === "echo") {
    return resolveEchoAgentCommand(); // unchanged — no sandbox for echo
  }
  return resolveClaudeCodeCommand(cwd, profilePath);
}
```

**Key detail:** The echo agent is never sandboxed. It's our development/test tool and doesn't need filesystem restrictions. Only Claude Code sessions get the sandbox treatment.

### 2.2 Update `createSession()` to generate profile before spawning

- [ ] Import sandbox-profile functions
- [ ] Generate policy and write profile to disk between worktree creation and agent spawning
- [ ] Create session-scoped temp directory (for writable tmp)
- [ ] Pass `profilePath` to `resolveAgentCommand()`

Insert after the worktree creation block:

```typescript
// Generate sandbox profile
let sandboxProfilePath: string | null = null;
if (agentType === "claude-code") {
  const policy = defaultPolicy({
    worktreePath: workingDir,
    homedir: homedir(),
    tmpdir: tmpdir(),
    sessionId: id,
  });
  const profileContent = generateProfile(policy);
  sandboxProfilePath = await writePolicyToDisk(id, profileContent);

  // Create the session-scoped temp directory
  const sessionTmpDir = join(tmpdir(), `glitterball-${id}`);
  await mkdir(sessionTmpDir, { recursive: true });
}

// Update the resolveAgentCommand call
const { cmd, args, env, cwd } = resolveAgentCommand(
  agentType,
  workingDir,
  sandboxProfilePath,
);
```

- [ ] Store `sandboxProfilePath` on the session state

### 2.3 Update `SessionState` with sandbox fields

- [ ] Add `sandboxProfilePath` and `sandboxViolations` to `SessionState`

```typescript
interface SessionState {
  // ... existing fields ...
  sandboxProfilePath: string | null;
  sandboxMonitor: SandboxMonitor | null;   // wired in Phase 3
  sandboxViolations: SandboxViolation[];   // populated in Phase 3
}
```

- [ ] Initialize new fields in `createSession()`:

```typescript
const session: SessionState = {
  // ... existing fields ...
  sandboxProfilePath,
  sandboxMonitor: null,
  sandboxViolations: [],
};
```

### 2.4 Update `closeSession()` to clean up profile files

- [ ] Stop the sandbox monitor (placeholder — wired in Phase 3)
- [ ] Delete the `.sb` profile file
- [ ] Delete the session-scoped temp directory

```typescript
async closeSession(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.status = "closed";
  session.agentProcess?.kill();

  // Stop sandbox monitor
  session.sandboxMonitor?.stop();

  // Tear down worktree (existing)
  if (session.worktree) {
    try {
      await this.worktreeManager.remove(session.worktree);
    } catch (err) {
      console.warn(`Failed to remove worktree for session ${sessionId}:`, err);
    }
  }

  // Clean up sandbox profile
  if (session.sandboxProfilePath) {
    await rm(session.sandboxProfilePath, { force: true }).catch(() => {});
  }

  // Clean up session temp directory
  const sessionTmpDir = join(tmpdir(), `glitterball-${sessionId}`);
  await rm(sessionTmpDir, { recursive: true, force: true }).catch(() => {});

  this.emit("session-update", {
    sessionId,
    type: "status-change",
    status: "closed",
  });
}
```

### 2.5 Write `scripts/test-sandboxed-agent.ts`

- [ ] Create standalone test script that spawns Claude Code under sandbox-exec and runs the ACP handshake + a simple prompt

This script replicates the structure of `scripts/test-claude-agent.ts` from M1, but wraps the spawn in `sandbox-exec`. It isolates the sandboxed agent spawning from the full Electron app, making it faster to iterate on the profile.

```typescript
// scripts/test-sandboxed-agent.ts
//
// Spawns Claude Code under a Seatbelt sandbox, runs ACP handshake,
// sends a simple prompt, and reports success/failure.
//
// Usage: npx tsx scripts/test-sandboxed-agent.ts [project-dir]

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  defaultPolicy,
  generateProfile,
  writePolicyToDisk,
} from "../src/main/sandbox-profile.js";

const require = createRequire(import.meta.url);
const worktreePath = process.argv[2] || process.cwd();
const sessionId = randomUUID();

console.log("=== Sandboxed Agent Test ===\n");
console.log(`Worktree: ${worktreePath}`);

// Generate profile
const policy = defaultPolicy({
  worktreePath,
  homedir: homedir(),
  tmpdir: tmpdir(),
  sessionId,
});
const profile = generateProfile(policy);
const profilePath = await writePolicyToDisk(sessionId, profile);
console.log(`Profile: ${profilePath}`);

// Create session temp dir
const sessionTmpDir = join(tmpdir(), `glitterball-${sessionId}`);
await mkdir(sessionTmpDir, { recursive: true });

// Resolve agent binary
const agentBin = require.resolve(
  "@zed-industries/claude-agent-acp/dist/index.js"
);

// Spawn under sandbox
console.log("\nSpawning sandboxed agent...");
const agent = spawn(
  "/usr/bin/sandbox-exec",
  ["-f", profilePath, "node", agentBin],
  {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: worktreePath,
    env: process.env,
  },
);

let stderr = "";
agent.stderr?.on("data", (data: Buffer) => {
  stderr += data.toString();
  process.stderr.write(data);
});
agent.on("error", (err) => console.error("Spawn error:", err));
agent.on("exit", (code) => console.log(`\nAgent exited: code ${code}`));

// Set up ACP
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
  // ACP handshake
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

  // Simple read-only prompt
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
  if (stderr.includes("Sandbox")) {
    console.error("\nSandbox-related stderr detected — profile may be too restrictive");
  }
  process.exitCode = 1;
} finally {
  agent.kill();
  await rm(profilePath, { force: true }).catch(() => {});
  await rm(sessionTmpDir, { recursive: true, force: true }).catch(() => {});
}

console.log("\n=== Done ===");
```

Add to `package.json` scripts:
```json
"test:sandboxed-agent": "tsx scripts/test-sandboxed-agent.ts"
```

### 2.6 Smoke test: agent starts and reads worktree

- [ ] `npm run test:sandboxed-agent` — agent process starts without crashing
- [ ] ACP `InitializeRequest` and `NewSessionRequest` succeed
- [ ] The simple directory listing prompt returns a response
- [ ] No unexpected sandbox violations in stderr

If the agent fails to start:
1. Check stderr for `Sandbox:` denial messages — these indicate which operations the profile is missing
2. Common early failures: Node.js needs to read shared libraries from `/usr/lib`, `/usr/local/lib`, or Homebrew paths; Claude Code needs to read `~/.claude.json` for auth
3. Add the missing paths to `defaultPolicy()` and re-run

### 2.7 Smoke test: agent writes within worktree

- [ ] Run `test:sandboxed-agent` with a mutation prompt (manually edit the script or add a second prompt)
- [ ] Suggested prompt: "Create a file called sandbox-test.txt containing 'hello from sandbox'"
- [ ] Verify the file appears in the worktree directory
- [ ] Clean up the test file afterward

### 2.8 Iterate on profile for startup failures

- [ ] Document every path that needed to be added to make the agent start and operate
- [ ] For each addition, record:
  - What operation failed (e.g., `file-read-data /private/var/db/dyld/dyld_shared_cache_arm64e`)
  - Why it's needed (e.g., dynamic linker shared cache for loading libraries)
  - Whether it's a read-only or read-write addition
  - Whether it's always needed or only in specific scenarios

This iteration log feeds directly into Phase 5's `findings.md`.

**Done condition:** Claude Code can start under the sandbox, read from the worktree, and write to the worktree. The profile may still break some operations — that's expected and will be addressed in Phase 5.

---

## Phase 3: Sandbox Monitor

Build the log-stream-based violation monitor. This is informational infrastructure — the sandbox enforces boundaries regardless of whether the monitor works. The monitor's job is to surface violations in the UI for debugging and research.

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

export declare interface SandboxMonitor {
  on(event: "violation", listener: (v: SandboxViolation) => void): this;
  emit(event: "violation", v: SandboxViolation): boolean;
}

export class SandboxMonitor extends EventEmitter {
  private logProcess: ChildProcess | null = null;
  private rootPid: number = 0;
  private knownPids: Set<number> = new Set();
  private pidRefreshTimer: ReturnType<typeof setInterval> | null = null;

  start(pid: number): void { /* ... */ }
  stop(): void { /* ... */ }
  private refreshPidTree(): void { /* ... */ }
  private parseLine(line: string): SandboxViolation | null { /* ... */ }
}
```

### 3.2 Implement `log stream` spawning and line parsing

- [ ] Spawn `log stream --style ndjson --predicate 'sender=="Sandbox"'`
- [ ] Read stdout line-by-line using `readline.createInterface`
- [ ] Parse each line as JSON and extract violation details

```typescript
start(pid: number): void {
  this.rootPid = pid;
  this.knownPids.add(pid);

  // Try ndjson first, fall back to compact
  this.logProcess = spawn("log", [
    "stream",
    "--style", "ndjson",
    "--predicate", 'sender=="Sandbox"',
  ], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const rl = createInterface({ input: this.logProcess.stdout! });
  rl.on("line", (line) => {
    const violation = this.parseLine(line);
    if (violation && this.knownPids.has(violation.pid)) {
      this.emit("violation", violation);
    }
  });

  this.logProcess.on("error", (err) => {
    console.warn("Sandbox monitor log stream error:", err);
  });

  // Refresh PID tree periodically
  this.pidRefreshTimer = setInterval(() => this.refreshPidTree(), 2000);
  this.refreshPidTree(); // Initial refresh
}
```

- [ ] Implement `parseLine()` for NDJSON format

```typescript
private parseLine(line: string): SandboxViolation | null {
  try {
    const entry = JSON.parse(line);

    // ndjson format has eventMessage, processID, timestamp, etc.
    const msg: string = entry.eventMessage ?? "";
    const pid: number = entry.processID ?? 0;

    // Seatbelt messages look like:
    // "process_name(pid) deny(1) file-write-data /some/path"
    // or: "Sandbox: process_name(pid) deny(1) operation path"
    const match = msg.match(
      /(\w+)\(\d+\)\s+deny\(\d+\)\s+([\w-]+)\s*(.*)/
    );
    if (!match) return null;

    const [, processName, operation, path] = match;
    return {
      timestamp: new Date(entry.timestamp ?? Date.now()),
      pid,
      processName,
      operation,
      path: path?.trim() || undefined,
      raw: msg,
    };
  } catch {
    // Not valid JSON — may be a header line or compact format
    // Try compact format regex as fallback
    return this.parseCompactLine(line);
  }
}

private parseCompactLine(line: string): SandboxViolation | null {
  // Compact format: "Sandbox: node(12345) deny(1) file-write-data /some/path"
  const match = line.match(
    /Sandbox:\s+(\w+)\((\d+)\)\s+deny\(\d+\)\s+([\w-]+)\s*(.*)/
  );
  if (!match) return null;

  const [, processName, pidStr, operation, path] = match;
  return {
    timestamp: new Date(),
    pid: parseInt(pidStr, 10),
    processName,
    operation,
    path: path?.trim() || undefined,
    raw: line,
  };
}
```

### 3.3 Implement PID-tree filtering

- [ ] Use `pgrep -P <pid>` to discover child PIDs
- [ ] Recursively discover grandchildren
- [ ] Refresh every 2 seconds (agent spawns short-lived subprocesses frequently)

```typescript
private refreshPidTree(): void {
  // Use pgrep to find all descendants of the root PID
  const pgrep = spawn("pgrep", ["-P", String(this.rootPid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  let output = "";
  pgrep.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
  pgrep.on("close", () => {
    const childPids = output.trim().split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n));

    for (const childPid of childPids) {
      this.knownPids.add(childPid);
      // Recursively discover grandchildren
      this.discoverDescendants(childPid);
    }
  });
}

private discoverDescendants(parentPid: number): void {
  const pgrep = spawn("pgrep", ["-P", String(parentPid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  pgrep.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
  pgrep.on("close", () => {
    const pids = output.trim().split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n));
    for (const pid of pids) {
      if (!this.knownPids.has(pid)) {
        this.knownPids.add(pid);
        this.discoverDescendants(pid);
      }
    }
  });
}
```

**Design choice — over-matching is better than under-matching.** PIDs are added to `knownPids` but never removed (short-lived processes may exit before the next refresh). PID reuse is theoretically possible but unlikely within a single session's lifetime. If we over-match and attribute a violation from a different process to our sandbox, the worst case is a spurious entry in the UI log — not a functional problem.

### 3.4 Wire into session manager

- [ ] Import `SandboxMonitor` in `session-manager.ts`
- [ ] After spawning the sandboxed agent, create and start a `SandboxMonitor`
- [ ] Forward `violation` events as `sandbox-violation` SessionUpdate emissions
- [ ] Store violations in `session.sandboxViolations` for history queries
- [ ] Stop the monitor in `closeSession()`

```typescript
// In createSession(), after spawning the agent:
if (sandboxProfilePath && agentProcess.pid) {
  const monitor = new SandboxMonitor();
  monitor.on("violation", (violation) => {
    session.sandboxViolations.push({
      timestamp: violation.timestamp.getTime(),
      operation: violation.operation,
      path: violation.path,
      processName: violation.processName,
    });
    this.emit("session-update", {
      sessionId: id,
      type: "sandbox-violation",
      violation: {
        timestamp: violation.timestamp.getTime(),
        operation: violation.operation,
        path: violation.path,
        processName: violation.processName,
      },
    });
  });
  monitor.start(agentProcess.pid);
  session.sandboxMonitor = monitor;
}
```

- [ ] Add `getSandboxViolations(sessionId)` method to session manager

```typescript
getSandboxViolations(sessionId: string): SandboxViolationInfo[] {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session.sandboxViolations;
}
```

### 3.5 Write `scripts/test-sandbox-monitor.ts`

- [ ] Create standalone script that spawns a sandboxed process designed to trigger violations and verifies the monitor catches them

```typescript
// scripts/test-sandbox-monitor.ts
//
// Tests the SandboxMonitor by spawning a process that deliberately
// triggers sandbox violations and checking they're detected.
//
// Usage: npx tsx scripts/test-sandbox-monitor.ts

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { SandboxMonitor } from "../src/main/sandbox-monitor.js";
import {
  defaultPolicy,
  generateProfile,
  writePolicyToDisk,
} from "../src/main/sandbox-profile.js";

const sessionId = randomUUID();
const worktreePath = join(tmpdir(), `sandbox-monitor-test-${sessionId}`);
await mkdir(worktreePath, { recursive: true });

// Generate a restrictive profile
const policy = defaultPolicy({
  worktreePath,
  homedir: homedir(),
  tmpdir: tmpdir(),
  sessionId,
});
const profile = generateProfile(policy);
const profilePath = await writePolicyToDisk(sessionId, profile);

console.log("=== Sandbox Monitor Test ===\n");

// Start monitor
const monitor = new SandboxMonitor();
const violations: any[] = [];
monitor.on("violation", (v) => {
  violations.push(v);
  console.log(`  [VIOLATION] ${v.operation} ${v.path ?? ""} (${v.processName})`);
});

// Spawn a process that will trigger violations
const proc = spawn(
  "/usr/bin/sandbox-exec",
  ["-f", profilePath, "/bin/sh", "-c",
    // Try to write outside worktree (violation), then exit
    `touch /tmp/bad-file-${sessionId} 2>/dev/null; echo done`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

monitor.start(proc.pid!);

proc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

// Wait for process to exit, then wait a bit for log to catch up
await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
console.log("\nProcess exited. Waiting for log events...");
await new Promise((resolve) => setTimeout(resolve, 3000));

monitor.stop();

console.log(`\nTotal violations captured: ${violations.length}`);
if (violations.length > 0) {
  console.log("✓ Monitor detected violations");
} else {
  console.log("✗ No violations detected — monitor may need debugging");
  console.log("  (This can happen if log stream hasn't started yet or PID filtering missed it)");
}

// Cleanup
await rm(profilePath, { force: true }).catch(() => {});
await rm(worktreePath, { recursive: true, force: true }).catch(() => {});

console.log("\n=== Done ===");
```

Add to `package.json` scripts:
```json
"test:sandbox-monitor": "tsx scripts/test-sandbox-monitor.ts"
```

### 3.6 Smoke test

- [ ] `npm run test:sandbox-monitor` reports at least one violation (the `touch /tmp/bad-file` should trigger a `file-write-data` denial)
- [ ] The violation has correct fields: operation, path, processName
- [ ] Monitor stops cleanly without orphan `log` processes

If no violations are detected:
1. Check if `log stream` requires elevated permissions (may need Full Disk Access in System Preferences)
2. Try running `log stream --predicate 'sender=="Sandbox"'` manually in a terminal and triggering a violation to verify log output format
3. If ndjson parsing fails, the compact-line fallback should catch it — check if either parser matched

**Done condition:** The monitor can detect sandbox violations from a child process and emit them as structured events.

---

## Phase 4: UI Integration

Wire sandbox events into the Electron renderer. This phase adds a violation log panel and sandbox status indicators to the existing UI.

### 4.1 Add `SandboxViolationInfo` type and `sandbox-violation` SessionUpdate variant

- [ ] Add to `src/main/types.ts`:

```typescript
export interface SandboxViolationInfo {
  timestamp: number;
  operation: string;
  path?: string;
  processName: string;
}

// Add to the SessionUpdate union:
| {
    sessionId: string;
    type: "sandbox-violation";
    violation: SandboxViolationInfo;
  }
```

### 4.2 Add IPC handler for violation history

- [ ] Add `sessions:getSandboxViolations` handler in `src/main/index.ts`

```typescript
ipcMain.handle("sessions:getSandboxViolations", (_event, sessionId: string) => {
  return sessionManager.getSandboxViolations(sessionId);
});
```

### 4.3 Update preload bridge

- [ ] Add `getSandboxViolations` method to `src/preload/index.ts`

```typescript
sessions: {
  // ... existing methods ...
  getSandboxViolations: (sessionId: string) =>
    ipcRenderer.invoke("sessions:getSandboxViolations", sessionId),
},
```

- [ ] Update the renderer type declarations in `src/renderer/src/env.d.ts`

### 4.4 Build `<SandboxLog />` component

- [ ] Create `src/renderer/src/components/SandboxLog.tsx`

```tsx
// Collapsible panel showing sandbox violations in real time
interface SandboxLogProps {
  violations: SandboxViolationInfo[];
  visible: boolean;
  onToggle: () => void;
}
```

Key UI decisions:
- **Collapsible**: Default collapsed to avoid cluttering the chat view. Toggle via a button/header.
- **Auto-scroll**: Scroll to bottom as new violations arrive (like a terminal log)
- **Color coding**: Red background/text for violations. Light styling to distinguish from chat messages.
- **Max entries**: Keep at most 200 violations in the UI state to avoid memory bloat. Older entries can be queried via `getSandboxViolations`.

### 4.5 Add sandbox badge to `<SessionList />`

- [ ] Update `src/renderer/src/components/SessionList.tsx`
- [ ] Add a shield icon or "sandboxed" label next to Claude Code sessions
- [ ] If violations are occurring, show a count badge (e.g., "3" in red)

The badge state comes from the `sandbox-violation` updates tracked in the App's state. Only Claude Code sessions show the badge — echo agent sessions don't have a sandbox.

### 4.6 Wire violations into `<ChatPanel />`

- [ ] Update `src/renderer/src/components/ChatPanel.tsx`
- [ ] Add the `<SandboxLog />` panel below the chat messages (before the input)
- [ ] Track violations in `App.tsx` state, keyed by session ID

In `App.tsx`, extend the `handleUpdate` switch to handle `sandbox-violation`:

```typescript
case "sandbox-violation":
  setViolations((prev) => ({
    ...prev,
    [update.sessionId]: [
      ...(prev[update.sessionId] ?? []),
      update.violation,
    ],
  }));
  break;
```

### 4.7 Full flow test

- [ ] Launch the app with `npm run dev`
- [ ] Create a Claude Code session (select a project directory)
- [ ] Verify the session shows a "sandboxed" badge
- [ ] Send a prompt that causes the agent to work within the worktree
- [ ] Send a prompt that triggers violations (e.g., "read the file at /etc/hosts and also try to write to /tmp/test.txt")
- [ ] Verify violations appear in the sandbox log panel
- [ ] Verify the chat still functions normally alongside the violation log

**Done condition:** Sandbox violations appear in the UI in real time. The sandbox log is collapsible. Sessions show sandbox status badges.

---

## Phase 5: Empirical Iteration

This is the research phase. Run a set of representative coding tasks under the sandbox, document what breaks, iterate on the profile, and record findings.

### 5.1 Test: read-only task

- [ ] Prompt: "Read the README.md file and summarize its contents"
- [ ] Expected: succeeds without violations (or only benign violations from system path reads)
- [ ] Record: any violations, success/failure, profile changes needed

### 5.2 Test: file creation and editing

- [ ] Prompt: "Create a new file called `src/main/sandbox-test.ts` with a simple hello-world function. Then edit it to add a JSDoc comment."
- [ ] Expected: succeeds — writing within worktree is allowed
- [ ] Record: any violations, verify file was created in worktree (not in original project dir)

### 5.3 Test: running tests / spawning subprocesses

- [ ] Prompt: "Run `npm test` or list the available npm scripts and run the lint command"
- [ ] Expected: may partially succeed — depends on whether test/lint commands need network access or global caches
- [ ] Record: all violations, which subprocess caused them, whether the task completed despite violations
- [ ] This test exercises the subprocess inheritance: npm/node/jest processes must all inherit sandbox constraints

### 5.4 Test: git operations (add, commit)

- [ ] Prompt: "Create a new file, git add it, and commit with message 'test commit'"
- [ ] Expected: should succeed — git add/commit are local operations, `~/.gitconfig` is readable
- [ ] Known risk: git may write to `.git/` directory — but the worktree's `.git` is inside the worktree path, so writes should be allowed
- [ ] Record: any violations, verify the commit exists in the worktree's branch

### 5.5 Test: network-dependent task (expect failure)

- [ ] Prompt: "Install the `lodash` package using npm"
- [ ] Expected: fails — network is denied
- [ ] This test validates that network blocking works
- [ ] Record: the error message the agent receives, whether it handles the failure gracefully or crashes

### 5.6 Profile iteration

- [ ] For each failed test, categorize the violations per the design doc's taxonomy:
  - **Expected/acceptable**: working as intended (e.g., network block)
  - **Legitimate operation to allow**: add to `defaultPolicy()`
  - **Surprising system path**: investigate, document, allow if safe
  - **Application-layer gap**: note for Milestone 5
- [ ] Update `defaultPolicy()` with any new paths discovered
- [ ] Re-run failed tests to confirm fixes
- [ ] If Claude Code needs write access to `~/.claude/`:
  1. Try the full task first — does it crash or just log warnings?
  2. If it crashes, add `~/.claude/` to writable paths
  3. If it only logs warnings, leave as-is and document

### 5.7 Write `docs/milestones/seatbelt-sandbox/findings.md`

- [ ] Create findings document with:

```markdown
# Milestone 2: Seatbelt Sandbox — Empirical Findings

## Summary

[Brief summary: how many tasks succeeded, what needed to be added to the profile,
what remains broken]

## Test Results

### Task 1: Read-only (README summary)
- **Result**: [pass/fail]
- **Violations**: [count, notable ones]
- **Profile changes**: [none / list]

### Task 2: File creation and editing
...

## Profile Evolution

### Paths added during iteration
| Path | Read/Write | Why |
|------|-----------|-----|
| ... | ... | ... |

### Paths considered but not added
| Path | Why not |
|------|--------|
| ... | ... |

## Application-Layer Gaps Identified
[Operations that the OS sandbox can't meaningfully restrict]

## Open Issues
[Things that still don't work and need resolution in future milestones]
```

**Done condition:** At least 3 of the 5 test tasks complete successfully under the sandbox. All violations are categorized and documented. The profile reflects the iteration. `findings.md` is written.

---

## Phase 6: Cleanup and Polish

### 6.1 Graceful degradation when `sandbox-exec` unavailable

- [ ] In `resolveClaudeCodeCommand()`, check if `/usr/bin/sandbox-exec` exists before using it
- [ ] If unavailable (e.g., Linux, or removed by Apple in a future macOS), fall back to unsandboxed spawning
- [ ] Log a warning: "sandbox-exec not available — agent will run without OS-level sandboxing"

```typescript
import { existsSync } from "node:fs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const canSandbox = existsSync(SANDBOX_EXEC);

function resolveClaudeCodeCommand(cwd: string, profilePath: string | null): SpawnConfig {
  // ... existing code ...
  if (profilePath && canSandbox) {
    return { cmd: SANDBOX_EXEC, args: ["-f", profilePath, "node", binPath], cwd };
  }
  if (profilePath && !canSandbox) {
    console.warn("sandbox-exec not available — running agent without sandbox");
  }
  return { cmd: "node", args: [binPath], cwd };
}
```

### 6.2 Echo agent bypass

- [ ] Verify that echo agent sessions skip profile generation, sandbox-exec wrapping, and monitor startup
- [ ] This should already work from the `if (agentType === "claude-code")` guards, but verify manually

### 6.3 Monitor crash resilience

- [ ] If the `log stream` process exits unexpectedly, log a warning but don't crash the session
- [ ] The session should continue operating — the sandbox still enforces boundaries even without the monitor

```typescript
this.logProcess.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.warn(`Sandbox monitor log stream exited with code ${code}`);
  }
  // Don't restart — the monitor is best-effort
});
```

### 6.4 Profile file cleanup on app quit

- [ ] In the `closeAllSessions()` method, ensure profile files and session temp dirs are cleaned up
- [ ] Already handled by `closeSession()` being called for each active session — verify it works on force-quit too
- [ ] Add a cleanup of the `glitterball-sandbox` directory on app startup (similar to orphan worktree cleanup)

```typescript
async cleanupOrphanSandboxProfiles(): Promise<void> {
  const dir = join(tmpdir(), "glitterball-sandbox");
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (entry.endsWith(".sb")) {
        const sessionId = entry.replace(".sb", "");
        if (!this.sessions.has(sessionId)) {
          await rm(join(dir, entry), { force: true });
          console.log(`Cleaned up orphan sandbox profile: ${entry}`);
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}
```

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

**Done condition:** The sandbox system handles edge cases gracefully. Echo agent is unaffected. Missing `sandbox-exec` doesn't crash the app. All test scripts are runnable.

---

## Verification Checklist

Run these checks after all phases are complete:

- [ ] **Profile generation**: `npm run test:sandbox-profile` passes all validation tests
- [ ] **Sandboxed agent**: `npm run test:sandboxed-agent` completes a prompt successfully
- [ ] **Monitor detection**: `npm run test:sandbox-monitor` detects at least one violation
- [ ] **Full Electron flow**: Launch app → create Claude Code session → verify "sandboxed" badge → send prompt → see response → see sandbox log
- [ ] **Write boundary**: Agent can create/edit files within the worktree
- [ ] **Write enforcement**: Agent cannot write files outside the worktree (verify via sandbox log or EPERM in tool output)
- [ ] **Network enforcement**: Agent cannot make network requests (verify via a task that requires network)
- [ ] **Echo agent unaffected**: Create an echo agent session (if UI toggle exists, or via code) → confirm it works without sandbox
- [ ] **Session cleanup**: Close a session → verify worktree removed, profile file removed, temp dir removed, monitor stopped
- [ ] **Findings documented**: `docs/milestones/seatbelt-sandbox/findings.md` exists with test results and profile evolution

---

## File Change Summary

### New files

| File | Purpose |
|------|---------|
| `src/main/sandbox-profile.ts` | SBPL profile generation from `SandboxPolicy` |
| `src/main/sandbox-monitor.ts` | Unified log monitoring for sandbox violations |
| `src/renderer/src/components/SandboxLog.tsx` | UI component for violation log display |
| `scripts/test-sandbox-profile.ts` | Test harness for profile generation |
| `scripts/test-sandboxed-agent.ts` | Test harness for sandboxed agent spawning |
| `scripts/test-sandbox-monitor.ts` | Test harness for violation monitoring |
| `docs/milestones/seatbelt-sandbox/findings.md` | Empirical findings from sandbox testing |

### Modified files

| File | Changes |
|------|---------|
| `src/main/session-manager.ts` | Profile generation, sandboxed spawn, monitor lifecycle, violation tracking |
| `src/main/types.ts` | `SandboxViolationInfo`, `sandbox-violation` SessionUpdate variant |
| `src/preload/index.ts` | `getSandboxViolations` IPC bridge method |
| `src/renderer/src/env.d.ts` | Type declarations for new IPC methods |
| `src/renderer/src/App.tsx` | Violation state management, `sandbox-violation` update handling |
| `src/renderer/src/components/ChatPanel.tsx` | `<SandboxLog />` integration |
| `src/renderer/src/components/SessionList.tsx` | Sandbox status badge |
| `package.json` | New test scripts |
