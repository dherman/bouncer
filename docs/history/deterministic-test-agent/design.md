# Milestone 4: Deterministic Test Agent — Design

## Goal

Build a reproducible testing system for sandbox policies by replaying real tool-use sequences from the dataset against policy-configured sandboxes. By the end of this milestone, we can run any recorded session against any policy template and measure exactly which tool calls would be allowed vs. blocked — without requiring Claude Code, an API key, or network access.

## Success Criteria

- An ACP-compliant **replay agent** that reads a session's tool-use sequence from the dataset and executes each tool call against the real filesystem/sandbox
- A **test harness** (CLI script) that runs a replay against a given policy and produces a structured report: allowed, blocked (sandbox violation), and skipped operations
- Dataset enrichment: sessions have enough context (worktree structure, branch, file content stubs) to replay realistically
- **Batch validation**: run all sessions (or a representative subset) against each policy template, producing a coverage matrix showing false-block rates per policy
- The replay agent is a first-class agent type selectable from the Glitter Ball UI (alongside `echo` and `claude-code`)

## Non-Goals

- LLM-based agents or any network-dependent agent behavior (the replay is purely deterministic)
- Application-layer policy enforcement (Milestone 5) — we measure what the OS sandbox allows/blocks, not git-semantic or API-semantic constraints
- Modifying policy templates based on findings (that's a follow-up task informed by this milestone's data)
- Replay fidelity for tool _results_ — we care about whether the operation was allowed, not whether it produced the right output
- UI for browsing batch validation results (CLI/JSON output is sufficient)

---

## Background

### What We Learned in Milestones 2–3

Milestone 2 ([findings](../../history/seatbelt-sandbox/findings.md)) validated that safehouse-based sandboxing works for typical coding workflows. Milestone 3 ([findings](../../history/policy-templates/findings.md)) built the policy template system and discovered two key enforcement limitations:

1. **Network deny is all-or-nothing.** SBPL `(deny network-outbound)` blocks Claude Code's own API traffic. Network enforcement is deferred to Milestone 6 (proxy-based).

2. **Temp directory access is broad.** Safehouse's `--enable=all-agents` grants write access to temp directories, and worktrees live in temp. Filesystem write restrictions within temp are not enforceable at the OS level.

These findings mean the current policy templates (`standard-pr`, `research-only`, `permissive`) differ primarily in _declared intent_ rather than _enforced behavior_. Milestone 4 quantifies this gap: given real-world tool-use patterns, what fraction of operations does each policy _actually_ constrain?

### Why a Replay Agent

Manual testing (running Claude Code under different policies and observing what breaks) is slow, expensive, non-reproducible, and limited to whatever tasks we think to try. We have a dataset of 11,491 real tool calls across 296 sessions — that's our test corpus. A replay agent lets us:

- **Measure policy coverage**: What percentage of real-world operations does each policy allow? Where are the false blocks?
- **Regression-test policy changes**: When we add a new template or tighten an existing one, replay the corpus to see what breaks.
- **Validate future enforcement mechanisms**: When Milestone 5 adds application-layer policies or Milestone 6 adds network filtering, replay shows the incremental impact.

### Relationship to the Dataset

The dataset ([`data/tool-use-dataset.jsonl`](../../data/tool-use-dataset.jsonl)) was extracted in the initial research phase ([PR 0](../../history/initial-research/pr-0-dataset-extraction.md)). Each record contains:

```json
{
  "id": 1,
  "tool": "Read",
  "input": { "file_path": "{project}/src/index.ts" },
  "outcome": "approved",
  "project": "project-01",
  "session": "session-001",
  "is_subagent": false,
  "permission_mode": "default",
  "timestamp_relative": 0
}
```

Key properties relevant to replay:

- **Anonymized paths**: `{project}`, `{home}`, `{user}` placeholders replace real paths. The replay agent must de-anonymize these to worktree-relative paths.
- **Tool inputs only**: Tool results are excluded from the dataset. The replay agent doesn't need them — it executes the operation and observes whether the sandbox allows it.
- **Session grouping**: Records are grouped by `session` and ordered by `timestamp_relative`, giving us sequential replay order.
- **11,491 records across 296 sessions**: Large enough for statistical claims about policy coverage.

---

## Architecture

### Overview

