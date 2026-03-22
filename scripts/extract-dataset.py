#!/usr/bin/env python3
"""
Extract and anonymize tool use records from Claude Code session history.

Produces a clean JSONL dataset suitable for policy research, with all PII
(usernames, project names, paths, URLs) scrubbed.

Usage:
    python3 scripts/extract-dataset.py
    python3 scripts/extract-dataset.py --source-dir ~/.claude/projects --output-dir ./data
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Anonymization helpers
# ---------------------------------------------------------------------------

def make_anonymizer(home_dir: str, username: str,
                    email_local_parts: list[str] | None = None,
                    full_name_patterns: list[str] | None = None):
    """Return a closure that holds anonymization state across the full run."""

    # Maps raw project path -> "project-NN"
    project_map: dict[str, str] = {}
    # Maps raw session UUID -> "session-NNN"
    session_map: dict[str, str] = {}
    # Track first-seen timestamp per session for ordering
    session_first_seen: dict[str, str] = {}

    # Patterns for secret-looking env var values
    SECRET_PATTERN = re.compile(r'(token|key|secret|password|passwd|credential|auth)', re.IGNORECASE)

    # URL domain pattern
    URL_PATTERN = re.compile(r'(https?://)([^/\s:]+)((?::\d+)?(?:/\S*)?)')

    def register_project(raw_path: str):
        """Register a project path; assignment happens later in finalize_ordering."""
        if raw_path not in project_map:
            project_map[raw_path] = None  # placeholder

    def register_session(raw_uuid: str, timestamp: str):
        """Register a session UUID with its first-seen timestamp."""
        if raw_uuid not in session_first_seen:
            session_first_seen[raw_uuid] = timestamp
            session_map[raw_uuid] = None  # placeholder

    def finalize_ordering():
        """Assign stable IDs: projects alphabetically, sessions by first-seen time."""
        for i, path in enumerate(sorted(project_map.keys()), 1):
            project_map[path] = f"project-{i:02d}"

        sorted_sessions = sorted(session_first_seen.keys(),
                                 key=lambda s: session_first_seen[s])
        for i, uuid in enumerate(sorted_sessions, 1):
            session_map[uuid] = f"session-{i:03d}"

        # Build project basenames for scrubbing encoded directory names.
        # Extract unique basenames from project paths, excluding the home dir
        # prefix and generic names that would cause false positives.
        seen_basenames: set[str] = set()
        generic = {"Code", "src", "examples", "packages", "server", "experiments",
                   ".claude", "worktrees", "subagents", "vscode-extension",
                   "pkg-poc"}
        for raw_path in project_map.keys():
            # Get path components after home dir
            if raw_path.startswith(home_dir):
                rel = raw_path[len(home_dir):].strip("/")
            else:
                rel = raw_path.strip("/")
            parts = rel.split("/")
            for part in parts:
                # Skip generic directory names and very short names
                if part and part not in generic and len(part) > 2:
                    seen_basenames.add(part)

        # Sort longest-first to avoid partial replacement issues.
        # Build a regex pattern for case-insensitive matching.
        project_basenames.clear()
        for bn in sorted(seen_basenames, key=len, reverse=True):
            project_basenames.append((re.compile(re.escape(bn), re.IGNORECASE), "{project-name}"))

    def get_project_id(raw_path: str) -> str:
        return project_map.get(raw_path, "project-unknown")

    def get_session_id(raw_uuid: str) -> str:
        return session_map.get(raw_uuid, "session-unknown")

    def scrub_path(path_str: str, project_dir: str | None) -> str:
        """Replace home dir and project dir prefixes in a path string."""
        if not isinstance(path_str, str):
            return path_str

        # Replace project dir first (more specific), then home dir
        if project_dir and path_str.startswith(project_dir):
            path_str = "{project}" + path_str[len(project_dir):]
        elif path_str.startswith(home_dir):
            path_str = "{home}" + path_str[len(home_dir):]

        return path_str

    def scrub_url(match: re.Match) -> str:
        """Replace URL domain with {host}, keep path structure."""
        scheme = match.group(1)
        path_part = match.group(3)
        return f"{scheme}{{host}}{path_part}"

    def scrub_env_value(command: str) -> str:
        """Replace values of secret-looking env vars with {value}."""
        def replace_secret(m):
            return f"{m.group(1)}={{value}}"
        # Match KEY=VALUE where KEY contains a secret-ish word
        return re.sub(
            r'(\b\w*(?:' + SECRET_PATTERN.pattern + r')\w*)\s*=\s*(\S+)',
            replace_secret, command, flags=re.IGNORECASE
        )

    def scrub_bash_command(command: str, project_dir: str | None) -> str:
        """Apply all scrubbing rules to a Bash command string."""
        if not isinstance(command, str):
            return command

        # 1. Path replacement
        if project_dir:
            command = command.replace(project_dir, "{project}")
        command = command.replace(home_dir, "{home}")

        # 2. Email and full name (before username, since username is a substring)
        command = EMAIL_PATTERN.sub("{email}", command)
        if FULLNAME_PATTERN:
            command = FULLNAME_PATTERN.sub("{user}", command)

        # 3. Username replacement (in any position)
        command = command.replace(username, "{user}")

        # 4. URL domain scrubbing
        command = URL_PATTERN.sub(scrub_url, command)

        # 5. Secret env var values
        command = scrub_env_value(command)

        return command

    # Email pattern: match any of the configured local parts followed by @domain
    _email_parts = [re.escape(username)]
    for part in (email_local_parts or []):
        if part != username:
            _email_parts.append(re.escape(part))
    EMAIL_PATTERN = re.compile(
        r'\b(?:' + '|'.join(_email_parts) + r')@[a-zA-Z0-9._-]+\b',
        re.IGNORECASE
    )

    # Full name pattern: match any of the configured name variants
    if full_name_patterns:
        _name_alts = '|'.join(re.escape(p) for p in full_name_patterns)
        FULLNAME_PATTERN = re.compile(r'\b(?:' + _name_alts + r')\b', re.IGNORECASE)
    else:
        FULLNAME_PATTERN = None

    def scrub_string(value: str, project_dir: str | None) -> str:
        """Generic string scrubbing: paths, username, email, full name."""
        if not isinstance(value, str):
            return value
        if project_dir:
            value = value.replace(project_dir, "{project}")
        value = value.replace(home_dir, "{home}")
        value = EMAIL_PATTERN.sub("{email}", value)
        if FULLNAME_PATTERN:
            value = FULLNAME_PATTERN.sub("{user}", value)
        value = value.replace(username, "{user}")
        return value

    # Set of project basenames to scrub, built during finalize_ordering
    project_basenames: list[tuple[str, str]] = []  # (basename, replacement) sorted longest-first

    def scrub_all_project_names(value: str) -> str:
        """Replace any known project path or project basename in strings.

        This catches cross-references (e.g., session from project A reading
        files from project B's Claude Code directory) including the encoded
        directory names used inside ~/.claude/projects/.
        """
        if not isinstance(value, str):
            return value
        # Replace full paths first (longest first)
        for raw_path in sorted(project_map.keys(), key=len, reverse=True):
            if raw_path in value:
                value = value.replace(raw_path, "{project}")
        # Replace basenames (catches encoded dir names like -Users-{user}-Code-myproject)
        for pattern, replacement in project_basenames:
            value = pattern.sub(replacement, value)
        return value

    def scrub_value(value, project_dir: str | None):
        """Recursively scrub any value: strings, dicts, lists."""
        if isinstance(value, str):
            return scrub_all_project_names(scrub_string(value, project_dir))
        elif isinstance(value, dict):
            return {k: scrub_value(v, project_dir) for k, v in value.items()}
        elif isinstance(value, list):
            return [scrub_value(v, project_dir) for v in value]
        else:
            return value

    def scrub_tool_input(tool_name: str, tool_input: dict, project_dir: str | None) -> dict:
        """Scrub tool input according to tool-specific rules."""
        if not isinstance(tool_input, dict):
            return tool_input

        result = {}
        for key, value in tool_input.items():
            if tool_name == "Bash" and key == "command":
                result[key] = scrub_all_project_names(scrub_bash_command(value, project_dir))
            elif tool_name == "Write" and key == "content":
                # Replace file contents entirely — not needed for policy research
                result[key] = "{file_content}"
            elif tool_name == "NotebookEdit" and key in ("new_source", "source"):
                result[key] = "{cell_content}"
            else:
                result[key] = scrub_value(value, project_dir)
        return result

    return {
        "register_project": register_project,
        "register_session": register_session,
        "finalize_ordering": finalize_ordering,
        "get_project_id": get_project_id,
        "get_session_id": get_session_id,
        "scrub_tool_input": scrub_tool_input,
        "scrub_all_project_names": scrub_all_project_names,
        "project_map": project_map,
        "session_map": session_map,
    }


# ---------------------------------------------------------------------------
# Session parsing
# ---------------------------------------------------------------------------

def extract_project_path_from_file(filepath: Path) -> str | None:
    """Read the first user message's cwd to get the real project path.

    The encoded directory name is ambiguous (hyphens vs slashes), so we
    extract the actual project path from session data instead.
    """
    try:
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    cwd = msg.get("cwd")
                    if cwd:
                        return cwd
                except json.JSONDecodeError:
                    continue
    except (OSError, IOError):
        pass
    return None


def find_all_session_files(source_dir: Path) -> list[tuple[str | None, Path, bool]]:
    """Find all .jsonl session files under the source dir.

    Returns list of (project_path_or_None, file_path, is_subagent).
    Project path is extracted from file contents (cwd field), not the dir name.
    """
    results = []
    for project_dirname in sorted(os.listdir(source_dir)):
        project_path_dir = source_dir / project_dirname
        if not project_path_dir.is_dir():
            continue

        # Main session files: UUID.jsonl directly in the project dir
        for entry in sorted(os.listdir(project_path_dir)):
            entry_path = project_path_dir / entry
            if entry_path.is_file() and entry.endswith(".jsonl"):
                results.append((None, entry_path, False))  # project_path filled in during parse
            elif entry_path.is_dir():
                # Could be a session subdir with subagents/
                subagents_dir = entry_path / "subagents"
                if subagents_dir.is_dir():
                    for agent_file in sorted(os.listdir(subagents_dir)):
                        if agent_file.endswith(".jsonl"):
                            results.append((None, subagents_dir / agent_file, True))

    return results


def parse_session_file(filepath: Path, is_subagent: bool,
                       anonymizer: dict) -> list[dict]:
    """Parse a single session .jsonl file and extract tool use records.

    Returns a list of raw (pre-anonymization-ID) record dicts.
    """
    records = []

    # Two-pass: first collect all tool_uses and tool_results, then correlate
    messages = []
    try:
        with open(filepath, "r") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    messages.append(msg)
                except json.JSONDecodeError:
                    print(f"  Warning: skipping malformed JSON at {filepath}:{line_num}",
                          file=sys.stderr)
    except (OSError, IOError) as e:
        print(f"  Warning: cannot read {filepath}: {e}", file=sys.stderr)
        return []

    # Extract project path from the first cwd field we find
    project_path = None
    for msg in messages:
        cwd = msg.get("cwd")
        if cwd:
            project_path = cwd
            break

    if not project_path:
        # No cwd found — skip this file (likely empty or non-session data)
        return []

    # Build a map of tool_use_id -> tool_result info
    tool_results: dict[str, dict] = {}
    # Track permission_mode from user messages (most recent seen)
    current_permission_mode = "default"
    # Track the first timestamp in this file for session ordering
    first_timestamp = None

    for msg in messages:
        ts = msg.get("timestamp")
        if ts and first_timestamp is None:
            first_timestamp = ts

        if msg.get("type") == "user":
            # Update permission mode if present
            pm = msg.get("permissionMode")
            if pm:
                current_permission_mode = pm

            # Check for tool_result in content
            content = msg.get("message", {}).get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tool_use_id = block.get("tool_use_id")
                        if tool_use_id:
                            is_error = block.get("is_error", False)
                            tool_use_result_field = msg.get("toolUseResult")

                            if tool_use_result_field == "User rejected tool use":
                                outcome = "rejected"
                                error_type = "user_rejected"
                            elif is_error:
                                outcome = "error"
                                error_type = "system_error"
                            else:
                                outcome = "approved"
                                error_type = None

                            tool_results[tool_use_id] = {
                                "outcome": outcome,
                                "error_type": error_type,
                            }

    # Determine session ID from the file
    session_id = None
    for msg in messages:
        sid = msg.get("sessionId")
        if sid:
            session_id = sid
            break

    # If no sessionId found, derive from filename for main sessions
    if not session_id:
        stem = filepath.stem
        if not stem.startswith("agent-"):
            session_id = stem

    if session_id and first_timestamp:
        anonymizer["register_session"](session_id, first_timestamp)

    anonymizer["register_project"](project_path)

    # Second pass: extract tool_use blocks
    # Track permission_mode chronologically
    current_permission_mode = "default"
    first_ts_value = None  # for computing relative timestamps

    for msg in messages:
        if msg.get("type") == "user":
            pm = msg.get("permissionMode")
            if pm:
                current_permission_mode = pm

        if msg.get("type") != "assistant":
            continue

        content = msg.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue

        msg_timestamp = msg.get("timestamp")

        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue

            tool_use_id = block.get("id")
            tool_name = block.get("name", "unknown")
            tool_input = block.get("input", {})

            # Look up outcome
            result_info = tool_results.get(tool_use_id, {})
            outcome = result_info.get("outcome", "unknown")
            error_type = result_info.get("error_type")

            # Compute relative timestamp
            ts = msg_timestamp
            if ts:
                if first_ts_value is None:
                    first_ts_value = _parse_timestamp(ts)
                ts_parsed = _parse_timestamp(ts)
                if first_ts_value is not None and ts_parsed is not None:
                    timestamp_relative = int((ts_parsed - first_ts_value))
                else:
                    timestamp_relative = 0
            else:
                timestamp_relative = 0

            record = {
                "_raw_project": project_path,
                "_raw_session": session_id,
                "_raw_tool_use_id": tool_use_id,
                "tool": tool_name,
                "input": tool_input,
                "outcome": outcome,
                "is_subagent": is_subagent or msg.get("isSidechain", False),
                "permission_mode": current_permission_mode,
                "timestamp_relative": timestamp_relative,
            }
            if error_type:
                record["error_type"] = error_type

            records.append(record)

    return records


def _parse_timestamp(ts) -> float | None:
    """Parse a timestamp (ISO string or epoch ms) to epoch seconds."""
    if isinstance(ts, (int, float)):
        return ts / 1000.0
    if isinstance(ts, str):
        try:
            from datetime import datetime, timezone
            # Handle ISO 8601 with Z suffix
            ts_clean = ts.replace("Z", "+00:00")
            dt = datetime.fromisoformat(ts_clean)
            return dt.timestamp()
        except (ValueError, TypeError):
            return None
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Extract anonymized tool use dataset from Claude Code session history"
    )
    parser.add_argument("--source-dir", type=str,
                        default=os.path.expanduser("~/.claude/projects"),
                        help="Path to Claude Code projects directory")
    parser.add_argument("--output-dir", type=str, default="./data",
                        help="Output directory for dataset files")
    parser.add_argument("--scrub-config", type=str,
                        default=os.path.join(os.path.dirname(__file__), "scrub-config.json"),
                        help="Path to scrub config JSON (contains PII patterns to scrub)")
    args = parser.parse_args()

    source_dir = Path(args.source_dir)
    output_dir = Path(args.output_dir)
    home_dir = os.path.expanduser("~")

    # Load scrub config
    config_path = Path(args.scrub_config)
    if not config_path.is_file():
        print(f"Error: scrub config not found: {config_path}", file=sys.stderr)
        print("Create scripts/scrub-config.json with your PII patterns. See README.", file=sys.stderr)
        sys.exit(1)

    with open(config_path) as f:
        scrub_config = json.load(f)

    username = scrub_config.get("username", os.path.basename(home_dir))
    email_local_parts = scrub_config.get("email_local_parts", [])
    full_name_patterns = scrub_config.get("full_name_patterns", [])
    exclude_sessions = set(scrub_config.get("exclude_sessions", []))

    if not source_dir.is_dir():
        print(f"Error: source directory not found: {source_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Source: {source_dir}", file=sys.stderr)
    print(f"Output: {output_dir}", file=sys.stderr)
    print(f"Username to scrub: {username}", file=sys.stderr)
    print(file=sys.stderr)

    anonymizer = make_anonymizer(home_dir, username, email_local_parts, full_name_patterns)

    # --- Pass 1: Discover and parse all session files ---
    print("Discovering session files...", file=sys.stderr)
    session_files = find_all_session_files(source_dir)
    print(f"  Found {len(session_files)} session files", file=sys.stderr)

    all_records = []
    files_processed = 0

    for _, filepath, is_subagent in session_files:
        # Skip excluded sessions (match UUID in any path component)
        if exclude_sessions and any(uuid in str(filepath) for uuid in exclude_sessions):
            continue
        records = parse_session_file(filepath, is_subagent, anonymizer)
        all_records.extend(records)
        files_processed += 1
        if files_processed % 50 == 0:
            print(f"  Processed {files_processed}/{len(session_files)} files "
                  f"({len(all_records)} records so far)...", file=sys.stderr)

    print(f"  Done: {files_processed} files, {len(all_records)} tool use records",
          file=sys.stderr)

    # --- Finalize anonymization ordering ---
    anonymizer["finalize_ordering"]()

    # --- Pass 2: Apply anonymization and assign sequential IDs ---
    print("Anonymizing records...", file=sys.stderr)

    # Sort by project, session, then relative timestamp for stable ordering
    all_records.sort(key=lambda r: (
        anonymizer["get_project_id"](r["_raw_project"]),
        anonymizer["get_session_id"](r["_raw_session"]) if r["_raw_session"] else "",
        r["timestamp_relative"],
    ))

    output_records = []
    for i, rec in enumerate(all_records, 1):
        project_dir = rec["_raw_project"]
        out = {
            "id": i,
            "tool": anonymizer["scrub_all_project_names"](rec["tool"]),
            "input": anonymizer["scrub_tool_input"](rec["tool"], rec["input"], project_dir),
            "outcome": rec["outcome"],
        }
        if "error_type" in rec:
            out["error_type"] = rec["error_type"]
        out["project"] = anonymizer["get_project_id"](project_dir)
        out["session"] = anonymizer["get_session_id"](rec["_raw_session"]) if rec["_raw_session"] else "session-unknown"
        out["is_subagent"] = rec["is_subagent"]
        out["permission_mode"] = rec["permission_mode"]
        out["timestamp_relative"] = rec["timestamp_relative"]

        output_records.append(out)

    # --- Write JSONL ---
    dataset_path = output_dir / "tool-use-dataset.jsonl"
    print(f"Writing {len(output_records)} records to {dataset_path}...", file=sys.stderr)
    with open(dataset_path, "w") as f:
        for rec in output_records:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    dataset_size = dataset_path.stat().st_size
    print(f"  Dataset size: {dataset_size / 1024 / 1024:.2f} MB", file=sys.stderr)

    # --- Compute and write summary ---
    tool_dist: dict[str, int] = {}
    outcome_dist: dict[str, int] = {}
    projects_seen: set[str] = set()
    sessions_seen: set[str] = set()

    for rec in output_records:
        tool_dist[rec["tool"]] = tool_dist.get(rec["tool"], 0) + 1
        outcome_dist[rec["outcome"]] = outcome_dist.get(rec["outcome"], 0) + 1
        projects_seen.add(rec["project"])
        sessions_seen.add(rec["session"])

    # Sort tool distribution by count descending
    tool_dist = dict(sorted(tool_dist.items(), key=lambda x: -x[1]))
    outcome_dist = dict(sorted(outcome_dist.items(), key=lambda x: -x[1]))

    from datetime import date
    summary = {
        "extraction_date": str(date.today()),
        "source_version": "1.0.0",
        "total_records": len(output_records),
        "projects_count": len(projects_seen),
        "sessions_count": len(sessions_seen),
        "tool_distribution": tool_dist,
        "outcome_distribution": outcome_dist,
        "anonymization": {
            "paths_scrubbed": True,
            "projects_anonymized": True,
            "sessions_anonymized": True,
            "tool_results_excluded": True,
            "write_content_excluded": True,
        }
    }

    summary_path = output_dir / "dataset-summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    # --- Print summary ---
    print(file=sys.stderr)
    print("=== Extraction Summary ===", file=sys.stderr)
    print(f"Total records: {summary['total_records']}", file=sys.stderr)
    print(f"Projects: {summary['projects_count']}", file=sys.stderr)
    print(f"Sessions: {summary['sessions_count']}", file=sys.stderr)
    print(file=sys.stderr)
    print("Tool distribution:", file=sys.stderr)
    for tool, count in tool_dist.items():
        pct = 100 * count / len(output_records) if output_records else 0
        print(f"  {tool:20s} {count:5d}  ({pct:.1f}%)", file=sys.stderr)
    print(file=sys.stderr)
    print("Outcome distribution:", file=sys.stderr)
    for outcome, count in outcome_dist.items():
        pct = 100 * count / len(output_records) if output_records else 0
        print(f"  {outcome:20s} {count:5d}  ({pct:.1f}%)", file=sys.stderr)
    print(file=sys.stderr)

    # --- Project mapping (for debugging, printed to stderr only) ---
    print("Project mapping:", file=sys.stderr)
    for raw, anon in sorted(anonymizer["project_map"].items(), key=lambda x: x[1]):
        print(f"  {anon} <- {raw}", file=sys.stderr)
    print(file=sys.stderr)

    print(f"Dataset written to: {dataset_path}", file=sys.stderr)
    print(f"Summary written to: {summary_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
