# Milestone 5: Application-Layer Policies — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequenced implementation steps. Each phase produces a testable increment. Steps reference specific source files and existing code structures to enable implementation by an agent or developer with minimal ambiguity.

## Progress

- [x] **[Phase 1: Policy Types and GitHub Remote Detection](#phase-1-policy-types-and-github-remote-detection)**
  - [x] 1.1 Add `GitHubPolicy` and `PolicyEvent` types
  - [x] 1.2 Create `github-policy.ts`
  - [x] 1.3 Update `standard-pr` template
  - [x] 1.4 Write a test script for remote detection
- [x] **[Phase 2: `gh` Shim — Core](#phase-2-gh-shim--core)**
  - [x] 2.1 Create the shim entry point
  - [x] 2.2 Implement the subcommand parser
  - [x] 2.3 Implement policy evaluation
  - [x] 2.4 Implement `gh api` endpoint matching
  - [x] 2.5 Implement the main entry point
  - [x] 2.6 Build script for standalone shim
  - [x] 2.7 Write shim unit tests
- [x] **[Phase 3: Git Hooks](#phase-3-git-hooks)**
  - [x] 3.1 Create `hooks.ts`
  - [x] 3.2 Write hook tests
- [x] **[Phase 4: Session Manager Integration](#phase-4-session-manager-integration)**
  - [x] 4.1 Update `SessionState`
  - [x] 4.2 Integrate into `createSession`
  - [x] 4.3 Set up shim PATH and environment
  - [x] 4.4 Update `resolveAgentCommand` for PATH
  - [x] 4.5 Update `closeSession` for cleanup
  - [x] 4.6 Update `summarize` for new `SessionSummary` fields
  - [x] 4.7 Update `cleanupOrphans`
  - [x] 4.8 Update IPC and preload
  - [x] 4.9 Integration test
- [x] **[Phase 5: Observability — Stderr Parsing and Policy Events](#phase-5-observability--stderr-parsing-and-policy-events)**
  - [x] 5.1 Add stderr log parser
  - [x] 5.2 Integrate into stderr capture
  - [x] 5.3 Update the `gh` shim to emit structured log lines
  - [x] 5.4 Update the pre-push hook to emit structured log lines
  - [x] 5.5 Test the parser
- [x] **[Phase 6: UI Updates](#phase-6-ui-updates)**
  - [x] 6.1 Handle `policy-event` in `App.tsx`
  - [x] 6.2 Extend `SandboxLog` component
  - [x] 6.3 Show GitHub session info in the session list
  - [x] 6.4 Visual verification
- [ ] **[Phase 7: End-to-End Validation](#phase-7-end-to-end-validation)**
  - [ ] 7.1 Create a test repository
  - [ ] 7.2 Manual end-to-end test
  - [ ] 7.3 Test git hook enforcement
  - [x] 7.4 Document findings

## Prerequisites

- Milestone 4 complete (current state)
- `gh` CLI installed and authenticated (`gh auth status` succeeds)
- Familiarity with the [design doc](design.md) and [M5 design investigation](../../reference/m5-app-layer-design.md)

---

## Phase 1: Policy Types and GitHub Remote Detection

**Goal**: Define the `GitHubPolicy` type, detect the GitHub remote from a worktree, and manage the policy state file. No enforcement yet — just the data model and plumbing.

### Step 1.1: Add `GitHubPolicy` and `PolicyEvent` types

**File**: `src/main/types.ts`

Add to the existing type definitions:

```typescript
/** GitHub-specific application-layer policy for a session (M5). */
export interface GitHubPolicy {
  repo: string;
  allowedPushRefs: string[];
  ownedPrNumber: number | null;
  canCreatePr: boolean;
}

/** Logged when the gh shim or git hook allows/denies an operation. */
export interface PolicyEvent {
  timestamp: number;
  tool: "gh" | "git";
  operation: string;
  decision: "allow" | "deny";
  reason?: string;
}
```

Update `PolicyTemplate` — add an optional `github` field:

```typescript
export interface PolicyTemplate {
  // ... existing fields ...
  github?: GitHubPolicy;
}
```

Update `SessionSummary` — add GitHub session info:

```typescript
export interface SessionSummary {
  // ... existing fields ...
  githubRepo: string | null;
  ownedPrNumber: number | null;
}
```

Update `SessionUpdate` — add the `policy-event` variant:

```typescript
export type SessionUpdate =
  // ... existing variants ...
  | { sessionId: string; type: "policy-event"; event: PolicyEvent };
```

**Verify**: `npm run typecheck` passes.

### Step 1.2: Create `github-policy.ts`

**New file**: `src/main/github-policy.ts`

This module handles GitHub remote detection and policy state file I/O.

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { POLICY_DIR } from "./sandbox.js";
import type { GitHubPolicy } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Detect the GitHub "owner/repo" from the git remote in a directory.
 * Parses the origin remote URL (HTTPS or SSH format).
 * Returns null if no GitHub remote is found.
 */
export async function detectGitHubRepo(cwd: string): Promise<string | null>

/**
 * Build a GitHubPolicy for a new session.
 */
export function buildSessionPolicy(repo: string, branch: string): GitHubPolicy

/**
 * Path to the policy state file for a session.
 */
export function policyStatePath(sessionId: string): string

/**
 * Write the policy state file. Called at session creation and
 * updated by the gh shim after PR creation.
 */
export async function writePolicyState(sessionId: string, policy: GitHubPolicy): Promise<void>

/**
 * Read the policy state file. Called by the gh shim on each invocation.
 */
export async function readPolicyState(path: string): Promise<GitHubPolicy>

/**
 * Clean up the policy state file for a session.
 */
export async function cleanupPolicyState(sessionId: string): Promise<void>
```

Implementation notes:
- `detectGitHubRepo`: run `git -C <cwd> remote get-url origin`, parse the URL. Handle both `https://github.com/owner/repo.git` and `git@github.com:owner/repo.git` formats. Strip trailing `.git`. Return `null` if the remote doesn't match GitHub.
- `buildSessionPolicy`: returns `{ repo, allowedPushRefs: [branch], ownedPrNumber: null, canCreatePr: true }`.
- `policyStatePath`: returns `join(POLICY_DIR, \`${sessionId}-github-policy.json\`)`.
- File I/O: JSON serialize/deserialize the `GitHubPolicy` interface.

### Step 1.3: Update `standard-pr` template

**File**: `src/main/policy-templates.ts`

Add the `github` field to `standardPrTemplate`:

```typescript
export const standardPrTemplate: PolicyTemplate = {
  // ... existing fields ...
  github: {
    repo: "",              // Populated per-session
    allowedPushRefs: [],   // Populated per-session
    ownedPrNumber: null,
    canCreatePr: true,
  },
};
```

The other two templates (`research-only`, `permissive`) remain unchanged — no `github` field means no application-layer policy.

**Verify**: `npm run typecheck` passes.

### Step 1.4: Write a test script for remote detection

**New file**: `scripts/test-github-policy.ts`

A standalone test script (consistent with the project's existing `scripts/test-*.ts` pattern) that:
1. Calls `detectGitHubRepo` on the Bouncer repo itself (should return `dherman/bouncer` or similar)
2. Tests URL parsing for HTTPS, SSH, and non-GitHub remotes
3. Tests `buildSessionPolicy` output
4. Tests write → read round-trip for the policy state file
5. Tests `cleanupPolicyState`

Add to `package.json` scripts: `"test:github-policy": "tsx scripts/test-github-policy.ts"`.

**Verify**: `npm run test:github-policy` passes.

---

## Phase 2: `gh` Shim — Core

**Goal**: A working `gh` shim that reads the policy state file, parses `gh` subcommands, and enforces allow/deny decisions. Not yet integrated into sessions — tested standalone.

### Step 2.1: Create the shim entry point

**New file**: `src/main/gh-shim.ts`

This file is both the shim logic (importable for testing) and the standalone entry point (invoked as `node gh-shim.js <args>`). Structure:

```typescript
#!/usr/bin/env node

/**
 * Bouncer gh shim — policy-aware wrapper for the GitHub CLI.
 *
 * Environment:
 *   BOUNCER_GITHUB_POLICY — path to the policy state JSON file
 *   BOUNCER_REAL_GH       — path to the real gh binary
 *
 * Reads policy, parses gh subcommand, evaluates against policy,
 * then either execs real gh or exits with a policy error.
 */

// --- Subcommand Parser ---

export interface ParsedGhCommand {
  command: string;
  subcommand: string | null;
  positionalArgs: string[];
  flags: {
    repo?: string;
    method?: string;
  };
  /** The raw args to forward to real gh (everything after "gh"). */
  rawArgs: string[];
}

/**
 * Parse gh CLI arguments into a structured command.
 * Only extracts policy-relevant information; all other flags pass through.
 */
export function parseGhArgs(args: string[]): ParsedGhCommand

// --- Policy Evaluation ---

export type PolicyDecision =
  | { action: "allow" }
  | { action: "allow-and-capture-pr" }
  | { action: "deny"; reason: string };

/**
 * Evaluate a parsed gh command against the session policy.
 */
export function evaluatePolicy(
  parsed: ParsedGhCommand,
  policy: GitHubPolicy,
): PolicyDecision

// --- Main (standalone entry point) ---

async function main(): Promise<void>
```

### Step 2.2: Implement the subcommand parser

**File**: `src/main/gh-shim.ts` — the `parseGhArgs` function.

The parser processes `argv` (everything after the shim's own invocation, i.e., what would follow `gh`):

1. Skip any global flags that appear before the command (`--help`, `--version`)
2. First non-flag argument is the `command` (e.g., `pr`, `issue`, `api`)
3. For commands that have subcommands (`pr`, `issue`, `repo`, `release`, `run`, `workflow`, `gist`), the next non-flag argument is the `subcommand`
4. Remaining non-flag arguments are `positionalArgs`
5. Extract `-R` / `--repo` flag value if present
6. For `api` command: extract `--method` / `-X` flag value; detect `-f` / `-F` / `--field` / `--raw-field` presence (implies POST)

Edge cases to handle:
- `gh pr view` (no positional args — operates on current branch's PR)
- `gh pr view 42` (PR number as positional arg)
- `gh pr create --title "foo" --body "bar"` (flags interspersed)
- `gh api /repos/owner/repo/pulls --method GET` (api with explicit method)
- `gh api graphql -f query='...'` (GraphQL)
- `gh --help` (global flag, no command)
- `gh pr --help` (help for a command)

### Step 2.3: Implement policy evaluation

**File**: `src/main/gh-shim.ts` — the `evaluatePolicy` function.

Implements the [subcommand policy table](design.md#subcommand-policy-table) from the design doc. The function is a series of match clauses:

```typescript
export function evaluatePolicy(
  parsed: ParsedGhCommand,
  policy: GitHubPolicy,
): PolicyDecision {
  const { command, subcommand, positionalArgs } = parsed;

  // Global help/version — always allow
  if (command === "--help" || command === "--version") {
    return { action: "allow" };
  }

  switch (command) {
    case "pr":
      return evaluatePrPolicy(subcommand, positionalArgs, parsed.flags, policy);
    case "issue":
      return evaluateIssuePolicy(subcommand);
    case "api":
      return evaluateApiPolicy(positionalArgs, parsed.flags, policy);
    // ... other commands ...
    default:
      return { action: "deny", reason: `command '${command}' is not allowed` };
  }
}
```

Key helper: `extractTargetPrNumber(positionalArgs, policy)` — returns the PR number being targeted. If no positional arg, assumes current branch's PR (which is the session's own PR). If a number is given, check it against `policy.ownedPrNumber`.

### Step 2.4: Implement `gh api` endpoint matching

**File**: `src/main/gh-shim.ts` — within the `evaluateApiPolicy` function.

Parse the endpoint argument and match against the REST API patterns from the design doc:

```typescript
interface ApiEndpointMatch {
  /** The resource type (e.g., "pulls", "issues"). */
  resource: string;
  /** HTTP method. */
  method: string;
  /** Extracted owner/repo from the path, if present. */
  ownerRepo: string | null;
  /** Extracted resource number (PR or issue number), if present. */
  number: number | null;
  /** Whether this is a sub-resource (e.g., /pulls/42/merge). */
  subResource: string | null;
  /** Whether this is the GraphQL endpoint. */
  isGraphQL: boolean;
}
```

The endpoint parser handles:
- Absolute paths: `/repos/owner/repo/pulls/42`
- Placeholder paths: `/repos/{owner}/{repo}/pulls` (gh expands `{owner}` and `{repo}`)
- The `graphql` shorthand

GraphQL: allow with an "unaudited" log warning (per design doc decision).

### Step 2.5: Implement the main entry point

**File**: `src/main/gh-shim.ts` — the `main` function.

```
1. Read BOUNCER_GITHUB_POLICY and BOUNCER_REAL_GH from environment
2. If either is missing, print error and exit 1
3. Read policy state from BOUNCER_GITHUB_POLICY
4. Parse process.argv.slice(2) via parseGhArgs()
5. Evaluate policy via evaluatePolicy()
6. Log the decision to stderr in [bouncer:gh] format
7. If deny: print error message, exit 1
8. If allow-and-capture-pr:
   a. Spawn real gh with the original args, capturing stdout
   b. If exit code 0, parse PR number from stdout (gh pr create prints the PR URL)
   c. Update policy state file: set ownedPrNumber, set canCreatePr to false
   d. Write captured stdout to process.stdout
   e. Exit with gh's exit code
9. If allow:
   a. execFileSync (or spawn) real gh with the original args, inheriting stdio
   b. Exit with gh's exit code
```

PR number capture from `gh pr create` output: `gh pr create` prints a URL like `https://github.com/owner/repo/pull/42`. Parse the trailing number.

### Step 2.6: Build script for standalone shim

The shim needs to run as a standalone Node.js script outside the Electron context. Since the project uses electron-vite (Vite/Rollup), add a small build step.

**Option A**: Use `tsx` at runtime (simpler, already a dev dependency):
- The shim wrapper script is a shell script:
  ```bash
  #!/bin/bash
  exec node --import tsx/esm /path/to/gh-shim.ts "$@"
  ```
- Pro: no build step. Con: slower startup (~100ms for tsx), and tsx must be accessible in the sandbox.

**Option B**: Bundle with esbuild (add as dev dependency):
- `npm install -D esbuild`
- Add `scripts/build-gh-shim.ts` that calls esbuild to produce `out/gh-shim.js`
- The wrapper script: `#!/bin/bash\nexec node /path/to/out/gh-shim.js "$@"`
- Pro: fast startup, self-contained. Con: additional build step and dependency.

**Recommendation**: Option A for initial development (faster iteration), migrate to Option B before M5 is complete (better startup performance in production). The plan proceeds with Option A.

**New file**: `src/main/gh-shim-wrapper.sh` — a template that the Session Manager writes to the bin directory with paths filled in:

```bash
#!/bin/bash
# Bouncer gh shim — delegates to gh-shim.ts with policy enforcement
exec "__NODE__" --import tsx/esm "__GH_SHIM_TS__" "$@"
```

The Session Manager replaces `__NODE__` and `__GH_SHIM_TS__` with actual paths at session creation time.

### Step 2.7: Write shim unit tests

**New file**: `scripts/test-gh-shim.ts`

Test the exported functions (`parseGhArgs`, `evaluatePolicy`) directly — no subprocess needed.

**Parser tests:**
- `["pr", "create", "--title", "foo"]` → `{ command: "pr", subcommand: "create", ... }`
- `["pr", "view", "42"]` → positionalArgs includes `"42"`
- `["pr", "edit", "--title", "new", "42"]` → positional `"42"` extracted despite flags
- `["-R", "other/repo", "pr", "list"]` → `flags.repo === "other/repo"`
- `["api", "/repos/{owner}/{repo}/pulls", "--method", "GET"]` → `flags.method === "GET"`
- `["api", "graphql", "-f", "query=..."]` → positional `"graphql"`, method inferred POST
- `["--help"]` → `command === "--help"`
- `["pr", "--help"]` → `command === "pr"`, subcommand === "--help"` (pass through to real gh)

**Policy evaluation tests** — for each row in the subcommand policy table, one test case:
- `pr create` with `canCreatePr: true` → `allow-and-capture-pr`
- `pr create` with `canCreatePr: false` → `deny`
- `pr edit 42` with `ownedPrNumber: 42` → `allow`
- `pr edit 99` with `ownedPrNumber: 42` → `deny`
- `pr edit` (no number, implies current branch) → `allow`
- `pr view 99` → `allow` (read-only, any PR)
- `pr merge 42` → `deny`
- `pr close 42` → `deny`
- `issue view 10` → `allow`
- `issue create` → `deny`
- `api /repos/o/r/pulls GET` → `allow`
- `api /repos/o/r/pulls POST` with `canCreatePr: true` → `allow`
- `api /repos/o/r/pulls/42/merge PUT` → `deny`
- `api graphql` → `allow` (with warning)
- `auth login` → `deny`
- `gist create` → `deny`

Add to `package.json` scripts: `"test:gh-shim": "tsx scripts/test-gh-shim.ts"`.

**Verify**: `npm run test:gh-shim` passes.

---

## Phase 3: Git Hooks

**Goal**: A `pre-push` hook that restricts pushes to allowed refs, with installation and cleanup integrated into the session lifecycle.

### Step 3.1: Create `hooks.ts`

**New file**: `src/main/hooks.ts`

```typescript
import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { POLICY_DIR } from "./sandbox.js";

const execFileAsync = promisify(execFile);

/**
 * Path to the hooks directory for a session.
 */
export function hooksDir(sessionId: string): string

/**
 * Install the pre-push hook for a session.
 * Creates the hooks directory, writes the hook script,
 * and sets core.hooksPath in the worktree's git config.
 */
export async function installHooks(
  sessionId: string,
  worktreePath: string,
  policyFilePath: string,
): Promise<void>

/**
 * Remove the hooks directory and unset core.hooksPath.
 */
export async function cleanupHooks(
  sessionId: string,
  worktreePath: string,
): Promise<void>
```

Implementation notes:
- `hooksDir`: returns `join(POLICY_DIR, \`${sessionId}-hooks\`)`.
- `installHooks`:
  1. `mkdir` the hooks directory
  2. Write the `pre-push` script (from design doc), replacing `__BOUNCER_POLICY_FILE__` with `policyFilePath`
  3. `chmod(hookPath, 0o755)`
  4. `execFileAsync("git", ["-C", worktreePath, "config", "core.hooksPath", hooksDir(sessionId)])`
- `cleanupHooks`:
  1. `execFileAsync("git", ["-C", worktreePath, "config", "--unset", "core.hooksPath"])` (catch errors — worktree may already be gone)
  2. `rm(hooksDir(sessionId), { recursive: true, force: true })`

**Design note on the pre-push hook**: The design doc uses `python3` to parse JSON. For robustness (python3 may not be available in all environments), replace with a `node -e` one-liner or inline JSON parsing in bash via basic string manipulation. Since the policy file has a predictable format, a simpler approach:

```bash
# Extract allowedPushRefs using node (available since we're in a Node.js agent context)
ALLOWED_REFS=$(node -e "
  const p = require('$POLICY_FILE');
  p.allowedPushRefs.forEach(r => console.log(r));
")
```

Or even simpler, since the allowed refs are just branch names — write them to a plain text file (one per line) alongside the JSON, and have the hook read that. This avoids any JSON parsing dependency in the hook. The Session Manager writes both files.

**Recommendation**: Write a companion file `{sessionId}-allowed-refs.txt` with one ref per line. The hook reads it with a simple `cat`. This is more robust than any JSON parsing in bash.

### Step 3.2: Write hook tests

**New file**: `scripts/test-hooks.ts`

1. Create a temporary git repo
2. Create a worktree in it
3. Call `installHooks` with a test policy
4. Verify the hook file exists and is executable
5. Verify `core.hooksPath` is set correctly in the worktree config
6. Simulate a push to an allowed ref (should succeed — run `git push --dry-run` or test the hook script directly)
7. Simulate a push to a denied ref (should fail)
8. Call `cleanupHooks`, verify the directory is removed and `core.hooksPath` is unset

Add to `package.json` scripts: `"test:hooks": "tsx scripts/test-hooks.ts"`.

**Verify**: `npm run test:hooks` passes.

---

## Phase 4: Session Manager Integration

**Goal**: Wire the policy state file, `gh` shim, and git hooks into the session creation/teardown lifecycle. After this phase, creating a `standard-pr` session installs the full application-layer policy.

### Step 4.1: Update `SessionState`

**File**: `src/main/session-manager.ts`

Add to the `SessionState` interface (line ~138):

```typescript
interface SessionState {
  // ... existing fields ...
  githubPolicy: GitHubPolicy | null;
}
```

Initialize as `null` in `createSession`.

### Step 4.2: Integrate into `createSession`

**File**: `src/main/session-manager.ts` — the `createSession` method.

After the worktree is created and the policy template is resolved (current lines ~180-254), add the application-layer policy setup. Insert after `session.sandboxConfig = sandboxConfig` and before the agent command resolution:

```typescript
// --- Application-layer policy (M5) ---
let githubPolicy: GitHubPolicy | null = null;
if (template?.github && worktree) {
  const repo = await detectGitHubRepo(workingDir);
  if (repo) {
    githubPolicy = buildSessionPolicy(repo, worktree.branch);
    await writePolicyState(id, githubPolicy);
    await installHooks(id, workingDir, policyStatePath(id));
  } else {
    console.warn("No GitHub remote detected — skipping application-layer policy");
  }
}
session.githubPolicy = githubPolicy;
```

### Step 4.3: Set up shim PATH and environment

**File**: `src/main/session-manager.ts` — within `createSession`, before the `spawn` call.

```typescript
// Install gh shim if GitHub policy is active
let shimEnv: Record<string, string> = {};
if (githubPolicy) {
  const shimBinDir = await installGhShim(id);
  const realGhPath = await findRealGh();
  shimEnv = {
    BOUNCER_GITHUB_POLICY: policyStatePath(id),
    BOUNCER_REAL_GH: realGhPath,
  };
  // Prepend shim bin dir to PATH
  shimEnv.PATH = `${shimBinDir}:${process.env.PATH ?? ""}`;
}
```

This requires two new helper functions (can live in `github-policy.ts` or a new `gh-shim-install.ts`):

- `installGhShim(sessionId)`: creates `{POLICY_DIR}/bin-{sessionId}/gh` (the wrapper shell script), returns the directory path
- `findRealGh()`: runs `which gh` and caches the result (similar to `isSafehouseAvailable()`)

Update the `spawn` call to merge `shimEnv`:

```typescript
const agentProcess = spawn(cmd, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...env, ...shimEnv },
  cwd,
});
```

### Step 4.4: Update `resolveAgentCommand` for PATH

The existing `resolveAgentCommand` returns a `SpawnConfig` with an `env` field. The shim's `PATH` override and `BOUNCER_*` vars need to flow through. Two options:

**Option A**: Merge `shimEnv` into the `SpawnConfig.env` returned by `resolveAgentCommand`. This is cleaner — the env flows naturally.

**Option B**: Merge at the `spawn` call site (shown in Step 4.3).

**Recommendation**: Option B is simpler and avoids changing `resolveAgentCommand`'s signature. The shim env is a session-level concern, not an agent-type concern.

### Step 4.5: Update `closeSession` for cleanup

**File**: `src/main/session-manager.ts` — the `closeSession` method (line ~519).

Add cleanup before the existing worktree removal:

```typescript
// Clean up application-layer policy artifacts
if (session.githubPolicy && session.worktree) {
  await cleanupHooks(sessionId, session.worktree.path).catch((err) =>
    console.warn(`Failed to clean up hooks for session ${sessionId}:`, err)
  );
}
if (session.githubPolicy) {
  await cleanupPolicyState(sessionId).catch((err) =>
    console.warn(`Failed to clean up policy state for session ${sessionId}:`, err)
  );
  await cleanupGhShim(sessionId).catch((err) =>
    console.warn(`Failed to clean up gh shim for session ${sessionId}:`, err)
  );
}
```

Where `cleanupGhShim(sessionId)` removes the `{POLICY_DIR}/bin-{sessionId}/` directory.

### Step 4.6: Update `summarize` for new `SessionSummary` fields

**File**: `src/main/session-manager.ts` — the `summarize` method (line ~574).

```typescript
private summarize(session: SessionState): SessionSummary {
  // ... existing code ...
  return {
    // ... existing fields ...
    githubRepo: session.githubPolicy?.repo ?? null,
    ownedPrNumber: session.githubPolicy?.ownedPrNumber ?? null,
  };
}
```

### Step 4.7: Update `cleanupOrphans`

**File**: `src/main/session-manager.ts` — the `cleanupOrphans` method (line ~562).

Add cleanup for orphan GitHub policy artifacts (hooks dirs, policy state files, shim bin dirs) in `/tmp/glitterball-sandbox/`. Pattern: scan for `*-github-policy.json`, `*-hooks/`, and `bin-*/` entries, extract session IDs, remove if not in `activeIds`.

This can be a new function `cleanupOrphanGitHubPolicy(activeIds)` in `github-policy.ts`, called alongside the existing `cleanupOrphanPolicies`.

### Step 4.8: Update IPC and preload

**File**: `src/main/index.ts` — no new IPC handlers needed for Phase 4. The existing `sessions:create` returns `SessionSummary`, which now includes the new fields.

**File**: `src/preload/index.ts` — verify the preload bridge passes through the new `SessionSummary` fields and the new `policy-event` update type. Since the preload uses generic IPC forwarding, this should work without changes, but verify.

### Step 4.9: Integration test

**New file**: `scripts/test-app-layer-policy.ts`

An integration test that exercises the full lifecycle without Electron:

1. Import `SessionManager` (requires mocking the Electron `app` object — follow the pattern from existing test scripts)
2. Create a session with `standard-pr` policy against a git repo with a GitHub remote
3. Verify:
   - Policy state file exists at the expected path
   - `gh` shim wrapper exists and is executable
   - Git hooks are installed (`core.hooksPath` is set)
   - `BOUNCER_GITHUB_POLICY` would be set in the env
4. Close the session
5. Verify all artifacts are cleaned up

Add to `package.json` scripts: `"test:app-layer-policy": "tsx scripts/test-app-layer-policy.ts"`.

**Verify**: `npm run test:app-layer-policy` passes.

---

## Phase 5: Observability — Stderr Parsing and Policy Events

**Goal**: The Session Manager parses `[bouncer:gh]` and `[bouncer:git]` log lines from the agent's stderr, converts them to `PolicyEvent` objects, and emits them to the renderer.

### Step 5.1: Add stderr log parser

**New file**: `src/main/policy-event-parser.ts`

```typescript
import type { PolicyEvent } from "./types.js";

/**
 * Attempt to parse a stderr line as a Bouncer policy event.
 * Returns null if the line is not a policy event.
 *
 * Expected format:
 *   [bouncer:gh] ALLOW pr create --title "foo"
 *   [bouncer:gh] DENY pr merge 15 — reason text
 *   [bouncer:git] DENY push to refs/heads/main — reason text
 *   [bouncer:git] ALLOW push to refs/heads/bouncer/abc123
 */
export function parsePolicyEvent(line: string): PolicyEvent | null
```

### Step 5.2: Integrate into stderr capture

**File**: `src/main/session-manager.ts` — the stderr `data` handler (line ~271).

Currently:
```typescript
agentProcess.stderr?.on("data", (data: Buffer) => {
  collectedStderr += data.toString();
  process.stderr.write(data);
});
```

Add line-by-line parsing:

```typescript
let stderrBuffer = "";
agentProcess.stderr?.on("data", (data: Buffer) => {
  const chunk = data.toString();
  collectedStderr += chunk;
  process.stderr.write(data);

  // Parse policy events from complete lines
  stderrBuffer += chunk;
  const lines = stderrBuffer.split("\n");
  stderrBuffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
  for (const line of lines) {
    const event = parsePolicyEvent(line);
    if (event) {
      this.emit("session-update", {
        sessionId: id,
        type: "policy-event",
        event,
      });
    }
  }
});
```

### Step 5.3: Update the `gh` shim to emit structured log lines

**File**: `src/main/gh-shim.ts` — the `main` function.

After evaluating the policy, write to stderr:

```typescript
function logDecision(parsed: ParsedGhCommand, decision: PolicyDecision): void {
  const op = [parsed.command, parsed.subcommand, ...parsed.positionalArgs]
    .filter(Boolean)
    .join(" ");
  if (decision.action === "deny") {
    process.stderr.write(`[bouncer:gh] DENY ${op} — ${decision.reason}\n`);
  } else {
    process.stderr.write(`[bouncer:gh] ALLOW ${op}\n`);
  }
}
```

### Step 5.4: Update the pre-push hook to emit structured log lines

**File**: `src/main/hooks.ts` — in the hook template.

Add `[bouncer:git]` prefixed output to stderr on allow and deny:

```bash
if [ "$allowed" = false ]; then
  echo "[bouncer:git] DENY push to $remote_branch — ref not in allowed list" >&2
  exit 1
fi
echo "[bouncer:git] ALLOW push to $remote_branch" >&2
```

### Step 5.5: Test the parser

Add parser tests to `scripts/test-gh-shim.ts` (or a new `scripts/test-policy-event-parser.ts`):

- `[bouncer:gh] ALLOW pr create --title "foo"` → `{ tool: "gh", operation: "pr create --title \"foo\"", decision: "allow" }`
- `[bouncer:gh] DENY pr merge 15 — merging pull requests is not allowed` → `{ tool: "gh", decision: "deny", reason: "merging pull requests is not allowed" }`
- `[bouncer:git] DENY push to refs/heads/main — ref not in allowed list` → `{ tool: "git", decision: "deny" }`
- `some random stderr line` → `null`

**Verify**: Tests pass.

---

## Phase 6: UI Updates

**Goal**: Show policy events in the UI alongside sandbox violations.

### Step 6.1: Handle `policy-event` in `App.tsx`

**File**: `src/renderer/src/App.tsx`

Add state for policy events (alongside the existing `violationsBySession`):

```typescript
const [policyEventsBySession, setPolicyEventsBySession] =
  useState<Map<string, PolicyEvent[]>>(new Map());
```

Add a case in `handleUpdate`:

```typescript
case 'policy-event':
  setPolicyEventsBySession((prev) => {
    const next = new Map(prev);
    const existing = next.get(update.sessionId) ?? [];
    const updated = [...existing, update.event].slice(-200);
    next.set(update.sessionId, updated);
    return next;
  });
  break;
```

Pass `policyEvents` to the relevant component (Step 6.2).

### Step 6.2: Extend `SandboxLog` component

**File**: `src/renderer/src/components/SandboxLog.tsx`

Rename to `PolicyLog` (or keep the name and extend it). Accept both violations and policy events:

```typescript
interface Props {
  violations: SandboxViolationInfo[];
  policyEvents: PolicyEvent[];
}
```

Merge and sort both lists by timestamp. Render with visual differentiation:
- Policy allow events: green check mark or similar
- Policy deny events: red X
- Sandbox violations: existing shield icon

Update the header text: "Policy & sandbox events (N)" instead of "Sandbox violations (N)".

### Step 6.3: Show GitHub session info in the session list

**File**: `src/renderer/src/components/SessionList.tsx`

If `session.githubRepo` is set, show it under the session entry (e.g., "dherman/bouncer • PR #42" or "dherman/bouncer • creating PR"). Subtle visual indication that application-layer policy is active.

### Step 6.4: Visual verification

Run the Electron app (`npm run dev`), create a `standard-pr` session against a repo with a GitHub remote, and verify:
- The session shows the GitHub repo name
- Policy events appear when the agent runs `gh` commands
- Denied operations show a clear reason

---

## Phase 7: End-to-End Validation

**Goal**: Validate the complete system with a real Claude Code session.

### Step 7.1: Create a test repository

Create a disposable test repo on GitHub (e.g., `dherman/bouncer-sandbox-test`) with a simple codebase. This gives a safe target for testing PR creation, pushing, and verifying that destructive operations are blocked.

### Step 7.2: Manual end-to-end test

1. Start Glitter Ball (`npm run dev`)
2. Create a new `standard-pr` session pointing at the test repo
3. Ask the agent to: "Create a new file called hello.txt with the content 'Hello from Bouncer' and open a PR for it"
4. Verify:
   - Agent can commit and push to the session branch
   - Agent can create a PR (`gh pr create` succeeds)
   - Policy event log shows ALLOW entries
5. Ask the agent to: "Merge the PR" or "Close PR #1"
6. Verify:
   - `gh pr merge` / `gh pr close` is denied by the shim
   - Policy event log shows DENY entry with reason
   - Agent sees the error message and understands it can't do this

### Step 7.3: Test git hook enforcement

1. In the same session, ask the agent to: "Push this change to the main branch"
2. Verify:
   - `git push origin main` is denied by the pre-push hook
   - Agent sees the `[bouncer:git] DENY` error

### Step 7.4: Document findings

Write results and any issues discovered to `docs/milestones/application-layer-policies/findings.md` (following the pattern from earlier milestones if one exists). Note:
- Any `gh` subcommands the agent tried that weren't in the policy table
- Any false denials (legitimate operations incorrectly blocked)
- UX quality of the error messages — did the agent understand and adapt?
- Performance impact of the shim (latency added to `gh` commands)

---

## Summary of New and Modified Files

### New Files

| File | Purpose |
|---|---|
| `src/main/github-policy.ts` | GitHubPolicy logic, remote detection, state file I/O |
| `src/main/gh-shim.ts` | `gh` shim: parser, policy engine, entry point |
| `src/main/gh-shim-wrapper.sh` | Shell wrapper template for the shim |
| `src/main/hooks.ts` | Git hook installation and cleanup |
| `src/main/policy-event-parser.ts` | Stderr log line → PolicyEvent parser |
| `scripts/test-github-policy.ts` | Tests for remote detection, policy state I/O |
| `scripts/test-gh-shim.ts` | Tests for parser, policy evaluation, API matching |
| `scripts/test-hooks.ts` | Tests for hook installation and ref enforcement |
| `scripts/test-app-layer-policy.ts` | Integration test for full session lifecycle |

### Modified Files

| File | Changes |
|---|---|
| `src/main/types.ts` | Add `GitHubPolicy`, `PolicyEvent`, update `PolicyTemplate`, `SessionSummary`, `SessionUpdate` |
| `src/main/policy-templates.ts` | Add `github` field to `standard-pr` template |
| `src/main/session-manager.ts` | GitHub policy setup in `createSession`, cleanup in `closeSession`, stderr parsing, `SessionState` extension, `summarize` update |
| `src/main/index.ts` | No changes expected (IPC passes through generically) |
| `src/renderer/src/App.tsx` | Handle `policy-event` updates, pass to `SandboxLog` |
| `src/renderer/src/components/SandboxLog.tsx` | Accept and display policy events alongside violations |
| `src/renderer/src/components/SessionList.tsx` | Show GitHub repo and PR number |
| `package.json` | New test scripts |

### Not Modified

| File | Reason |
|---|---|
| `src/main/sandbox.ts` | Safehouse integration unchanged |
| `src/main/policy-sandbox.ts` | `policyToSandboxConfig` unchanged (GitHub policy is orthogonal to Seatbelt config) |
| `src/main/policy-registry.ts` | Registry logic unchanged (templates still registered the same way) |
| `src/main/worktree-manager.ts` | Worktree creation unchanged |
| `src/main/sandbox-monitor.ts` | Seatbelt monitoring unchanged |
| `src/agents/replay-agent.ts` | Replay agent unchanged (doesn't interact with gh/git in ways that need policy) |
| `src/preload/index.ts` | Generic IPC bridge, no changes needed |