```
┌───────────────────────────────────────────────────────────────┐
│                    Test Harness (CLI)                          │
│                                                               │
│  Inputs:                                                      │
│    - dataset path (JSONL)                                     │
│    - policy template ID                                       │
│    - project dir (git repo for worktree creation)             │
│    - session filter (optional: specific session IDs)          │
│                                                               │
│  Orchestration:                                               │
│    1. Group dataset records by session                         │
│    2. For each session:                                        │
│       a. Create worktree + scaffold files                     │
│       b. Build sandbox config from policy template            │
│       c. Spawn replay agent inside sandbox                    │
│       d. Feed tool-call sequence via ACP                      │
│       e. Collect per-call outcomes (allowed/blocked/skipped)  │
│       f. Tear down worktree                                   │
│    3. Aggregate results into report                           │
│                                                               │
│  Output: JSON report + summary statistics                     │
└───────────────────────┬───────────────────────────────────────┘
                        │ stdio (ACP / JSON-RPC)
┌───────────────────────▼───────────────────────────────────────┐
│              Replay Agent (sandboxed)                          │
│                                                               │
│  ACP AgentSideConnection                                      │
│                                                               │
│  On prompt:                                                   │
│    1. Parse tool-call sequence from prompt text (JSON)         │
│    2. For each tool call:                                      │
│       a. De-anonymize paths ({project} → worktree path)       │
│       b. Execute the operation (file read/write, bash, etc.)  │
│       c. Report result via sessionUpdate (tool_call events)    │
│       d. Catch EPERM/sandbox errors → record as "blocked"     │
│    3. Return summary as final message                         │
│                                                               │
│  Runs inside safehouse sandbox (inherits policy constraints)  │
└───────────────────────────────────────────────────────────────┘
```

### Key Design Decision: Execute Inside the Sandbox

The replay agent doesn't _simulate_ what the sandbox would do — it actually runs the operations inside a real sandbox. This means:

- **No sandbox model to maintain**: We don't need to reason about SBPL rules. The kernel enforces them.
- **Ground truth**: If a `Read` call returns EPERM, we know the policy blocks it. No false assumptions.
- **Same code path as real agents**: The replay agent is spawned via the same `SessionManager` → `buildSafehouseArgs()` → `safehouse` pipeline as Claude Code.

The tradeoff is speed (spawning a sandboxed process per session is slower than pure simulation), but correctness matters more for policy validation.

### Key Design Decision: Agent-Side Execution

Tool calls are executed by the replay agent process itself, not delegated back to the client via ACP's tool-call protocol. This is critical because:

- The agent process is the one inside the sandbox. If we delegated tool execution to the client (Electron main process), the operations would run unsandboxed.
- The echo agent already demonstrates this pattern: the agent process does the work and reports results via `sessionUpdate`.
- Claude Code also works this way — it executes tools internally and reports via ACP session updates.

### Key Design Decision: Prompt-Based Replay Sequence

Rather than building a custom protocol, the test harness sends the tool-call sequence as structured JSON in the ACP prompt text. The replay agent parses it and executes sequentially. This keeps the ACP interface standard — the harness is just a client sending prompts.

```
Harness → prompt({text: JSON.stringify(toolCalls)})
Agent   → executes each, emits sessionUpdate per call
Agent   → returns {stopReason: "end_turn"}
```

---

## Components

### 1. Replay Agent (`src/agents/replay-agent.ts`)

A new ACP agent, peer to `echo-agent.ts`. Implements the same `AgentSideConnection` interface.

**Prompt handler behavior**:

```typescript
async prompt(params) {
  const toolCalls: ReplayToolCall[] = JSON.parse(promptText);

  for (const call of toolCalls) {
    const result = await executeToolCall(call, context);

    // Report via ACP session update
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: call.id.toString(),
        _meta: { claudeCode: { toolName: call.tool } },
        title: `${call.tool}: ${summarizeInput(call)}`,
        status: "completed",
        rawOutput: JSON.stringify(result),
      },
    });
  }

  // Final summary
  await connection.sessionUpdate({
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify(summary) },
    },
  });

  return { stopReason: "end_turn" };
}
```

**`ReplayToolCall` type** (derived from dataset records):

```typescript
interface ReplayToolCall {
  id: number
  tool: string
  input: Record<string, unknown>
  original_outcome: string // from dataset: approved/rejected/error
}
```

**`ReplayResult` type**:

```typescript
interface ReplayResult {
  id: number
  tool: string
  replay_outcome: 'allowed' | 'blocked' | 'skipped' | 'error'
  error_message?: string // EPERM message, sandbox violation detail
  original_outcome: string // for comparison
}
```

**Tool execution strategy** — the replay agent maps each tool name to an actual operation:

