# PR 2: Bash Command Safety Classification

## Goal

Classify Bash tool use requests by safety level to auto-approve clearly safe commands (~60-70% of Bash usage) while maintaining human review for risky ones.

## Background

From analysis of 7,188 tool uses across 615 sessions:

- Bash is **34.2%** of all tool use (2,460 invocations)
- Bash has the **highest rejection count** (8 of 13 total rejections)
- Bash is the **most heterogeneous** tool — the `command` input is arbitrary shell

### Bash Command Distribution (1,934 sampled)

| Command                 | Count | % of Bash | Notes                         |
| ----------------------- | ----: | --------: | ----------------------------- |
| git                     |   630 |       33% | Mix of read-only and write    |
| gh                      |   244 |       13% | GitHub CLI, mix of read/write |
| pnpm/npm/npx            |   242 |       13% | Build/test/install            |
| ls/cd/pwd               |   282 |       15% | Navigation, always safe       |
| grep/cat/find/head/tail |   196 |       10% | Read-only                     |
| cargo                   |    37 |        2% | Build/test                    |
| docker                  |    23 |        1% | Varies widely                 |
| rm                      |    14 |       <1% | Destructive                   |
| Other                   |  ~266 |       14% | Long tail                     |

### What Was Actually Rejected

Only 2 Bash rejections in the dataset, both `pnpm install` in worktree directories. These weren't safety concerns — the user just didn't want the install to run at that moment.

## Safety Level Taxonomy

| Level | Label            | Description                                                  | Policy                          | Examples                                                                                                                                                    |
| ----- | ---------------- | ------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0    | Pure read        | No state change possible                                     | Auto-approve                    | `ls`, `cat`, `git status`, `git log`, `git diff`, `which`, `pwd`, `head`, `tail`, `wc`, `find` (without `-exec`/`-delete`), `grep`, `echo` (no redirection) |
| L1    | Build/test       | Creates local artifacts, repeatable, no lasting side effects | Auto-approve (with constraints) | `pnpm build`, `pnpm test`, `cargo build`, `cargo test`, `npm run lint`, `pnpm typecheck`                                                                    |
| L2    | Local mutation   | Changes local files/state, generally reversible              | Conditional                     | `git add`, `git commit`, `mkdir`, `pnpm install`, `git checkout`, `git branch`                                                                              |
| L3    | External effects | Visible to others or hard to reverse                         | Require approval                | `git push`, `gh pr create`, `gh issue comment`, `curl -X POST`, `docker push`, `aws *`                                                                      |
| L4    | Destructive      | Data loss risk                                               | Require approval + warning      | `rm -rf`, `git reset --hard`, `git push --force`, `git clean -f`, `docker rm`                                                                               |

## Research Tasks

### Phase A: Dataset Construction

#### Task A1: Extract All Bash Commands

Extract every Bash tool_use input from session history into a structured dataset.

**Command**:

```bash
python3 -c "
import json, os

projects_dir = os.path.expanduser('~/.claude/projects')
entries = []

for project in os.listdir(projects_dir):
    project_path = os.path.join(projects_dir, project)
    if not os.path.isdir(project_path):
        continue
    decoded_project = '/' + project.lstrip('-').replace('-', '/')
    for fname in os.listdir(project_path):
        if not fname.endswith('.jsonl'):
            continue
        fpath = os.path.join(project_path, fname)
        try:
            with open(fpath) as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                        if obj.get('type') != 'assistant':
                            continue
                        for c in obj.get('message', {}).get('content', []):
                            if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'Bash':
                                cmd = c.get('input', {}).get('command', '')
                                desc = c.get('input', {}).get('description', '')
                                entries.append({
                                    'command': cmd,
                                    'description': desc,
                                    'tool_use_id': c.get('id', ''),
                                    'project': decoded_project,
                                    'session_file': fname
                                })
                    except: pass
        except: pass

import json as j
with open('bash-commands-raw.json', 'w') as f:
    j.dump(entries, f, indent=2)
print(f'Extracted {len(entries)} Bash commands')
"
```

#### Task A2: Normalize and Deduplicate

Group commands by pattern to identify unique command shapes:

- `git status --short` and `git status -s` → same pattern
- `cat /path/to/foo.ts` and `cat /path/to/bar.ts` → same pattern (cat + file)
- `pnpm build` across different projects → same pattern

**Expected output**: A set of ~100-300 unique command patterns from ~2,460 raw commands.

#### Task A3: Label Each Pattern

For each unique command pattern, assign:

- `safety_level`: L0-L4
- `decision`: approve / ask / deny
- `rationale`: Why this classification
- `confidence`: How confident we are (high/medium/low)

For commands that are hard to classify (confidence: low), flag them for deeper analysis.

### Phase B: Taxonomy Validation

#### Task B1: Git Command Deep Dive

Git is 33% of all Bash usage. Break down by subcommand:

```bash
# Extract git subcommands
grep -h '"type": "tool_use"' ~/.claude/projects/*/*.jsonl 2>/dev/null | \
  python3 -c "
import sys, json, re
from collections import Counter
counts = Counter()
for line in sys.stdin:
    m = re.search(r'\"command\":\s*\"(git\s+\S+)', line)
    if m:
        counts[m.group(1)] += 1
for cmd, n in counts.most_common(30):
    print(f'{n:4d}  {cmd}')
"
```

**Expected breakdown**:

- L0 (read-only): `git status`, `git log`, `git diff`, `git branch` (list), `git tag`, `git show`, `git remote -v`
- L2 (local mutation): `git add`, `git commit`, `git checkout`, `git branch` (create/delete), `git stash`, `git merge`
- L3 (external): `git push`, `git fetch` (safe but network), `git pull`
- L4 (destructive): `git reset --hard`, `git push --force`, `git clean`

