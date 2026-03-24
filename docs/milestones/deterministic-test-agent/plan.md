# Milestone 4: Deterministic Test Agent — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition and builds on the previous one. The plan builds on the working policy template system from [Milestone 3](../../history/policy-templates/plan.md).

## Progress

- [x] **[Phase 1: Replay Types and Agent Skeleton](#phase-1-replay-types-and-agent-skeleton)**
  - [x] 1.1 Add replay types to `src/main/types.ts`
  - [x] 1.2 Create `src/agents/replay-agent.ts` skeleton (ACP boilerplate only)
  - [x] 1.3 Verify: replay agent starts, completes ACP handshake, echoes back prompt text
- [ ] **[Phase 2: Agent Type Registration](#phase-2-agent-type-registration)**
  - [ ] 2.1 Add `resolveReplayAgentCommand()` to `src/main/session-manager.ts`
  - [ ] 2.2 Update `resolveAgentCommand()` to handle `"replay"` agent type
  - [ ] 2.3 Update `createSession()` for replay-specific worktree and policy behavior
  - [ ] 2.4 Update IPC handler in `src/main/index.ts` to accept `"replay"` agent type
  - [ ] 2.5 Write `scripts/test-replay-agent.ts` — spawn replay agent, send hand-crafted tool calls, verify session updates
- [ ] **[Phase 3: Tool Execution Engine](#phase-3-tool-execution-engine)**
  - [ ] 3.1 Add filesystem tool executors (`Read`, `Write`, `Edit`, `Grep`, `Glob`)
  - [ ] 3.2 Add `Bash` executor with timeout and EPERM detection
  - [ ] 3.3 Add network tool handling (`WebFetch` attempt, `WebSearch` skip)
  - [ ] 3.4 Add skip rules for non-replayable tools
  - [ ] 3.5 Verify: hand-crafted sequence with mixed tools produces correct outcomes
- [ ] **[Phase 4: Path De-anonymization](#phase-4-path-de-anonymization)**
  - [ ] 4.1 Implement `deanonymizePath()` for `{project}`, `{home}`, `{user}` substitution
  - [ ] 4.2 Implement `deanonymizeCommand()` for Bash command strings
  - [ ] 4.3 Add skip detection for un-resolvable paths (`{project-name}`, `.claude/` internal state)
  - [ ] 4.4 Verify: a real dataset record de-anonymizes to valid paths within a worktree
- [ ] **[Phase 5: Worktree Scaffolding](#phase-5-worktree-scaffolding)**
  - [ ] 5.1 Create `src/main/replay-scaffold.ts` with `buildScaffoldPlan()`
  - [ ] 5.2 Implement `applyScaffold()` to create stub files and directories
  - [ ] 5.3 Handle `Edit` inputs: seed files with `old_string` content
  - [ ] 5.4 Write `scripts/test-scaffold.ts` — scaffold a real dataset session, verify file tree
- [ ] **[Phase 6: Dataset Loader](#phase-6-dataset-loader)**
  - [ ] 6.1 Create `src/main/dataset-loader.ts` — parse JSONL, group by session, sort by timestamp
  - [ ] 6.2 Add session listing and summary statistics
  - [ ] 6.3 Verify: loader parses all 11,491 records, groups into 296 sessions
- [ ] **[Phase 7: Test Harness — Single Session](#phase-7-test-harness--single-session)**
  - [ ] 7.1 Create `scripts/replay-test.ts` with CLI arg parsing
  - [ ] 7.2 Implement single-session orchestration: load → scaffold → spawn → prompt → collect → teardown
  - [ ] 7.3 Implement `ReplayReport` generation with per-call outcomes
  - [ ] 7.4 Run one real dataset session against `standard-pr` — verify report structure
- [ ] **[Phase 8: Test Harness — Batch Mode](#phase-8-test-harness--batch-mode)**
  - [ ] 8.1 Add batch orchestration with concurrency limit (4 concurrent sessions)
  - [ ] 8.2 Add `--policy all` mode (run against every template)
  - [ ] 8.3 Add aggregate summary statistics and per-tool breakdown
  - [ ] 8.4 Add `--output` flag for JSON report file
  - [ ] 8.5 Run full corpus against `standard-pr` — first real validation run
- [ ] **[Phase 9: Batch Validation and Findings](#phase-9-batch-validation-and-findings)**
  - [ ] 9.1 Run full corpus against all three policies
  - [ ] 9.2 Analyze results: allowed rates, false-block rates, per-tool breakdowns
  - [ ] 9.3 Categorize blocks: sandbox enforcement vs. missing-file noise vs. network gap
  - [ ] 9.4 Document findings in `findings.md`
- [ ] **[Phase 10: UI Integration](#phase-10-ui-integration)**
  - [ ] 10.1 Update `NewSessionDialog.tsx` — add agent type selector with "Replay" option
  - [ ] 10.2 Add session ID text input (shown when Replay is selected)
  - [ ] 10.3 Update preload bridge and IPC handler for replay-specific session creation
  - [ ] 10.4 Update `env.d.ts` type declarations
  - [ ] 10.5 Full flow test: select Replay agent, enter session ID, see tool calls stream in chat panel
- [ ] **[Verification](#verification-checklist)** — all checks pass

---

## Phase 1: Replay Types and Agent Skeleton

Define the data types and get the bare ACP agent running. No tool execution yet — just parse prompt text and echo it back as a session update.

### 1.1 Add replay types to `src/main/types.ts`

Extend `AgentType` and add the replay-specific types:

```typescript
export type AgentType = "echo" | "claude-code" | "replay";

// --- Replay Types ---

export interface ReplayToolCall {
  id: number;
  tool: string;
  input: Record<string, unknown>;
  original_outcome: string;
}

export interface ReplayResult {
  id: number;
  tool: string;
  replay_outcome: "allowed" | "blocked" | "skipped" | "error";
  error_message?: string;
  original_outcome: string;
}
```

### 1.2 Create `src/agents/replay-agent.ts` skeleton

Model after `echo-agent.ts`. The skeleton:
- Sets up `AgentSideConnection` with stdio streams
- Implements `initialize`, `newSession`, `prompt`, `cancel`
- In `prompt`: parses the prompt text as `JSON.parse(text)` to get `ReplayToolCall[]`
- For now, just emits each call as a `tool_call` session update with `replay_outcome: "skipped"` and returns `{stopReason: "end_turn"}`

This validates the ACP plumbing before we add real execution.

**Key difference from echo agent**: The replay agent receives the worktree path via an environment variable `REPLAY_WORKTREE_PATH` (set by the session manager when spawning). This is how the agent knows where `{project}` maps to, without needing a custom protocol extension.

```typescript
// Environment-based config (set by session manager before spawn)
const WORKTREE_PATH = process.env.REPLAY_WORKTREE_PATH ?? process.cwd();
```

### 1.3 Verify

```bash
# Standalone test — spawn the agent directly, send a prompt with a JSON array
npx tsx src/agents/replay-agent.ts
# (stdin) → ACP initialize, newSession, prompt with [{"id":1,"tool":"Read","input":{"file_path":"test.txt"},"original_outcome":"approved"}]
# Expect: tool_call session update for each item, then end_turn
```

Confirm output is valid ACP JSON-RPC and the tool_call updates contain the expected tool names.

**Done when**: Agent starts, completes handshake, parses a JSON tool-call array from prompt text, emits one `tool_call` session update per item, returns `end_turn`.

---

## Phase 2: Agent Type Registration

Wire the replay agent into the existing session manager so it can be spawned like the echo and claude-code agents.

### 2.1 Add `resolveReplayAgentCommand()` to `src/main/session-manager.ts`

Follow the same pattern as `resolveEchoAgentCommand()`:

```typescript
function resolveReplayAgentCommand(
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  worktreePath: string,
): SpawnConfig {
  const isDev = !app.isPackaged;
  const require = createRequire(app.getAppPath() + "/");

  let cmd: string;
  let args: string[];

  if (isDev) {
    const tsxBin = require.resolve("tsx/cli");
    const agentScript = join(app.getAppPath(), "src", "agents", "replay-agent.ts");
    cmd = process.execPath;
    args = [tsxBin, agentScript];
  } else {
    const agentScript = join(__dirname, "..", "agents", "replay-agent.js");
    cmd = process.execPath;
    args = [agentScript];
  }

  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: "1",
    REPLAY_WORKTREE_PATH: worktreePath,
  };

  // Wrap in safehouse if sandbox config present
  if (sandboxConfig) {
    const safehouseArgs = buildSafehouseArgs(sandboxConfig, [cmd, ...args]);
    return { cmd: "safehouse", args: safehouseArgs, cwd, env };
  }

  return { cmd, args, env, cwd };
}
```

**Important**: Unlike the echo agent, the replay agent needs sandboxing — it must run inside the sandbox to test policy enforcement. Unlike claude-code, it doesn't need `ANTHROPIC_API_KEY`.

### 2.2 Update `resolveAgentCommand()`

Add the `"replay"` case:

```typescript
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  worktreePath?: string,
): SpawnConfig {
  if (agentType === "echo") {
    return resolveEchoAgentCommand();
  }
  if (agentType === "replay") {
    return resolveReplayAgentCommand(cwd, sandboxConfig, worktreePath ?? cwd);
  }
  return resolveClaudeCodeCommand(cwd, sandboxConfig);
}
```

### 2.3 Update `createSession()` for replay-specific behavior

The replay agent needs:
- A worktree (same as claude-code) — for sandbox-scoped file operations
- A policy template (same as claude-code) — for sandbox config generation
- **No** `ANTHROPIC_API_KEY` in env passthrough

Update the conditional in `createSession()`:

```typescript
// Resolve policy template — replay agents also get sandboxed
const resolvedPolicyId = (agentType === "claude-code" || agentType === "replay")
  ? (policyId ?? this.policyRegistry.defaultId)
  : null;

// Create worktree for Claude Code and replay sessions
if (agentType === "claude-code" || agentType === "replay") {
  const isGitRepo = await this.worktreeManager.validateGitRepo(projectDir);
  if (!isGitRepo) {
    throw new Error(`Not a git repository: ${projectDir}`);
  }
  worktree = await this.worktreeManager.create(id, projectDir);
}
```

Pass `worktreePath` through to `resolveAgentCommand()`:

```typescript
const { cmd, args, env, cwd } = resolveAgentCommand(
  agentType,
  workingDir,
  sandboxConfig,
  worktree?.path,
);
```

### 2.4 Update IPC handler in `src/main/index.ts`

The current `sessions:create` handler only accepts `"echo"` and `"claude-code"`. Add `"replay"`:

```typescript
ipcMain.handle('sessions:create', (_e, projectDir: unknown, agentType: unknown, policyId: unknown) => {
  if (typeof projectDir !== 'string') {
    throw new Error('Invalid argument: projectDir must be a string')
  }
  const validTypes = ['echo', 'claude-code', 'replay'] as const
  type ValidType = typeof validTypes[number]
  const validAgentType: ValidType = validTypes.includes(agentType as ValidType)
    ? (agentType as ValidType)
    : 'claude-code'
  const validPolicyId = typeof policyId === 'string' ? policyId : undefined
  return sessionManager.createSession(projectDir, validAgentType, validPolicyId)
})
```

### 2.5 Write `scripts/test-replay-agent.ts`

Test script that:
1. Spawns the replay agent directly (no Electron, no sandbox)
2. Performs ACP handshake (initialize → newSession)
3. Sends a prompt with a hand-crafted JSON tool-call array
4. Collects session updates and prints them
5. Asserts: one `tool_call` update per tool call in the array

This is the same pattern as `scripts/test-echo-agent.ts` but for the replay agent.

**Done when**: `npx tsx scripts/test-replay-agent.ts` spawns the replay agent, completes ACP handshake, sends a prompt with tool calls, and receives the expected session updates.

---

## Phase 3: Tool Execution Engine

Add real tool execution to the replay agent. Each tool maps to a filesystem or process operation.

### 3.1 Add filesystem tool executors

In `replay-agent.ts`, implement an `executeToolCall()` function with handlers for each filesystem tool:

**`Read`**: `fs.readFile(deanonymizePath(input.file_path))` — catch EPERM → `blocked`, catch ENOENT → `error`, success → `allowed`

**`Write`**: `fs.writeFile(deanonymizePath(input.file_path), "// replay-stub\n")` — we don't use the original content (excluded from dataset). Catch EPERM → `blocked`.

**`Edit`**: `fs.readFile(path)` then `fs.writeFile(path, content)` — the read verifies access; the write tests mutation. If `old_string` is in the input, do a naive string replace. Catch EPERM → `blocked`.

**`Grep`**: Simplify to `fs.access(path, fs.constants.R_OK)` on the `input.path` field. We're testing read access, not search results. If `path` is a directory, use `fs.readdir`. Catch EPERM → `blocked`.

**`Glob`**: Same as Grep — `fs.readdir(path)` to test read access to the directory. Catch EPERM → `blocked`.

**Error classification logic** (shared across all executors):

```typescript
function classifyError(err: unknown): "blocked" | "error" {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("eperm") ||
      msg.includes("eacces") ||
      msg.includes("operation not permitted") ||
      msg.includes("permission denied")
    ) {
      return "blocked";
    }
  }
  return "error";
}
```

### 3.2 Add `Bash` executor

```typescript
async function executeBash(command: string, cwd: string): Promise<ReplayResult> {
  // Skip network-dependent commands
  if (command.includes("{host}")) return { ...base, replay_outcome: "skipped" };

  try {
    execSync(deanonymizeCommand(command), {
      cwd,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return { ...base, replay_outcome: "allowed" };
  } catch (err) {
    // Check if it's a sandbox block vs. a regular command failure
    const stderr = (err as any)?.stderr?.toString() ?? "";
    const msg = (err as Error).message ?? "";
    const combined = stderr + msg;
    if (
      combined.includes("Operation not permitted") ||
      combined.includes("EPERM") ||
      combined.includes("Permission denied")
    ) {
      return { ...base, replay_outcome: "blocked", error_message: combined.slice(0, 200) };
    }
    return { ...base, replay_outcome: "error", error_message: combined.slice(0, 200) };
  }
}
```

### 3.3 Add network tool handling

**`WebFetch`**: Attempt `fetch(url)` with a 3-second timeout. If the sandbox blocks network → `blocked`. If it succeeds → `allowed`. If URL is `{host}` → `skipped`.

**`WebSearch`**: Always `skipped` — no local equivalent.

### 3.4 Add skip rules for non-replayable tools

Build a skip set:

```typescript
const SKIP_TOOLS = new Set([
  "WebSearch", "Task", "Agent", "TodoWrite",
  "EnterPlanMode", "ExitPlanMode", "ToolSearch",
  "Skill", "AskUserQuestion", "TaskOutput", "TaskStop",
  "EnterWorktree", "ExitWorktree", "NotebookEdit",
]);

function shouldSkip(tool: string): boolean {
  if (SKIP_TOOLS.has(tool)) return true;
  if (tool.startsWith("mcp__")) return true;  // MCP tools
  return false;
}
```

### 3.5 Verify

Update `scripts/test-replay-agent.ts` to send a mixed sequence:

```json
[
  {"id": 1, "tool": "Read", "input": {"file_path": "{project}/test.txt"}, "original_outcome": "approved"},
  {"id": 2, "tool": "Write", "input": {"file_path": "{project}/new.txt", "content": "hello"}, "original_outcome": "approved"},
  {"id": 3, "tool": "Bash", "input": {"command": "ls {project}"}, "original_outcome": "approved"},
  {"id": 4, "tool": "TodoWrite", "input": {"todos": []}, "original_outcome": "approved"},
  {"id": 5, "tool": "Read", "input": {"file_path": "/etc/passwd"}, "original_outcome": "approved"}
]
```

Expected outcomes (unsandboxed): 1=allowed (if file exists), 2=allowed, 3=allowed, 4=skipped, 5=allowed (unsandboxed) or blocked (sandboxed).

**Done when**: All five tool types produce the expected replay_outcome.

---

## Phase 4: Path De-anonymization

The dataset uses `{project}`, `{home}`, `{user}`, and `{project-name}` placeholders. The agent needs to resolve these to real paths.

### 4.1 Implement `deanonymizePath()`

In `replay-agent.ts`:

```typescript
interface ReplayContext {
  worktreePath: string;
  homePath: string;
  username: string;
}

function deanonymizePath(path: string, ctx: ReplayContext): string {
  return path
    .replace(/\{project\}/g, ctx.worktreePath)
    .replace(/\{home\}/g, ctx.homePath)
    .replace(/\{user\}/g, ctx.username);
}
```

The context is initialized from environment:

```typescript
const ctx: ReplayContext = {
  worktreePath: process.env.REPLAY_WORKTREE_PATH ?? process.cwd(),
  homePath: os.homedir(),
  username: os.userInfo().username,
};
```

### 4.2 Implement `deanonymizeCommand()` for Bash commands

Bash commands have paths embedded in command strings. Apply the same substitution:

```typescript
function deanonymizeCommand(command: string, ctx: ReplayContext): string {
  return command
    .replace(/\{project\}/g, ctx.worktreePath)
    .replace(/\{home\}/g, ctx.homePath)
    .replace(/\{user\}/g, ctx.username);
}
```

### 4.3 Add skip detection for un-resolvable paths

Some paths in the dataset can't be meaningfully de-anonymized:
- `{project-name}` — appears in `.claude/projects/-Users-{user}-Code-{project-name}/...` (Claude Code's internal state files, not project files)
- Paths containing `.claude/` — agent reading its own session transcripts, not replayable

```typescript
function hasUnresolvablePath(input: Record<string, unknown>): boolean {
  const json = JSON.stringify(input);
  if (json.includes("{project-name}")) return true;
  if (json.includes(".claude/")) return true;
  return false;
}
```

These tool calls get `replay_outcome: "skipped"`.

### 4.4 Verify

Take record `id: 1` from the dataset:
```json
{"id":1,"tool":"Read","input":{"file_path":"{project}/.claude/projects/-Users-{user}-Code-{project-name}/fd033680-dc2e-44b6-a5c4-8079d916b2bf.jsonl"}}
```

This should be detected as un-resolvable (contains `{project-name}` and `.claude/`) → `skipped`.

Take a normal record like:
```json
{"tool":"Read","input":{"file_path":"{project}/src/index.ts"}}
```

This should de-anonymize to `<worktreePath>/src/index.ts` → valid path.

**Done when**: De-anonymization correctly handles all placeholder types, and un-resolvable paths are skipped rather than producing spurious errors.

---

## Phase 5: Worktree Scaffolding

Before replaying, populate the worktree with stub files so that `Read` and `Edit` calls don't fail for missing-file reasons (which we'd miscount as errors rather than sandbox blocks).

### 5.1 Create `src/main/replay-scaffold.ts`

```typescript
import type { ReplayToolCall } from "./types.js";

export interface ScaffoldPlan {
  /** Relative path → file content */
  files: Map<string, string>;
  /** Relative directory paths to create */
  directories: Set<string>;
}

/**
 * Scan a session's tool calls and build a plan for stub files.
 * All paths in the plan are relative to the worktree root.
 */
export function buildScaffoldPlan(
  toolCalls: ReplayToolCall[],
  deanonymize: (path: string) => string,
  worktreePath: string,
): ScaffoldPlan;
```

**Path extraction logic per tool**:

| Tool | Input field(s) | Scaffold action |
|------|---------------|-----------------|
| `Read` | `input.file_path` | Create file with `// stub\n` |
| `Write` | `input.file_path` | Create parent directory only (write creates the file) |
| `Edit` | `input.file_path` | Create file with `input.old_string` as content (if present) |
| `Grep` | `input.path` | Create file or directory depending on whether path looks like a file or dir |
| `Glob` | `input.path` | Create directory |
| `Bash` | `input.command` | Best-effort: extract paths that start with `{project}/` from the command string |

**Path filtering**:
- Only scaffold paths that start with `{project}/` (or de-anonymize to within the worktree)
- Skip paths containing `{project-name}`, `.claude/`, or `{home}`
- Skip paths that are system paths (`/etc`, `/usr`, `/tmp`, `/var`)

### 5.2 Implement `applyScaffold()`

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function applyScaffold(
  worktreePath: string,
  plan: ScaffoldPlan,
): Promise<number> {
  // Create directories first
  for (const dir of plan.directories) {
    await mkdir(join(worktreePath, dir), { recursive: true });
  }
  // Create files
  for (const [relPath, content] of plan.files) {
    const absPath = join(worktreePath, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }
  return plan.files.size;
}
```

### 5.3 Handle `Edit` inputs

For `Edit` tool calls, the dataset includes `input.old_string` — the text the edit expects to find. Seed the stub file with this content so the edit can match:

```typescript
if (tool === "Edit" && typeof input.old_string === "string") {
  files.set(relPath, input.old_string);
} else {
  // Don't overwrite if already seeded with Edit content
  if (!files.has(relPath)) {
    files.set(relPath, "// stub\n");
  }
}
```

If multiple edits target the same file with different `old_string` values, concatenate them (separated by newlines). The edit won't produce a correct result, but it will test whether the write is allowed by the sandbox — which is all we need.

### 5.4 Write `scripts/test-scaffold.ts`

Test script that:
1. Loads a real dataset session (e.g., `session-001`)
2. Creates a temp directory (not a real worktree — just for scaffold testing)
3. Calls `buildScaffoldPlan()` and `applyScaffold()`
4. Lists the created file tree and prints statistics (files created, directories created)
5. Spot-checks a few files for expected content

**Done when**: A real dataset session scaffolds without errors, creating a plausible file tree within the temp directory.

---

## Phase 6: Dataset Loader

Provide a clean API for loading and querying the dataset. This is used by both the test harness (Phase 7) and the UI integration (Phase 10).

### 6.1 Create `src/main/dataset-loader.ts`

```typescript
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ReplayToolCall } from "./types.js";

interface DatasetRecord {
  id: number;
  tool: string;
  input: Record<string, unknown>;
  outcome: string;
  error_type?: string;
  project: string;
  session: string;
  is_subagent: boolean;
  permission_mode: string;
  timestamp_relative: number;
}

/**
 * Load the dataset and group records by session.
 * Returns a Map from session ID to sorted tool-call array.
 */
export async function loadDataset(
  datasetPath: string,
): Promise<Map<string, ReplayToolCall[]>>;

/**
 * Get summary statistics for the loaded dataset.
 */
export function datasetSummary(
  sessions: Map<string, ReplayToolCall[]>,
): { sessionCount: number; recordCount: number; toolDistribution: Record<string, number> };
```

**Record → ReplayToolCall mapping**:

```typescript
function toReplayToolCall(record: DatasetRecord): ReplayToolCall {
  return {
    id: record.id,
    tool: record.tool,
    input: record.input,
    original_outcome: record.outcome,
  };
}
```

**Grouping**: Parse JSONL line by line, group into `Map<session, ReplayToolCall[]>`, sort each group by `timestamp_relative`.

### 6.2 Add session listing and summary

The loader exposes `listSessions()` that returns session IDs with basic metadata (project, tool call count, tools used). This is used by the test harness for `--session` filtering and by the UI for the session ID picker.

### 6.3 Verify

```bash
npx tsx -e "
  import { loadDataset, datasetSummary } from './src/main/dataset-loader.js';
  const sessions = await loadDataset('data/tool-use-dataset.jsonl');
  const summary = datasetSummary(sessions);
  console.log(JSON.stringify(summary, null, 2));
"
```

Expected: `sessionCount: 296`, `recordCount: 11491`, tool distribution matching `data/dataset-summary.json`.

**Done when**: Loader parses the full dataset, grouping matches expected session count, records are sorted by timestamp within each session.

---

## Phase 7: Test Harness — Single Session

Build the CLI test harness with single-session replay first.

### 7.1 Create `scripts/replay-test.ts` with CLI arg parsing

Use `process.argv` parsing (no external CLI library — keep it simple):

```
Usage: npx tsx scripts/replay-test.ts [options]

Options:
  --policy <id>        Policy template ID (standard-pr, research-only, permissive, or "all")
  --session <id>       Single session ID to replay (e.g., session-042)
  --sessions <ids>     Comma-separated session IDs
  --project-dir <dir>  Git repo directory for worktree creation
  --dataset <path>     Dataset JSONL path (default: data/tool-use-dataset.jsonl)
  --output <path>      Output file for JSON report (default: stdout)
  --concurrency <n>    Max concurrent sessions in batch mode (default: 4)
  --no-sandbox         Run without safehouse sandbox (for baseline comparison)
```

### 7.2 Implement single-session orchestration

The core replay loop for one session. This runs **outside Electron** — the harness directly imports and uses the same modules that `SessionManager` uses, without the Electron `app` object.

```typescript
async function replaySession(
  sessionId: string,
  toolCalls: ReplayToolCall[],
  policyId: string,
  projectDir: string,
): Promise<SessionReplayResult> {
  const startTime = Date.now();

  // 1. Create worktree
  const worktreeManager = new WorktreeManager();
  const fakeSessionId = randomUUID(); // Unique ID for worktree lifecycle
  const worktree = await worktreeManager.create(fakeSessionId, projectDir);

  try {
    // 2. Scaffold files
    const plan = buildScaffoldPlan(toolCalls, deanonymize, worktree.path);
    const scaffoldedFiles = await applyScaffold(worktree.path, plan);

    // 3. Build sandbox config from policy
    const registry = new PolicyTemplateRegistry();
    const template = registry.get(policyId);
    const sandboxConfig = policyToSandboxConfig(template, {
      sessionId: fakeSessionId,
      worktreePath: worktree.path,
      gitCommonDir: worktree.gitCommonDir,
    });

    // 4. Spawn replay agent inside sandbox
    const agentArgs = buildReplayAgentSpawnArgs(sandboxConfig, worktree.path);
    const agentProcess = spawn(agentArgs.cmd, agentArgs.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...agentArgs.env },
      cwd: worktree.path,
    });

    // 5. ACP handshake
    const connection = setupAcpConnection(agentProcess);
    await connection.initialize({ ... });
    const acpSession = await connection.newSession({ cwd: worktree.path });

    // 6. Send tool-call sequence as prompt
    const results: ReplayResult[] = [];
    // Collect results from sessionUpdate callbacks...
    await connection.prompt({
      sessionId: acpSession.sessionId,
      prompt: [{ type: "text", text: JSON.stringify(toolCalls) }],
    });

    // 7. Kill agent
    agentProcess.kill();

    return {
      sessionId,
      project: toolCalls[0]?.project ?? "unknown",
      toolCallCount: toolCalls.length,
      results,
      scaffoldedFiles,
      replayDurationMs: Date.now() - startTime,
    };
  } finally {
    // 8. Tear down worktree
    await worktreeManager.remove(worktree);
  }
}
```

**Important**: The harness cannot use `app.getAppPath()` (Electron-only). Factor out the agent resolution logic so it works standalone. The replay agent script path is simply `src/agents/replay-agent.ts` when running via `tsx`.

Safehouse wrapping logic: reuse `buildSafehouseArgs()` from `src/main/sandbox.ts` directly — it has no Electron dependencies.

### 7.3 Implement `ReplayReport` generation

After collecting `ReplayResult[]` from the agent's session updates, compute:

```typescript
function buildReport(
  policyId: string,
  sessionResults: SessionReplayResult[],
  datasetPath: string,
): ReplayReport {
  const allResults = sessionResults.flatMap(s => s.results);
  const allowed = allResults.filter(r => r.replay_outcome === "allowed").length;
  const blocked = allResults.filter(r => r.replay_outcome === "blocked").length;
  const skipped = allResults.filter(r => r.replay_outcome === "skipped").length;
  const error = allResults.filter(r => r.replay_outcome === "error").length;

  // False blocks: sandbox blocked something that was approved in the original session
  const falseBlocks = allResults.filter(
    r => r.replay_outcome === "blocked" && r.original_outcome === "approved"
  ).length;
  const actionable = allowed + blocked; // excluding skipped and error

  return {
    metadata: {
      timestamp: new Date().toISOString(),
      dataset: datasetPath,
      policyId,
      sessionsTotal: sessionResults.length,
      sessionsCompleted: sessionResults.filter(s => s.results.length > 0).length,
      sessionsFailed: sessionResults.filter(s => s.results.length === 0).length,
    },
    summary: {
      totalToolCalls: allResults.length,
      allowed,
      blocked,
      skipped,
      error,
      allowedRate: actionable > 0 ? allowed / actionable : 1,
      falseBlockRate: (allowed + falseBlocks) > 0
        ? falseBlocks / (allowed + falseBlocks)
        : 0,
    },
    byTool: computeByToolBreakdown(allResults),
    sessions: sessionResults,
  };
}
```

### 7.4 Run one real dataset session against `standard-pr`

Pick a session with moderate complexity (mix of Read, Bash, Edit). Run:

```bash
npx tsx scripts/replay-test.ts \
  --policy standard-pr \
  --session session-001 \
  --project-dir .
```

Verify the report:
- Every tool call has a `replay_outcome`
- `skipped` for TodoWrite, WebSearch, MCP tools
- `allowed` or `error` for Read, Edit, Bash (no sandbox blocks expected for in-worktree operations)
- Report JSON is valid and parseable

**Done when**: Single-session replay produces a complete, valid `ReplayReport` JSON.

---

## Phase 8: Test Harness — Batch Mode

Scale from one session to the full corpus.

### 8.1 Add batch orchestration with concurrency limit

```typescript
async function replayBatch(
  sessions: Map<string, ReplayToolCall[]>,
  policyId: string,
  projectDir: string,
  concurrency: number,
): Promise<SessionReplayResult[]> {
  const results: SessionReplayResult[] = [];
  const entries = Array.from(sessions.entries());
  let index = 0;

  async function worker() {
    while (index < entries.length) {
      const i = index++;
      const [sessionId, toolCalls] = entries[i];
      process.stderr.write(`[${i + 1}/${entries.length}] ${sessionId}...\n`);
      try {
        const result = await replaySession(sessionId, toolCalls, policyId, projectDir);
        results.push(result);
      } catch (err) {
        process.stderr.write(`  FAILED: ${(err as Error).message}\n`);
        results.push({
          sessionId,
          project: toolCalls[0]?.project ?? "unknown",
          toolCallCount: toolCalls.length,
          results: [],
          scaffoldedFiles: 0,
          replayDurationMs: 0,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
```

### 8.2 Add `--policy all` mode

When `--policy all` is specified, run the batch against each policy template sequentially. Output a combined report:

```json
{
  "standard-pr": { ...ReplayReport },
  "research-only": { ...ReplayReport },
  "permissive": { ...ReplayReport }
}
```

### 8.3 Add aggregate summary and per-tool breakdown

Print a human-readable summary to stderr after the JSON report:

```
=== standard-pr ===
Sessions: 296 completed, 0 failed
Tool calls: 11491 total
  Allowed: 8234 (87.3%)
  Blocked: 412 (4.4%)
  Skipped: 2103 (18.3%)
  Error:   742 (6.5%)
False-block rate: 3.2% (of originally-approved calls)

By tool:
  Read:   3719 total | 3680 allowed | 2 blocked | 37 skipped | 0 error
  Bash:   3825 total | 2910 allowed | 350 blocked | 230 skipped | 335 error
  Edit:   909  total | 870 allowed | 12 blocked | 0 skipped | 27 error
  ...
```

### 8.4 Add `--output` flag

Write the JSON report to a file. Print the summary to stderr regardless.

### 8.5 Run full corpus against `standard-pr`

```bash
npx tsx scripts/replay-test.ts \
  --policy standard-pr \
  --project-dir . \
  --output results/standard-pr-$(date +%Y%m%d).json
```

This is the first real validation run. Review the report for:
- Are the numbers plausible?
- Which tools have the most blocks?
- Are blocks real (sandbox enforcement) or noise (missing files, command failures)?
- How long does the full batch take?

Tune the concurrency and timeout settings based on this run.

**Done when**: Full corpus replay completes for one policy with a valid report.

---

## Phase 9: Batch Validation and Findings

Run the complete validation matrix and document findings.

### 9.1 Run full corpus against all three policies

```bash
npx tsx scripts/replay-test.ts \
  --policy all \
  --project-dir . \
  --output results/all-policies-$(date +%Y%m%d).json
```

### 9.2 Analyze results

For each policy, examine:
- **Allowed rate**: What fraction of real-world operations does the policy permit?
- **False-block rate**: Among operations that were approved in the original session, what fraction does the policy block?
- **Per-tool breakdown**: Which tools are most affected?
- **Cross-policy comparison**: How do the three policies differ in practice?

### 9.3 Categorize blocks

For blocked operations, categorize:

| Category | Description | Example |
|----------|-------------|---------|
| **Sandbox enforcement** | Real sandbox block (EPERM on restricted path) | Read `/etc/passwd`, write to `{home}/...` |
| **Missing-file noise** | File doesn't exist in scaffold (ENOENT counted as error, not block) | Bash `cat` on unscaffolded file |
| **Network gap** | Operation needs network but network isn't enforced yet | `git push`, `npm install`, `curl` |
| **Temp-dir gap** | Operation writes to temp which safehouse allows broadly | Write to `/tmp/...` |

This categorization directly informs M5 and M6 priorities.

### 9.4 Document findings

Create `docs/milestones/deterministic-test-agent/findings.md` with:
- Summary table: policy × metric (allowed rate, false-block rate)
- Per-tool heatmap (text table)
- Block categorization breakdown
- Implications for M5 (application-layer policies) and M6 (network boundary)
- Notable edge cases or surprises

**Done when**: Findings document is written with quantitative data from real batch runs.

---

## Phase 10: UI Integration

Add the replay agent as a selectable option in the Glitter Ball UI.

### 10.1 Update `NewSessionDialog.tsx`

Add an agent type selector above the policy selector. Three options: Claude Code (default), Echo (dev), Replay.

```tsx
const [agentType, setAgentType] = useState<'claude-code' | 'echo' | 'replay'>('claude-code')
```

Add a section to the dialog:

```tsx
<div style={sectionStyle}>
  <label style={labelStyle}>Agent</label>
  <div style={agentTypeListStyle}>
    <label><input type="radio" ... value="claude-code" /> Claude Code</label>
    <label><input type="radio" ... value="replay" /> Replay</label>
    <label><input type="radio" ... value="echo" /> Echo (dev)</label>
  </div>
</div>
```

### 10.2 Add session ID text input

When `agentType === "replay"`, show a text input for the dataset session ID to replay:

```tsx
{agentType === 'replay' && (
  <div style={sectionStyle}>
    <label style={labelStyle}>Dataset Session ID</label>
    <input
      type="text"
      placeholder="e.g., session-042"
      value={replaySessionId}
      onChange={(e) => setReplaySessionId(e.target.value)}
      style={textInputStyle}
    />
  </div>
)}
```

The policy selector should still be shown for replay (the user picks which policy to test).

Update `handleCreate()` to pass `agentType` and, for replay sessions, send the dataset session's tool calls as the first message after session creation:

```typescript
async function handleCreate() {
  if (!projectDir || !selectedPolicyId) return;
  setCreating(true);
  try {
    const session = await window.glitterball.sessions.create(
      projectDir,
      agentType,
      selectedPolicyId,
    );
    onCreated(session);

    // For replay sessions, auto-send the tool-call sequence
    if (agentType === 'replay' && replaySessionId) {
      // Load dataset and send tool calls as first message
      // This happens via a new IPC call: sessions:loadReplayData
      const toolCalls = await window.glitterball.sessions.loadReplayData(replaySessionId);
      await window.glitterball.sessions.sendMessage(session.id, JSON.stringify(toolCalls));
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  } finally {
    setCreating(false);
  }
}
```

### 10.3 Update preload bridge and IPC handler

Add a new IPC call for loading replay data:

**`src/preload/index.ts`**:
```typescript
sessions: {
  // ... existing ...
  loadReplayData: (datasetSessionId: string) =>
    ipcRenderer.invoke('sessions:loadReplayData', datasetSessionId),
},
```

**`src/main/index.ts`**:
```typescript
ipcMain.handle('sessions:loadReplayData', async (_e, datasetSessionId: unknown) => {
  if (typeof datasetSessionId !== 'string') {
    throw new Error('Invalid argument: datasetSessionId must be a string');
  }
  const { loadDataset } = await import('./dataset-loader.js');
  const sessions = await loadDataset(join(app.getAppPath(), 'data', 'tool-use-dataset.jsonl'));
  const toolCalls = sessions.get(datasetSessionId);
  if (!toolCalls) {
    throw new Error(`Session not found in dataset: ${datasetSessionId}`);
  }
  return toolCalls;
});
```

### 10.4 Update `env.d.ts`

Add `loadReplayData` to the type declarations:

```typescript
sessions: {
  // ... existing ...
  loadReplayData(datasetSessionId: string): Promise<unknown[]>
}
```

### 10.5 Full flow test

1. Launch Glitter Ball (`npm run dev`)
2. Click "New Session"
3. Select agent type: "Replay"
4. Enter session ID: `session-001`
5. Select policy: `standard-pr`
6. Browse to project directory
7. Click "Create Session"
8. Watch tool calls stream into the chat panel
9. Verify each tool call shows its name and outcome (allowed/blocked/skipped)

**Done when**: Interactive replay works end-to-end in the UI with tool calls visible in the chat panel.

---

## Verification Checklist

- [ ] `npx tsx scripts/test-replay-agent.ts` — replay agent spawns, handshakes, executes tool calls, reports results
- [ ] `npx tsx scripts/test-scaffold.ts` — scaffolds a real dataset session into a temp directory
- [ ] `npx tsx scripts/replay-test.ts --policy standard-pr --session session-001 --project-dir .` — single-session replay produces valid report
- [ ] `npx tsx scripts/replay-test.ts --policy all --project-dir . --output results/validation.json` — batch replay across all policies completes
- [ ] Findings documented in `findings.md` with quantitative coverage data
- [ ] Replay agent selectable in Glitter Ball UI, tool calls visible in chat panel
- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] No new external dependencies added