| Tool           | Replay Action                                           | Can Be Blocked By Sandbox?                       |
| -------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `Read`         | `fs.readFile(path)`                                     | Yes — path outside sandbox boundary              |
| `Write`        | `fs.writeFile(path, placeholder)`                       | Yes — write to read-only or restricted path      |
| `Edit`         | `fs.readFile(path)` then `fs.writeFile(path, modified)` | Yes — same as Write                              |
| `Bash`         | `child_process.execSync(command)`                       | Yes — commands touching restricted paths/network |
| `Grep`         | `fs.readFile(path)` (simplified to read access check)   | Yes — path restrictions                          |
| `Glob`         | `fs.readdir(path)` (simplified to read access check)    | Yes — path restrictions                          |
| `WebFetch`     | `fetch(url)` or skip if network blocked                 | Yes — network-deny policy                        |
| `WebSearch`    | Skip (no local equivalent)                              | N/A                                              |
| `TodoWrite`    | No-op (in-memory only)                                  | No                                               |
| `Task`/`Agent` | Skip (subagent spawning)                                | N/A                                              |
| MCP tools      | Skip (no MCP servers in replay)                         | N/A                                              |

**Path de-anonymization**:

```typescript
function deanonymizePath(path: string, context: ReplayContext): string {
  return path
    .replace(/\{project\}/g, context.worktreePath)
    .replace(/\{home\}/g, os.homedir())
    .replace(/\{user\}/g, os.userInfo().username)
}
```

**Bash command handling**:

Bash commands require special care:

