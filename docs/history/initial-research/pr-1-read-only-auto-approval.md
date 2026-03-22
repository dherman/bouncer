# PR 1: Read-Only Tool Auto-Approval

## Goal

Auto-approve Read, Grep, Glob, and TodoWrite tool uses with 0% false positives, eliminating unnecessary permission prompts for ~43% of all tool invocations.

## Background

From analysis of 7,188 tool uses across 615 sessions:

| Tool | Count | % of Total | Rejections |
|------|------:|----------:|-----------:|
| Read | 2,129 | 29.6% | 2 (collateral, not safety-motivated) |
| Grep | 374 | 5.2% | 1 (collateral) |
| Glob | 260 | 3.6% | 1 (collateral) |
| TodoWrite | 353 | 4.9% | 0 |
| **Total** | **3,116** | **43.3%** | **~0 legitimate** |

The handful of rejections were collateral — the user was rejecting the agent's overall approach (e.g., shutting down a subagent), not objecting to the read operation itself.

## Hypothesis

These tools are inherently safe because they don't mutate state. The only risk vector is **information disclosure** — reading sensitive files the user doesn't want the agent to see.

## Research Tasks

### Task 1: Validate Path-Scoping Assumption

**Question**: What % of Read operations target files outside the project directory?

**Method**:
1. Extract all Read tool inputs from session history (the `file_path` field)
2. Compare each path against the project directory (from the session's `cwd` or project path)
3. Categorize: in-project, in-home-dir, system-level, other

**Expected output**: A table showing the distribution. If >95% are in-project, path-scoping is a strong policy lever.

**Command to run**:
```bash
python3 -c "
import json, os

projects_dir = os.path.expanduser('~/.claude/projects')
in_project = 0
in_home = 0
system_level = 0
total = 0

for project in os.listdir(projects_dir):
    project_path = os.path.join(projects_dir, project)
    if not os.path.isdir(project_path):
        continue
    # Decode project path: -Users-dherman-Code-foo -> /Users/dherman/Code/foo
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
                            if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'Read':
                                fp = c.get('input', {}).get('file_path', '')
                                total += 1
                                if fp.startswith(decoded_project):
                                    in_project += 1
                                elif fp.startswith(os.path.expanduser('~')):
                                    in_home += 1
                                else:
                                    system_level += 1
                    except: pass
        except: pass

print(f'Total Read operations: {total}')
print(f'In-project: {in_project} ({100*in_project/total:.1f}%)')
print(f'In home dir (outside project): {in_home} ({100*in_home/total:.1f}%)')
print(f'System-level: {system_level} ({100*system_level/total:.1f}%)')
"
```

### Task 2: Identify Sensitive In-Project Paths

**Question**: Are there files within the project tree that should still be gated?

**Method**:
1. From the Read paths collected in Task 1, check for patterns like `.env`, `credentials`, `secrets`, `*.pem`, `*.key`, etc.
2. Also check: do any Grep/Glob operations target sensitive patterns?

**Expected output**: A list of sensitive file patterns observed in real usage, if any.

### Task 3: Analyze Grep and Glob Inputs

**Question**: Do Grep/Glob operations ever have safety-relevant characteristics?

**Method**:
1. Extract all Grep inputs — check the `path` and `pattern` fields
2. Extract all Glob inputs — check the `pattern` and `path` fields
3. Look for any that target sensitive locations or patterns

**Expected output**: Confirmation that these are universally safe, or identification of edge cases.

### Task 4: Draft Policy Specification

Based on findings from Tasks 1-3, write a policy spec:

```yaml
# Example policy format (to be refined)
policy:
  name: read-only-auto-approve
  version: 0.1.0
  rules:
    - tool: Read
      decision: approve
      conditions:
        - path_within: "${project_dir}"
        - path_not_matches:
            - "**/.env"
            - "**/.env.*"
            - "**/credentials*"
            - "**/*.pem"
            - "**/*.key"
    - tool: Read
      decision: ask
      conditions:
        - path_not_within: "${project_dir}"
    - tool: Grep
      decision: approve
    - tool: Glob
      decision: approve
    - tool: TodoWrite
      decision: approve
```

### Task 5: Build Test Dataset

Extract all read-only tool uses from session history into a labeled dataset:

```json
{
  "tool": "Read",
  "input": {"file_path": "/Users/dherman/Code/thinkwell/src/index.ts"},
  "context": {
    "project": "/Users/dherman/Code/thinkwell",
    "session": "abc123"
  },
  "labels": {
    "in_project": true,
    "sensitive_file": false,
    "expected_decision": "approve"
  }
}
```

## Implementation Sketch

This workstream is fully deterministic — no LLM needed.

```
Tool use request arrives
  → Is tool in {Read, Grep, Glob, TodoWrite}?
    → No: pass to PR 2 / default handler
    → Yes (Grep, Glob, TodoWrite): AUTO-APPROVE
    → Yes (Read):
        → Is file_path within project directory?
          → Yes: Does it match a sensitive file pattern?
            → No: AUTO-APPROVE
            → Yes: ASK (with reason: "sensitive file")
          → No: ASK (with reason: "outside project")
```

## Success Criteria

- **Coverage**: Auto-approves ≥95% of Read/Grep/Glob/TodoWrite tool uses from the test dataset
- **Safety**: 0% false positives (never auto-approves something that should have been gated)
- **Simplicity**: Entire policy fits in a single deterministic function, no LLM calls

## Dependencies

- Access to `~/.claude/projects/` session data
- Understanding of Claude Code's tool input schemas (documented in [claude-code-history-analysis.md](../../reference/claude-code-history-analysis.md))

## Non-Goals

- Handling Write or Edit tools (that's a separate concern with mutation risk)
- Handling Bash commands (that's PR 2)
- Handling MCP tool calls (future work)
