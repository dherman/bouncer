# Milestone 5: Application-Layer Policies — Design

## Overview

This milestone adds application-layer policy enforcement for GitHub PR workflows. The agent operates in a session with a static policy: it can create/edit one PR and read repository data, but cannot perform destructive operations on other PRs or the repository.

Enforcement is via **CLI wrappers** (`gh` shim and git `pre-push` hook) running under the existing Seatbelt sandbox. These are guardrails — bypassable in principle, hardened in M6 (containers), and backstopped by a network proxy in M7. See [M5 design investigation](../../reference/m5-app-layer-design.md) for the strategic analysis.

### Design Use Case

A user starts a session: "Create a PR that adds input validation to the signup form." The session is configured with:

- **Repository**: `acme/webapp`
- **Branch**: `bouncer/abc123` (created by WorktreeManager)
- **Allowed push refs**: `bouncer/abc123` (the session branch)
- **PR scope**: create new, then edit the created PR

The agent has full read-write access to the worktree, can commit and push to its branch, can create a PR and edit it, and can read issues and other PRs for context — but cannot merge, close, or edit other PRs.

## Session Policy

### Type Definition

A new `GitHubPolicy` type extends the existing `PolicyTemplate` with application-layer constraints:

```typescript
/** GitHub-specific policy for a session. */
export interface GitHubPolicy {
  /** GitHub repository in "owner/repo" format. */
  repo: string;

  /** Refs the agent is allowed to push to (exact match). */
  allowedPushRefs: string[];

  /**
   * PR number the agent owns, if known at session start.
   * When null, the agent can create one PR; the shim captures the
   * created PR number and scopes subsequent edit operations to it.
   */
  ownedPrNumber: number | null;

  /**
   * Whether the agent can create a new PR.
   * Typically true when ownedPrNumber is null.
   */
  canCreatePr: boolean;
}
```

This is composed into `PolicyTemplate` as an optional field:

```typescript
export interface PolicyTemplate {
  // ... existing fields ...

  /** Application-layer policy for GitHub operations (M5). */
  github?: GitHubPolicy;
}
```

### Policy Lifecycle

1. **Session creation**: The Session Manager builds the `GitHubPolicy` from session parameters:
   - `repo`: detected from the git remote in `projectDir`
   - `allowedPushRefs`: `[worktree.branch]` (the `bouncer/{sessionId}` branch)
   - `ownedPrNumber`: `null` (the agent will create the PR)
   - `canCreatePr`: `true`

2. **PR creation**: When the `gh` shim proxies a successful `gh pr create`, it captures the new PR number from the output and writes it to a state file. Subsequent `gh pr edit` calls are scoped to this PR.

3. **Session teardown**: No special cleanup needed — the worktree branch and PR persist on GitHub for the user to review.

### Policy State File

The `gh` shim needs to persist state that changes during the session (specifically, the PR number after creation). This is stored as a JSON file in the Bouncer-managed policy directory:

```
/tmp/glitterball-sandbox/{sessionId}-github-policy.json
```

```typescript
interface GitHubPolicyState {
  repo: string;
  allowedPushRefs: string[];
  ownedPrNumber: number | null;
  canCreatePr: boolean;
}
```

The Session Manager writes this file during session setup. The `gh` shim reads and updates it (specifically, writing `ownedPrNumber` after a successful `gh pr create`).

On Seatbelt, this file is in a writable temp directory. In M6 (containers), the policy state directory can be mounted read-only except for this specific file, or the shim can communicate state back to the Session Manager via a sidecar mechanism.

## `gh` Shim

### Architecture

The shim is a standalone executable placed on the agent's `PATH` as `gh`. When invoked, it:

1. Reads the session policy from `BOUNCER_GITHUB_POLICY` (path to the policy state file, set as an environment variable)
2. Parses the `gh` subcommand and arguments
3. Evaluates the operation against the policy
4. If allowed: execs the real `gh` binary (path stored in `BOUNCER_REAL_GH`)
5. If denied: prints a policy-violation error to stderr and exits non-zero
6. If the operation was `gh pr create` and succeeded: captures the PR number and updates the policy state file

