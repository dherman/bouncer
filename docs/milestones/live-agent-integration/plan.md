# Milestone 1: Live Agent Integration — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition. The plan builds on the working Electron + ACP codebase from [Milestone 0](../../history/electron-acp-hello-world/plan.md).

## Progress

- [x] **[Phase 1: Worktree Manager](#phase-1-worktree-manager)**
  - [x] 1.1 Create `src/main/worktree-manager.ts`
  - [x] 1.2 Implement `validateGitRepo()`
  - [x] 1.3 Implement `create()` (worktree + branch)
  - [x] 1.4 Implement `remove()` (worktree + branch cleanup)
  - [x] 1.5 Write `scripts/test-worktree.ts` test harness
  - [x] 1.6 Smoke test: create, verify, remove a worktree
- [x] **[Phase 2: Claude Code Agent Discovery](#phase-2-claude-code-agent-discovery)**
  - [x] 2.1 Install `@zed-industries/claude-agent-acp`
  - [x] 2.2 Discover binary entry point and spawn mechanism
  - [x] 2.3 Discover which ACP Client methods Claude Code calls
  - [x] 2.4 Write `scripts/test-claude-agent.ts` standalone test
  - [x] 2.5 Smoke test: ACP handshake + simple prompt with Claude Code
  - [x] 2.6 Document deviations in `sdk-deviations.md`
- [ ] **[Phase 3: Terminal Management](#phase-3-terminal-management)**
  - [ ] 3.1 Define `TerminalState` type
  - [ ] 3.2 Implement `createTerminal()` — spawn shell in worktree
  - [ ] 3.3 Implement `terminalOutput()` — return accumulated output
  - [ ] 3.4 Implement `killTerminal()` — send SIGTERM
  - [ ] 3.5 Implement `waitForTerminalExit()` — wait for process exit
  - [ ] 3.6 Implement `releaseTerminal()` — cleanup tracking state
  - [ ] 3.7 Verify terminals work via the Claude Code test script
- [ ] **[Phase 4: Session Manager Integration](#phase-4-session-manager-integration)**
  - [ ] 4.1 Extend `SessionState` with new fields
  - [ ] 4.2 Update `createSession()` — agent type selection + worktree creation
  - [ ] 4.3 Implement `resolveClaudeCodeCommand()`
  - [ ] 4.4 Implement `readTextFile()` and `writeTextFile()` in Client
  - [ ] 4.5 Switch `requestPermission()` from `cancelled` to `approved`
  - [ ] 4.6 Expand `sessionUpdate()` handler for tool calls and plans
  - [ ] 4.7 Update `closeSession()` — terminal cleanup + worktree teardown
  - [ ] 4.8 Verify from main process: create Claude Code session, send prompt, see response
- [ ] **[Phase 5: IPC and UI Updates](#phase-5-ipc-and-ui-updates)**
  - [ ] 5.1 Add `dialog:selectDirectory` IPC handler
  - [ ] 5.2 Update `sessions:create` to accept `projectDir` and `agentType`
  - [ ] 5.3 Update preload bridge with new signatures
  - [ ] 5.4 Update renderer type declarations
  - [ ] 5.5 Update `<SessionList />` — project name labels, agent type indicator
  - [ ] 5.6 Update `<App />` — directory picker flow on "New Session"
  - [ ] 5.7 Add `<ToolCallBlock />` component for tool call display
  - [ ] 5.8 Wire new `SessionUpdate` variants (`tool-call`, `plan-update`) into `handleUpdate`
  - [ ] 5.9 Full flow test: select project → create session → chat with Claude Code
- [ ] **[Phase 6: Edge Cases and Polish](#phase-6-edge-cases-and-polish)**
  - [ ] 6.1 Agent startup failure handling (missing API key, Claude Code not installed)
  - [ ] 6.2 Worktree creation failure handling (not a git repo, git not found)
  - [ ] 6.3 Multiple concurrent sessions with different projects
  - [ ] 6.4 Echo agent fallback still works
  - [ ] 6.5 Session close cleanup (terminals killed, worktree removed, branch deleted)
  - [ ] 6.6 Orphan worktree cleanup on app startup
- [ ] **[Verification](#verification-checklist)** — all manual checks pass

---

## Phase 1: Worktree Manager

Build and test the worktree manager in isolation before touching the session manager. This is a self-contained module with no ACP or Electron dependencies — just git CLI calls.

### 1.1 Create `src/main/worktree-manager.ts`

- [ ] Create the file with the class skeleton and types

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;         // Absolute path to the worktree directory
  branch: string;       // Branch name: bouncer/<session-id>
  projectDir: string;   // Original project directory
}

export class WorktreeManager {
  private basePath: string;

  constructor(basePath?: string) {
    // Default: system temp dir / glitterball-worktrees
    this.basePath = basePath ?? join(tmpdir(), "glitterball-worktrees");
  }

  async validateGitRepo(dir: string): Promise<boolean> { /* ... */ }
  async create(sessionId: string, projectDir: string): Promise<WorktreeInfo> { /* ... */ }
  async remove(info: WorktreeInfo): Promise<void> { /* ... */ }
}
```

### 1.2 Implement `validateGitRepo()`

- [ ] Run `git rev-parse --git-dir` in the target directory
- [ ] Return `true` if exit code is 0, `false` otherwise

```typescript
async validateGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}
```

### 1.3 Implement `create()`

- [ ] Ensure the base directory exists (`mkdir -p` equivalent)
- [ ] Run `git worktree add <path> -b bouncer/<id> HEAD` in the project directory
- [ ] Return `WorktreeInfo` with the absolute worktree path and branch name

```typescript
async create(sessionId: string, projectDir: string): Promise<WorktreeInfo> {
  const branch = `bouncer/${sessionId}`;
  const worktreePath = join(this.basePath, sessionId);

  // Ensure base directory exists
  await mkdir(this.basePath, { recursive: true });

  // Create worktree with a new branch based on HEAD
  await execFileAsync(
    "git",
    ["worktree", "add", worktreePath, "-b", branch, "HEAD"],
    { cwd: projectDir }
  );

  return { path: worktreePath, branch, projectDir };
}
```

**Key detail:** The `-b` flag creates a new branch. Using `HEAD` means the worktree starts from whatever the project's current HEAD is — it doesn't need to be on a specific branch.

### 1.4 Implement `remove()`

- [ ] Run `git worktree remove <path> --force` in the project directory
- [ ] Run `git branch -D <branch>` to delete the session branch
- [ ] Swallow errors on branch deletion (branch may have been manually deleted or may have unpushed commits the user wants to keep)

```typescript
async remove(info: WorktreeInfo): Promise<void> {
  // Remove the worktree (--force handles uncommitted changes)
  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", info.path, "--force"],
      { cwd: info.projectDir }
    );
  } catch (err) {
    // Worktree may already be gone (e.g., user deleted it manually)
    console.warn(`Failed to remove worktree ${info.path}:`, err);
  }

  // Delete the session branch
  try {
    await execFileAsync(
      "git",
      ["branch", "-D", info.branch],
      { cwd: info.projectDir }
    );
  } catch {
    // Branch may already be gone or may have been merged
  }
}
```

**Design choice:** We use `--force` on worktree removal and `-D` (force delete) on branch deletion. This is intentional for session cleanup — the session's worktree is ephemeral scaffolding, not precious state. If the agent made commits worth keeping, the user should have pushed them to a remote before closing the session. We can revisit this if it causes problems (e.g., prompt "discard uncommitted work?" before close in a later milestone).

### 1.5 Write `scripts/test-worktree.ts`

- [ ] Create test script that exercises the full lifecycle

```typescript
// scripts/test-worktree.ts
import { WorktreeManager } from "../src/main/worktree-manager.js";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const manager = new WorktreeManager();

// Use the bouncer repo itself as the test project
const projectDir = process.cwd();
const sessionId = randomUUID();

console.log("=== Worktree Manager Test ===\n");

// Validate git repo
const isGitRepo = await manager.validateGitRepo(projectDir);
console.log(`1. Is git repo: ${isGitRepo}`);
if (!isGitRepo) {
  console.error("Not a git repo — run this from the bouncer project root");
  process.exit(1);
}

// Create worktree
console.log(`\n2. Creating worktree for session ${sessionId}...`);
const info = await manager.create(sessionId, projectDir);
console.log(`   Path: ${info.path}`);
console.log(`   Branch: ${info.branch}`);

// Verify it exists
const { stdout: worktreeList } = await execFileAsync(
  "git", ["worktree", "list"], { cwd: projectDir }
);
console.log(`\n3. git worktree list:\n${worktreeList}`);

// Verify branch exists
const { stdout: branchList } = await execFileAsync(
  "git", ["branch", "--list", info.branch], { cwd: projectDir }
);
console.log(`4. Branch exists: ${branchList.trim().length > 0}`);

// Remove worktree
console.log(`\n5. Removing worktree...`);
await manager.remove(info);

// Verify cleanup
const { stdout: worktreeListAfter } = await execFileAsync(
  "git", ["worktree", "list"], { cwd: projectDir }
);
console.log(`6. git worktree list after cleanup:\n${worktreeListAfter}`);

const { stdout: branchListAfter } = await execFileAsync(
  "git", ["branch", "--list", info.branch], { cwd: projectDir }
);
console.log(`7. Branch gone: ${branchListAfter.trim().length === 0}`);

console.log("\n=== Done ===");
```

Add to `package.json` scripts:
```json
"test:worktree": "tsx scripts/test-worktree.ts"
```

### 1.6 Smoke test

- [ ] `npm run test:worktree` completes without errors
- [ ] Worktree appears in `git worktree list` during the test
- [ ] Worktree and branch are gone after cleanup
- [ ] Running from a non-git directory returns `validateGitRepo() === false`

**Done condition:** The worktree manager can create and destroy worktrees reliably. All test assertions pass.

---

## Phase 2: Claude Code Agent Discovery

This is the highest-risk phase. We're making first contact with `@zed-industries/claude-agent-acp` and need to discover its real API before integrating it. This mirrors M0's Phase 2 (echo agent discovery) — learn the API surface in isolation, document surprises, then integrate.

### 2.1 Install `@zed-industries/claude-agent-acp`

- [ ] Install the package

```bash
npm install @zed-industries/claude-agent-acp
```

If the package requires peer dependencies we don't have, install those too. Check the install output carefully.

### 2.2 Discover binary entry point and spawn mechanism

- [ ] Read the package's `package.json` to find the `bin` field
- [ ] Identify the actual entry point script

```bash
# Check the package.json
cat node_modules/@zed-industries/claude-agent-acp/package.json | grep -A5 '"bin"'

# Check what's in the bin directory
ls -la node_modules/.bin/claude-agent-acp*
```

- [ ] Determine how to resolve and spawn it from the Electron main process

The spawning pattern should mirror how we resolve `tsx` for the echo agent. In `session-manager.ts` the existing code uses `createRequire` to resolve binary paths:

```typescript
const require = createRequire(app.getAppPath() + "/");
const tsxBin = require.resolve("tsx/cli");
```

We need the equivalent for `claude-agent-acp`. The exact `require.resolve()` target depends on what the package exports:

```typescript
// Likely one of:
require.resolve("@zed-industries/claude-agent-acp/bin");
require.resolve("@zed-industries/claude-agent-acp/cli");
// or the path from the package.json bin field
```

- [ ] Document the correct resolution path

### 2.3 Discover which ACP Client methods Claude Code calls

- [ ] Read the package's TypeScript types or source to understand what it expects from the client

The ACP SDK defines these optional Client methods (from `sdk-deviations.md`, only `requestPermission` and `sessionUpdate` are required):

| Method | Required? | Expected by Claude Code? |
|--------|-----------|--------------------------|
| `sessionUpdate` | Yes | Yes — streaming responses |
| `requestPermission` | Yes | Yes — permission prompts |
| `readTextFile` | No | Likely — Read tool |
| `writeTextFile` | No | Likely — Write/Edit tools |
| `createTerminal` | No | Likely — Bash tool |
| `terminalOutput` | No | Likely — get command output |
| `killTerminal` | No | Likely — kill running commands |
| `waitForTerminalExit` | No | Likely — await command completion |
| `releaseTerminal` | No | Likely — cleanup after command |

We need to discover which of these Claude Code actually calls. The test script in 2.4 will reveal this — any unimplemented method that Claude Code calls will throw an error.

**Discovery approach:** Start with stubs that log the call and throw. Replace with real implementations as we discover what's needed.

### 2.4 Write `scripts/test-claude-agent.ts`

- [ ] Create standalone test script that spawns Claude Code via its ACP binary

```typescript
// scripts/test-claude-agent.ts
//
// Spawns the Claude Code ACP adapter, runs the ACP handshake,
// sends a simple prompt, and logs all Client method calls.
//
// Usage: npx tsx scripts/test-claude-agent.ts
//
// Prerequisites:
//   - @zed-industries/claude-agent-acp installed
//   - ANTHROPIC_API_KEY set or Claude Code OAuth active

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);

// --- Resolve the claude-agent-acp binary ---
// TODO: Update this path after discovery in step 2.2
const agentBin = require.resolve("@zed-industries/claude-agent-acp/bin");

const agent = spawn(process.execPath, [agentBin], {
  stdio: ["pipe", "pipe", "inherit"], // stderr → console for debugging
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

agent.on("error", (err) => console.error("Agent spawn error:", err));
agent.on("exit", (code) => console.log(`Agent exited with code ${code}`));

const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

// --- Client implementation with logging stubs ---
// Every method logs its call so we can see what Claude Code actually uses.

const connection = new acp.ClientSideConnection(
  (_agentInterface) => ({
    async sessionUpdate(params) {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        process.stdout.write(update.content.text);
      } else {
        console.log("\n[sessionUpdate]", JSON.stringify(update, null, 2));
      }
    },

    async requestPermission(params) {
      console.log("\n[requestPermission]", JSON.stringify(params, null, 2));
      // Auto-approve for testing
      return { outcome: { outcome: "approved" as const } };
    },

    // --- Discovery stubs: log and implement minimally ---

    async readTextFile(params) {
      console.log("\n[readTextFile]", JSON.stringify(params));
      // Passthrough to filesystem
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(params.uri, "utf-8");
      return { content };
    },

    async writeTextFile(params) {
      console.log("\n[writeTextFile]", JSON.stringify(params));
      const { writeFile } = await import("node:fs/promises");
      await writeFile(params.uri, params.content, "utf-8");
    },

    async createTerminal(params) {
      console.log("\n[createTerminal]", JSON.stringify(params));
      // Minimal terminal: spawn shell, return ID
      const { spawn: spawnShell } = await import("node:child_process");
      const shell = spawnShell(process.env.SHELL || "/bin/zsh", [], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const terminalId = `term-${Date.now()}`;
      // Store for later use (simplified — real impl uses a Map on session state)
      (globalThis as any).__terminals = (globalThis as any).__terminals || {};
      (globalThis as any).__terminals[terminalId] = {
        process: shell,
        output: "",
      };
      shell.stdout?.on("data", (data: Buffer) => {
        (globalThis as any).__terminals[terminalId].output += data.toString();
      });
      shell.stderr?.on("data", (data: Buffer) => {
        (globalThis as any).__terminals[terminalId].output += data.toString();
      });
      return { terminalId };
    },

    async terminalOutput(params) {
      console.log("\n[terminalOutput]", JSON.stringify(params));
      const term = (globalThis as any).__terminals?.[params.terminalId];
      if (!term) throw new Error(`Unknown terminal: ${params.terminalId}`);
      const output = term.output;
      term.output = ""; // Consume
      return { output };
    },

    async killTerminal(params) {
      console.log("\n[killTerminal]", JSON.stringify(params));
      const term = (globalThis as any).__terminals?.[params.terminalId];
      if (term) term.process.kill("SIGTERM");
    },

    async waitForTerminalExit(params) {
      console.log("\n[waitForTerminalExit]", JSON.stringify(params));
      const term = (globalThis as any).__terminals?.[params.terminalId];
      if (!term) return { exitCode: 1 };
      return new Promise((resolve) => {
        if (term.process.exitCode !== null) {
          resolve({ exitCode: term.process.exitCode });
        } else {
          term.process.on("exit", (code: number | null) => {
            resolve({ exitCode: code ?? 1 });
          });
        }
      });
    },

    async releaseTerminal(params) {
      console.log("\n[releaseTerminal]", JSON.stringify(params));
      const term = (globalThis as any).__terminals?.[params.terminalId];
      if (term) {
        term.process.kill();
        delete (globalThis as any).__terminals[params.terminalId];
      }
    },
  }),
  stream
);

// --- Drive the protocol ---

try {
  console.log("Initializing...");
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  console.log("Initialized:", JSON.stringify(initResp, null, 2));

  console.log("\nCreating session...");
  const sessionResp = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log("Session:", sessionResp.sessionId);

  // Simple prompt that exercises file reading and terminal use
  const prompt = "What files are in the current directory? List them briefly.";
  console.log(`\nSending prompt: "${prompt}"\n`);
  console.log("--- Response ---");

  const promptResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: "text", text: prompt }],
  });

  console.log("\n--- End Response ---");
  console.log(`\nStop reason: ${promptResp.stopReason}`);
} catch (err) {
  console.error("\nError:", err);
  process.exitCode = 1;
} finally {
  agent.kill();
}
```

**Important:** The `readTextFile`, `writeTextFile`, `createTerminal`, etc. signatures above are guesses based on the ACP reference doc. The actual parameter and return types may differ. The SDK's TypeScript compiler will flag mismatches — fix them during implementation.

Add to `package.json` scripts:
```json
"test:claude-agent": "tsx scripts/test-claude-agent.ts"
```

### 2.5 Smoke test

- [ ] Claude Code agent process starts without crashing
- [ ] ACP `InitializeRequest` / `NewSessionRequest` succeed
- [ ] `PromptRequest` with a simple question returns a streamed response
- [ ] Observe which Client methods are actually called (from `[methodName]` log lines)
- [ ] If any method throws due to wrong parameter types, fix the stub and re-run

**Expected observations:**

For a prompt like "What files are in the current directory?", Claude Code should:
1. Call `createTerminal` to spawn a shell
2. Write `ls` (or similar) to the terminal
3. Call `waitForTerminalExit` / `terminalOutput` to get the result
4. Stream a text response summarizing the files
5. Call `releaseTerminal` to clean up

If it instead uses `readTextFile` to read the directory, or uses a completely different approach, that's important to document.

### 2.6 Document deviations

- [ ] Create `docs/milestones/live-agent-integration/sdk-deviations.md`

Document every difference between the design doc's assumptions and reality:

- Actual binary entry point path
- Which Client methods Claude Code calls (and which it never calls)
- Parameter/return type differences from our pseudocode
- Any required environment variables or configuration
- Any required `clientCapabilities` that we didn't set
- Terminal semantics: does it expect PTY? Persistent shell? One-shot commands?
- File path format: absolute? Relative? `file://` URI?
- Authentication behavior: what happens when the API key is missing?

