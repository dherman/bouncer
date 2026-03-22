# Claude Code ACP Adapter — SDK Deviations

Discovered during Phase 2 of Milestone 1 against `@zed-industries/claude-agent-acp` v0.22.2 and `@agentclientprotocol/sdk` v0.16.1.

## Critical: Claude Code handles tools internally

**Plan assumed:** Claude Code would call our ACP Client methods (`createTerminal`, `readTextFile`, `writeTextFile`) to execute its tools, giving us control over tool execution.

**Actual:** Claude Code handles tool execution internally. Its Bash, Read, Write, and Edit tools all execute within the agent process itself. It does **not** delegate to the client via ACP terminal or file methods.

The `sessionUpdate` notifications with `sessionUpdate: "tool_call"` and `"tool_call_update"` report tool execution status and results, but the actual execution has already happened by the time the client sees the update.

**Impact:** Phase 3 (terminal management) as designed is unnecessary for basic operation. The client-side terminal and file methods are optional capabilities that Claude Code *can* use but doesn't *need* to use — it has its own implementations.

**For Milestone 2 (sandboxing):** This is actually good news. Since Claude Code spawns its own subprocesses, all child processes inherit the Seatbelt sandbox. We don't need to intercept tool execution at the ACP level — the OS sandbox handles it.

**For Milestones 5-6 (application-layer policies):** ACP-level tool call interception may become relevant for domain-specific policies (e.g., restricting git operations, network allowlisting) that can't be enforced at the OS level alone. The ACP committee has a proxy design proposal that could enable this. David has an implementation of this in a separate repo — revisit when scoping M5-6.

## RequestPermission API changed

**Plan assumed:** `{ outcome: { outcome: "approved" } }`

**Actual:** The permission model now uses an options-based approach:

- Agent sends `options: PermissionOption[]`, each with `optionId`, `name`, and `kind`
- `kind` is one of: `"allow_once"`, `"allow_always"`, `"reject_once"`, `"reject_always"`
- Client responds with `{ outcome: "selected", optionId: "<id>" }` or `{ outcome: "cancelled" }`

To auto-approve, select the first option with `kind: "allow_once"`.

**Note:** In testing, `requestPermission` was never called — Claude Code auto-approved `ls` via its internal permission system. This method will only fire for operations Claude Code considers dangerous enough to prompt for.

## ReadTextFileRequest uses `path` not `uri`

**Plan assumed:** `params.uri` (from ACP reference doc)

**Actual:** `params.path` — an absolute filesystem path. No URI scheme.

Also includes optional `line` (1-based start line) and `limit` (max lines to read) parameters for partial reads.

## WriteTextFileRequest uses `path` not `uri`

**Plan assumed:** `params.uri` and `params.content`

**Actual:** `params.path` and `params.content`. Same as read — absolute path, no URI scheme.

## CreateTerminalRequest uses command+args, not a shell

**Plan assumed:** Spawn a persistent shell (like `/bin/zsh`) and write commands to stdin.

**Actual:** `CreateTerminalRequest` has `command: string` and `args?: string[]` fields — it's a one-shot command execution model, not a persistent shell. Also includes `cwd`, `env` (as `EnvVariable[]` with `name`/`value` pairs), `outputByteLimit`, and `sessionId`.

**However:** Claude Code doesn't actually use this interface. It runs commands internally via its own Bash tool.

## ClientCapabilities structure

**Plan assumed:** `clientCapabilities: {}`

**Actual:** Capabilities have explicit flags:
```typescript
clientCapabilities: {
  terminal: true,                                    // enables terminal methods
  fs: { readTextFile: true, writeTextFile: true },  // enables file methods
}
```

Without these flags, the agent won't call the corresponding Client methods. In practice Claude Code doesn't use them regardless, but setting them is correct protocol behavior.

## Session updates are richer than expected

**Plan assumed:** `agent_message_chunk` (text) as the primary update type.

**Actual:** Claude Code sends several update variants:

| `sessionUpdate` | When | Content |
|-----------------|------|---------|
| `available_commands_update` | After session creation | List of available slash commands |
| `tool_call` | Tool invocation starts | Tool name, status=pending |
| `tool_call_update` | Tool progress/completion | Input, output, status transitions |
| `agent_message_chunk` | Text streaming | Text content |
| `usage_update` | After prompt completes | Token usage and cost |

The `tool_call` and `tool_call_update` notifications include `_meta.claudeCode.toolName` with the actual tool name (e.g., "Bash") and `_meta.claudeCode.toolResponse` with the tool's output.

## Agent binary entry point

**Resolved path:** `@zed-industries/claude-agent-acp/dist/index.js`

The package's `bin` field maps `claude-agent-acp` to `dist/index.js`. It's a `#!/usr/bin/env node` script. The entry point:
1. Loads managed settings
2. Redirects `console.log` → `console.error` (stdout reserved for ACP)
3. Calls `runAcp()` which sets up the `AgentSideConnection`
4. Keeps stdin open (`process.stdin.resume()`)

Can be spawned directly with Node — no need for `ELECTRON_RUN_AS_NODE` since it's a pure Node script.

## Agent handles its own authentication

Claude Code uses its existing auth from `~/.claude.json` (OAuth) or `ANTHROPIC_API_KEY` env var. No ACP-level authentication exchange is needed — the `authMethods: []` in the initialize response confirms this.

## No need for ELECTRON_RUN_AS_NODE

**Plan assumed:** Set `ELECTRON_RUN_AS_NODE: "1"` when spawning the agent.

**Actual:** The `claude-agent-acp` binary is a standalone Node script, not an Electron-dependent module. It should be spawned with plain `node` (or `process.execPath` with `ELECTRON_RUN_AS_NODE`). Either works, but `ELECTRON_RUN_AS_NODE` is unnecessary if spawning with `node` directly.

In the Electron context, using `process.execPath` + `ELECTRON_RUN_AS_NODE` is still the safest approach since it avoids depending on `node` being on PATH.
