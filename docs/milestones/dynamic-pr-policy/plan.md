# Dynamic PR Policy — Implementation Plan

**Date**: 2026-03-30

## Overview

This plan implements the design in [design.md](design.md). The work breaks into 7 steps, ordered by dependency. Each step is independently testable.

## Assumptions

- The agent works in a git worktree created by Bouncer (branch `bouncer/<sessionId>` from HEAD). The agent can create and check out its own feature branch locally — the worktree setup doesn't constrain this.
- The push policy (not the local branch name) is what governs what reaches GitHub. The agent pushes whatever branch it creates; the proxy enforces the push ref rules.
- Protected branches are hardcoded to `["main"]`. Querying the repo's default branch is future work.

## Step 1: Wildcard Push Refs + Protected Branches

**Goal**: Policy starts allowing pushes to any non-protected branch instead of requiring a specific branch at session start.

### Changes

**`src/main/types.ts`** — Update `GitHubPolicy`:

```typescript
export interface GitHubPolicy {
  repo: string;
  allowedPushRefs: string[]; // Now supports wildcards: ["refs/heads/*"]
  ownedPrNumber: number | null;
  canCreatePr: boolean;
  protectedBranches: string[]; // NEW — branches that can never be pushed to
}
```

**`src/main/github-policy.ts`** — Update `buildSessionPolicy`:

```typescript
export function buildSessionPolicy(repo: string, _branch: string): GitHubPolicy {
  return {
    repo,
    allowedPushRefs: ['refs/heads/*'], // Was: [branch]
    ownedPrNumber: null,
    canCreatePr: true,
    protectedBranches: ['main'], // NEW
  };
}
```

The `_branch` parameter is kept for backward compatibility but no longer used to constrain push refs.

**`src/main/proxy-github.ts`** — Update `evaluateGitPush`:
The existing `evaluateGitPush` function does exact-match against `allowedPushRefs`. Update it to:

1. Support glob/wildcard matching (`refs/heads/*` matches any branch)
2. Check `protectedBranches` — deny if the ref matches any protected branch, regardless of wildcards

**`src/main/hooks.ts`** — Update `installHooks`:
The pre-push hook currently checks against a hardcoded list of allowed refs (written to `allowed-refs.txt`). Update to:

1. Write wildcard patterns to `allowed-refs.txt`
2. Update the hook script to support glob matching and protected branch exclusion
3. Or: simplify the hook to just check protected branches (deny `main`), since the proxy is authoritative

### Testing

- Push to a feature branch from inside the sandbox → allowed
- Push to `main` → denied by both hook and proxy
- Push to a second feature branch (before ratchet) → allowed

## Step 2: Branch Ratchet

**Goal**: After the first successful push, lock `allowedPushRefs` to that specific branch.

### Changes

**`src/main/proxy-github.ts`** — In `handleGitSmartHttp`, after a successful push is forwarded:

```typescript
// After forwarding a successful git-receive-pack:
if (isFirstPush(config.githubPolicy)) {
  const pushedBranch = refs[0].refName; // e.g., "refs/heads/agent/my-feature"
  config.githubPolicy.allowedPushRefs = [pushedBranch];
  config.onPolicyEvent({
    timestamp: Date.now(),
    tool: 'proxy',
    operation: `branch-ratchet: locked to ${pushedBranch}`,
    decision: 'allow',
  });
}
```

The "is first push" check: `allowedPushRefs` contains a wildcard pattern (e.g., `refs/heads/*`). After ratchet, it contains a specific ref. So `isFirstPush` = `allowedPushRefs.some(r => r.includes("*"))`.

**`src/main/workspace-manager.ts`** — Wire policy state sync:
The proxy already emits policy events via `onPolicyEvent`. Add a listener that detects branch-ratchet events and calls `writePolicyState()` to persist the narrowed policy. This keeps the `gh` shim and git hooks in sync.

The proxy already has `updatePolicy()` on `ProxyHandle`, but for the branch ratchet the proxy itself is the one narrowing the policy (it mutates `config.githubPolicy` directly). The session manager just needs to persist the change.

### Interaction with PR Capture

The branch ratchet (step 2) and PR capture (existing M7) are independent ratchet events. They can happen in either order, though the typical flow is: push first, then create PR. Both mutate `config.githubPolicy` and both need to trigger `writePolicyState()`.

### Testing

- First push to `feature-a` → allowed, policy narrows to `feature-a`
- Second push to `feature-a` → allowed (same branch)
- Push to `feature-b` after ratchet → denied

## Step 3: Expand API Allowlist

**Goal**: Allow the CI, review, and issue API endpoints needed for the full PR lifecycle.

### Changes

**`src/main/github-policy-engine.ts`** — Add new endpoint patterns to the REST API allowlist:

```typescript
// Issues (read-only)
{ method: "GET", pattern: "/repos/:owner/:repo/issues", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/issues/:number", action: "allow" },

// PR reviews (read-only + request reviewers)
{ method: "GET", pattern: "/repos/:owner/:repo/pulls/:number/reviews", action: "allow-if-owned-pr" },
{ method: "GET", pattern: "/repos/:owner/:repo/pulls/:number/reviews/:id/comments", action: "allow-if-owned-pr" },
{ method: "GET", pattern: "/repos/:owner/:repo/pulls/:number/comments", action: "allow-if-owned-pr" },
{ method: "GET", pattern: "/repos/:owner/:repo/pulls/:number/requested_reviewers", action: "allow-if-owned-pr" },
{ method: "POST", pattern: "/repos/:owner/:repo/pulls/:number/requested_reviewers", action: "allow-if-owned-pr" },

// CI / Actions (read-only, not PR-scoped)
{ method: "GET", pattern: "/repos/:owner/:repo/actions/runs", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/actions/runs/:id", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/actions/runs/:id/logs", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/actions/runs/:id/jobs", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/check-runs/:id", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/check-suites/:id/check-runs", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/commits/:ref/check-runs", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/commits/:ref/check-suites", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/commits/:ref/status", action: "allow" },
{ method: "GET", pattern: "/repos/:owner/:repo/statuses/:sha", action: "allow" },
```

The `allow-if-owned-pr` action checks `n == ownedPrNumber` when set, or denies if no PR is owned yet.

**Review comment POST — explicitly denied**: `POST` to `/pulls/:number/comments` and `/pulls/:number/reviews` (creating a review, not requesting one) are not in the allowlist and therefore denied by default. The `POST /pulls/:number/requested_reviewers` endpoint is distinct — it requests a review from someone, it doesn't post a review comment.

### Testing

- `GET /repos/owner/repo/issues/42` → allowed
- `GET /repos/owner/repo/pulls/15/reviews` (when ownedPr=15) → allowed
- `GET /repos/owner/repo/pulls/99/reviews` (when ownedPr=15) → denied
- `GET /repos/owner/repo/actions/runs/123/logs` → allowed
- `POST /repos/owner/repo/pulls/15/comments` → denied (not in allowlist)
- `POST /repos/owner/repo/pulls/15/requested_reviewers` (when ownedPr=15) → allowed

## Step 4: Explicit Merge Deny

**Goal**: Return a clear, specific error message when the agent attempts to merge, rather than a generic 403.

### Changes

**`src/main/github-policy-engine.ts`** — Add a special-case rule that matches before the general allowlist:

```typescript
// Hard deny: merge is never allowed
{ method: "PUT", pattern: "/repos/:owner/:repo/pulls/:number/merge", action: "deny-merge" },
```

The `deny-merge` action returns a specific reason string:

> "Merging PRs is not allowed in this sandbox. The PR is ready for human review."

**`src/main/gh-shim.ts`** — Add explicit handling for `gh pr merge`:

The shim already denies `pr merge` (line ~267 in current code), but update the error message to match the proxy's message for consistency.

### Testing

- `PUT /repos/owner/repo/pulls/15/merge` → 403 with merge-specific message
- `gh pr merge 15` → denied with same message

## Step 5: `gh` Shim Updates

**Goal**: Support new subcommands so the shim doesn't block legitimate operations that the proxy would allow.

### Changes

**`src/main/gh-shim.ts`** — Update `evaluatePolicy` to handle:

| Subcommand                   | Action                                                   |
| ---------------------------- | -------------------------------------------------------- |
| `gh pr checks [number]`      | Allow (pass through to real gh)                          |
| `gh pr review --request ...` | Allow if owned PR (requesting a review, not posting one) |
| `gh run view [id]`           | Allow                                                    |
| `gh run view [id] --log`     | Allow                                                    |
| `gh run list`                | Allow                                                    |
| `gh issue view [number]`     | Allow (already handled)                                  |
| `gh issue list`              | Allow (already handled)                                  |
| `gh pr merge`                | Deny with explicit message (update existing deny)        |

Most of these are already partially handled — the shim allows `run list`, `run view`, `issue view`, `issue list`. Check each one and ensure the full set is covered.

**Container API mode** (`src/main/gh-shim.ts` lines 460+): If the shim is running in API-direct mode (no real `gh` binary), add handlers for:

- `pr checks` → `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` or `GET /repos/{owner}/{repo}/pulls/{n}/reviews`
- `run view` → `GET /repos/{owner}/{repo}/actions/runs/{id}`
- `run view --log` → `GET /repos/{owner}/{repo}/actions/runs/{id}/logs`

These are the commands the agent will use most during the CI/review loop.

### Testing

- `gh pr checks 15` → passes through, returns check status
- `gh run view 12345 --log` → passes through, returns logs
- `gh pr merge 15` → denied with clear message

## Step 6: Policy State Sync

**Goal**: Ensure ratchet events from the proxy are persisted so the `gh` shim and git hooks stay in sync.

### Changes