**Done condition:** We can spawn Claude Code, complete the ACP handshake, send a prompt, receive a streamed response with tool call execution, and have a documented understanding of which Client methods are used and how.

---

## Phase 3: Terminal Management

With the discovery from Phase 2 in hand, implement proper terminal management. The test script's `globalThis` hack was fine for discovery but needs to be a proper data structure for the session manager.

### 3.1 Define `TerminalState` type

- [ ] Add to `src/main/types.ts`

```typescript
import type { ChildProcess } from "node:child_process";

export interface TerminalState {
  id: string;
  process: ChildProcess;
  output: string;        // Accumulated stdout + stderr since last read
  exitCode: number | null;
  exited: boolean;
  exitPromise: Promise<number>; // Resolves when process exits
}
```

The `exitPromise` is created at terminal spawn time and resolves when the process exits. This makes `waitForTerminalExit` trivial — just `await` the promise.

### 3.2 Implement `createTerminal()`

- [ ] Spawn shell process with `cwd` set to session worktree path
- [ ] Collect stdout and stderr into `output` buffer
- [ ] Create and store `exitPromise`
- [ ] Return terminal ID

```typescript
async createTerminal(params: CreateTerminalParams): Promise<CreateTerminalResult> {
  const terminalId = `term-${randomUUID()}`;
  const shell = spawn(process.env.SHELL || "/bin/zsh", [], {
    cwd: session.worktree?.path ?? session.projectDir,
    env: { ...process.env, ...params.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const exitPromise = new Promise<number>((resolve) => {
    shell.on("exit", (code) => {
      termState.exited = true;
      termState.exitCode = code ?? 1;
      resolve(code ?? 1);
    });
  });

  const termState: TerminalState = {
    id: terminalId,
    process: shell,
    output: "",
    exitCode: null,
    exited: false,
    exitPromise,
  };

  shell.stdout?.on("data", (data: Buffer) => { termState.output += data.toString(); });
  shell.stderr?.on("data", (data: Buffer) => { termState.output += data.toString(); });

  session.terminals.set(terminalId, termState);
  return { terminalId };
}
```

