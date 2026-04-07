# Workspace Label Inference — Design Document

**Date**: 2026-04-06

## Goal

Replace the redundant repo-name label on each workspace in the sidebar with a short, inferred topic that distinguishes workspaces at a glance.

## Motivation

Today every workspace under a repo shows the same label — the repo directory basename (e.g. "rome"). When a repo has 3+ concurrent workspaces, they're distinguished only by small badges (policy, phase, PR number). Users must click into each workspace to remember what it's doing.

A good topic label like "Fix auth middleware" or "Add user pagination" makes the sidebar scannable without clicking. It should appear quickly, improve over time, and never require manual input (though manual override is nice to have).

## Signals Available for Topic Inference

We have several data sources at different points in a workspace's lifecycle:

| Signal | When Available | Quality | Cost |
|--------|---------------|---------|------|
| Worktree branch name | At workspace creation | Medium — branch names are often descriptive but can be cryptic | Free |
| First user prompt | After first message sent | High — users lead with intent | Free (heuristic) or ~0.1s + fraction of a cent (LLM) |
| PR title | After `gh pr create` | High — human-readable by design | Free (already captured by gh shim) |
| LLM-generated summary | After first agent response | Highest — purpose-built for this | ~0.1s, requires API call |

## Design: Progressive Label Refinement

The topic evolves through the workspace lifecycle, getting better as more information becomes available. Each stage overwrites the previous unless the user has manually set a label.

### Stage 0: Placeholder (workspace created, no messages yet)

Display: **"New workspace"** in a dimmed/italic style.

This is the brief window between workspace creation and the first prompt. The dim styling signals that the label is provisional.

### Stage 1: Branch name (worktree assigned)

When a worktree is created, the branch name is cleaned up and used as the initial topic:

```
"dherman/fix-auth-middleware" → "fix auth middleware"
"dherman/add-user-pagination" → "add user pagination"
```

**Cleanup rules:**
1. Strip the `user/` prefix (everything before and including the first `/`)
2. Replace hyphens and underscores with spaces
3. Truncate to 30 characters at a word boundary

This is free, instant, and surprisingly good for repos that enforce descriptive branch naming.

### Stage 2: LLM-inferred topic (first prompt sent)

After the user sends their first message, fire a lightweight API call to generate a proper topic label. This runs asynchronously — the branch-name label stays visible until the LLM responds.

**Approach: Direct Anthropic API call from the main process using Haiku.**

Why not a side ACP session or invisible follow-up prompt:
- A side ACP session is heavy machinery for a one-shot classification task
- Appending an invisible prompt to the real conversation pollutes the agent's context
- A direct API call is isolated, fast (~100-300ms with Haiku), and cheap

**Prompt design:**

```
Summarize this task request in 3-5 words for use as a sidebar label
in a coding workspace manager. Output ONLY the label, nothing else.
Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → "Fix auth token expiry"
- "Can you add pagination to the /api/users endpoint?" → "Add users pagination"
- "Refactor the database connection pool" → "Refactor DB conn pool"
- "Write tests for the payment service" → "Payment service tests"

Task: {first_user_message}
```

**Constraints:**
- Max 30 characters
- If the LLM call fails or times out (>2s), keep the branch-name label — don't block or retry
- Cache the result in the persisted workspace state

### Stage 3: PR title (PR created)

When the agent creates a PR via the gh shim, the PR title is already captured. PR titles are written for human consumption and are usually the best available label.

The gh shim already parses `--title` from `gh pr create` (see `gh-shim.ts:242-243`). When a PR is created and the title flows back through the policy event system, update the topic.

**Cleanup rules:**
1. Truncate to 30 characters at a word boundary
2. Only overwrite if the current topic was LLM-inferred or branch-derived (not user-set)

### Stage 4: Manual override (user action)

Allow the user to double-click the workspace label in the sidebar to edit it inline. A manually-set topic is never overwritten by automatic inference.

This is a polish feature — the automatic stages should be good enough that most users never need it.

## Data Model Changes

### `WorkspaceSummary` (renderer-facing)

```typescript
interface WorkspaceSummary {
  // ... existing fields ...
  topic: string | null;        // Inferred or user-set topic label
}
```

### `PersistedWorkspace` (disk persistence)

```typescript
interface PersistedWorkspace {
  // ... existing fields ...
  topic: string | null;        // Current topic label
  topicSource: 'placeholder' | 'branch' | 'inferred' | 'pr-title' | 'user';
}
```

The `topicSource` field tracks provenance so we know whether a higher-quality source should overwrite it. The precedence order: `user > pr-title > inferred > branch > placeholder`.

## Sidebar Layout Changes

### Current layout (single line)

```
🔀 rome  echo  standard  Impl  #42  ready
```

All information competes for one line. The repo name ("rome") is redundant with the repo group header.

### Proposed layout (two lines)

```
🔀 Fix auth token expiry
   standard · Impl · #42                ready
```

- **Line 1**: Branch icon + topic label (bold/bright, 13px)
- **Line 2**: Badges on the left (dimmer, 11px), status on the right

Benefits:
- Topic gets dedicated horizontal space — no competition with badges
- Badges move to their own line where they can breathe
- The workspace item is taller but more scannable
- Repo name disappears from the workspace row (it's already in the group header)

### Tooltip

Hovering the topic shows the full first user message (or branch name if no message yet). This makes truncation lossless.

## API Credentials for Haiku Calls

The main process needs Anthropic API credentials for the topic inference call. Options:

1. **Reuse the Claude Code credentials** — The app already extracts OAuth tokens from the macOS keychain for container auth. These same credentials can authenticate a direct Haiku call. However, they're Claude Code OAuth tokens, not raw API keys — we'd need to check if they work with the Messages API directly.

2. **Bundled API key** — Ship a low-privilege API key with the app, rate-limited and scoped to Haiku. Simple but requires key management.

3. **Piggyback on the ACP session** — Send the summarization request as a lightweight prompt through an existing or new ACP session. This avoids credential management but couples topic inference to the agent lifecycle.

Recommendation: Start with option 3 — use a one-shot echo-agent-style ACP session with Haiku. If that's too heavy, fall back to option 1.

## Edge Cases

- **Empty first message**: Skip LLM inference, keep branch name
- **Very long first message** (>1000 chars): Truncate to first 500 chars before sending to Haiku
- **Multiple rapid messages before LLM responds**: Use only the first message, ignore subsequent ones
- **Workspace created without a worktree** (e.g. container-only): Skip Stage 1, go straight from placeholder to LLM-inferred
- **Branch name is just a hash or ticket number** (e.g. "dherman/JIRA-1234"): The branch-derived label ("JIRA 1234") is mediocre but acceptable; the LLM stage will replace it shortly
