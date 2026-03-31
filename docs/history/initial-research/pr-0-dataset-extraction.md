# PR 0: Dataset Extraction and Anonymization

## Goal

Produce a clean, anonymized, minimal dataset of tool use requests and their outcomes from real Claude Code session history. This dataset is the foundation for both PR 1 (read-only auto-approval) and PR 2 (Bash command classification).

## Design Principles

- **Anonymized**: No usernames, real project names, or personally identifying paths. Anyone should be able to look at this dataset without learning anything about who generated it or what they were working on.
- **Minimal**: Only the fields needed for policy research. No thinking content, no assistant text, no file contents, no tool result output.
- **Stable**: Checked into git so both workstreams (and future work) operate on the same snapshot.
- **Reproducible**: The extraction script is also checked in, so the dataset can be regenerated from fresh session data.

## What to Extract

For each tool use in the session history, we need one record:

| Field                | Source                   | Description                                          |
| -------------------- | ------------------------ | ---------------------------------------------------- |
| `id`                 | Synthetic                | Sequential integer, stable ordering                  |
| `tool`               | `tool_use.name`          | Tool name (Read, Bash, Edit, etc.)                   |
| `input`              | `tool_use.input`         | Tool input parameters (scrubbed)                     |
| `outcome`            | Derived                  | `approved`, `rejected`, or `error`                   |
| `error_type`         | Derived                  | For errors: `user_rejected` or `system_error`        |
| `project`            | Derived                  | Anonymized project identifier (e.g., `project-01`)   |
| `session`            | Derived                  | Anonymized session identifier (e.g., `session-042`)  |
| `is_subagent`        | `isSidechain` / filename | Whether this occurred in a subagent                  |
| `permission_mode`    | `permissionMode`         | The active permission mode at time of request        |
| `timestamp_relative` | Derived                  | Seconds since start of session (not wall-clock time) |

### Fields Intentionally Excluded

- **`message.content` text**: Assistant reasoning, user prompts — not needed and may contain PII
- **`tool_result` content**: Command output, file contents — not needed and may contain PII
- **Thinking blocks**: Extended thinking content — not needed
- **File history snapshots**: Checkpoint data — not needed
- **Queue operations**: Prompt queuing — not needed
- **UUIDs**: Replaced with sequential IDs to prevent correlation with raw data

## Anonymization Rules

### Path Scrubbing

All file paths are transformed:

| Raw Path                                               | Anonymized                             |
| ------------------------------------------------------ | -------------------------------------- |
| `/Users/dherman/Code/thinkwell/src/index.ts`           | `{project}/src/index.ts`               |
| `/Users/dherman/Code/cadmus/packages/server/src/db.ts` | `{project}/packages/server/src/db.ts`  |
| `/Users/dherman/.claude/settings.json`                 | `{home}/.claude/settings.json`         |
| `/Users/dherman/.zshrc`                                | `{home}/.zshrc`                        |
| `/etc/hosts`                                           | `/etc/hosts` (system paths left as-is) |
| `/tmp/foo`                                             | `/tmp/foo` (temp paths left as-is)     |

Rules:

1. Replace the user's home directory prefix with `{home}`
2. Replace the project directory prefix with `{project}` (the project directory is derived from the session's project path)
3. Leave system paths (`/etc`, `/usr`, `/tmp`, `/var`) unchanged
4. Apply to all string values in tool inputs, recursively

### Project Name Scrubbing

Each unique project directory maps to a stable anonymous name:

| Raw Project                     | Anonymous ID |
| ------------------------------- | ------------ |
| `/Users/dherman/Code/thinkwell` | `project-01` |
| `/Users/dherman/Code/cadmus`    | `project-02` |
| `/Users/dherman/Code/bouncer`   | `project-03` |
| ...                             | `project-NN` |

Assignment order: sorted alphabetically by original path, then numbered sequentially. This ensures stable IDs across re-extractions.

### Session Scrubbing

Each unique session UUID maps to a sequential ID:

| Raw Session                            | Anonymous ID  |
| -------------------------------------- | ------------- |
| `0805e6a3-f2d9-4df8-a0eb-2970477c3c34` | `session-001` |
| `6133ee45-5d2c-4803-aff2-5e4ff1890450` | `session-002` |
| ...                                    | `session-NNN` |

Assignment order: sorted by first-seen timestamp.

### Bash Command Scrubbing

Bash commands need special handling because they contain arbitrary text:

1. **Path replacement**: Apply the same path rules (home → `{home}`, project → `{project}`)
2. **Username replacement**: Replace occurrences of the username in any position with `{user}`
3. **Branch/tag names**: Keep as-is (they're project metadata, not PII)
4. **URLs**: Replace domain names with `{host}` but keep path structure (e.g., `https://{host}/api/v1/foo`)
5. **Environment variables in values**: If a command sets `FOO=bar`, keep the key, replace the value with `{value}` if it looks like a secret (contains token, key, secret, password, etc.)

### Other String Scrubbing

For non-Bash tool inputs:

- **Edit `old_string` / `new_string`**: Keep the code content (it's the thing we're classifying), but apply path scrubbing within it
- **Write `content`**: Replace entirely with `{file_content}` (we don't need file contents for policy research)
- **Grep `pattern`**: Keep as-is (search patterns are not PII)
- **Glob `pattern`**: Keep as-is

## Determining Outcomes

For each tool_use, we need to determine whether it was approved, rejected, or errored:

1. Find the corresponding `tool_result` message (match by `tool_use_id`)
2. Check `toolUseResult` field:
   - `"User rejected tool use"` → outcome: `rejected`
   - Any other `is_error: true` → outcome: `error`
   - Normal result → outcome: `approved`
3. If no matching tool_result found → outcome: `unknown` (shouldn't happen, but handle gracefully)

**Note**: We cannot distinguish "user was prompted and said yes" from "tool was auto-approved by permission mode." Both appear as `approved`. The `permission_mode` field provides some signal — if mode is `bypassPermissions`, the user was definitely not prompted.

## Output Format

### Primary dataset: `data/tool-use-dataset.jsonl`

One JSON object per line, one line per tool use:

```json
{"id": 1, "tool": "Read", "input": {"file_path": "{project}/src/index.ts"}, "outcome": "approved", "project": "project-01", "session": "session-001", "is_subagent": false, "permission_mode": "default", "timestamp_relative": 0}
{"id": 2, "tool": "Bash", "input": {"command": "git status --short", "description": "Check working tree status"}, "outcome": "approved", "project": "project-01", "session": "session-001", "is_subagent": false, "permission_mode": "default", "timestamp_relative": 12}
{"id": 3, "tool": "Bash", "input": {"command": "cd {project} && pnpm install", "description": "Install dependencies"}, "outcome": "rejected", "error_type": "user_rejected", "project": "project-05", "session": "session-023", "is_subagent": false, "permission_mode": "default", "timestamp_relative": 145}
```

### Summary file: `data/dataset-summary.json`

Metadata about the extraction:

```json
{
  "extraction_date": "2026-03-21",
  "source_version": "1.0.0",
  "total_records": 7188,
  "projects_count": 20,
  "sessions_count": 200,
  "tool_distribution": {
    "Bash": 2460,
    "Read": 2129,
    "Edit": 883,
    "...": "..."
  },
  "outcome_distribution": {
    "approved": 7170,
    "rejected": 13,
    "error": 5,
    "unknown": 0
  },
  "anonymization": {
    "paths_scrubbed": true,
    "projects_anonymized": true,
    "sessions_anonymized": true,
    "tool_results_excluded": true,
    "write_content_excluded": true
  }
}
```

## Tasks

### Task 1: Build the Extraction Script

Write `scripts/extract-dataset.py` that:

1. Walks `~/.claude/projects/` to find all `.jsonl` session files
2. Parses each file, correlating tool_use with tool_result messages
3. Applies anonymization rules
4. Outputs `data/tool-use-dataset.jsonl` and `data/dataset-summary.json`

The script should:

- Be idempotent (safe to re-run)
- Accept `--source-dir` argument (default: `~/.claude/projects`)
- Accept `--output-dir` argument (default: `./data`)
- Accept `--username` argument (default: detected from home directory)
- Print progress and summary stats to stderr
- Be well-documented with inline comments explaining anonymization decisions

### Task 2: Run Extraction and Validate

1. Run the script against the real session data
2. Manually spot-check 20-30 records to verify:
   - No raw usernames appear anywhere in the output
   - No real project names appear anywhere in the output
   - Paths are correctly normalized
   - Outcomes are correctly determined
   - Bash commands are properly scrubbed
3. Run a grep for known PII patterns to verify scrubbing:
   ```bash
   grep -i "dherman\|thinkwell\|cadmus\|bouncer" data/tool-use-dataset.jsonl
   # Should return nothing
   ```

### Task 3: Validate Dataset Completeness

Compare extraction stats against the raw data analysis we already did:

- Total tool uses should be ~7,188
- Bash count should be ~2,460
- Rejection count should be ~13
- Tool distribution should match our earlier analysis

Any significant discrepancies indicate a parsing bug.

### Task 4: Update PR 1 and PR 2 Plans

Once the dataset exists, update both PR plans to:

- Reference `data/tool-use-dataset.jsonl` instead of raw session data
- Remove inline extraction scripts (they're now redundant)
- Add filtering commands for their specific needs, e.g.:
  - PR 1: `jq 'select(.tool == "Read" or .tool == "Grep" or .tool == "Glob")' data/tool-use-dataset.jsonl`
  - PR 2: `jq 'select(.tool == "Bash")' data/tool-use-dataset.jsonl`

## Output Location

```
bouncer/
├── data/
│   ├── tool-use-dataset.jsonl    # The anonymized dataset
│   └── dataset-summary.json      # Extraction metadata
├── scripts/
│   └── extract-dataset.py        # The extraction script
└── docs/
    └── pr-0-dataset-extraction.md  # This document
```

## Success Criteria

- [ ] Dataset contains all tool use records from session history (~7,188 expected)
- [ ] Zero PII in the output (verified by automated grep + manual spot-check)
- [ ] File size is reasonable for git (target: <5MB for the JSONL, ideally <2MB)
- [ ] Both PR 1 and PR 2 can operate entirely from this dataset without touching raw session data
- [ ] Script is re-runnable to incorporate new sessions in the future

## Dependencies

- Access to `~/.claude/projects/` (raw session data on this device)
- Python 3 (for the extraction script)

## Non-Goals

- Real-time streaming extraction (this is a batch process)
- Preserving message ordering across sessions (within-session ordering is preserved)
- Extracting non-tool-use data (user prompts, assistant text, thinking)