> **Note:** Phase 2 will reveal whether Claude Code expects a raw process (no shell) or a shell. If it writes commands to stdin like `ls\n`, it expects a shell. If it passes a command array, it expects `execFile`-style execution. Adapt accordingly.

> **PTY consideration:** If Phase 2 reveals that Claude Code needs PTY semantics (e.g., it sends terminal control codes or checks `isatty()`), install `node-pty` and use `pty.spawn()` instead of `child_process.spawn()`. This is a known risk from the design doc.

### 3.3 Implement `terminalOutput()`

- [ ] Return accumulated output since last read
- [ ] Clear the buffer after reading

```typescript
async terminalOutput(params: TerminalOutputParams): Promise<TerminalOutputResult> {
  const term = session.terminals.get(params.terminalId);
  if (!term) throw new Error(`Unknown terminal: ${params.terminalId}`);
  const output = term.output;
  term.output = "";
  return { output };
}
```

> **Open question:** Does Claude Code call `terminalOutput` in a polling loop, or does it expect output to be pushed? The ACP spec suggests polling. Phase 2 will confirm.

### 3.4 Implement `killTerminal()`

- [ ] Send SIGTERM to the terminal's process

```typescript
async killTerminal(params: KillTerminalParams): Promise<void> {
  const term = session.terminals.get(params.terminalId);
  if (!term) return;
  if (!term.exited) {
    term.process.kill("SIGTERM");
  }
}
```

