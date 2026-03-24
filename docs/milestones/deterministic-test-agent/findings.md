# Milestone 4: Batch Validation Findings

**Date**: 2026-03-24
**Dataset**: 11,491 records across 296 sessions
**Run mode**: Unsandboxed baseline (`--no-sandbox`) — establishes ground truth before enabling safehouse enforcement

## Summary

| Metric | Value |
|--------|-------|
| Sessions attempted | 296 |
| Sessions completed | 285 (96.3%) |
| Sessions failed | 11 (3.7%) |
| Tool calls replayed | 10,044 |
| Allowed | 5,989 (59.6%) |
| Blocked | 0 (0.0%) |
| Skipped | 3,423 (34.1%) |
| Error | 632 (6.3%) |
| Allowed rate | 100.0% |
| False-block rate | 0.0% |

**Key finding**: With no sandbox enforcement, 100% of actionable tool calls (allowed + blocked) succeed. This is the expected baseline — zero blocks confirms the replay agent correctly executes operations when unconstrained.

## Cross-Policy Comparison

All three policies produce identical results in unsandboxed mode (expected):

| Policy | Allowed | Blocked | Skipped | Error | Allowed Rate |
|--------|---------|---------|---------|-------|-------------|
| standard-pr | 5,989 | 0 | 3,423 | 632 | 100.0% |
| research-only | 5,989 | 0 | 3,423 | 632 | 100.0% |
| permissive | 5,989 | 0 | 3,423 | 632 | 100.0% |

Policy differentiation will only appear when safehouse sandboxing is enabled (M5-6).

## Per-Tool Breakdown

| Tool | Total | Allowed | Blocked | Skipped | Error |
|------|-------|---------|---------|---------|-------|
| Bash | 3,329 | 1,818 (54.6%) | 0 | 898 (27.0%) | 613 (18.4%) |
| Read | 3,269 | 2,176 (66.6%) | 0 | 1,067 (32.6%) | 26 (0.8%) |
| Edit | 841 | 570 (67.8%) | 0 | 265 (31.5%) | 6 (0.7%) |
| Glob | 502 | 491 (97.8%) | 0 | 11 (2.2%) | 0 |
| Grep | 467 | 332 (71.1%) | 0 | 127 (27.2%) | 8 (1.7%) |
| WebFetch | 426 | 414 (97.2%) | 0 | 12 (2.8%) | 0 |
| WebSearch | 367 | 0 | 0 | 367 (100%) | 0 |
| TodoWrite | 334 | 0 | 0 | 334 (100%) | 0 |
| Write | 190 | 166 (87.4%) | 0 | 23 (12.1%) | 1 (0.5%) |
| MCP tools | 136 | 0 | 0 | 136 (100%) | 0 |
| Other (Agent, Task, etc.) | 183 | 0 | 0 | 183 (100%) | 0 |

## Error Analysis

### Bash errors (613 / 3,329 = 18.4%)

The highest error rate. Root causes:
- **Command not found**: Commands like `pnpm`, `cargo`, `gh`, `npx` that aren't installed in the replay environment
- **Git operations**: `git push`, `git pull` and other network-dependent git commands that fail without remote access
- **Missing dependencies**: Build commands (`npm run build`, `cargo test`) that fail because project dependencies aren't installed
- **Placeholder commands**: Commands still containing `{host}` or other unresolved placeholders that were not caught by the skip rules

These are **not sandbox blocks** — they're environmental errors from replaying commands outside their original project context.

### Read/Edit/Grep errors (40 combined)

Very low error rate (<1%). Causes:
- Missing files not covered by scaffolding (files referenced only in later tool calls after being created by Write/Bash)
- Permission errors on files within `.git/` internals

### Session failures (11 / 296 = 3.7%)

Root causes:
- **EEXIST on scaffold**: 9 sessions failed because `mkdir` in `applyScaffold` collided with existing git-tracked files (e.g., `.gitignore`, `.git`, `examples/src`). The scaffold tries to create a directory where a file already exists. Fix: improve `looksLikeFile()` heuristic or add ENOTDIR handling in scaffold.
- **Git worktree contention**: 1 session failed due to concurrent git ref updates (`unable to append to .git/logs/refs/heads/...`). This is a concurrency issue with git worktrees sharing the same `.git` directory.
- **ENOTDIR in scaffold**: 1 session failed because a path component in node_modules was a symlink/file, not a directory.

## Skipped Calls Analysis (3,423 / 10,044 = 34.1%)

| Skip reason | Count | Percentage |
|-------------|-------|-----------|
| Non-replayable tools (WebSearch, TodoWrite, Agent, etc.) | 1,369 | 40.0% |
| Un-resolvable paths ({project-name}, .claude/) | ~1,156 | 33.8% |
| {host} placeholder in commands/URLs | ~898 | 26.2% |

The skip rate is expected — these represent tool calls that either have no filesystem/process side effects or contain anonymized values that can't be resolved.

## Implications for M5-6

1. **Sandbox differentiation**: The unsandboxed baseline shows 100% allowed rate. When safehouse is enabled, any blocked calls will represent real sandbox enforcement. This makes the false-block rate calculation meaningful.

2. **Scaffold improvements needed**: The 11 EEXIST/ENOTDIR failures should be fixed before sandboxed runs to avoid confusing scaffold failures with sandbox blocks. Priority fix: handle existing files/directories gracefully in `applyScaffold`.

3. **Bash error rate is environmental, not sandbox**: The 18.4% Bash error rate is from missing tools/dependencies, not permission blocks. Under sandbox, additional EPERM errors will appear on top of these environmental errors.

4. **Network tools work unsandboxed**: WebFetch succeeds at 97.2% unsandboxed. Under sandbox with network restrictions, these should become blocks — providing a clean signal for network policy validation.

5. **Git worktree concurrency**: The 1 git contention failure suggests reducing concurrency for sandboxed runs, or adding retry logic for worktree creation.
