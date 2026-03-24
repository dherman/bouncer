# Milestone 3: Policy Templates — Empirical Findings

## Summary

Phase 7 empirical validation revealed two key limitations of OS-level sandboxing for policy differentiation:

1. **Network deny is incompatible with Claude Code.** SBPL deny rules are all-or-nothing — they block the agent's own Anthropic API traffic, making sessions non-functional. Domain-based filtering requires an application-layer proxy (Milestone 6).

2. **Safehouse's `--enable=all-agents` grants broad temp directory access.** The agent profiles grant write access to temp directories (`/tmp`, `/var/folders/...`), which is where worktrees live. This means filesystem policies can't restrict writes *within* temp. Writes to paths outside the sandbox (e.g., home directory) are correctly blocked.

The policy template system, registry, IPC layer, session manager integration, and UI all work end-to-end. The `research-only` template was updated to reflect what's actually enforceable: worktree-scoped writes (not read-only), with writes outside the sandbox blocked.

## Test Results

### 7.1 `standard-pr` — Network deny

- **Result: BLOCKED (by design limitation)**
- The `--append-profile` with `(deny network-outbound)` and `(deny network-bind)` was correctly generated and applied
- However, Claude Code requires outbound HTTPS to `api.anthropic.com` for every prompt
- With network deny active, the agent hangs indefinitely — it cannot reach the API
- **Root cause**: SBPL deny is all-or-nothing. No mechanism for "deny all network EXCEPT api.anthropic.com"
- **Resolution**: Network deny rules removed from `policyToSandboxConfig()`. The template still declares `network: "none"` as intent, but enforcement is deferred to Milestone 6 (application-layer proxy)

### 7.2 `research-only` — Filesystem restrictions

- **Result: PARTIAL PASS**
- Writes inside the worktree succeed (worktree is in tmpdir, which safehouse grants broadly via `--enable=all-agents`)
- Writes inside `/tmp` also succeed for the same reason
- **Writes to paths outside the sandbox are correctly blocked** — e.g., writing to `/Users/dherman/outside-test.txt` fails with "Operation not permitted"
- **Template updated**: `research-only` changed from `worktreeAccess: "read-only"` to `worktreeAccess: "read-write"` with description "Worktree-scoped writes, full network access" — this accurately reflects what the sandbox enforces
- The meaningful distinction from `permissive` will come from application-layer policies (Milestone 5) and network filtering (Milestone 6)

### 7.3 `permissive` — Full access

- **Result: PASS**
- File creation in worktree succeeded
- `curl https://example.com` returned HTTP 200
- No sandbox violations observed
- Equivalent to M2 default behavior — confirms the policy system introduces no regressions

### 7.4 SBPL append-profile ordering

- **Result: CONFIRMED (via 7.1 observation)**
- When network deny rules were active in the append profile, they fully overrode the network allows in safehouse's base profile — the agent could not make any outbound connections
- This proves append-profile deny rules take precedence, as designed
- The problem isn't ordering — it's that SBPL has no mechanism for domain-level exceptions

## Key Findings

### Network filtering requires Milestone 6

SBPL deny rules are absolute. Meaningful network restriction requires an **application-layer proxy**:
- SBPL blocks all network except localhost proxy ports
- Proxy allows agent API traffic (e.g., `api.anthropic.com`)
- Proxy enforces domain allowlists from the policy template
- `filtered` network mode becomes viable with `allowedDomains` list

### Filesystem differentiation is limited by safehouse's agent profiles

Safehouse's `--enable=all-agents` grants write access to temp directories where worktrees live. To achieve true read-only worktree enforcement, we'd need either:
- Worktrees in a non-temp location (complicates cleanup)
- Custom safehouse profiles that don't grant temp broadly
- Container-based sandboxing (Milestone roadmap discusses this migration)

For now, all three templates have the same effective filesystem behavior: rw worktree, no writes outside the sandbox.

### What works today

Despite the limitations above, the sandbox **does** provide meaningful protection:
- Agent cannot write to arbitrary paths outside the worktree/temp (home directory, system files, etc.)
- Agent cannot access other users' files
- All child processes inherit sandbox constraints
- Policy metadata flows end-to-end: templates → registry → IPC → UI badges + tooltips
- The framework is ready for stronger enforcement when proxy (M6) and application-layer (M5) support lands

### Permission auto-approval

The session manager auto-approves all ACP `requestPermission` callbacks (`allow_once`). A proper permission prompt UI is future work, likely part of Milestone 5 (Application-Layer Policies), where ACP's permission system becomes a policy interception point.
