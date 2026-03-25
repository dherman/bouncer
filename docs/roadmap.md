# Bouncer: Project Roadmap

## Status

- [x] **[Milestone 0: Electron + ACP Hello World](#milestone-0-electron--acp-hello-world)**
- [x] **[Milestone 1: Live Agent Integration](#milestone-1-live-agent-integration)**
- [x] **[Milestone 2: Seatbelt Sandbox](#milestone-2-seatbelt-sandbox)**
- [x] **[Milestone 3: Policy Templates](#milestone-3-policy-templates)**
- [x] **[Milestone 4: Deterministic Test Agent](#milestone-4-deterministic-test-agent)**
- [x] **[Milestone 5: Application-Layer Policies](#milestone-5-application-layer-policies)**
- [ ] **[Milestone 6: Container Migration](#milestone-6-container-migration)**
- [ ] **[Milestone 7: Network Boundary](#milestone-7-network-boundary)**

## Vision

Bouncer is an experimental project exploring **boundary-based sandboxing and policy enforcement for AI coding agent sessions**. Rather than inspecting individual tool-use requests and deciding whether each one is safe, Bouncer defines a **capability envelope** per session — a boundary within which the agent can operate freely — and enforces that boundary at the OS level.

This approach is inspired by how real-world sandboxing systems work (Capsicum, WASI, Landlock, Seatbelt, containers): they define a boundary upfront and let processes run freely within it, rather than inspecting each action.

## Background

### How We Got Here

The project began with a research phase (see [docs/history/initial-research/](history/initial-research/)) focused on analyzing real Claude Code session data to understand tool-use patterns and develop per-action safety classifiers. That analysis produced two key insights:

1. **Per-action classification has a ceiling.** It works for known commands (`ls`, `git status`) but fundamentally can't handle unknown executables, Turing-complete code execution (e.g., `python3 -c "..."`), or novel MCP tools. Over 51% of real Bash commands are compound (pipes, chaining, subshells), making deterministic parsing brittle.

2. **The real-world coding-agent workflow implies a natural boundary.** A typical session works within a git worktree on a specific branch, pushes to a specific PR, and accesses the web for research. This is a capability envelope — exactly the kind of boundary that OS-level sandboxing can enforce.

These insights led to a reframing: instead of building a per-action policy oracle, we're building a **boundary-based sandbox** that makes sessions safe by construction, regardless of what specific commands the agent runs inside the boundary.

### Principles

These principles carry forward from the research phase:

- **Sandboxing is useless without policy.** The hard part isn't the enforcement mechanism (Seatbelt, Landlock, containers) — it's defining the right boundary for a given workflow.
- **There is low-hanging fruit everywhere.** We don't need a perfect boundary for every workflow. If we can define good boundaries for common workflows, we can dramatically reduce permission fatigue.
- **Constraining scope improves our chances.** Different workflows get different boundaries. A PR implementation session has a tighter boundary than a research session.
- **Both deterministic and non-deterministic solutions are on the table.** OS-level sandboxing is deterministic. Deriving the right boundary from a task description might require LLM judgment.
- **We will learn how to apply and combine policies over time.** Start with a few policy templates, expand as we learn.

### The Application-Layer Gap

OS-level sandboxes enforce filesystem and network boundaries, but some safety-relevant constraints are application-level semantics:

- "Don't push to main" is a git semantic, not a filesystem operation
- "Only update PR #47" is a GitHub API semantic
- "Don't `npm publish`" is an npm semantic over HTTPS

Closing this gap requires a **layered approach** (see [M5 design investigation](reference/m5-app-layer-design.md)):

1. **CLI wrappers** (`gh` shim, git hooks): guardrails that enforce policy at the tool level. Effective against accidental violations; bypassable via raw HTTP calls. Implemented in M5.
2. **Container isolation** (M6): strengthens CLI wrappers by controlling the entire filesystem — the real `gh` binary doesn't exist, so the shim can't be bypassed via absolute paths.
3. **Network proxy** (M7): the authoritative security boundary. Inspects HTTP traffic to GitHub's API and git's smart HTTP transport. At this layer, CLI wrappers become a UX optimization (better error messages), not the enforcement mechanism.

ACP-level interception (via the ACP proxy) serves as an **observability and UX layer**, not a security boundary — parsing security-relevant intent from arbitrary bash command strings is the per-action classification problem we already moved away from.

## Architecture

The project is structured as an **Electron app** (codename: **Glitter Ball**) that serves as a multi-session coding agent workbench. It uses the **Agent Client Protocol (ACP)** to communicate with coding agents, and **[agent-safehouse](https://agent-safehouse.dev)** for OS-level sandbox enforcement on macOS (with a planned migration to containers for cross-platform support — see [Sandbox Primitive: Seatbelt vs. Containers](#sandbox-primitive-seatbelt-vs-containers)).

```
┌──────────────────────────────────────────────────────────┐
│                 Glitter Ball (Electron)                   │
│                                                          │
│  ┌───────────────────────────────────────────────────┐   │
│  │                   React UI                        │   │
│  │  ┌──────────┐  ┌──────────────────────────────┐   │   │
│  │  │ Session  │  │ Chat Interface               │   │   │
│  │  │ List     │  │ (streamed via ACP)           │   │   │
│  │  │          │  │                              │   │   │
│  │  │          │  │ Sandbox Event Log            │   │   │
│  │  │          │  │ (allowed/blocked operations) │   │   │
│  │  └──────────┘  └──────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────┘   │
│                          │                               │
│  ┌───────────────────────▼───────────────────────────┐   │
│  │          Session Manager (Node main process)      │   │
│  │                                                   │   │
│  │  • Manages worktrees (git worktree add/remove)    │   │
│  │  • Builds sandbox config per session              │   │
│  │  • Spawns agent via safehouse (or containers)     │   │
│  │  • ACP ClientSideConnection per session           │   │
│  │  • Monitors sandbox violations (log stream)       │   │
│  └───────────────────┬───────────────────────────────┘   │
│                      │ stdio (ACP / JSON-RPC)            │
│  ┌───────────────────▼────────────────────────────────┐  │
│  │          Agent Process (sandboxed)                 │  │
│  │                                                    │  │
│  │  Speaks ACP (AgentSideConnection)                  │  │
│  │  • Real: Claude Code via @zed-industries/          │  │
│  │          claude-agent-acp                          │  │
│  │  • Test: deterministic replay agent                │  │
│  │                                                    │  │
│  │  All child processes inherit sandbox constraints   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Key Technologies

| Component | Technology | Notes |
|-----------|-----------|-------|
| App shell | Electron | Native app, no server to spin up |
| UI | React + TypeScript | Chat interface + session management |
| Agent protocol | ACP (`@agentclientprotocol/sdk`) | JSON-RPC over stdio; sessions, streaming, tool calls, permission requests |
| Claude Code adapter | `@zed-industries/claude-agent-acp` | Official ACP adapter for Claude Code |
| OS sandbox (current) | [agent-safehouse](https://agent-safehouse.dev) | Curated Seatbelt profiles, macOS only; see [sandbox primitive discussion](#sandbox-primitive-seatbelt-vs-containers) |
| OS sandbox (future) | Containers (Docker/OrbStack) | Cross-platform, isolated filesystem; planned migration |
| Worktree management | git CLI | `git worktree add/remove` per session |
| App-layer policy (M5) | CLI wrappers (`gh` shim, git hooks) | Policy enforcement at the tool level |
| Container sandbox (M6) | OrbStack (Docker-compatible) | Isolated filesystem, read-only policy mounts |
| Network boundary (M7) | HTTP proxy + container networking | Authoritative policy enforcement, domain allowlisting |

### Sandbox Primitive: Seatbelt vs. Containers

The project's sandbox enforcement layer is designed to be swappable. We currently use macOS Seatbelt (via agent-safehouse) for fast iteration, with a planned migration to containers. This section captures the tradeoff analysis.

**The carveout problem with Seatbelt.** Seatbelt works by starting with "deny everything" and adding back exceptions for every path the agent needs — toolchain caches, shell config, git config, SSH keys, system libraries, Mach IPC services, etc. Every new tool integration is another set of paths to enumerate. Agent-safehouse demonstrates this vividly: separate profile modules for Node, Rust, Python, Go, Java, Ruby, Perl, PHP, Bun, Deno, plus optional integrations for Docker, kubectl, Playwright, Xcode, and more. The profile library *is* the product, and it's always chasing the long tail.

**Containers flip the model.** Instead of subtracting from the host, you build up a known-good environment. The agent gets its own filesystem root with exactly the tools it needs, and the boundary is "nothing outside the container" rather than "everything except these enumerated paths." You don't need to know where pnpm stores its cache on macOS vs. Linux — the container has its own copy. Adding a toolchain means updating a Dockerfile, not discovering and whitelisting a dozen host paths.

**Where containers are clearly better:**
- **Cross-platform**: Docker works on macOS, Linux, and Windows. Seatbelt is macOS-only.
- **Reproducibility**: A container image is a snapshot. Same image = identical environment across sessions and machines.
- **The carveout problem goes away**: No need to enumerate global paths. The container has its own copies of everything.
- **Network isolation is native**: Docker gives fine-grained network control (bridge networks, port mapping, DNS filtering) that provides the foundation for Milestone 7's network proxy.
- **Ecosystem maturity**: E2B, Daytona, Modal, and Kubernetes Agent Sandbox all use containers or VMs.

**Where Seatbelt/safehouse is clearly better:**
- **Startup latency**: Near-zero overhead vs. 500ms-2s for container start.
- **Host integration**: Agent sees the user's actual git config, SSH keys, shell environment. In a container, these must be explicitly mounted or copied.
- **Simplicity for prototyping**: A single CLI call vs. Docker daemon, images, volumes, networking config.

**OrbStack bind-mount performance (validated 2026-03-24):** Performance testing with OrbStack on this repo (6,500+ files, 462MB `node_modules`) showed bind-mount performance at parity with native macOS — some operations were actually faster due to Linux kernel IO scheduling. See [OrbStack performance investigation](reference/orbstack-perf-investigation.md) for details. This eliminates the key container migration risk.

**Current approach:** Use safehouse for Milestones 2-3 to get to the policy design questions quickly. The policy learnings transfer directly to containers — "the agent needs write access to the worktree, read access to toolchains, and restricted network" is the same policy whether expressed as SBPL rules or as Dockerfile + bind mounts + network config.

**Migration plan:** Milestone 5 implements application-layer policies on Seatbelt to iterate on policy semantics quickly. Milestone 6 migrates to containers (OrbStack), which strengthens the CLI wrapper enforcement model (the real `gh` binary simply doesn't exist in the container) and provides native network isolation for Milestone 7. See the [M5 design investigation](reference/m5-app-layer-design.md) for the analysis behind this sequencing.

---

### Milestone 0: Electron + ACP Hello World

**Goal**: Validate that the Electron + ACP plumbing works end-to-end.

- Electron app with basic React UI (session list + chat panel)
- Spawn a trivial ACP echo agent
- Wire up `ClientSideConnection` ↔ `AgentSideConnection` over stdio
- Send a message, see a response in the chat UI

### Milestone 1: Live Agent Integration

**Goal**: A working coding-agent chat UI with Claude Code, unsandboxed.

- Integrate `@zed-industries/claude-agent-acp` to spawn Claude Code as the agent
- Agent can chat, read files, run terminal commands via ACP
- Session manager creates a git worktree per session
- No sandboxing yet — confirm the agent can do real work through the harness

### Milestone 2: Seatbelt Sandbox

**Goal**: Validate that filesystem sandboxing works for real agent workflows; identify what breaks.

- Agent process launched via [agent-safehouse](https://agent-safehouse.dev) (`safehouse --workdir=... --add-dirs=... -- node <agent>`)
- Safehouse provides curated macOS Seatbelt profiles (system runtime, toolchains, agent state, git integration)
- Session manager provides session-specific config (worktree paths, env passthrough, git common dir)
- UI shows sandbox status and violation events (parsed from macOS unified log)
- Empirical testing: what works, what breaks, what needs `--append-profile` overrides
- Document findings to inform policy template design (Milestone 3)

### Milestone 3: Policy Templates

**Goal**: A usable policy configuration system with a small set of templates.

- Define policy templates as TypeScript types, serializable to JSON:
  - `standard-pr`: read-write worktree, standard toolchain access, no network (initially)
  - `research-only`: read-only filesystem, full web access (when network layer exists)
  - `permissive`: broader access for trusted tasks
- UI for viewing/selecting policy per session
- Templates map to safehouse flags and `--append-profile` overlays (Seatbelt) or Dockerfile + bind mount configs (containers)

### Milestone 4: Deterministic Test Agent

**Goal**: Reproducible testing of sandbox policies against real-world data.

- ACP-compliant agent that replays recorded tool-use sequences from the dataset
- Test harness: run a replay against a policy → report what was allowed vs. blocked
- Enrich dataset with session-level context (worktree path, branch) for realistic replay
- Batch validation: run all sessions against policy templates, measure coverage and false-block rate

### Milestone 5: Application-Layer Policies

**Goal**: Implement application-layer policy enforcement for a GitHub PR workflow, using CLI wrappers on Seatbelt.

**Design use case**: A session where the agent creates and iterates on a pull request. The PR identity (repo, branch, PR number) is static for the session — known at session start. See [M5 design investigation](reference/m5-app-layer-design.md) for the full analysis.

**`gh` shim:**
- A policy-aware wrapper placed on the agent's `PATH` that intercepts `gh` commands
- Parses the `gh` subcommand grammar and enforces session policy:
  - **Allow**: `gh pr create`, `gh pr edit` (for this session's PR), `gh pr view`, `gh issue list/view`, repo metadata reads
  - **Deny**: `gh pr merge/close` on other PRs, `gh issue create/edit`, destructive operations
  - **Special handling**: `gh api` (arbitrary API calls) — parse HTTP method + URL path to apply the same policy
- Proxies allowed operations to the real `gh` binary; returns policy-violation errors for denied operations
- GitHub auth: read the user's existing `gh auth` token (zero setup); consider OAuth device flow as a future upgrade for tighter scoping

**Git hooks:**
- `pre-push` hook restricting which remote refs the agent can push to (e.g., allow `agent/feature-branch`, deny `main`/`master`)
- Installed in the worktree during session setup via `core.hooksPath` pointing to a Bouncer-managed directory
- On Seatbelt, these are guardrails (the agent could bypass them); the container migration (M6) makes them harder to tamper with via read-only mounts

**ACP observability:**
- Log `gh` and `git` invocations (allowed and denied) via ACP for UI visibility
- Surface policy violations in the session event log
- ACP is the observability layer, not the enforcement layer

**Known gaps (addressed in M6-M7):**
- Agent can bypass the `gh` shim via `curl` to `api.github.com` (closed by M7 network proxy)
- Agent can bypass git hooks via `--no-verify` or by unsetting `core.hooksPath` (mitigated by M6 read-only mounts, closed by M7 network proxy)
- The real `gh` binary is still accessible on the host filesystem (closed by M6 container isolation)

### Milestone 6: Container Migration

**Goal**: Migrate the sandbox primitive from Seatbelt to containers (OrbStack), strengthening application-layer policy enforcement and enabling native network isolation.

**Why now**: Application-layer policies (M5) rely on CLI wrappers and git hooks that can be bypassed on a host filesystem the agent partially controls. Containers close several of these gaps:
- The real `gh` binary doesn't exist in the container — the shim *is* `gh`, with no bypass via absolute paths
- Git hooks can be mounted read-only, preventing agent tampering
- Container networking provides the foundation for M7's network proxy

**Performance**: OrbStack bind-mount performance has been [validated](reference/orbstack-perf-investigation.md) at parity with native macOS filesystem performance (tested 2026-03-24).

**Scope:**
- Dockerfile(s) for the agent environment: Node.js, git, the `gh` shim, git hooks, standard toolchains
- Session Manager spawns agent containers via OrbStack's Docker-compatible API
- Worktree bind-mounted read-write into the container
- Git hooks directory and `gh` shim mounted read-only
- User's git config and SSH keys mounted read-only (or copied) for authentication
- GitHub auth token injected via environment variable
- Policy templates (M3) updated to generate container configs instead of (or in addition to) Seatbelt profiles
- Port the sandbox violation detection from Seatbelt log parsing to container-appropriate mechanisms

### Milestone 7: Network Boundary

**Goal**: Network-level enforcement via an HTTP proxy, completing the sandbox boundary. The proxy becomes the authoritative security layer for application-level policies.

**Architecture:**
- HTTP/HTTPS proxy running in the Session Manager (host-side)
- Container networking routes all agent egress through the proxy
- Domain allowlisting per policy template (e.g., `github.com`, `registry.npmjs.org`, `api.github.com`)

**GitHub API policy enforcement:**
- The proxy inspects requests to `api.github.com` and enforces the same policy as the M5 `gh` shim, but at the HTTP level
- REST API: match HTTP method + URL path (e.g., `POST /repos/{owner}/{repo}/pulls` = allow, `PUT /repos/{owner}/{repo}/pulls/{number}/merge` = deny)
- GraphQL API (`POST /graphql`): parse the query body to determine the operation
- Git smart HTTP transport: inspect ref-update requests to enforce branch restrictions

**At this point, enforcement roles shift:**

| Mechanism | Role after M7 |
|---|---|
| `gh` shim | UX (better error messages) + fast-reject optimization |
| Git hooks | UX (better error messages) |
| Network proxy | **Authoritative security boundary** |
| ACP | Observability and session event logging |

**Additional scope:**
- TLS interception with injected CA certificate (installed in the container's trust store)
- Proxy bypass prevention: container networking ensures all traffic routes through the proxy
- Integration with policy templates (allowed domains, allowed API operations per policy type)
- Test with real agent workflows: `git push`, `npm install`, `gh pr create`, web research

## Open Questions

- **What legitimate operations does safehouse's sandbox break?** Milestone 2 answered this empirically. Agent-safehouse handles most common paths, but session-specific edge cases may need `--append-profile` overrides.
- **How reliable is log-stream parsing for detecting sandbox violations?** If flaky, we may need to also detect violations via EPERM errors surfaced through ACP.
- **Can a small number of policy templates cover most workflows?** Milestone 3-4 tested this against real data.
- **What's the right model for boundary derivation?** Can we eventually infer boundaries from task descriptions, or do users always need to select explicitly?
- ~~**What's the macOS Docker bind-mount performance like for large worktrees?**~~ **Answered**: OrbStack bind-mount performance is at parity with native. See [investigation](reference/orbstack-perf-investigation.md).
- ~~**When should we migrate from Seatbelt to containers?**~~ **Answered**: Milestone 6, after M5 establishes application-layer policy semantics on Seatbelt.
- **How should the `gh` shim handle `gh api`?** The `gh api` subcommand allows arbitrary GitHub API calls, requiring the shim to parse HTTP method + URL path — essentially the same logic the M7 proxy will need. This is a design opportunity: build the policy engine once, use it in both the shim and the proxy.
- **What's the right GitHub auth strategy long-term?** M5 reuses the user's existing `gh auth` token. For tighter scoping, an OAuth device flow or GitHub App installation could provide session-scoped tokens. Evaluate after M5 based on real usage.
- **How do we handle dynamic PR identity?** M5 assumes the PR is known at session start. A future enhancement could allow agents to spawn sub-sessions via MCP/CLI tools, where a "create PR" session transitions into an "iterate on PR #N" session.

## Prior Work

- [Initial research phase](history/initial-research/roadmap.md) — goals, data analysis, and original per-action classification plans (superseded by boundary-based framing)
- [Research goals and principles](history/initial-research/goals.md)
- [PR 0: Dataset extraction](history/initial-research/pr-0-dataset-extraction.md) (completed — produced `data/tool-use-dataset.jsonl`)
- [Claude Code history analysis reference](reference/claude-code-history-analysis.md)
- [M5 application-layer design investigation](reference/m5-app-layer-design.md) — analysis of enforcement layers, sequencing rationale, and GitHub PR use case
- [OrbStack performance investigation](reference/orbstack-perf-investigation.md) — bind-mount benchmark results validating container migration feasibility