#### Task B2: GitHub CLI Deep Dive

`gh` is 13% of Bash usage. Break down similarly:

- L0: `gh pr list`, `gh pr view`, `gh run list`, `gh run view`, `gh issue list`
- L3: `gh pr create`, `gh pr merge`, `gh issue create`, `gh issue comment`

#### Task B3: Package Manager Deep Dive

`pnpm`/`npm`/`npx` is 13%. Break down:

- L1: `pnpm build`, `pnpm test`, `npm run lint`, `npx tsc --noEmit`
- L2: `pnpm install`, `pnpm add <pkg>`, `npm install`
- L3: `npm publish`, `pnpm deploy`

#### Task B4: Edge Cases and Compound Commands

Identify commands that are hard to classify:

- **Pipes**: `git log --oneline | head -5` (safe) vs `git log | xargs rm` (dangerous)
- **Subshells**: `$(command)` embedded in other commands
- **Redirects**: `echo foo > file.txt` (mutation via redirect)
- **Chained**: `cmd1 && cmd2` where cmd1 is safe but cmd2 is not
- **Aliases/scripts**: `tw-new`, `cadmus` — custom commands with unknown behavior

**Question to answer**: How prevalent are compound commands in real usage? If rare (<5%), a deterministic classifier can punt on them (ask for approval). If common, we need a parser.

### Phase C: Classifier Prototyping

#### Task C1: Deterministic Classifier (L0 Fast Path)

Build a simple parser that:

1. Splits the command on pipes, `&&`, `||`, `;`
2. For each subcommand, extracts the base command and subcommand/flags
3. Matches against an allowlist of known-safe patterns
4. If ALL subcommands are safe → approve; if ANY is unknown → ask; if ANY is denied → deny

**Test against**: The labeled dataset from Phase A.

**Metrics to capture**:

- Coverage: What % of commands does it classify (vs. falling through to "ask")?
- Accuracy: What % of its classifications match the labels?
- False positive rate: Does it EVER approve something labeled L3/L4?

#### Task C2: LLM Classifier

Design a classification prompt:

```
You are a safety classifier for shell commands run by a coding agent.
Classify the following command into one of these safety levels:

- L0 (pure read): No state change. Examples: ls, cat, git status, grep
- L1 (build/test): Creates local build artifacts. Examples: npm build, cargo test
- L2 (local mutation): Changes local files. Examples: git add, mkdir, npm install
- L3 (external effects): Visible to others. Examples: git push, gh pr create
- L4 (destructive): Risk of data loss. Examples: rm -rf, git reset --hard

Command: {command}
Working directory: {cwd}
Project directory: {project}

Respond with ONLY the level (L0, L1, L2, L3, or L4) and a one-sentence rationale.
```

**Test against**: Same labeled dataset.

**Metrics**: Same as C1, plus latency and cost per classification.

#### Task C3: Hybrid Classifier

Combine C1 and C2:

1. Deterministic fast path for L0 commands (covers ~60% of Bash usage)
2. Deterministic deny path for known L4 patterns
3. LLM fallback for everything in between
4. Measure: does the hybrid outperform either alone?

### Phase D: Evaluation and Decision

#### Task D1: Compare Approaches

| Metric                  | Deterministic | LLM  | Hybrid |
| ----------------------- | ------------- | ---- | ------ |
| Coverage (% classified) | ?             | ?    | ?      |
| Accuracy                | ?             | ?    | ?      |
| False positive rate     | ?             | ?    | ?      |
| Latency (p50/p99)       | ~0ms          | ~?ms | ~?ms   |
| Cost per classification | $0            | ~$?  | ~$?    |

#### Task D2: Decide MVP Scope

Based on D1 results, decide:

- Which classifier approach to implement
- Which safety levels to auto-approve in the MVP (likely L0 only, possibly L0+L1)
- Whether to handle compound commands or punt on them

## Safety Model: The Two-Axis Framework

Every Bash command is evaluated on two axes:

### Axis 1: Mutation Level

- **None**: Command only reads state
- **Local**: Command modifies files/state on this machine
- **External**: Command sends data to external systems
- **Destructive**: Command may cause irreversible data loss

### Axis 2: Scope

- **Project-local**: Operates within the current project directory
- **User-local**: Operates within the user's home directory
- **System-wide**: Operates on system files/services
- **Network**: Communicates with external services

### Policy Matrix

```
              │ Project │ Home │ System │ Network
──────────────┼─────────┼──────┼────────┼─────────
No mutation   │ APPROVE │ APPROVE│ ASK  │ ASK
Local mutation│ APPROVE │ ASK  │ DENY   │ N/A
External      │ ASK     │ ASK  │ DENY   │ DENY
Destructive   │ ASK+WARN│ DENY │ DENY   │ DENY
```

## Deliverables

1. **Labeled dataset**: All ~2,460 Bash commands classified with safety level, decision, rationale
2. **Taxonomy validation**: Detailed breakdown of git/gh/pnpm commands with level assignments
3. **Classifier evaluation**: Accuracy/coverage/latency comparison of deterministic vs LLM vs hybrid
4. **MVP recommendation**: Which approach and scope to implement first
5. **Policy spec draft**: Machine-readable policy for the chosen MVP scope

## Dependencies

- Labeled dataset from Phase A (blocks Phases C and D)
- Access to `~/.claude/projects/` session data
- For LLM classifier testing: API access to a fast/cheap model (Haiku or similar)

## Non-Goals

- Handling non-Bash tools (covered by PR 1 for read-only tools)
- Full natural-language understanding of user intent (out of scope for MVP)
- Real-time context awareness (e.g., "is the agent on a protected branch?") — future work
- MCP tool classification — future work