- De-anonymize paths in the command string
- Execute via `child_process.execSync` with a short timeout (5 seconds)
- Capture exit code and stderr
- EPERM or "Operation not permitted" in stderr → `blocked`
- Non-zero exit for other reasons → `error` (not a sandbox block)
- Commands referencing `{host}` (anonymized URLs) → `skipped` (can't replay network calls)

**Skipping rules**:

- Tool is `WebSearch`, `Task`, `Agent`, `TodoWrite`, `EnterPlanMode`, `ExitPlanMode`, `ToolSearch`, `Skill`, `AskUserQuestion`, or any MCP tool → `skipped`
- Bash command contains `{host}` → `skipped`
- Input references paths that can't be de-anonymized → `skipped`

### 2. Agent Type Registration

**Add `"replay"` to `AgentType`** (`src/main/types.ts`):

```typescript
export type AgentType = 'echo' | 'claude-code' | 'replay'
```

**Add `resolveReplayAgentCommand()`** to `session-manager.ts`, following the same pattern as `resolveEchoAgentCommand()`. The replay agent script path: `src/agents/replay-agent.ts` (dev) / `dist/agents/replay-agent.js` (prod).

### 3. Worktree Scaffolding (`src/main/replay-scaffold.ts`)

Before replaying a session, the worktree needs a minimal file structure so that `Read` and `Edit` calls don't fail for missing files (as opposed to being sandbox-blocked). The scaffolder:

1. **Scans the session's tool calls** for all referenced file paths
2. **Creates stub files** at those paths within the worktree:
   - For `Read`/`Grep`/`Glob` targets: create file with placeholder content (`// stub`)
   - For `Edit` targets: create file with the `old_string` content (so the edit can find it)
   - For `Write` targets: ensure parent directory exists (the write will create the file)
   - For `Bash` commands: parse for file paths and create stubs where identifiable
3. **Creates directory structure** to match the project layout implied by the paths

```typescript
interface ScaffoldPlan {
  files: Map<string, string> // relative path → content
  directories: Set<string> // relative paths to mkdir -p
}

function buildScaffoldPlan(toolCalls: ReplayToolCall[]): ScaffoldPlan
function applyScaffold(worktreePath: string, plan: ScaffoldPlan): Promise<void>
```

This is intentionally minimal — we're testing sandbox boundaries, not application correctness. The stub content doesn't matter as long as the file exists.

### 4. Test Harness (`scripts/replay-test.ts`)

CLI script that orchestrates batch replay. Not part of the Electron app — runs standalone via `tsx`.

**Usage**:

```bash
# Single session against a policy
npx tsx scripts/replay-test.ts \
  --policy standard-pr \
  --session session-042 \
  --project-dir /path/to/any/git/repo

# All sessions against all policies
npx tsx scripts/replay-test.ts \
  --policy all \
  --project-dir /path/to/any/git/repo \
  --output results/batch-$(date +%Y%m%d).json

# Subset of sessions
npx tsx scripts/replay-test.ts \
  --policy standard-pr \
  --sessions session-001,session-002,session-003 \
  --project-dir /path/to/any/git/repo
```

**Orchestration flow**:

```
for each session in dataset:
  1. Filter tool calls for this session, ordered by timestamp_relative
  2. Create a git worktree (via WorktreeManager)
  3. Build scaffold (stub files) in the worktree
  4. Resolve policy template → SandboxConfig
  5. Spawn replay agent inside sandbox (via safehouse)
  6. Send tool-call sequence as ACP prompt
  7. Collect ReplayResults from session updates
  8. Tear down worktree
  9. Append session results to report
```

**The harness reuses existing infrastructure**:

- `WorktreeManager` for worktree lifecycle
- `PolicyTemplateRegistry` for policy lookup
- `policyToSandboxConfig()` for sandbox config generation
- `buildSafehouseArgs()` for safehouse CLI construction
- ACP `ClientSideConnection` for agent communication

This means the test harness exercises the same code paths that a real Glitter Ball session would, minus the Electron/UI layer.

### 5. Report Format (`ReplayReport`)

```typescript
interface ReplayReport {
  metadata: {
    timestamp: string
    dataset: string
    policyId: string
    sessionsTotal: number
    sessionsCompleted: number
    sessionsFailed: number
  }
  summary: {
    totalToolCalls: number
    allowed: number
    blocked: number
    skipped: number
    error: number
    allowedRate: number // allowed / (allowed + blocked)
    falseBlockRate: number // blocked calls that were "approved" in original
  }
  byTool: Record<
    string,
    {
      total: number
      allowed: number
      blocked: number
      skipped: number
      error: number
    }
  >
  sessions: SessionReplayResult[]
}

interface SessionReplayResult {
  sessionId: string
  project: string
  toolCallCount: number
  results: ReplayResult[]
  scaffoldedFiles: number
  replayDurationMs: number
}
```

**Key metrics**:

- **Allowed rate**: `allowed / (allowed + blocked)` — what fraction of real-world operations does the policy permit?
- **False-block rate**: Among operations that were `approved` in the original session, what fraction does the policy block? This is the "permission fatigue" metric — a high false-block rate means the policy is too restrictive for real workflows.
- **Per-tool breakdown**: Which tools are most affected by each policy? (e.g., does `standard-pr` block a lot of `Bash` calls but allow all `Read` calls?)

### 6. UI Integration (Lightweight)

The replay agent should be selectable in the Glitter Ball UI as a third agent type. This is primarily for interactive debugging — the batch harness is the main workflow.

**Changes**:

- `NewSessionDialog`: Add "Replay" option to agent type selector
- When `replay` is selected, prompt for a session ID (text input) to replay
- Session manager loads that session's tool calls from the dataset and sends them as the first prompt
- Tool call events stream into the chat panel like any other agent's tool calls

This gives a visual way to watch a single session replay and see which operations hit sandbox blocks.

---

## Dataset Enrichment

The current dataset has anonymized paths but no session-level metadata. For realistic replay, we need to understand each session's project structure. Two approaches, in order of preference:

### Approach A: Infer Structure from Tool Calls (Preferred)

The tool calls themselves tell us what files the session touched. The scaffold step (Component 3) already extracts these paths. No dataset changes needed — the scaffolder builds the file structure on-the-fly from the session's own tool calls.

This is sufficient because:

- We're testing sandbox boundaries, not application behavior
- A `Read` to `{project}/src/index.ts` just needs that file to exist
- A `Bash` running `npm test` doesn't need real tests — it will succeed or fail based on sandbox permissions, not test correctness

### Approach B: Add Session Metadata (If Needed)

If Approach A proves insufficient (e.g., Bash commands that assume specific directory structures), we could add a `data/session-metadata.json`:

```json
{
  "session-001": {
    "project_type": "node", // inferred from tool calls (package.json present?)
    "estimated_file_count": 42,
    "tools_used": ["Read", "Bash", "Edit"],
    "has_network_calls": true
  }
}
```

We defer this until Approach A hits a wall.

---

## Iteration Plan

### Phase 1: Replay Agent

1. Implement `replay-agent.ts` with `Read`, `Write`, `Edit`, `Glob`, `Grep` support
2. Add `"replay"` agent type to session manager
3. Test with a single hand-crafted tool-call sequence (not from dataset)
4. Verify ACP session updates flow correctly to the client

### Phase 2: Path De-anonymization + Scaffolding

1. Implement `deanonymizePath()` with `{project}`, `{home}`, `{user}` substitution
2. Implement `buildScaffoldPlan()` — scan a session's tool calls for paths
3. Implement `applyScaffold()` — create stub files in worktree
4. Test with one real dataset session: scaffold → replay → verify files created

### Phase 3: Bash Command Replay

1. Add `Bash` tool execution to replay agent (with timeout and error capture)
2. Handle path de-anonymization within command strings
3. Handle `{host}` URLs → skip
4. Test with dataset sessions that include Bash calls
5. Tune timeout and skip heuristics based on failures

### Phase 4: Test Harness + Single-Policy Validation

1. Build `scripts/replay-test.ts` with single-session mode
2. Add batch mode (all sessions in dataset)
3. Run full batch against `standard-pr` policy
4. Generate first `ReplayReport` and analyze results
5. Identify false blocks and categorize: sandbox limitation vs. policy design issue

### Phase 5: Batch Validation Across Policies

1. Run full corpus against all three policies
2. Generate coverage matrix
3. Document findings: which policies are viable for which workflow types
4. Identify the policy gap — operations that no template handles well

### Phase 6: UI Integration

1. Add `"replay"` to agent type selector in `NewSessionDialog`
2. Add session ID input field (shown when replay is selected)
3. Wire up dataset loading in session manager
4. Test interactive single-session replay in the UI

---

## Risks and Open Questions

### Bash Command Fidelity

**Risk**: Bash commands from the dataset may reference tools, paths, or state that can't be reproduced in a scaffold worktree. Example: `git log --oneline` assumes a real git history; `npm test` assumes a real `package.json` with test scripts.

**Mitigation**: Accept that Bash replay will have a high `error` rate (command fails for non-sandbox reasons) and distinguish sandbox blocks (EPERM) from execution errors (non-zero exit). The `blocked` count is what matters for policy validation; `error` is noise we track but don't count against the policy.

### Replay Speed

**Risk**: Spawning a sandboxed process per session (296 sessions) could be slow. Safehouse startup is near-zero, but worktree creation and scaffold file creation add overhead.

**Mitigation**: Parallelize with a concurrency limit (e.g., 4 concurrent sessions). Each session is independent. Worktree creation is fast (`git worktree add` is sub-second). Scaffold file creation is filesystem I/O only. Target: full corpus against one policy in under 10 minutes.

### De-anonymization Ambiguity

**Risk**: Some anonymized paths may not de-anonymize cleanly. `{project-name}` in nested paths (like `.claude/projects/-Users-{user}-Code-{project-name}/...`) may not resolve to anything meaningful in the replay worktree.

**Mitigation**: These paths reference Claude Code's own internal state (session transcripts), not project files. They should be skipped — a real agent wouldn't read its own history files as part of a coding task. Add `.claude/` paths to the skip list.

### Network Operations in Standard-PR

**Risk**: The `standard-pr` policy declares `network: "none"` but enforcement is deferred to M6. Replay will show these operations as `allowed` even though the policy intends to block them.

**Mitigation**: Track network-dependent operations separately in the report. The scaffolder already skips `WebFetch`/`WebSearch`. For Bash commands like `curl`, `npm install`, or `git push`, tag them as `network_dependent` in the report so the M6 analysis can quantify the gap.

### Dataset Representativeness

**Risk**: The dataset comes from one developer's (David's) Claude Code usage. It may not represent the diversity of real-world agent workflows.

