# Bouncer: Initial Research Roadmap

> **Status**: This research phase has been completed through PR 0. PRs 1 and 2 were superseded by a pivot to boundary-based sandboxing — see [docs/roadmap.md](../../roadmap.md) for the current plan.

## Progress

- [x] **[PR 0: Dataset Extraction](./pr-0-dataset-extraction.md)** — Extract and anonymize tool use records from session history into `data/tool-use-dataset.jsonl`
- [ ] ~~**[PR 1: Read-Only Auto-Approval](./pr-1-read-only-auto-approval.md)** — Validate path-scoping, identify sensitive file edge cases, draft deterministic policy spec~~ *(superseded)*
- [ ] ~~**[PR 2: Bash Command Classification](./pr-2-bash-classification.md)** — Build labeled dataset, develop L0-L4 taxonomy, prototype classifiers~~ *(superseded)*

## Context

This plan is based on analysis of real Claude Code session history data from this device: 615 session files, 7,188 tool invocations, and 13 tool use rejections across 20+ projects.

## Key Findings from Data Analysis

### Tool Use Distribution

| Tool | Count | % | Rejection Rate |
|------|------:|--:|----------------|
| Bash | 2,460 | 34.2% | 0.33% (8/2460) |
| Read | 2,129 | 29.6% | 0.09% (2/2129) |
| Edit | 883 | 12.3% | 0.45% (4/883) |
| Grep | 374 | 5.2% | ~0% (1 in subagent) |
| TodoWrite | 353 | 4.9% | 0% |
| Glob | 260 | 3.6% | ~0% (1 in subagent) |
| Write | 197 | 2.7% | 0.5% (1/197) |
| Other | 532 | 7.4% | varies |

### Bash Command Breakdown (1,934 commands sampled)

| Command | Count | % of Bash | Safety Profile |
|---------|------:|----------:|----------------|
| git | 630 | 33% | Mostly read-only (status, diff, log); some write (add, commit, push) |
| gh | 244 | 13% | Read (pr list, run view) vs write (pr create, issue comment) |
| pnpm/npm/npx | 242 | 13% | Build/test safe; install/add modify state |
| ls/cd/pwd | 282 | 15% | Always safe |
| grep/cat/find/head/tail | 196 | 10% | Always safe (read-only) |
| cargo | 37 | 2% | Build/test safe |
| docker | 23 | 1% | Varies widely |
| rm | 14 | <1% | Destructive |
| Everything else | ~266 | 14% | Case-by-case |

### Rejection Analysis (All 13 Rejections)

Every rejection fell into one of these categories:

1. **Unwanted mutations** (6): Edit/Write operations the agent initiated that weren't aligned with user intent (e.g., rewriting import paths across doc files without being asked).
2. **Unwanted side effects** (2): `pnpm install` in worktrees — long-running, modifies node_modules.
3. **Unwanted agent spawning** (3): Task/Agent subagent creation the user considered unnecessary.
4. **Accidental read rejection** (2): Read/Grep in subagent context — likely collateral from rejecting the subagent's entire approach.

