# Bouncer: Project Roadmap

## Status

- [x] **[Milestone 0: Electron + ACP Hello World](#milestone-0-electron--acp-hello-world)**
- [x] **[Milestone 1: Live Agent Integration](#milestone-1-live-agent-integration)**
- [x] **[Milestone 2: Seatbelt Sandbox](#milestone-2-seatbelt-sandbox)**
- [x] **[Milestone 3: Policy Templates](#milestone-3-policy-templates)**
- [ ] **[Milestone 4: Deterministic Test Agent](#milestone-4-deterministic-test-agent)**
- [ ] **[Milestone 5: Application-Layer Policies](#milestone-5-application-layer-policies)**
- [ ] **[Milestone 6: Network Boundary](#milestone-6-network-boundary)**

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

Closing this gap requires a semantic layer above the OS sandbox — potentially via git hooks, API-aware proxies, or ACP-level interception. This is a key research question for later milestones.

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
| Network boundary (later) | HTTP/SOCKS proxy or container networking | Domain allowlisting |

### Sandbox Primitive: Seatbelt vs. Containers

The project's sandbox enforcement layer is designed to be swappable. We currently use macOS Seatbelt (via agent-safehouse) for fast iteration, with a planned migration to containers. This section captures the tradeoff analysis.

**The carveout problem with Seatbelt.** Seatbelt works by starting with "deny everything" and adding back exceptions for every path the agent needs — toolchain caches, shell config, git config, SSH keys, system libraries, Mach IPC services, etc. Every new tool integration is another set of paths to enumerate. Agent-safehouse demonstrates this vividly: separate profile modules for Node, Rust, Python, Go, Java, Ruby, Perl, PHP, Bun, Deno, plus optional integrations for Docker, kubectl, Playwright, Xcode, and more. The profile library *is* the product, and it's always chasing the long tail.

**Containers flip the model.** Instead of subtracting from the host, you build up a known-good environment. The agent gets its own filesystem root with exactly the tools it needs, and the boundary is "nothing outside the container" rather than "everything except these enumerated paths." You don't need to know where pnpm stores its cache on macOS vs. Linux — the container has its own copy. Adding a toolchain means updating a Dockerfile, not discovering and whitelisting a dozen host paths.

**Where containers are clearly better:**
- **Cross-platform**: Docker works on macOS, Linux, and Windows. Seatbelt is macOS-only.
- **Reproducibility**: A container image is a snapshot. Same image = identical environment across sessions and machines.
- **The carveout problem goes away**: No need to enumerate global paths. The container has its own copies of everything.
- **Network isolation is native**: Docker gives fine-grained network control (bridge networks, port mapping, DNS filtering) that could simplify or replace Milestone 6.
- **Ecosystem maturity**: E2B, Daytona, Modal, and Kubernetes Agent Sandbox all use containers or VMs.

**Where Seatbelt/safehouse is clearly better:**
- **Startup latency**: Near-zero overhead vs. 500ms-2s for container start.
- **Host integration**: Agent sees the user's actual git config, SSH keys, shell environment. In a container, these must be explicitly mounted or copied.
- **Worktree performance**: Bind-mounted filesystems on macOS Docker have significant performance overhead, especially for large `node_modules`. OrbStack and virtiofs help but are still slower than native.
- **Simplicity for prototyping**: A single CLI call vs. Docker daemon, images, volumes, networking config.

**Current approach:** Use safehouse for Milestones 2-3 to get to the policy design questions quickly. The policy learnings transfer directly to containers — "the agent needs write access to the worktree, read access to toolchains, and restricted network" is the same policy whether expressed as SBPL rules or as Dockerfile + bind mounts + network config.

**When to migrate:** Consider migrating to containers when:
1. We need cross-platform support (Linux builders)
2. The carveout maintenance burden becomes significant
3. We start building domain-specific sandboxes (e.g., "only work on this PR") where the isolated-snapshot model is more natural than the carveout model
4. Milestone 5+ application-layer policies benefit from container-level hooks (e.g., git hooks baked into the image, proxy-based network control via container networking)

**Key risk to validate early:** macOS Docker file-sharing performance with large Node.js projects. If bind-mount performance is unacceptable for the worktree, we may need OrbStack, or a hybrid approach (container for isolation + host worktree via high-performance mount).

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

**Goal**: Understand and start closing the gap between OS-level and intent-level enforcement.

- Git semantic constraints: branch restrictions via git hooks or a git wrapper
- Investigate ACP's `RequestPermissionRequest` as a policy interception point
- Catalog the full application-layer gap: what can't Seatbelt enforce?
- Design the semantic policy layer

### Milestone 6: Network Boundary

**Goal**: Network-level enforcement, completing the sandbox boundary.

- If Seatbelt: block all network via `--append-profile` overlay except localhost proxy ports
- If containers: use Docker network policies or bridge network configuration
- HTTP/SOCKS proxy in the session manager enforcing domain allowlists
- Integrate with policy templates (allowed domains per policy type)
- Test with real agent workflows (git push, npm install, web research)

## Open Questions

- **What legitimate operations does safehouse's sandbox break?** Milestone 2 will answer this empirically. Agent-safehouse handles most common paths, but session-specific edge cases (e.g., unusual toolchains, custom git hooks) may need `--append-profile` overrides.
- **How reliable is log-stream parsing for detecting sandbox violations?** If flaky, we may need to also detect violations via EPERM errors surfaced through ACP.
- **Can a small number of policy templates cover most workflows?** Milestone 3-4 will test this against real data.
- **What's the right model for boundary derivation?** Can we eventually infer boundaries from task descriptions, or do users always need to select explicitly?
- **When should we migrate from Seatbelt to containers?** See [sandbox primitive discussion](#sandbox-primitive-seatbelt-vs-containers). The trigger is likely cross-platform need or domain-specific sandboxing (e.g., "only work on PR #47").
- **What's the macOS Docker bind-mount performance like for large worktrees?** This is the key feasibility question for the container migration. OrbStack may be the answer, but needs testing.
- **How do domain-specific policies (e.g., PR-scoped sessions) map to sandbox primitives?** This is the most interesting policy question — it goes beyond filesystem boundaries into git semantics, API scoping, and task-level intent. Neither Seatbelt nor containers solve it alone; it requires an application-layer policy system (Milestone 5).

## Prior Work

- [Initial research phase](history/initial-research/roadmap.md) — goals, data analysis, and original per-action classification plans (superseded by boundary-based framing)
- [Research goals and principles](history/initial-research/goals.md)
- [PR 0: Dataset extraction](history/initial-research/pr-0-dataset-extraction.md) (completed — produced `data/tool-use-dataset.jsonl`)
- [Claude Code history analysis reference](reference/claude-code-history-analysis.md)