**`src/main/workspace-manager.ts`** — The `onPolicyEvent` callback from the proxy currently logs events to the workspace's event stream. Extend it to also detect ratchet events and persist the updated policy:

```typescript
onPolicyEvent: (event: PolicyEvent) => {
  // Existing: emit event to UI
  workspace.events.push(event);
  this.emitUpdate(workspace);

  // NEW: persist policy on ratchet events
  if (event.operation.startsWith('branch-ratchet:') || event.operation.startsWith('pr-capture:')) {
    writePolicyState(workspace.id, workspace.githubPolicy!);
    // Also update hooks if branch changed
    if (event.operation.startsWith('branch-ratchet:')) {
      updateHooksAllowedRefs(workspace.id, workspace.githubPolicy!.allowedPushRefs);
    }
  }
};
```

The proxy already mutates `config.githubPolicy` directly for PR capture (M7). The branch ratchet (step 2) follows the same pattern. The session manager just needs to detect these mutations and persist them.

**`src/main/hooks.ts`** — Add `updateHooksAllowedRefs` function:
Write the new allowed refs to the existing `allowed-refs.txt` file. The pre-push hook re-reads this file on each push, so it picks up changes automatically.

### Testing

- Push to `feature-a` → proxy narrows policy → policy file updated → shim reads narrowed policy
- Create PR #15 → proxy captures PR → policy file updated → shim scopes to PR #15

## Step 7: Minimal UI Updates

**Goal**: Show workflow phase and PR URL in the sidebar.

### Changes

**`src/main/types.ts`** — Add phase to workspace state:

```typescript
export type WorkspacePhase =
  | 'implementing' // Pre-push
  | 'pr-open' // PR created, CI/review loop
  | 'ci-failing' // CI checks failing
  | 'reviewing' // Review comments pending
  | 'ready'; // CI green, reviews clean

// Add to Workspace type:
export interface Workspace {
  // ... existing fields ...
  phase: WorkspacePhase; // NEW
  prUrl: string | null; // NEW
}
```

**`src/main/workspace-manager.ts`** — Derive phase from policy events:

- Session start → `"implementing"`
- PR capture event → `"pr-open"`, set `prUrl` from captured PR response
- Phase transitions for `ci-failing` / `reviewing` / `ready` are harder to derive from proxy events alone (the proxy sees API calls but doesn't interpret CI results). For the demo, keep it simple: `"implementing"` → `"pr-open"` is the only automatic transition. Further refinement is future work.

**`src/renderer/src/components/WorkspacesSidebar.tsx`** — Display:

- Phase badge next to workspace name (small colored label)
- PR URL as a clickable link below the workspace entry (when set)

**`src/renderer/src/components/ChatPanel.tsx`** — When a PR is created:

- Show a banner or inline card with the PR URL at the point in the chat timeline where it was created

### Testing

- Create workspace → sidebar shows "Implementing"
- Agent creates PR → sidebar updates to "PR Open" with clickable PR URL
- PR URL appears in chat timeline

## Dependency Graph

```
Step 1 (wildcard refs + protected branches)
  ↓
Step 2 (branch ratchet)
  ↓
Step 3 (API allowlist) ←── independent of 1-2, but listed here for ordering
  ↓
Step 4 (merge deny) ←── independent, small
  ↓
Step 5 (gh shim) ←── depends on 3 (needs to know which commands to allow)
  ↓
Step 6 (policy sync) ←── depends on 2 (branch ratchet events to persist)
  ↓
Step 7 (UI) ←── depends on 6 (phase derived from policy events)
```

Steps 1-2 are the core policy changes. Steps 3-5 are the API surface expansion. Step 6 is the glue. Step 7 is the UI.

Steps 3 and 4 are independent of steps 1-2 and could be done in parallel.

## Files Changed Summary

| File                                                | Steps   | Nature of Change                                                                        |
| --------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `src/main/types.ts`                                 | 1, 7    | Add `protectedBranches` to `GitHubPolicy`; add `WorkspacePhase`, `prUrl` to `Workspace` |
| `src/main/github-policy.ts`                         | 1       | Update `buildSessionPolicy` to use wildcard refs                                        |
| `src/main/proxy-github.ts`                          | 2       | Add branch ratchet logic after successful push                                          |
| `src/main/github-policy-engine.ts`                  | 2, 3, 4 | Wildcard ref matching, new API endpoints, merge deny                                    |
| `src/main/gh-shim.ts`                               | 4, 5    | Explicit merge deny message, new subcommand handlers                                    |
| `src/main/hooks.ts`                                 | 1, 6    | Wildcard support in hook, `updateHooksAllowedRefs`                                      |
| `src/main/workspace-manager.ts`                     | 6, 7    | Policy sync on ratchet, phase tracking, PR URL capture                                  |
| `src/renderer/src/components/WorkspacesSidebar.tsx` | 7       | Phase badge, PR URL link                                                                |
| `src/renderer/src/components/ChatPanel.tsx`         | 7       | PR creation banner                                                                      |