**Key insight**: Rejections were almost never about safety concerns — they were about *relevance* (the agent doing something the user didn't ask for). This is an important distinction for policy design.

---

## Research Workstreams

We'll pursue two tracks in parallel: a **quick win** (read-only auto-approval) and a **deep dive** (Bash command classification).

### PR 1: Read-Only Auto-Approval (Quick Win)

**Goal**: Auto-approve Read, Grep, Glob, and TodoWrite with 0% false positives.

**Hypothesis**: These tools are inherently safe because they don't mutate state. The data confirms this — across 3,116 uses, there are essentially 0 legitimate rejections (the 2-3 that occurred were collateral, not safety-motivated).

**Safety model**: A tool use is safe to auto-approve if:
- It is purely read-only (no side effects on the filesystem, network, or external systems), AND
- It operates within the project directory or explicitly allowed paths

**Scope constraints**:
- Read: Auto-approve for files within the project tree. Flag reads outside the project (e.g., `~/.env`, `/etc/passwd`) for review.
- Grep/Glob: Auto-approve. These are always scoped to a path.
- TodoWrite: Auto-approve. Internal state only.

**Implementation approach**: Deterministic. Simple allowlist + path validation. No LLM needed.

**Research tasks**:
- [ ] Validate the path-scoping assumption: extract all Read tool inputs from history and check what % read files outside the project directory
- [ ] Identify edge cases: are there Read targets that are within the project tree but still sensitive (e.g., `.env`, credentials files)?
- [ ] Draft a policy specification

### PR 2: Bash Command Classification (Deep Dive)

**Goal**: Classify Bash commands into safe/unsafe categories to auto-approve the safe ones.

**Hypothesis**: ~60-70% of Bash commands are read-only or benign (git status, ls, grep, build commands) and could be auto-approved. The remaining ~30-40% involve state mutation and need more nuanced handling.

#### Phase 2a: Taxonomy Development

Develop a taxonomy of Bash command safety levels:

| Level | Description | Examples | Auto-approve? |
|-------|-------------|----------|---------------|
| **L0: Pure read** | No state change possible | `ls`, `cat`, `git status`, `git log`, `git diff`, `which`, `pwd`, `head`, `tail`, `wc`, `find` (without `-exec`/`-delete`) | Yes |
| **L1: Build/test** | Local artifacts only, repeatable | `pnpm build`, `pnpm test`, `cargo build`, `cargo test`, `npm run lint` | Yes (with constraints) |
| **L2: Local mutation** | Changes local files/state, reversible | `git add`, `git commit`, `mkdir`, `pnpm install`, `git checkout <branch>` | Conditional |
| **L3: External effects** | Visible to others or hard to reverse | `git push`, `gh pr create`, `gh issue comment`, `curl -X POST`, `docker push`, `aws` | No (require approval) |
| **L4: Destructive** | Data loss risk | `rm -rf`, `git reset --hard`, `git push --force`, `docker rm`, `DROP TABLE` | No (require approval + warning) |

#### Phase 2b: Classification Strategy

Three approaches to evaluate:

**Option A — Deterministic (regex/pattern matching)**:
- Parse the command string, extract the base command and flags
- Match against a curated allowlist/denylist
- Pros: Predictable, fast, auditable
- Cons: Brittle against variations (pipes, subshells, aliases, complex commands)
- Challenge: `git log` is safe but `git log | xargs rm` is not

**Option B — LLM-as-judge**:
- Send the command to a small/fast LLM with a safety classification prompt
- Pros: Handles syntactic variation, can reason about intent
- Cons: Non-deterministic, latency cost, potential for false negatives
- Mitigation: Constrain to binary safe/unsafe output, use structured output

**Option C — Hybrid (recommended for investigation)**:
- Deterministic fast-path for clearly safe patterns (L0 commands)
- LLM fallback for ambiguous commands
- Deterministic deny for clearly dangerous patterns (L4 commands)
- Pros: Best of both — speed for common cases, flexibility for edge cases
- Cons: More complex to implement and test

#### Phase 2c: Dataset Construction

Build a labeled dataset from real session history for testing:

1. **Extract**: Pull all Bash tool_use inputs from session history (~2,460 commands)
2. **Deduplicate**: Normalize and deduplicate to unique command patterns
3. **Label**: Classify each command with safety level (L0-L4) and expected policy decision (approve/deny/ask)
4. **Augment**: Generate synthetic variations (e.g., same command with different file paths, with pipes, with flags)
5. **Split**: Training set (for tuning prompts or rules) and test set (for evaluation)

**Format**: Each entry should include:
```json
{
  "command": "git status --short",
  "base_command": "git",
  "subcommand": "status",
  "safety_level": "L0",
  "decision": "approve",
  "rationale": "Read-only git operation, no state change",
  "source": "session-abc123",
  "context": {
    "project": "/Users/dherman/Code/thinkwell",
    "cwd": "/Users/dherman/Code/thinkwell"
  }
}
```

---

## Safety Model Design Principles

Drawing from Claude Code's existing permission model (default/acceptEdits/plan/bypassPermissions) but designing from first principles:

### What Claude Code's Model Gets Right
- **Mode-based simplicity**: Users pick a posture (cautious vs. permissive) rather than configuring per-tool rules
- **Tool-level granularity in settings.json**: `allow` rules like `Bash(npm run lint)` show the direction of pattern-based auto-approval

### Where It Falls Short (Gaps We Can Address)
- **All-or-nothing for Bash**: You either approve every Bash command or get prompted for each one. There's no middle ground for "approve read-only Bash commands."
- **No semantic understanding**: `Bash(git status)` and `Bash(git push --force)` are treated identically unless you write exact-match rules for each
- **Static rules**: The allowlist in settings.json doesn't adapt to context (what project, what branch, what the agent is currently doing)

### Our Safety Taxonomy

A tool use request is evaluated on two independent axes:

1. **Mutation level**: Does it change state? (None → Local → External → Destructive)
2. **Scope**: Where does it operate? (Project-local → User-local → System-wide → Network/external)

The policy decision is a function of both:

```
              │ Project-local │ User-local │ System │ External
──────────────┼───────────────┼────────────┼────────┼──────────
No mutation   │ Auto-approve  │ Approve    │ Ask    │ Ask
Local mutation│ Approve       │ Ask        │ Deny   │ N/A
External      │ Ask           │ Ask        │ Deny   │ Deny
Destructive   │ Ask+Warn      │ Deny       │ Deny   │ Deny
```

---

## Deliverables

By the end of the research phase, we should have:

1. **Taxonomy document**: Finalized safety level definitions with concrete examples from real data
2. **Labeled dataset**: All Bash commands from session history, classified and formatted for testing
3. **Prototype evaluation**: Results from testing deterministic, LLM, and hybrid classifiers against the dataset
4. **MVP scope decision**: Which workstream(s) to implement first, with confidence levels
5. **Policy specification draft**: Machine-readable policy format for the chosen MVP scope

## Detailed Plans

Each PR-sized activity has a self-contained plan document designed to be run in a parallel session:

- **[PR 0: Dataset Extraction](./pr-0-dataset-extraction.md)** (prerequisite) — Extract and anonymize all tool use records from raw session history into a clean, PII-free dataset (`data/tool-use-dataset.jsonl`). Must complete before PR 1 and PR 2 can begin analysis.
- **[PR 1: Read-Only Auto-Approval](./pr-1-read-only-auto-approval.md)** — Validate path-scoping assumptions, identify sensitive file edge cases, draft a deterministic policy spec. Quick win targeting ~43% of tool use.
- **[PR 2: Bash Command Classification](./pr-2-bash-classification.md)** — Build a labeled dataset of ~2,460 Bash commands, develop the L0-L4 taxonomy, prototype and evaluate deterministic vs LLM vs hybrid classifiers. Deep dive targeting ~34% of tool use.

### Dependency Graph

```
PR 0 (Dataset Extraction)
    ├──► PR 1 (Read-Only Auto-Approval)
    └──► PR 2 (Bash Classification)
```

PR 1 and PR 2 can run in parallel once PR 0 is complete.