**Mitigation**: Acknowledged. The dataset is a starting point, not a benchmark. The replay infrastructure is reusable — as we collect more session data (potentially from other users), we can re-run the validation. The tooling is the deliverable; the first dataset is the validation.

---

## Dependencies

| Dependency                    | Status | Notes                                      |
| ----------------------------- | ------ | ------------------------------------------ |
| `@agentclientprotocol/sdk`    | Exists | Same ACP primitives used by echo agent     |
| `agent-safehouse`             | Exists | CLI must be installed on developer machine |
| `WorktreeManager`             | Exists | Reused from session manager                |
| `PolicyTemplateRegistry`      | Exists | Reused from M3                             |
| `policyToSandboxConfig()`     | Exists | Reused from M3                             |
| `data/tool-use-dataset.jsonl` | Exists | 11,491 records, 296 sessions               |
| Node.js `fs`, `child_process` | Stdlib | For tool execution in replay agent         |

No new external dependencies required.

## File Inventory

| File                                               | Type     | Description                                                 |
| -------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `src/agents/replay-agent.ts`                       | New      | ACP replay agent                                            |
| `src/main/replay-scaffold.ts`                      | New      | Worktree file scaffolding for replay sessions               |
| `scripts/replay-test.ts`                           | New      | CLI test harness for batch validation                       |
| `src/main/types.ts`                                | Modified | Add `"replay"` to `AgentType`, add replay-related types     |
| `src/main/session-manager.ts`                      | Modified | Add `resolveReplayAgentCommand()`, handle replay agent type |
| `src/renderer/src/components/NewSessionDialog.tsx` | Modified | Add replay agent option + session ID input                  |