### 3.5 Implement `waitForTerminalExit()`

- [ ] Await the terminal's `exitPromise`

```typescript
async waitForTerminalExit(params: WaitForTerminalExitParams): Promise<WaitForTerminalExitResult> {
  const term = session.terminals.get(params.terminalId);
  if (!term) return { exitCode: 1 };
  const exitCode = await term.exitPromise;
  return { exitCode };
}
```

### 3.6 Implement `releaseTerminal()`

- [ ] Kill the process if still running
- [ ] Remove from the session's terminal map

```typescript
async releaseTerminal(params: ReleaseTerminalParams): Promise<void> {
  const term = session.terminals.get(params.terminalId);
  if (!term) return;
  if (!term.exited) {
    term.process.kill("SIGKILL");
  }
  session.terminals.delete(params.terminalId);
}
```

### 3.7 Verify via Claude Code test script

- [ ] Update `scripts/test-claude-agent.ts` to use the extracted terminal management functions (or import them directly)
- [ ] Send a prompt that triggers terminal use (e.g., "Run `echo hello` and tell me the output")
- [ ] Verify: `createTerminal` → `waitForTerminalExit` → `terminalOutput` → `releaseTerminal` lifecycle works

**Done condition:** All terminal lifecycle methods work correctly with Claude Code. We know whether we need PTY support.

