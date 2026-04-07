# Workspace Label Inference — Implementation Plan

**Date**: 2026-04-06

## Overview

This plan implements the design in [design.md](design.md). The work breaks into 5 steps, ordered by dependency. Each step is independently testable and delivers incremental value.

## Step 1: Data Model — Add `topic` and `topicSource` Fields

**Goal**: Wire a topic through the full data path: persistence → main process → IPC → renderer.

### Changes

**`src/main/types.ts`** — Add fields to both interfaces:

```typescript
// In WorkspaceSummary:
topic: string | null;

// In PersistedWorkspace:
topic: string | null;
topicSource: 'placeholder' | 'branch' | 'inferred' | 'pr-title' | 'user';
```

`topicSource` tracks provenance so higher-quality sources can overwrite lower ones. Precedence: `user > pr-title > inferred > branch > placeholder`.

**`src/main/workspace-manager.ts`** — Initialize fields in `WorkspaceState`:

```typescript
// In workspace creation (createWorkspace):
topic: null,
topicSource: 'placeholder' as const,
```

**`src/main/workspace-manager.ts`** — Include `topic` in `summarize()`:

```typescript
// In the return object of summarize():
topic: workspace.topic,
```

**`src/main/workspace-store.ts`** — Persist and restore the new fields. Add `topic` and `topicSource` to the `PersistedWorkspace` write/read path. Handle missing fields gracefully for existing workspace files (default to `null` / `'placeholder'`).

### Testing

- Create a workspace → `topic` is `null`, `topicSource` is `'placeholder'`
- Workspace summary includes `topic: null`
- Existing persisted workspaces without the field load without errors

## Step 2: Branch-Name Topic Extraction (Stage 1)

**Goal**: When a worktree is created, derive a human-readable topic from the branch name.

### Changes

**`src/main/workspace-manager.ts`** — Add a helper function:

```typescript
function topicFromBranch(branch: string): string {
  // Strip "user/" prefix (everything before and including first slash)
  const stripped = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch;
  // Replace hyphens and underscores with spaces
  const spaced = stripped.replace(/[-_]/g, ' ');
  // Truncate to 30 chars at word boundary
  if (spaced.length <= 30) return spaced;
  const truncated = spaced.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}
```

**`src/main/workspace-manager.ts`** — After worktree creation in `createWorkspace()`, set the topic:

```typescript
if (worktree?.branch) {
  workspace.topic = topicFromBranch(worktree.branch);
  workspace.topicSource = 'branch';
}
```

This runs before the workspace emits its `ready` status, so the renderer sees the branch-derived topic on the first summary.

### Testing

- Create a workspace with branch `dherman/fix-auth-middleware` → topic is `"fix auth middleware"`
- Branch `dherman/JIRA-1234` → topic is `"JIRA 1234"`
- Branch `my-feature` (no prefix) → topic is `"my feature"`
- Branch with >30 char slug → truncated at word boundary

## Step 3: Sidebar Two-Line Layout

**Goal**: Redesign the workspace item in the sidebar to show the topic on its own line, with badges below.

### Changes

**`src/renderer/src/components/WorkspacesSidebar.tsx`** — Replace the current single-line workspace item with a two-line layout:

```tsx
<div className={`workspace-item ${...}`} onClick={...}>
  <div className="workspace-row-top">
    <img className="workspace-branch-icon" src={branchIcon} alt="Branch" />
    <span className="workspace-topic" title={ws.topic ?? workspaceLabel(ws)}>
      {ws.topic ?? workspaceLabel(ws)}
    </span>
    {/* status / resume / archive buttons stay on the right of the top row */}
  </div>
  <div className="workspace-row-bottom">
    {/* badges: policy, phase, PR link, violation count */}
  </div>
</div>
```

The `workspaceLabel()` function remains as a fallback for workspaces that predate the topic field.

**`src/renderer/src/index.css`** — New styles:

```css
.workspace-item {
  /* Change from single-line flex to column layout */
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 6px 12px 6px 28px;
}

.workspace-row-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-topic {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.workspace-row-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 24px;  /* align with topic text (past the branch icon) */
  font-size: 11px;
  color: #888;
}
```

When `topic` is null (placeholder state), display "New workspace" in italic with reduced opacity.

### Testing

- Workspace with topic → topic displayed on first line, badges on second
- Workspace without topic (legacy) → falls back to repo directory name
- Long topic → truncated with ellipsis, full text in tooltip
- Badges render on second line with proper spacing

## Step 4: LLM-Inferred Topic (Stage 2)

**Goal**: After the first user prompt, use a lightweight LLM call to generate a high-quality 3-5 word topic.

### Approach

Use a direct Anthropic Messages API call from the main process with Claude Haiku. This avoids the overhead of a side ACP session and keeps topic inference decoupled from the agent conversation.

### Changes

