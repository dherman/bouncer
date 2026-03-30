# Dynamic PR Policy — Design Document

**Date**: 2026-03-29

## Goal

Enable an end-to-end autonomous PR workflow: an agent implements a change, creates a PR, fixes CI failures, addresses code review feedback, and stops when the PR is green and clean — all within Bouncer's sandbox. The policy evolves dynamically as the session progresses, narrowing from broad permissions to PR-scoped constraints through a one-way ratchet.

## Motivation

Bouncer's sandbox infrastructure (container isolation, network proxy, `gh` shim, git hooks) is built and working. But the current policy model is static: the branch name and PR number must be known at session start. A real workflow doesn't work that way — the agent picks a branch name, creates the PR, and discovers the PR number at runtime. The policy needs to follow.

Additionally, the full PR lifecycle involves operations not yet in the policy allowlist: polling CI status, downloading Actions logs, reading review comments, and requesting reviews. These need to be allowed without opening the policy too wide.

## End-to-End Workflow

The user adds a repo, creates a workspace, and types something like:

> "Implement issue #42: add rate limiting to the /api/submit endpoint"

The agent autonomously:

1. **Reads the issue** for context (`gh issue view`)
2. **Implements the change** — edits files, runs tests locally
3. **Creates a feature branch**, pushes, and creates a PR
4. **Polls CI status** (`gh pr checks`, `gh run view`)
5. **On CI failure**: reads logs (`gh run view --log`), fixes code, pushes again
6. **Reads review comments** (Copilot or human), prepares proposed responses and code fixes
7. **Presents proposed changes to the user** for approval before posting replies or pushing
8. **Stops** when CI is green and there are no unresolved review comments
9. The PR is left for the human to merge — **merge is never allowed**

### What "Done" Means

The agent considers the PR ready when:
- All CI checks are passing
- No unresolved review comments remain

At that point it reports back to the user. The user decides whether to merge, request more changes, or start a new session for additional work.

## Policy Lifecycle

The policy starts broad and narrows through three one-way ratchet events. Once narrowed, it never widens.

### Phase 1: Pre-Push

**Trigger**: session start

The agent has a clean checkout of the repo's default branch. It can read issues, implement changes, and prepare to push. The policy doesn't yet know the branch name.

| Capability | Allowed? |
|---|---|
| Read/write worktree files | Yes |
| Run builds/tests locally | Yes |
| `gh issue view` | Yes |
| Push to any non-protected branch | Yes |
| Push to `main`/`master`/protected branches | **No** |
| `gh pr create` | Yes |
| `gh pr merge` | **No, ever** |

**Policy state**:
```typescript
{
  repo: "owner/repo",
  allowedPushRefs: ["refs/heads/*", "!refs/heads/main"],
  ownedPrNumber: null,
  canCreatePr: true,
  protectedBranches: ["main"],
}
```

The `allowedPushRefs` pattern uses a wildcard with exclusions for protected branches. The proxy and git hooks enforce this.

### Ratchet Event 1: First Push → Lock Branch

**Trigger**: proxy observes a successful `git-receive-pack` to a non-protected branch

The proxy extracts the branch ref from the push and narrows `allowedPushRefs` to only that branch. From this point, the agent can only push to the branch it chose.

**Policy state after**:
```typescript
{
  repo: "owner/repo",
  allowedPushRefs: ["refs/heads/agent/rate-limit-api-submit"],
  ownedPrNumber: null,
  canCreatePr: true,
}
```

**Mechanism**: The proxy's git smart HTTP handler already parses `git-receive-pack` to extract ref names (M7). On the first allowed push, the proxy calls `updatePolicy()` with the narrowed `allowedPushRefs`. The session manager writes the updated policy state to disk so the `gh` shim and git hooks also see the change.

### Ratchet Event 2: PR Creation → Lock PR Number

**Trigger**: proxy observes a successful `POST /repos/{owner}/{repo}/pulls` response

This already exists (M7 design, Phase 5). The proxy extracts the PR number from the response body, sets `ownedPrNumber`, and clears `canCreatePr`.