---

## Phase 4: Session Manager Integration

Wire everything together in the session manager. This phase modifies `src/main/session-manager.ts` and `src/main/types.ts`.

### 4.1 Extend `SessionState` with new fields

- [ ] Add agent type, project directory, worktree info, and terminal tracking to `SessionState`

```typescript
interface SessionState {
  // Existing fields from M0
  id: string;
  acpSessionId: string;
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: "initializing" | "ready" | "error" | "closed";

  // New fields for M1
  agentType: AgentType;
  projectDir: string;
  worktree: WorktreeInfo | null;   // null for echo agent sessions
  terminals: Map<string, TerminalState>;
}
```

- [ ] Update `SessionSummary` in `types.ts` to include `agentType` and `projectDir`
- [ ] Add `AgentType`, `ToolCallInfo`, `PlanInfo`, `PlanEntry` types
- [ ] Add new `SessionUpdate` variants for `tool-call` and `plan-update`

### 4.2 Update `createSession()`

- [ ] Change signature to `createSession(projectDir: string, agentType: AgentType = "claude-code")`
- [ ] For `claude-code` agent type:
  1. Validate `projectDir` is a git repo via `worktreeManager.validateGitRepo()`
  2. Create worktree via `worktreeManager.create()`
  3. Spawn Claude Code with `cwd` set to worktree path
  4. Pass `cwd: worktreePath` in `NewSessionRequest`
- [ ] For `echo` agent type: keep existing behavior (no worktree)
- [ ] Store worktree info and agent type on session state

```typescript
async createSession(
  projectDir: string,
  agentType: AgentType = "claude-code"
): Promise<SessionSummary> {
  const id = randomUUID();
  let worktree: WorktreeInfo | null = null;

  // Create worktree for Claude Code sessions
  if (agentType === "claude-code") {
    const isGitRepo = await this.worktreeManager.validateGitRepo(projectDir);
    if (!isGitRepo) {
      throw new Error(`Not a git repository: ${projectDir}`);
    }
    worktree = await this.worktreeManager.create(id, projectDir);
  }

  const workingDir = worktree?.path ?? projectDir;

  const session: SessionState = {
    id,
    acpSessionId: "",
    agentProcess: null!,
    connection: null!,
    messages: [],
    status: "initializing",
    agentType,
    projectDir,
    worktree,
    terminals: new Map(),
  };
  this.sessions.set(id, session);
  // ... spawn agent, ACP handshake (rest follows existing pattern) ...
}
```

### 4.3 Implement `resolveClaudeCodeCommand()`

- [ ] Add alongside existing `resolveAgentCommand()` (which is renamed to `resolveEchoAgentCommand()`)
- [ ] Create a dispatch function that selects based on agent type

