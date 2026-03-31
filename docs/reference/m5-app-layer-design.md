# M5 Application-Layer Design Investigation

**Date**: 2026-03-24

## Motivation

OS-level sandboxes (Seatbelt, containers) enforce filesystem and network boundaries but cannot enforce application-level semantics like "only edit this PR" or "don't push to main." This investigation analyzed the design space for closing that gap, using a concrete use case: **an agent session that creates and iterates on a GitHub pull request**.

## Use Case: "Create a PR"

The capability envelope for a PR session:

| Capability                                     | Access Level        | Enforcement Layer                  |
| ---------------------------------------------- | ------------------- | ---------------------------------- |
| Worktree filesystem                            | Full read-write     | OS sandbox (existing)              |
| Git: commit, branch, push to session branch    | Allow               | Git hooks (M5)                     |
| Git: push to main/master                       | Deny                | Git hooks (M5), network proxy (M7) |
| `gh pr create/edit` for session's PR           | Allow               | `gh` shim (M5), network proxy (M7) |
| `gh pr view`, `gh issue list/view`, repo reads | Allow (read-only)   | `gh` shim (M5), network proxy (M7) |
| `gh pr merge/close` for other PRs              | Deny                | `gh` shim (M5), network proxy (M7) |
| Network: github.com, npm registry, etc.        | Allowlisted domains | Network proxy (M7)                 |

**Policy is static per session** — the PR identity (repo, branch, PR number) is known at session start. Dynamic policy (e.g., agent spawns sub-sessions) is deferred.

## Enforcement Strategies Evaluated

### 1. CLI Wrappers (`gh` shim + git hooks)

Replace `gh` on the agent's `PATH` with a policy-aware wrapper that parses subcommands and enforces policy. Use git `pre-push` hooks to restrict branch pushes.

**Strengths**: Simple to implement, handles the common case (agent uses standard tooling), the `gh` subcommand grammar is stable and well-documented, git hooks fire regardless of how `git push` is invoked.

**Weaknesses**: Bypassable — agent can `curl` the GitHub API directly, invoke the real `gh` by absolute path, or use `--no-verify` to skip git hooks.

**Bypass mitigations**: Container isolation (M6) removes the real `gh` binary entirely. Network proxy (M7) enforces policy at HTTP level regardless of which tool makes the request.

### 2. GitHub API Proxy (HTTP-level)

Route all HTTPS traffic to `api.github.com` through a local proxy that inspects HTTP method + URL path.

**Strengths**: Covers all access patterns (gh, curl, git credential helpers, Node.js fetch). GitHub's REST API has clean URL structure. Can't be bypassed by using a different tool.

**Weaknesses**: Requires TLS interception (MITM proxy with injected CA). GraphQL endpoint requires query body parsing. Git smart HTTP transport needs separate handling. Higher implementation complexity.

### 3. ACP-Level Interception

Intercept tool calls at the ACP protocol layer before execution.

**Strengths**: Natural integration with existing architecture. Rich UX via ACP's `RequestPermissionRequest`.

**Weaknesses**: Requires parsing security-relevant intent from arbitrary bash command strings — this is the per-action classification problem the project already moved away from. Can't protect against indirect execution (agent writes a script, then runs it).

**Verdict**: ACP should be the **observability and UX layer**, not the security boundary.

### 4. Scoped Credentials (capability-based)

Give the agent a GitHub token that can only do what the policy allows.

**Strengths**: Enforcement at the source of authority. No parser, no proxy, no bypass.

**Weaknesses**: GitHub's permission model is repo-scoped, not PR-scoped. Can't natively express "can only edit PR #47."

**Verdict**: Use the user's existing `gh auth` token for M5 (zero setup). Consider OAuth device flow or GitHub App installations as a future upgrade for tighter scoping.

## Recommended Architecture: Layered Enforcement

Each layer addresses a different part of the threat model. Each milestone makes the previous layers more robust:

### M5: CLI Wrappers (Seatbelt)

- `gh` shim on `PATH` — parses subcommands, enforces PR-scoped policy
- Git `pre-push` hook — restricts branch pushes
- ACP observability — logs allowed/denied operations
- **Security posture**: Guardrail. Stops accidental violations. Bypassable via curl or absolute paths.

### M6: Container Isolation (OrbStack)

- Real `gh` binary doesn't exist in the container — the shim IS `gh`
- Git hooks mounted read-only — agent can't delete them
- System-level gitconfig mounted read-only — agent can't unset `core.hooksPath`
- **Security posture**: Strong guardrail. Bypass requires raw HTTP calls to GitHub API (no standard tool available to do so).

### M7: Network Proxy (authoritative)

- HTTP proxy inspects all traffic to `api.github.com`
- REST API: match HTTP method + URL path against session policy
- GraphQL API: parse query body to determine operation
- Git smart HTTP transport: inspect ref-update requests
- **Security posture**: Security boundary. CLI wrappers become UX (better error messages), proxy is authority.

### Role evolution across milestones

| Mechanism     | M5 Role                | M6 Role                        | M7 Role                      |
| ------------- | ---------------------- | ------------------------------ | ---------------------------- |
| `gh` shim     | Security (best-effort) | Security (stronger)            | UX + fast-reject             |
| Git hooks     | Security (best-effort) | Security (stronger, read-only) | UX                           |
| Container     | N/A                    | Filesystem isolation           | Filesystem + network routing |
| Network proxy | N/A                    | N/A                            | **Authoritative security**   |
| ACP           | Observability          | Observability                  | Observability                |

## Key Design Decisions

1. **Static policy per session**: PR identity known at session start. Dynamic policy (spawning sub-sessions) deferred.

2. **GitHub-first**: Start with a GitHub-specific solution. Generalize the pattern (npm, aws, etc.) after learning from the GitHub implementation.

3. **Auth via existing `gh auth`**: Zero-friction for users already using `gh`. OAuth device flow is the upgrade path if tighter token scoping is needed.

4. **`gh api` is the interesting edge case**: The `gh api` subcommand allows arbitrary API calls, so the shim must parse HTTP method + URL path — the same logic the M7 proxy needs. This means the policy engine built for the shim is directly reusable in the proxy.

## Git Hook Hardening Analysis

Git hooks are inherently bypassable (agent can `--no-verify`, unset `core.hooksPath`, or delete hook files). Mitigation options in containers:

| Approach                   | Prevents deletion | Prevents config override                | Prevents `--no-verify`         |
| -------------------------- | ----------------- | --------------------------------------- | ------------------------------ |
| Read-only hook mount       | Yes               | No                                      | No                             |
| Read-only system gitconfig | Yes               | Partially (can override at local level) | No                             |
| Read-only `.git/config`    | Yes               | Yes                                     | No (but breaks normal git ops) |
| Network proxy              | N/A               | N/A                                     | Yes (enforcement is external)  |

**Conclusion**: Only the network proxy (M7) fully closes the git hook bypass gap. In M5-M6, git hooks are a guardrail, not a boundary.