**Policy state after**:
```typescript
{
  repo: "owner/repo",
  allowedPushRefs: ["refs/heads/agent/rate-limit-api-submit"],
  ownedPrNumber: 15,
  canCreatePr: false,
}
```

Now all PR operations are scoped to PR #15. The agent can view checks, read reviews, and push fixes — but only for this PR.

### Phase 2: Post-PR (CI + Review Loop)

With the branch locked and PR number known, the agent enters its main loop: push fixes, poll CI, read reviews.

| Capability | Allowed? |
|---|---|
| Push to locked branch | Yes |
| `gh pr checks` (PR #15) | Yes |
| `gh pr view` (PR #15) | Yes |
| `gh run view` / `gh run view --log` | Yes |
| Read PR review comments | Yes |
| Post PR review reply comments | **No** (see Review Feedback below) |
| Request a review (e.g., from Copilot) | Yes |
| `gh pr create` | **No** (already created) |
| `gh pr merge` | **No, ever** |
| Operations on other PRs | **No** |
| `gh issue view` | Yes (read-only, still useful for context) |

### Review Feedback: Propose, Don't Post

When the agent reads review feedback (from Copilot, a human, or any reviewer), it should **not** automatically reply to comments or push code changes in response. Instead:

1. The agent reads and analyzes the review comments
2. The agent prepares **proposed responses** — both code changes and reply comments
3. The agent presents these proposals to the user in the chat
4. The user decides: approve all, approve selectively, modify, or reject

This is enforced at the **sandbox level**: the policy denies `POST` to PR comment endpoints (`/repos/{owner}/{repo}/pulls/{n}/comments`, `/repos/{owner}/{repo}/pulls/{n}/reviews`). The agent can read reviews but cannot post replies. Code pushes remain allowed — the user approves the overall approach, and the agent pushes the approved changes.

**Why sandbox-level enforcement?** The agent could be influenced by review comments (prompt injection via a malicious review). Preventing automatic replies ensures the user reviews the agent's proposed responses before they become visible to others. This also gives the user a natural collaboration point — they can steer the agent's response to feedback.

**UX flow:**
- Agent reads reviews → presents a summary: "Copilot flagged 3 issues: (1) missing null check in handler.ts:42, (2) unused import, (3) suggests adding a test case. Here's my plan: ..."
- User responds: "Looks good, go ahead with 1 and 2, skip 3 for now"
- Agent makes the code changes and pushes
- User can post replies on GitHub manually if desired

### Merge: Always Denied

`PUT /repos/{owner}/{repo}/pulls/{n}/merge` and `gh pr merge` are denied at every phase, for every PR number. This is a hard constraint, not just a "not in the allowlist" omission — the proxy and shim should return an explicit, clear error message:

> "Merging PRs is not allowed in this sandbox. The PR is ready for human review."

## GitHub API Allowlist Updates

The M7 REST API allowlist needs to expand for CI and review operations. All new endpoints follow the same default-deny model — if it's not listed, it's blocked.

### New Endpoints

| Pattern | Method | Purpose |
|---|---|---|
| `/repos/{owner}/{repo}/issues/{n}` | `GET` | Read issue for task context |
| `/repos/{owner}/{repo}/issues` | `GET` | List issues |
| `/repos/{owner}/{repo}/pulls/{n}/reviews` | `GET` | Read review comments |
| `/repos/{owner}/{repo}/pulls/{n}/reviews/{id}/comments` | `GET` | Read review thread comments |
| `/repos/{owner}/{repo}/pulls/{n}/comments` | `GET` | Read PR comments (POST denied — see Review Feedback) |
| `/repos/{owner}/{repo}/pulls/{n}/requested_reviewers` | `GET`, `POST` | Read/request reviewers |
| `/repos/{owner}/{repo}/actions/runs` | `GET` | List workflow runs |
| `/repos/{owner}/{repo}/actions/runs/{id}` | `GET` | Get run details |
| `/repos/{owner}/{repo}/actions/runs/{id}/logs` | `GET` | Download run logs |
| `/repos/{owner}/{repo}/actions/runs/{id}/jobs` | `GET` | List jobs in a run |
| `/repos/{owner}/{repo}/check-runs/{id}` | `GET` | Get check run details |
| `/repos/{owner}/{repo}/check-suites/{id}/check-runs` | `GET` | List check runs in a suite |
| `/repos/{owner}/{repo}/commits/{ref}/check-runs` | `GET` | List check runs for a ref |
| `/repos/{owner}/{repo}/commits/{ref}/check-suites` | `GET` | List check suites for a ref |
| `/repos/{owner}/{repo}/commits/{ref}/status` | `GET` | Combined status for a ref |
| `/repos/{owner}/{repo}/statuses/{sha}` | `GET` | List statuses for a SHA |

### PR-Scoped Enforcement

For endpoints containing `{n}` (a PR number), the proxy enforces `n == ownedPrNumber` after ratchet event 2. Before PR creation, these endpoints are blocked (there's no owned PR yet). Exception: `GET /repos/{owner}/{repo}/pulls` (list PRs) is always allowed since it doesn't target a specific PR.

CI/Actions endpoints are not PR-scoped (they reference run IDs and SHAs, not PR numbers). These are allowed broadly for the target repo since they're read-only and the agent needs them to diagnose failures.

## Multi-Session Strategy

The full workflow (implement → PR → CI → review → iterate) may exceed a single agent context window. The work naturally decomposes into sessions:

**Session 1: Implement + Create PR**
- Input: task description (e.g., "implement issue #42")
- Output: PR URL, branch name

**Session 2..N: Fix CI**
- Input: PR URL or number
- Output: CI green, or "stuck, need human help"

**Session N+1..M: Address Reviews**
- Input: PR URL or number
- Output: reviews addressed, or "stuck, need human help"

### Session Initialization from PR Number

When the user creates a workspace and references an existing PR:

> "Fix the CI failures on PR #15"

The workspace should start in Phase 2 (post-PR) with the branch and PR number already locked. This requires:

1. **PR number in workspace creation**: Add an optional `prNumber` field to workspace setup. If provided, the policy starts with `ownedPrNumber` set and `canCreatePr: false`.
2. **Branch discovery**: Query `gh pr view {n} --json headRefName` to get the branch name and set `allowedPushRefs` accordingly.
3. **Worktree setup**: Check out the PR's branch instead of the repo's default branch.

This means the user doesn't need to manually specify the branch — Bouncer derives it from the PR number.

**For the demo**: The user types the PR context in chat. The policy could start in Phase 1 (broad) and narrow naturally when the agent interacts with the PR. Or we add the structured `prNumber` field. The former is simpler to ship; the latter is cleaner. Start with the former, add the field as a fast-follow.

## Sandbox Changes

### `GitHubPolicy` Type

```typescript
export interface GitHubPolicy {
  repo: string;
  allowedPushRefs: string[];        // Supports wildcards + exclusions
  ownedPrNumber: number | null;
  canCreatePr: boolean;
  protectedBranches: string[];       // NEW: branches that can never be pushed to
}
```

The `protectedBranches` field is hardcoded to `["main"]` for now. Even if `allowedPushRefs` is `["refs/heads/*"]`, protected branches are always excluded. Future work: query the repo's default branch via the GitHub API at session start instead of hardcoding.

### Proxy Updates

1. **Branch ratchet**: After a successful `git-receive-pack`, extract the pushed ref and call `updatePolicy()` to narrow `allowedPushRefs` from wildcard to the specific branch.

2. **New API endpoints**: Add the CI, review, and comment endpoints to the REST API allowlist (see table above).

3. **Explicit merge deny**: Add specific handling for `PUT /repos/{owner}/{repo}/pulls/{n}/merge` that returns a clear error message instead of a generic 403.

### `gh` Shim Updates

The shim needs to support new subcommands as UX fast-rejects:

- `gh pr checks` — allow (delegates to proxy)
- `gh run view`, `gh run view --log` — allow
- `gh issue view` — allow
- `gh pr review` — allow for owned PR
- `gh pr merge` — explicit deny with clear message

### Policy State File

The policy state written to disk (read by the shim) needs to stay in sync through ratchet events. When the proxy narrows the policy, the session manager writes the updated state to the policy file. This already happens for PR capture (M7); the branch ratchet adds a second write.

## UI Changes (Minimal)

### Phase Indicator

A small label on the workspace entry in the sidebar showing the current phase:

- **Implementing** — pre-push, agent is writing code
- **PR Open** — PR created, CI/review loop
- **CI Failing** — CI checks failing, agent is fixing
- **Reviewing** — reading/addressing review comments
- **Ready** — CI green, reviews clean

Phase transitions are derived from policy events and agent activity (e.g., the proxy reports PR creation → "PR Open"; CI checks start failing → "CI Failing").

### PR URL

When a PR is created, surface the URL prominently — either as a clickable link in the workspace sidebar entry or as a banner at the top of the chat panel.

## Triggering a Copilot Review

GitHub Copilot code review can be triggered via:

1. **Automatic**: If the repository has Copilot code review enabled in settings, it triggers automatically on PR creation and new pushes.
2. **Manual**: Request a review from the `copilot` user via `POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers` with `{"reviewers": ["copilot"]}`, or equivalently `gh pr edit {n} --add-reviewer copilot`.

For the demo, option 1 is simplest — enable Copilot review on the demo repo and let it trigger automatically. The agent just needs to poll for reviews and read comments. If automatic isn't configured, the agent can request the review explicitly (the endpoint is in the allowlist).

## Demo Plan

### Target Repo

Use `dherman/bouncer` or `dherman/cadmus` — both have CI set up. Enable Copilot code review on the chosen repo.

### Demo Scenario

1. User creates a workspace for the repo
2. User types: "Implement issue #N" (a pre-filed issue with a well-scoped task)
3. Agent implements, pushes, creates PR — user sees PR URL appear in the UI
4. CI runs — agent polls and waits (UI shows "Waiting for CI")
5. If CI fails: agent reads logs, fixes, pushes — user sees the iteration
6. Copilot review arrives — agent reads comments, proposes responses to user
7. User approves/modifies — agent pushes the agreed changes
8. CI re-runs, passes — agent reports "PR is ready for review"
9. User clicks through to GitHub, reviews, merges

### Assumptions for Demo Scope

- CI logs are small enough to download and read in their entirety
- Context overflow is handled by breaking work into multiple sessions manually
- Resumability (surviving laptop close) is deferred
- The user manually starts follow-up sessions if the agent runs out of context

## Implementation Sequence

1. **Wildcard push refs + branch ratchet** — update `GitHubPolicy` type, proxy git handler, policy state sync
2. **Expand API allowlist** — add CI, review, comment, and issue endpoints to proxy
3. **Explicit merge deny** — loud error message in proxy and shim
4. **`gh` shim updates** — support new subcommands (`pr checks`, `run view`, `issue view`, `pr review`)
5. **Phase indicator** — derive from policy events, show in sidebar
6. **PR URL surface** — show in sidebar or chat panel after creation
7. **End-to-end test** — run the full workflow against a demo repo

## Open Questions

1. **CI polling strategy.** How often should the agent poll? Too frequent wastes API calls and context; too infrequent wastes wall-clock time. The agent itself decides this (Bouncer doesn't control it), but we might want to provide guidance in the system prompt or a CI-specific tool.

2. **Review comment threading.** GitHub review comments can be inline (on specific lines) or top-level. The agent needs to understand which comments are unresolved. The `gh pr view` and review API endpoints provide this, but the data structure is non-trivial. Is this something the agent can handle natively, or does Bouncer need to provide a summarized view?

## Non-Goals

- **Automatic merging** — merge is always a human action
- **Automatic review replies** — the agent proposes responses; the user posts them (enforced at sandbox level)
- **Resumable sessions** — deferred; sessions are disposable for now
- **Context overflow handling** — the user manually starts new sessions
- **Multi-PR workflows** — one PR per session
- **Custom CI integrations** — GitHub Actions only for the demo; the API endpoints are generic enough to work with other CI systems that report via GitHub's checks API