```typescript
function resolveAgentCommand(
  agentType: AgentType,
  worktreePath: string | null
): { cmd: string; args: string[]; env?: Record<string, string>; cwd?: string } {
  if (agentType === "echo") {
    return resolveEchoAgentCommand();
  }
  return resolveClaudeCodeCommand(worktreePath!);
}

function resolveClaudeCodeCommand(worktreePath: string) {
  const require = createRequire(app.getAppPath() + "/");
  // TODO: Update path based on Phase 2 discovery
  const binPath = require.resolve("@zed-industries/claude-agent-acp/bin");
  return {
    cmd: process.execPath,
    args: [binPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    cwd: worktreePath,
  };
}
```

### 4.4 Implement `readTextFile()` and `writeTextFile()`

- [ ] Add to the `Client` implementation inside `createSession()`

```typescript
async readTextFile(params) {
  const filePath = resolveFilePath(params.uri, workingDir);
  const content = await readFile(filePath, "utf-8");
  return { content };
},

async writeTextFile(params) {
  const filePath = resolveFilePath(params.uri, workingDir);
  await writeFile(filePath, params.content, "utf-8");
},
```

Where `resolveFilePath` normalizes the URI/path:

```typescript
function resolveFilePath(uri: string, cwd: string): string {
  // Handle file:// URIs
  if (uri.startsWith("file://")) {
    return new URL(uri).pathname;
  }
  // Handle relative paths
  if (!uri.startsWith("/")) {
    return join(cwd, uri);
  }
  // Absolute path — use as-is
  return uri;
}
```

> **Note:** The exact format of `params.uri` depends on Phase 2 discovery. Claude Code may use `path` instead of `uri`, or it may always send absolute paths. Adapt the field name and normalization logic accordingly.

### 4.5 Switch `requestPermission()` from `cancelled` to `approved`

- [ ] Change the return value in the Client implementation

```typescript
async requestPermission(params) {
  // M1: auto-approve everything to remove friction
  // M2+ will evaluate against sandbox policy
  console.log(`[requestPermission] Auto-approving: ${JSON.stringify(params)}`);
  return { outcome: { outcome: "approved" as const } };
},
```

### 4.6 Expand `sessionUpdate()` handler

- [ ] Dispatch on `update.sessionUpdate` to handle tool calls and plans, not just text chunks

```typescript
async sessionUpdate(params) {
  const update = params.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        // Existing M0 behavior: append text to streaming message
        const agentMsg = session.messages.findLast(
          (m) => m.role === "agent" && m.streaming
        );
        if (agentMsg) {
          agentMsg.text += update.content.text;
          emitUpdate("session-update", {
            sessionId: id,
            type: "stream-chunk",
            messageId: agentMsg.id,
            text: update.content.text,
          });
        }
      } else if (update.content.type === "tool_call") {
        // New in M1: emit tool call status to the UI
        emitUpdate("session-update", {
          sessionId: id,
          type: "tool-call",
          messageId: session.messages.findLast((m) => m.role === "agent")?.id ?? "",
          toolCall: {
            id: update.content.id,
            name: update.content.name,
            status: update.content.status,
            input: update.content.input,
            output: update.content.output,
          },
        });
      }
      break;

    // TODO: handle "plan_update" and other sessionUpdate variants
    // discovered in Phase 2
    default:
      console.log(`[sessionUpdate] Unhandled variant: ${update.sessionUpdate}`);
      break;
  }
},
```

> **Important:** The exact field names on `ToolCallContent` (`update.content.id`, `.name`, `.status`, etc.) are guesses from the ACP reference. Phase 2 will reveal the actual shapes. The ACP SDK types will enforce correctness at compile time.

### 4.7 Update `closeSession()` — terminal cleanup + worktree teardown

- [ ] Kill all active terminals before killing the agent
- [ ] Remove the worktree after the agent process is gone

```typescript
async closeSession(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  session.status = "closed";

  // Kill all active terminals
  for (const [, term] of session.terminals) {
    if (!term.exited) {
      term.process.kill("SIGKILL");
    }
  }
  session.terminals.clear();

  // Kill agent process
  session.agentProcess?.kill();

  // Tear down worktree
  if (session.worktree) {
    try {
      await this.worktreeManager.remove(session.worktree);
    } catch (err) {
      console.warn(`Failed to remove worktree for session ${sessionId}:`, err);
    }
  }

  this.emit("session-update", { sessionId, type: "status-change", status: "closed" });
}
```

### 4.8 Verify from main process

- [ ] Temporarily wire a test call in `src/main/index.ts` that creates a Claude Code session, sends a prompt, and logs the response
- [ ] Verify: worktree is created, agent starts, prompt produces streamed response with tool calls, session close removes worktree

**Done condition:** The session manager can create a Claude Code session with a worktree, send prompts, receive streamed responses (including tool calls), and clean up fully on close. All of this works from the main process before we touch the UI.

---

## Phase 5: IPC and UI Updates

Wire the new session manager capabilities into the renderer through the IPC bridge and React UI.

### 5.1 Add `dialog:selectDirectory` IPC handler

- [ ] Add handler in `src/main/index.ts`

