# Milestone 5: Application-Layer Policies — Findings

## Summary

End-to-end validation confirmed that the application-layer policy system works: the `gh` shim correctly intercepts and enforces policy decisions, the pre-push hook restricts push refs, and the UI displays policy events. Several runtime integration issues were discovered and fixed during live testing.

### Key outcomes

1. **The `gh` shim works end-to-end.** `gh pr list` (and other read-only commands) return correct output through the shim. Denied operations produce clear error messages on stderr.

2. **The esbuild bundle approach is required.** The original design used `tsx` at runtime to run the TypeScript shim. This failed in three ways inside the sandbox: (a) `process.execPath` is Electron, not Node; (b) `tsx` can't resolve from the worktree cwd; (c) `tsx`'s esbuild dependency calls `process.cwd()` which the sandbox blocks after `cd`. Bundling with esbuild at session creation time eliminates all three issues.

3. **Agents treat stderr as tool output.** The shim's `[bouncer:gh] ALLOW` log lines on stderr were captured by the agent as the command's response, causing it to report no output. Allow events must not be written to stderr. Only deny events (which exit non-zero) should use stderr.

4. **Environment variables must be explicitly passed through safehouse.** `BOUNCER_GITHUB_POLICY`, `BOUNCER_REAL_GH`, and the modified `PATH` were being stripped by safehouse's `--env-pass` whitelist. They must be added to `sandboxConfig.envPassthrough`.

## Runtime Issues Discovered

### Issue 1: Shim segfault (exit code 139)

- **Symptom**: Agent reports `gh` segfaults with exit code 139
- **Cause**: `installGhShim` used `process.execPath` (Electron binary) as the node interpreter in the wrapper script. Electron's Chromium runtime launched and crashed.
- **Fix**: Use `"node"` as the interpreter. The shim runs as a standalone subprocess outside the Electron process.

### Issue 2: `tsx` module resolution failure

- **Symptom**: `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`
- **Cause**: The shim runs with cwd set to the worktree (a temp directory with no `node_modules`). `node --import tsx/esm` resolves `tsx` from cwd.
- **Fix**: Resolve `tsx/esm` to an absolute path at install time. (Superseded by Issue 3.)

### Issue 3: Sandbox blocks `process.cwd()` after `cd`

- **Symptom**: `EPERM: operation not permitted, uv_cwd`
- **Cause**: Attempted to `cd` to the source directory in the wrapper script so relative imports would resolve. The Seatbelt sandbox allowed the `cd` but blocked `process.cwd()` (called by esbuild inside tsx) because the process's original cwd context was the worktree.
- **Fix**: Abandoned tsx entirely. Bundle `gh-shim.ts` with esbuild into a standalone JS file at session creation time (cached per app launch). No relative imports, no tsx dependency, no cwd sensitivity. This is the "Option B" the design plan anticipated.

### Issue 4: Environment variables stripped by sandbox

- **Symptom**: Shim runs but `main()` never executes (env var guard is false)
- **Cause**: `BOUNCER_GITHUB_POLICY` and `BOUNCER_REAL_GH` were set in the spawn env, but safehouse's `--env-pass` whitelist didn't include them. The sandbox stripped them before the agent (and its subprocesses) could see them.
- **Fix**: Add `BOUNCER_GITHUB_POLICY`, `BOUNCER_REAL_GH`, and `PATH` to `sandboxConfig.envPassthrough` when GitHub policy is active.

### Issue 5: `main()` not awaited in ESM bundle

- **Symptom**: Shim produces no output (allow path), no error
- **Cause**: The entry point guard called `main().catch(...)` (fire-and-forget). In the original tsx runtime, this worked because tsx kept the event loop alive. In the bundled ESM module, Node saw no pending work after the top-level `if` block and exited before the async `readPolicyState()` completed.
- **Fix**: Use top-level `await` for the `main()` call.

### Issue 6: Stderr ALLOW lines confuse agents