### Implementation Language

The shim is implemented as a **compiled executable** (TypeScript compiled to a single-file Node.js script via `esbuild`, invoked as `node /path/to/gh-shim.js`). Alternatively, it could be a simple shell script for lower overhead, but TypeScript gives us:
- Shared types with the rest of the codebase
- Easier argument parsing (the `gh` CLI grammar is non-trivial)
- JSON policy file reading/writing
- Testability

The shim binary is placed at a Bouncer-managed path (e.g., `/tmp/glitterball-sandbox/bin/gh`) and prepended to the agent's `PATH`.

### Subcommand Policy Table

The shim evaluates each invocation against this policy matrix. The default is **deny** — only explicitly allowed operations pass through.

#### `gh pr` subcommands

| Subcommand | Policy | Conditions |
|---|---|---|
| `pr create` | **Allow** | Only if `canCreatePr` is true. Capture PR number from output. |
| `pr edit` | **Allow** | Only for `ownedPrNumber`. Deny if targeting a different PR. |
| `pr view` | **Allow** | Any PR (read-only). |
| `pr list` | **Allow** | Read-only. |
| `pr status` | **Allow** | Read-only. |
| `pr checks` | **Allow** | Any PR (read-only). |
| `pr diff` | **Allow** | Any PR (read-only). |
| `pr comment` | **Allow** | Only for `ownedPrNumber`. |
| `pr checkout` | **Deny** | The agent should work in its worktree, not switch to another PR's branch. |
| `pr close` | **Deny** | Destructive. |
| `pr merge` | **Deny** | Destructive. |
| `pr ready` | **Allow** | Only for `ownedPrNumber`. |
| `pr reopen` | **Deny** | Operates on closed PRs the agent doesn't own. |
| `pr review` | **Deny** | The agent shouldn't be reviewing PRs. |
| `pr lock` / `pr unlock` | **Deny** | Administrative. |
| `pr update-branch` | **Allow** | Only for `ownedPrNumber`. |

#### `gh issue` subcommands

| Subcommand | Policy |
|---|---|
| `issue view` | **Allow** (read-only) |
| `issue list` | **Allow** (read-only) |
| `issue status` | **Allow** (read-only) |
| `issue create` | **Deny** |
| `issue edit` | **Deny** |
| `issue close` | **Deny** |
| `issue comment` | **Deny** |
| `issue delete` | **Deny** |
| All other `issue` subcommands | **Deny** |

#### Other `gh` top-level commands