**`src/main/topic-inference.ts`** (new file) — Encapsulate the inference logic:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const TOPIC_PROMPT = `Summarize this task request in 3-5 words for use as a sidebar label in a coding workspace manager. Output ONLY the label, nothing else. Be specific — prefer concrete nouns and verbs over abstract descriptions.

Examples:
- "Fix the auth middleware to handle expired tokens" → "Fix auth token expiry"
- "Can you add pagination to the /api/users endpoint?" → "Add users pagination"
- "Refactor the database connection pool" → "Refactor DB conn pool"

Task: `;

export async function inferTopic(
  userMessage: string,
  apiKey: string,
): Promise<string | null> {
  const client = new Anthropic({ apiKey });
  const truncatedMessage = userMessage.slice(0, 500);

  try {
    const response = await Promise.race([
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: TOPIC_PROMPT + truncatedMessage }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000),
      ),
    ]);

    const text = response.content[0]?.type === 'text'
      ? response.content[0].text.trim()
      : null;

    // Enforce 30-char limit
    if (text && text.length > 30) {
      const lastSpace = text.slice(0, 30).lastIndexOf(' ');
      return lastSpace > 10 ? text.slice(0, lastSpace) : text.slice(0, 30);
    }
    return text;
  } catch {
    return null; // Fail silently — branch name label stays
  }
}
```

**`src/main/workspace-manager.ts`** — After the first prompt is sent (`promptCount === 0` block in `sendPrompt`), fire the inference asynchronously:

```typescript
if (workspace.promptCount === 0 && workspace.topicSource !== 'user') {
  inferTopic(text, this.getApiKey()).then((topic) => {
    if (topic && workspace.topicSource !== 'user' && workspace.topicSource !== 'pr-title') {
      workspace.topic = topic;
      workspace.topicSource = 'inferred';
      this.persistState(workspace);
      this.summarize(workspace).then((summary) => {
        this.emit('workspace-update', {
          workspaceId,
          type: 'status-change',
          status: workspace.status,
          summary,
        });
      });
    }
  });
}
```

The topic update is fire-and-forget. If it fails or times out, the branch-name label persists.

### API Key Sourcing

The simplest approach for this spike: check for `ANTHROPIC_API_KEY` in the environment. If the app already has credentials from the Claude Code OAuth flow, we can explore reusing those later. For now, an explicit env var keeps it simple and testable.

If no API key is available, skip inference entirely — the branch-name label is still a significant improvement over the repo name.

### Testing

- Send first message → topic updates after ~100-300ms to LLM-inferred label
- No API key → topic stays as branch name, no errors
- API call times out (>2s) → topic stays as branch name
- Second message does not re-trigger inference
- User-set topic is never overwritten

## Step 5: PR Title Topic (Stage 3)

**Goal**: When the agent creates a PR, update the topic to the PR title.

### Changes

The gh shim already captures the `--title` flag from `gh pr create` and writes it to policy state. The workspace manager already detects PR creation in the `summarize()` method where it reads live policy state.

**`src/main/workspace-manager.ts`** — In the code path that detects a new `ownedPrNumber` (the `summarize` method or the policy event handler), also capture the PR title:

```typescript
// When PR creation is detected:
if (prTitle && workspace.topicSource !== 'user') {
  const truncated = prTitle.length > 30
    ? prTitle.slice(0, prTitle.slice(0, 30).lastIndexOf(' ') || 30)
    : prTitle;
  workspace.topic = truncated;
  workspace.topicSource = 'pr-title';
  this.persistState(workspace);
}
```

This requires that the PR title is available when the PR creation event flows through. The gh shim's `create` handler already has access to `parsed.flags.title` — we need to propagate it through the policy event or policy state file so the workspace manager can read it.

**`src/main/gh-shim.ts`** — Add `prTitle` to the policy state written after PR creation:

The shim already writes `ownedPrNumber` to the policy state file. Add `prTitle` alongside it.

### Testing

- Agent creates a PR with `--title "Fix auth token handling"` → topic updates to "Fix auth token handling"
- PR title longer than 30 chars → truncated at word boundary
- User-set topic is not overwritten by PR title

## Deferred: Manual Override (Stage 4)

Double-click-to-rename on the sidebar label. This is a polish feature that can be added later. When implemented:

- Set `topicSource: 'user'` on manual edit
- No automatic source should overwrite a user-set topic
- Pressing Escape cancels the edit; pressing Enter or clicking away confirms

## Dependencies

```
Step 1 (data model)
  ├── Step 2 (branch name)
  │     └── Step 3 (sidebar layout)
  └── Step 4 (LLM inference)
        └── Step 5 (PR title)
```

Steps 2 and 4 can be developed in parallel after Step 1. Step 3 depends on Step 2 (needs topics to display). Step 5 depends on Step 4 (shares the topic-update pattern).

## Rollout

Each step delivers standalone value:

1. **After Step 1-2**: Workspaces show branch-derived topics instead of repo names — already a major improvement
2. **After Step 3**: Two-line layout makes the sidebar more scannable
3. **After Step 4**: Topics become crisp, human-quality labels
4. **After Step 5**: Topics reflect the final PR title — the most polished label available
