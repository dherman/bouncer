# Bouncer: Project Roadmap

## Vision

Bouncer is an experimental project exploring **boundary-based sandboxing and policy enforcement for AI coding agent sessions**. Rather than inspecting individual tool-use requests and deciding whether each one is safe, Bouncer defines a **capability envelope** per session — a boundary within which the agent can operate freely — and enforces that boundary at the OS level.

This approach is inspired by how real-world sandboxing systems work (Capsicum, WASI, Landlock, Seatbelt, containers): they define a boundary upfront and let processes run freely within it, rather than inspecting each action.

## Background

### How We Got Here

The project began with a research phase (see [docs/milestones/research/](milestones/research/)) focused on analyzing real Claude Code session data to understand tool-use patterns and develop per-action safety classifiers. That analysis produced two key insights:

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

The project is structured as an **Electron app** that serves as a multi-session coding agent workbench. It uses the **Agent Client Protocol (ACP)** to communicate with coding agents, and **macOS Seatbelt** (with parameterized SBPL profiles) for OS-level sandbox enforcement.

```
┌──────────────────────────────────────────────────────────┐
│                     Electron App                         │
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
│  │  • Generates .sb profiles from policy templates   │   │
│  │  • Spawns agent via sandbox-exec                  │   │
│  │  • ACP ClientSideConnection per session           │   │
│  │  • Monitors sandbox violations (log stream)       │   │
│  └───────────────────┬───────────────────────────────┘   │
│                      │ stdio (ACP / JSON-RPC)            │
│  ┌───────────────────▼────────────────────────────────┐  │
│  │          Agent Process (sandboxed via Seatbelt)    │  │
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
| OS sandbox | macOS Seatbelt (`sandbox-exec`) | Parameterized SBPL profiles, inherits to all child processes |
| Worktree management | git CLI | `git worktree add/remove` per session |
| Network boundary (later) | HTTP/SOCKS proxy | Domain allowlisting, following Claude Code's proven approach |

## Milestones

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

- SBPL profile generator: takes policy spec (worktree path, allowed read paths) → `.sb` profile
- Agent process launched via `sandbox-exec -D WORKTREE=... -f profile.sb`
- UI shows sandbox status and violation events (parsed from macOS unified log)
- Empirical testing: what legitimate operations does the sandbox break? (e.g., `~/.gitconfig`, global npm cache, SSH keys, system binaries)
- Iterate on SBPL profile to allow necessary system paths without opening the boundary too wide

### Milestone 3: Policy Templates

**Goal**: A usable policy configuration system with a small set of templates.

- Define policy templates as TypeScript types, serializable to JSON:
  - `standard-pr`: read-write worktree + `/tmp` subdirectory, read-only system tools/libraries, no network (initially)
  - `research-only`: read-only filesystem, full web access (when network layer exists)
  - `permissive`: broader access for trusted tasks
- UI for viewing/selecting policy per session
- SBPL generation parameterized by policy template + session context

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

- Block all network in Seatbelt profile except localhost proxy ports
- HTTP/SOCKS proxy in the session manager enforcing domain allowlists
- Integrate with policy templates (allowed domains per policy type)
- Test with real agent workflows (git push, npm install, web research)

## Open Questions

- **What legitimate operations does Seatbelt break?** Milestone 2 will answer this empirically. Expected friction: `~/.gitconfig`, globally-installed binaries, package manager caches, SSH keys.
- **How reliable is log-stream parsing for detecting sandbox violations?** If flaky, we may need to also detect violations via EPERM errors surfaced through ACP.
- **How do ACP terminal messages interact with sandboxing?** Agent creates terminals via `CreateTerminalRequest`; our session manager spawns the shell inside the sandbox. Need to verify.
- **Can a small number of policy templates cover most workflows?** Milestone 3-4 will test this against real data.
- **What's the right model for boundary derivation?** Can we eventually infer boundaries from task descriptions, or do users always need to select explicitly?

## Prior Work

- [Research phase goals and principles](milestones/research/goals.md)
- [Original research roadmap](milestones/research/roadmap.md) (per-action classification approach, superseded by boundary-based framing)
- [PR 0: Dataset extraction](milestones/research/pr-0-dataset-extraction.md) (completed — produced `data/tool-use-dataset.jsonl`)
- [Claude Code history analysis reference](reference/claude-code-history-analysis.md)