```typescript
import { dialog } from "electron";

ipcMain.handle("dialog:selectDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openDirectory"],
    title: "Select project directory",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

### 5.2 Update `sessions:create` to accept parameters

- [ ] Modify the IPC handler to pass through `projectDir` and `agentType`

```typescript
ipcMain.handle(
  "sessions:create",
  (_e, projectDir: unknown, agentType: unknown) => {
    if (typeof projectDir !== "string") {
      throw new Error("Invalid argument: projectDir must be a string");
    }
    const validAgentType =
      agentType === "echo" ? "echo" : "claude-code";
    return sessionManager.createSession(projectDir, validAgentType);
  }
);
```

### 5.3 Update preload bridge

- [ ] Add `dialog.selectDirectory` and update `sessions.create` signature

```typescript
contextBridge.exposeInMainWorld("glitterball", {
  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
    create: (projectDir: string, agentType?: string) =>
      ipcRenderer.invoke("sessions:create", projectDir, agentType),
    sendMessage: (sessionId: string, text: string) =>
      ipcRenderer.invoke("sessions:sendMessage", sessionId, text),
    closeSession: (sessionId: string) =>
      ipcRenderer.invoke("sessions:close", sessionId),
    onUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown): void =>
        callback(update);
      ipcRenderer.on("session-update", handler);
      return () => ipcRenderer.removeListener("session-update", handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke("dialog:selectDirectory"),
  },
});
```

### 5.4 Update renderer type declarations

- [ ] Update `src/renderer/src/env.d.ts`

```typescript
/// <reference types="vite/client" />

import type { AgentType, SessionSummary, SessionUpdate } from "../../main/types";

interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>;
    create(projectDir: string, agentType?: AgentType): Promise<SessionSummary>;
    sendMessage(sessionId: string, text: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
    onUpdate(callback: (update: SessionUpdate) => void): () => void;
  };
  dialog: {
    selectDirectory(): Promise<string | null>;
  };
}

declare global {
  interface Window {
    glitterball: GlitterballAPI;
  }
}
```

### 5.5 Update `<SessionList />`

- [ ] Show project directory basename as session label (e.g., "bouncer" not a UUID)
- [ ] Show agent type indicator (small label or icon distinguishing echo from Claude Code)
- [ ] Update `SessionSummary` rendering

```typescript
// In SessionList, per session entry:
const label = session.projectDir
  ? session.projectDir.split("/").pop()
  : `Session`;
const agentLabel = session.agentType === "echo" ? " (echo)" : "";
// Render: <span>{label}{agentLabel}</span>
```

### 5.6 Update `<App />` — directory picker flow

- [ ] Replace `handleCreateSession` to prompt for a directory before creating

```typescript
async function handleCreateSession() {
  try {
    const projectDir = await window.glitterball.dialog.selectDirectory();
    if (!projectDir) return; // User cancelled

    const session = await window.glitterball.sessions.create(projectDir);
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  } catch (err) {
    console.error("Failed to create session:", err);
    // TODO: show error in UI (e.g., "Not a git repository")
  }
}
```

### 5.7 Add `<ToolCallBlock />` component

- [ ] Create `src/renderer/src/components/ToolCallBlock.tsx`

Minimal display of tool call status within the chat panel:

```typescript
interface Props {
  toolCall: ToolCallInfo;
}

function ToolCallBlock({ toolCall }: Props) {
  const statusIcon =
    toolCall.status === "completed" ? "✓" :
    toolCall.status === "failed" ? "✗" :
    toolCall.status === "in_progress" ? "⋯" : "○";

  return (
    <div className="tool-call-block">
      <span className={`tool-status tool-status-${toolCall.status}`}>
        {statusIcon}
      </span>
      <span className="tool-name">{toolCall.name}</span>
      {toolCall.output && (
        <details className="tool-output">
          <summary>Output</summary>
          <pre>{toolCall.output}</pre>
        </details>
      )}
    </div>
  );
}
```

- [ ] Add basic CSS for `.tool-call-block` (inline block, monospace, muted colors)
- [ ] Integrate into `<ChatPanel />` — render tool calls inline within agent messages

### 5.8 Wire new `SessionUpdate` variants into `handleUpdate`

- [ ] Add `tool-call` and `plan-update` cases to the switch in `App.tsx`

```typescript
case "tool-call":
  // Store tool calls on the message for rendering
  setMessagesBySession((prev) => {
    const next = new Map(prev);
    const msgs = next.get(update.sessionId);
    if (msgs) {
      // Find the agent message and attach the tool call
      const msg = msgs.find((m) => m.id === update.messageId);
      if (msg) {
        msg.toolCalls = msg.toolCalls ?? [];
        const existing = msg.toolCalls.find((tc) => tc.id === update.toolCall.id);
        if (existing) {
          Object.assign(existing, update.toolCall);
        } else {
          msg.toolCalls.push(update.toolCall);
        }
        next.set(update.sessionId, [...msgs]);
      }
    }
    return next;
  });
  break;

case "plan-update":
  // TODO: store plan state for display (stretch goal)
  console.log("Plan update:", update.plan);
  break;