- **Symptom**: Agent reports `gh pr list` returned `[bouncer:gh] ALLOW pr list` with no actual data
- **Cause**: The agent captures stderr from tool subprocesses and includes it in tool output. The `[bouncer:gh] ALLOW` line appeared as the command's response.
- **Fix**: Only write DENY events to stderr (which exit non-zero anyway). Allow events are silent. The pre-push hook still logs both ALLOW/DENY since git hooks don't have this issue (stderr goes to the git push caller, not the tool output).

## Implications for Design

### Shim architecture

The esbuild bundle approach is strictly better than tsx-at-runtime:

- **Faster startup**: No tsx/esbuild initialization overhead per `gh` invocation
- **Sandbox-compatible**: No `process.cwd()` calls, no module resolution from worktree
- **Self-contained**: Single JS file with no external dependencies
- **Cached**: Built once per app launch, reused across sessions

The `gh-shim-wrapper.sh` template from the original design was removed. The wrapper script is generated inline by `installGhShim` with concrete paths.

### Observability trade-off

Allow events from the gh shim are not currently visible in the UI policy log — only deny events appear. This is an acceptable trade-off: deny events are the security-relevant ones. Allow events from the pre-push hook still appear (git hooks write to the push caller's stderr, not captured as tool output).

Future options for allow-event observability:

- Write to a dedicated log file that the session manager watches
- Use fd 3 as a log channel (requires session manager to open it)
- Parse the agent's ACP tool call stream for `gh` invocations

### Dev vs. production shim path

The session manager resolves the shim source path based on `app.isPackaged`:

- Dev: `src/main/gh-shim.ts` (bundled by esbuild at runtime)
- Prod: `dist/main/gh-shim.js` (pre-built by electron-vite)

The esbuild bundle step at session creation handles dev mode. For production, the shim should be pre-bundled as part of the electron-vite build, and the wrapper should reference the pre-built file directly (skipping the esbuild step).

## Test Coverage

| Test suite                 | Count   | CI  |
| -------------------------- | ------- | --- |
| `test:github-policy`       | 15      | Yes |
| `test:gh-shim`             | 89      | Yes |
| `test:hooks`               | 10      | Yes |
| `test:app-layer-policy`    | 14      | Yes |
| `test:policy-event-parser` | 14      | Yes |
| `test:policy-sandbox`      | 3       | Yes |
| **Total**                  | **145** |     |

All tests pass in CI (Ubuntu) and locally (macOS).

## Additional Runtime Issues (discovered during full E2E testing)

### Issue 7: Renderer crash — ACP rawOutput is an object

- **Symptom**: Window goes black, React error "Objects are not valid as a React child"
- **Cause**: ACP's `rawOutput` field is `{type, text}` (an object), not a string as the type declaration claimed. `ToolCallBlock` rendered it directly in a `<pre>` tag.
- **Fix**: Stringify `rawOutput` in the session manager if not already a string; add defensive `typeof` check in the renderer.

### Issue 8: SSH and keyring auth blocked by sandbox

- **Symptom**: Agent can't `git push` or use `gh pr create` — "SSH is blocked by the sandbox"
- **Cause**: The Seatbelt sandbox blocks SSH socket access (`SSH_AUTH_SOCK`) and macOS keyring access. Both SSH push and `gh` keyring-based auth fail.
- **Fix**: (a) Resolve `GH_TOKEN` via `gh auth token` in the main process (outside sandbox) and inject into agent env. (b) Switch worktree remote to HTTPS. (c) Configure git credential helper to use `gh auth git-credential` (reads `GH_TOKEN`). (d) Add auth env vars to safehouse passthrough.

## Manual Verification

- Live session with `standard-pr` policy against a GitHub repo
- `gh pr list` returns correct output through the shim
- `gh pr list --state closed` returns correct output
- Agent successfully creates commits, pushes to session branch, and creates a PR
- Policy event log panel appears in the UI
- GitHub repo badge appears in the session list
- Session creation and teardown clean up all artifacts