| Command | Policy | Notes |
|---|---|---|
| `repo view` | **Allow** | Read-only metadata. |
| `repo clone` | **Deny** | Agent should work in its worktree. |
| `release list` / `release view` | **Allow** | Read-only. |
| `release create` / `release edit` / `release delete` | **Deny** | Destructive. |
| `search` | **Allow** | Read-only. |
| `api` | **Evaluate** | See [gh api handling](#gh-api-handling) below. |
| `auth` | **Deny** | Agent should not modify auth state. |
| `config` | **Deny** | Agent should not modify gh config. |
| `gist` | **Deny** | Publishing content outside the repo. |
| `codespace` | **Deny** | Infrastructure. |
| `ssh-key` / `gpg-key` | **Deny** | Credential management. |
| `secret` / `variable` | **Deny** | Repository settings. |
| `label` | **Deny** | Repository settings. |
| `extension` | **Deny** | Installing extensions could be a vector. |
| `run view` / `run list` | **Allow** | Read-only CI status. |
| `run cancel` / `run rerun` / `run delete` / `run watch` | **Deny** | CI operations. |
| `workflow view` / `workflow list` | **Allow** | Read-only. |
| `workflow run` / `workflow enable` / `workflow disable` | **Deny** | CI operations. |
| `browse` | **Allow** | Opens a URL in the terminal; harmless. |
| `status` | **Allow** | Read-only cross-repo status. |
| All other commands | **Deny** | Default deny. |

### `gh api` Handling

`gh api` is the escape hatch — it allows arbitrary authenticated HTTP requests to the GitHub API. The shim must parse the endpoint and HTTP method to apply policy.

**Argument parsing for `gh api`:**

```
gh api <endpoint> [--method <METHOD>] [-X <METHOD>] [flags]
```

- `endpoint`: a path like `/repos/{owner}/{repo}/pulls` or `graphql`
- `--method` or `-X`: HTTP method (default: GET, or POST if body params are present)
- `-f`, `-F`, `--raw-field`, `--field`: request body parameters (their presence implies POST)

**REST API policy rules:**

The shim maps `(method, endpoint_pattern)` to allow/deny using the same logic as the subcommand table:

| Method | Endpoint Pattern | Policy | Equivalent |
|---|---|---|---|
| GET | `/repos/{owner}/{repo}` | Allow | Repo metadata |
| GET | `/repos/{owner}/{repo}/pulls` | Allow | `pr list` |
| GET | `/repos/{owner}/{repo}/pulls/{number}` | Allow | `pr view` |
| POST | `/repos/{owner}/{repo}/pulls` | Allow if `canCreatePr` | `pr create` |
| PATCH | `/repos/{owner}/{repo}/pulls/{ownedPr}` | Allow | `pr edit` |
| PATCH | `/repos/{owner}/{repo}/pulls/{otherPr}` | Deny | Editing another PR |
| PUT | `/repos/{owner}/{repo}/pulls/{number}/merge` | Deny | `pr merge` |
| GET | `/repos/{owner}/{repo}/issues` | Allow | `issue list` |
| GET | `/repos/{owner}/{repo}/issues/{number}` | Allow | `issue view` |
| POST | `/repos/{owner}/{repo}/issues` | Deny | `issue create` |
| DELETE | `*` | Deny | Any deletion |
| * | `*` | Deny | Default deny |

The `{owner}/{repo}` in patterns is matched against the session's `repo` field. Requests targeting other repos are denied.

**GraphQL handling:**

The `graphql` endpoint (`gh api graphql -f query='...'`) is harder — the query body determines the operation. Options:

1. **Deny all GraphQL** — simplest, but Claude Code may use it for some read operations
2. **Allow GraphQL, log for review** — accept the bypass risk for M5 since the network proxy (M7) will enforce this properly
3. **Parse the query for mutation keywords** — allow queries, deny mutations

Recommendation: **Option 2 for M5** — allow GraphQL requests but log them as "unaudited" in the ACP event stream. The `gh` CLI mostly uses REST for the operations we care about (`pr create`, `pr edit`, `pr merge`). GraphQL enforcement is deferred to M7's network proxy, which can parse query bodies at the HTTP level.

### Subcommand Parsing

The `gh` CLI has a consistent grammar: `gh <command> [<subcommand>] [<args>] [<flags>]`. The shim needs to parse just enough to identify the command and subcommand, plus a few key flags:

```typescript
interface ParsedGhCommand {
  /** Top-level command (e.g., "pr", "issue", "api") */
  command: string;
  /** Subcommand (e.g., "create", "view", "merge") */
  subcommand: string | null;
  /** Positional arguments after the subcommand */
  positionalArgs: string[];
  /** Parsed flags relevant to policy decisions */
  flags: {
    repo?: string;        // -R, --repo
    method?: string;      // --method, -X (for gh api)
  };
}
```

The parser does **not** need to understand every `gh` flag — only the ones relevant to policy decisions. Unknown flags are passed through to the real `gh` unchanged.

**PR number extraction**: For targeted PR commands (`pr edit`, `pr view`, etc.), the PR number is the first positional argument (e.g., `gh pr edit 42`). If no number is given, `gh` operates on the PR associated with the current branch — which is the session's own PR.

### Error Messages

When the shim denies an operation, it should produce a clear, actionable error:

```
Error: operation denied by session policy
  Command:  gh pr merge 15
  Reason:   merging pull requests is not allowed in this session
  Session:  bouncer/abc123 (PR #42)
  Policy:   standard-pr

This session is scoped to creating and editing PR #42.
Read-only operations (view, list, status) are allowed for any PR.
```

This helps the agent (and the user reviewing the session) understand what happened and why.

## Git Hooks

### `pre-push` Hook

The `pre-push` hook restricts which remote refs the agent can push to. It reads the allowed refs from a policy file and rejects pushes to anything else.

**Hook location:** Installed in a Bouncer-managed hooks directory:

```
/tmp/glitterball-sandbox/{sessionId}-hooks/pre-push
```

Activated via `core.hooksPath` in the worktree's git config during session setup.

**Hook implementation** (shell script for minimal overhead):

```bash
#!/bin/bash
# Bouncer pre-push hook: restrict pushes to allowed refs.
# Policy file path is set at hook installation time.

POLICY_FILE="__BOUNCER_POLICY_FILE__"

if [ ! -f "$POLICY_FILE" ]; then
  echo "bouncer: policy file not found, denying push" >&2
  exit 1
fi

# Read allowed refs from policy JSON
ALLOWED_REFS=$(python3 -c "
import json, sys
policy = json.load(open('$POLICY_FILE'))
for ref in policy.get('allowedPushRefs', []):
    print(ref)
")

# pre-push receives lines on stdin: <local-ref> <local-sha> <remote-ref> <remote-sha>
while read local_ref local_sha remote_ref remote_sha; do
  # Extract the branch name from the remote ref
  remote_branch="${remote_ref#refs/heads/}"

  allowed=false
  for ref in $ALLOWED_REFS; do
    if [ "$remote_branch" = "$ref" ]; then
      allowed=true
      break
    fi
  done

  if [ "$allowed" = false ]; then
    echo "bouncer: push to '$remote_branch' denied by session policy" >&2
    echo "bouncer: allowed refs: $ALLOWED_REFS" >&2
    exit 1
  fi
done

exit 0
```

The `__BOUNCER_POLICY_FILE__` placeholder is replaced with the actual path when the Session Manager installs the hook.

### Hook Installation

During session creation, after worktree setup:

1. Create the hooks directory: `/tmp/glitterball-sandbox/{sessionId}-hooks/`
2. Write the `pre-push` hook with the policy file path baked in
3. `chmod +x` the hook
4. Set `core.hooksPath` in the worktree's git config:
   ```
   git -C <worktree> config core.hooksPath /tmp/glitterball-sandbox/{sessionId}-hooks
   ```

### Hook Cleanup

During session teardown, remove the hooks directory alongside the existing policy file cleanup.

## Session Manager Changes

### Session Creation Flow (additions in bold)

1. Validate git repo
2. Create worktree via WorktreeManager
3. Resolve policy template (default: "standard-pr")
4. **Detect GitHub remote** (`git -C <worktree> remote get-url origin` → parse `owner/repo`)
5. **Build `GitHubPolicy`** from session parameters + detected remote
6. Build SandboxConfig via `policyToSandboxConfig()`
7. **Write GitHub policy state file** (`{sessionId}-github-policy.json`)
8. **Install `gh` shim** (write to bin directory, make executable)
9. **Install git hooks** (write `pre-push`, set `core.hooksPath`)
10. **Prepend shim directory to agent's `PATH`**
11. **Set `BOUNCER_GITHUB_POLICY` and `BOUNCER_REAL_GH` environment variables**
12. Write append profile if needed
13. Resolve agent command
14. Spawn agent process
15. Set up ACP connection
16. Start SandboxMonitor

### Environment Variables

New variables added to the agent's environment:

| Variable | Value | Purpose |
|---|---|---|
| `BOUNCER_GITHUB_POLICY` | `/tmp/glitterball-sandbox/{sessionId}-github-policy.json` | Policy state file path for the `gh` shim |
| `BOUNCER_REAL_GH` | Output of `which gh` at session start | Path to the real `gh` binary for proxying |

These are added to the `env` passed to `spawn()`, alongside the existing `ANTHROPIC_API_KEY` etc.

### `SessionState` Extension

```typescript
interface SessionState {
  // ... existing fields ...

  /** Application-layer policy state (M5). */
  githubPolicy: GitHubPolicy | null;
}
```

### `SessionSummary` Extension

```typescript
export interface SessionSummary {
  // ... existing fields ...

  /** GitHub repo this session targets (if applicable). */
  githubRepo: string | null;

  /** PR number owned by this session (null until PR is created). */
  ownedPrNumber: number | null;
}
```

### Cleanup

Session teardown adds:
- Remove hooks directory: `rm -rf /tmp/glitterball-sandbox/{sessionId}-hooks/`
- Remove policy state file: `rm -f /tmp/glitterball-sandbox/{sessionId}-github-policy.json`
- Unset `core.hooksPath` in worktree config (before worktree removal, to avoid stale config if removal fails)

## ACP Observability

### Policy Event Logging

The `gh` shim and git hooks produce structured log output that the Session Manager can capture and surface in the UI. Two approaches, both implemented:

**1. Stderr capture (existing mechanism):** The Session Manager already captures agent stderr. The shim writes policy decisions to stderr in a parseable format:

```
[bouncer:gh] ALLOW pr create --title "Add validation" --body "..."
[bouncer:gh] DENY pr merge 15 — merging pull requests is not allowed
[bouncer:git] DENY push to refs/heads/main — ref not in allowed list
```

**2. New SessionUpdate event type:**

```typescript
export type SessionUpdate =
  // ... existing types ...
  | {
      sessionId: string;
      type: "policy-event";
      event: PolicyEvent;
    };

export interface PolicyEvent {
  timestamp: number;
  tool: "gh" | "git";
  operation: string;       // e.g., "pr create", "push refs/heads/main"
  decision: "allow" | "deny";
  reason?: string;         // Human-readable reason for deny
}
```

The Session Manager parses `[bouncer:...]` lines from stderr and emits `policy-event` updates to the renderer.

### UI Integration

The existing SandboxLog component in the UI shows sandbox violations (Seatbelt denials). M5 extends this to show policy events alongside sandbox events, giving the user a unified view of all enforcement activity:

```
[14:32:01] ✓ gh pr create --title "Add validation"      (policy: allow)
[14:32:15] ✓ git push origin bouncer/abc123              (policy: allow)
[14:33:42] ✗ gh pr merge 15                              (policy: deny — not allowed)
[14:33:44] ✗ sandbox: open /etc/shadow                   (seatbelt: deny)
```

## `PolicyTemplate` Updates

### `standard-pr` Template

The existing `standard-pr` template gains GitHub policy defaults:

```typescript
export const standardPrTemplate: PolicyTemplate = {
  id: "standard-pr",
  name: "Standard PR",
  description: "Read-write worktree, standard toolchains, GitHub PR-scoped access",
  filesystem: {
    worktreeAccess: "read-write",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: { access: "none" },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
  github: {
    // repo, allowedPushRefs, ownedPrNumber are set per-session
    // These are template defaults indicating that GitHub policy is active
    repo: "",                   // Populated at session creation
    allowedPushRefs: [],        // Populated at session creation
    ownedPrNumber: null,        // Set after PR creation
    canCreatePr: true,
  },
};
```

The `repo` and `allowedPushRefs` fields are populated by the Session Manager from the worktree's git remote and branch name. The template declares *intent* (GitHub policy is active); the Session Manager fills in the *specifics*.

### Templates Without GitHub Policy

`research-only` and `permissive` templates omit the `github` field, meaning no `gh` shim or git hooks are installed. The agent has unrestricted access to `gh` and `git` (subject to Seatbelt filesystem/network restrictions).

## File Layout

New files and directories added in this milestone:

```
src/
  main/
    github-policy.ts          # GitHubPolicy type, policy state file I/O,
                               # GitHub remote detection
    gh-shim.ts                 # gh shim logic (compiled to standalone JS)
    hooks.ts                   # Git hook installation/cleanup
    types.ts                   # Updated: GitHubPolicy, PolicyEvent, etc.
    policy-templates.ts        # Updated: standard-pr gains github field
    policy-sandbox.ts          # Updated: SessionContext gains githubPolicy
    session-manager.ts         # Updated: shim/hook setup in session creation

scripts/
  build-gh-shim.ts             # esbuild script to compile gh-shim.ts
                               # to a single-file JS bundle

test/
  gh-shim.test.ts              # Unit tests for subcommand parsing + policy
  hooks.test.ts                # Unit tests for hook generation
  github-policy.test.ts        # Unit tests for remote detection, state file I/O
```

## Testing Strategy

### Unit Tests

- **Subcommand parser**: Verify correct parsing of all `gh` subcommand forms, including edge cases (flags before subcommands, `--` separators, short vs. long flags)
- **Policy evaluation**: For each row in the subcommand policy table, verify allow/deny with appropriate policy state
- **`gh api` endpoint matching**: Verify REST endpoint patterns match correctly, including path parameter extraction
- **PR number capture**: Verify the shim correctly extracts PR number from `gh pr create` output
- **Hook generation**: Verify the `pre-push` hook correctly allows/denies push refs

### Integration Tests

- **Replay agent with shim**: Use the existing replay agent infrastructure to replay recorded sessions through the `gh` shim. Add recorded `gh` commands to the test dataset.
- **End-to-end session**: Create a session with `standard-pr` policy, verify the shim is installed, run a sequence of `gh` commands, verify allow/deny behavior.

### Manual Testing

- Run a real Claude Code session with the `standard-pr` policy against a test GitHub repository
- Verify the agent can create a PR, push code, and iterate
- Verify that attempts to merge or edit other PRs are blocked
- Verify policy events appear in the UI

## Implementation Phases

### Phase 1: Policy Types and Session Setup

- Define `GitHubPolicy` type
- GitHub remote detection from worktree
- Policy state file I/O
- Session Manager: write policy file, set environment variables
- Unit tests for policy types and remote detection

### Phase 2: `gh` Shim

- Subcommand parser
- Policy evaluation engine
- `gh api` endpoint matching
- PR number capture from `gh pr create` output
- Error message formatting
- Build script (esbuild → standalone JS)
- Shim installation in Session Manager (PATH prepend)
- Unit tests for parser, policy evaluation, API matching

### Phase 3: Git Hooks

- `pre-push` hook template and generation
- Hook installation in Session Manager (`core.hooksPath`)
- Hook cleanup on session teardown
- Unit tests for hook generation and ref matching

### Phase 4: Observability and UI

- `PolicyEvent` type and `SessionUpdate` extension
- Stderr parsing for `[bouncer:...]` log lines
- Session Manager: emit policy events to renderer
- UI: extend SandboxLog to show policy events
- Integration tests with replay agent

## Open Questions (M5-scoped)

- **Should `gh pr comment` be allowed on other PRs?** The agent might need to comment on a related PR for cross-referencing. Current design says deny — revisit if this proves too restrictive in practice.
- **How should the shim handle `gh` extensions?** Extensions (`gh extension`) can add arbitrary subcommands. Default-deny covers this, but a popular extension might need explicit handling.
- **Should the policy state file be in the worktree or in the temp directory?** The temp directory keeps the worktree clean but requires the `BOUNCER_GITHUB_POLICY` env var. The worktree (e.g., `.bouncer/policy.json`) is discoverable but pollutes the working tree and is modifiable by the agent.
- **What happens if `gh pr create` fails?** The shim should not update `ownedPrNumber` on failure. It needs to distinguish between `gh` exit code 0 (success) and non-zero (failure) before writing state.