```

- [ ] Extend the `Message` type to include optional `toolCalls`

```typescript
export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];  // New in M1
}
```

### 5.9 Full flow test

- [ ] Launch `npm run dev`
- [ ] Click "New Session" → directory picker appears
- [ ] Select a git project directory
- [ ] Session appears in list with project name and "initializing" status
- [ ] Status changes to "ready" after a few seconds
- [ ] Type a message → Claude Code responds with streamed text
- [ ] Tool calls appear inline (e.g., Bash calls show `✓ Bash`)
- [ ] Multiple turns work correctly

**Done condition:** The full user flow works end-to-end through the Electron UI with Claude Code.

---

## Phase 6: Edge Cases and Polish

### 6.1 Agent startup failure handling

- [ ] Missing API key: if the agent exits immediately, show a descriptive error ("Claude Code failed to start — check your API key or run `claude login`")
- [ ] Claude Code not installed: if the binary can't be resolved, show "Claude Code is not installed — run `npm install` or install Claude Code globally"
- [ ] Parse stderr output from the agent process on early exit to surface the actual error message

```typescript
agentProcess.on("exit", (code) => {
  if (session.status === "initializing" && code !== 0) {
    // Agent died during startup — likely auth or config issue
    const stderr = collectedStderr; // Captured from stderr stream
    session.status = "error";
    session.errorMessage = stderr || `Agent exited with code ${code}`;
    this.emit("session-update", {
      sessionId: id,
      type: "status-change",
      status: "error",
      error: session.errorMessage,
    });
  }
});
```

- [ ] Add optional `error?: string` field to the `status-change` update variant
- [ ] Display error message in the UI when a session is in error state

### 6.2 Worktree creation failure handling

- [ ] Not a git repo: clear error message — "Selected directory is not a git repository"
- [ ] Git not found: detect and surface — "git is not installed or not on PATH"
- [ ] Dirty state preventing worktree creation: surface git's error message to the user
- [ ] All failures should be caught in `createSession()`, mark session as `error`, and emit the error to the UI

### 6.3 Multiple concurrent sessions

- [ ] Create two sessions pointing at different projects → both get independent worktrees
- [ ] Create two sessions pointing at the same project → both get independent worktrees (different branches)
- [ ] Send messages in both sessions → responses are independent
- [ ] Close one session → the other continues working
- [ ] Terminals in one session don't leak to another

### 6.4 Echo agent fallback

- [ ] Verify that the echo agent still works with the updated session manager
- [ ] Echo sessions should skip worktree creation (no `projectDir` validation, no worktree)
- [ ] Consider adding a keyboard shortcut or UI toggle for quickly creating echo sessions during development

### 6.5 Session close cleanup

- [ ] Close a Claude Code session → verify:
  - Agent process is killed
  - All terminal processes are killed
  - Worktree directory is removed
  - Session branch is deleted from git
  - No orphan processes remain (check with `ps`)
  - No orphan worktrees remain (check with `git worktree list`)

### 6.6 Orphan worktree cleanup on app startup

- [ ] On app launch, scan for leftover worktrees from previous sessions that weren't cleaned up (e.g., due to a crash)
- [ ] Clean up any worktrees under the `glitterball-worktrees` temp directory that don't correspond to active sessions

```typescript
// In SessionManager constructor or app startup
async cleanupOrphanWorktrees(): Promise<void> {
  const worktreeDir = join(tmpdir(), "glitterball-worktrees");
  try {
    const entries = await readdir(worktreeDir);
    for (const entry of entries) {
      if (!this.sessions.has(entry)) {
        // Orphan — try to clean up
        // Need to find which project it belongs to...
        // Simplest approach: just rm -rf the directory
        await rm(join(worktreeDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — nothing to clean
  }
}
```

> **Limitation:** This only removes the worktree directory, not the `bouncer/<id>` branch in the original repo. A more thorough cleanup would need to track which project directory each worktree belonged to. For the MVP, orphan branches are acceptable — they're small and don't affect the user's workflow.

---

## Verification Checklist

Run through this manually before considering M1 complete:

- [ ] `npm run dev` launches the Electron app
- [ ] Click "New Session" → directory picker dialog opens
- [ ] Select a git repository → session appears with project name and "initializing" status
- [ ] Session transitions to "ready" → green indicator
- [ ] Type "What files are in this directory?" → Claude Code responds with file listing
- [ ] Tool calls (e.g., Bash) appear in the chat with status indicators
- [ ] Send a follow-up message → multi-turn conversation works
- [ ] Type "Create a file called test.txt with 'hello'" → file is created in the worktree (not the original project)
- [ ] Create a second session (same or different project) → independent worktree, independent conversation
- [ ] Switch between sessions → each shows its own messages and tool calls
- [ ] Close a session → worktree removed, branch deleted, agent process killed
- [ ] Select a non-git directory → clear error message, session not created
- [ ] Unset `ANTHROPIC_API_KEY` and try creating a session → meaningful error message
- [ ] Create an echo agent session (if UI toggle exists, or via dev console) → echo still works
- [ ] `npm run build` produces a working production build
- [ ] `git worktree list` shows no orphan worktrees after all sessions are closed

---

## Sequencing Summary

| Phase | Description | Depends On | Key Risk |
|-------|-------------|------------|----------|
| 1 | Worktree manager | — | Git edge cases (submodules, dirty state) |
| 2 | Claude Code agent discovery | Phase 1 (for worktree CWD) | **Highest risk** — first contact with `claude-agent-acp` |
| 3 | Terminal management | Phase 2 (to know terminal semantics) | PTY requirement, command execution model |
| 4 | Session manager integration | Phase 1, 2, 3 | Wiring complexity, type alignment |
| 5 | IPC and UI updates | Phase 4 | Directory picker UX, tool call rendering |
| 6 | Edge cases and polish | Phase 5 | Cleanup reliability, error surface area |

**The highest-risk phase is 2** (Claude Code agent discovery). Everything in Phases 3-6 depends on what we learn there. If the `claude-agent-acp` package works differently than expected — different spawn mechanism, different Client method requirements, different terminal model — we'll need to adjust the design before proceeding. Phase 2's standalone test script is specifically designed to absorb this risk before we modify the session manager.

**Phase 1 has no external dependencies** and can be developed and tested immediately. Starting there gives us a working worktree manager before we need it in Phase 4.
