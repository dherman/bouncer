# Milestone 2: Seatbelt Sandbox — Empirical Findings

## Summary

All 5 test tasks completed successfully under the safehouse sandbox. One friction point was discovered (Electron cache path blocked), which is a known limitation of the sandbox boundary and does not affect normal agent coding workflows.

The safehouse integration with `--enable=all-agents` provides a comprehensive sandbox profile out of the box. No changes to `defaultSandboxConfig()` were required.

## Test Results

### Task 1: Read-only (README summary)

- **Prompt**: "Read the README.md file and summarize its contents"
- **Result**: Pass
- **Violations**: None (beyond warmup system noise)
- **Notes**: Agent read the file and returned a summary. No sandbox interference.

### Task 2: File creation and editing

- **Prompt**: "Create a new file called `src/main/sandbox-test.ts` with a simple exported function"
- **Result**: Pass
- **Violations**: None
- **Notes**: File created successfully in the worktree. Write access within the worktree boundary works correctly.

### Task 3: Running tests / spawning subprocesses

- **Prompt**: "List the available npm scripts and run the typecheck command"
- **Result**: Pass (with workaround)
- **Violations**: Electron cache read blocked (see below)
- **Notes**: Initial typecheck failed because the worktree lacked `node_modules` (worktrees don't carry installed dependencies). Agent diagnosed this and ran `npm install`. The Electron postinstall script failed due to sandbox blocking access to `~/Library/Caches/electron/`. Agent worked around by skipping the Electron binary. After install, typecheck passed cleanly.

**Electron cache friction:**
```
Error: EPERM: operation not permitted, open
  '/Users/dherman/Library/Caches/electron/.../electron-v41.0.3-darwin-arm64.zip'
```

This is `~/Library/Caches/electron/` — not in safehouse's default writable paths. The Electron npm package's `install.js` postinstall script tries to read/extract cached binaries here. This is specific to developing Electron apps inside the sandbox and wouldn't affect most coding workflows.

### Task 4: Git operations (add, commit)

- **Prompt**: "Create a file, git add it, and commit with message 'test commit'"
- **Result**: Pass
- **Violations**: None
- **Notes**: File created, staged, and committed successfully (`52146fe`). Confirms that `gitCommonDir` write access (parent repo's `.git` directory) works correctly for linked worktrees.

### Task 5: Network-dependent task (npm install)

- **Prompt**: "Install the `lodash` package using npm"
- **Result**: Pass
- **Violations**: None
- **Notes**: Package installed successfully. Safehouse allows network by default, so npm registry access works. npm cache writes (`~/.npm`) also work — safehouse's Node.js toolchain profile grants this.

## Additional Findings from Phase 4 Manual Testing

- **Reading `/etc/passwd`**: Blocked by sandbox (EPERM). Expected — sensitive system file.
- **Reading `~/.zshrc`**: Blocked by sandbox (EPERM). Expected — shell config not in worktree.
- **Warmup noise**: ~50 violations captured during the monitor's 5-second warmup period from unrelated system processes (Mail, SearchParty, WebKit). These are cosmetic — they don't affect sandbox enforcement. Could be filtered in a future UI improvement.

## Sandbox Configuration

No changes were needed to `defaultSandboxConfig()`. The current configuration:

- **Safehouse flags**: `--enable=all-agents`, `--workdir=<worktree>`, `--add-dirs=<worktree>`, `--add-dirs=<gitCommonDir>`, `--add-dirs-ro=<agentPkgDir>`
- **Env passthrough**: `ANTHROPIC_API_KEY`, `NODE_OPTIONS`, `NODE_PATH`, `EDITOR`, `VISUAL`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`

Safehouse's curated profiles handle system runtime, Node.js toolchain, Claude Code state directories, git config, SSH config, and shell init files without additional configuration.

## Known Limitations

| Issue | Severity | Workaround | Future Fix |
|-------|----------|-----------|------------|
| Electron cache blocked (`~/Library/Caches/electron/`) | Low | Agent skips Electron binary; only affects Electron app development | Could add `--add-dirs-ro` for `~/Library/Caches/electron/` if needed |
| Monitor warmup noise | Cosmetic | Violations are informational only | Filter by agent process names in UI, or shorten warmup window |
| Worktrees lack `node_modules` | Expected | Agent runs `npm install` in worktree | Could pre-install deps during worktree creation (Milestone 3 policy templates) |

## Application-Layer Gaps

These operations are allowed by the OS-level sandbox but would need application-layer policies (Milestone 5) to restrict:

- **`git push`**: Filesystem access to `.git` is needed for local operations, but push is an external-facing action the sandbox can't distinguish
- **`git checkout main`**: Branch switching is a local git operation but semantically may violate a "work only on this PR" policy
- **`npm publish`**: Network is allowed and npm credentials may be accessible — nothing in the OS sandbox prevents publishing

These gaps directly motivate the application-layer policy system planned for Milestone 5.

## Conclusion

The safehouse-based sandbox works well for typical coding agent workflows. The deny-default posture with safehouse's curated profiles provides strong filesystem boundaries while allowing the agent to read code, write files, run build tools, execute git operations, and install packages. The primary remaining work is in application-layer policies (Milestone 5) and network boundary control (Milestone 6).
