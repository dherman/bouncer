# macOS Seatbelt (sandbox-exec) Reference

Practical reference for using macOS Seatbelt sandboxing in Bouncer. Seatbelt is the mechanism used by Claude Code, Cursor, and OpenAI Codex for agent sandboxing on macOS.

## Invoking sandbox-exec

```bash
sandbox-exec [options] command [arguments...]
```

Options:
- `-f profile-file` — read sandbox profile from a file
- `-n profile-name` — use a built-in profile by name
- `-p profile-string` — specify profile inline
- `-D key=value` — set a profile parameter (repeatable)

Examples:
```bash
# Run a command with a profile file
sandbox-exec -f myprofile.sb /bin/ls /tmp

# Inline profile
sandbox-exec -p '(version 1)(allow default)(deny network*)' curl https://example.com

# Parameterized profile
sandbox-exec -D "WORKTREE=/Users/dave/project" -f session.sb ./build.sh
```

## SBPL Profile Syntax

SBPL (Sandbox Profile Language) uses Scheme-like S-expressions. Profiles start with a version declaration, set a default policy, then add rules.

### Basic structure

```scheme
(version 1)
(deny default)                              ; deny everything by default

; Allow reading system libraries
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/System"))

; Allow read+write within a specific directory
(allow file-read* (subpath "/Users/dave/project"))
(allow file-write* (subpath "/Users/dave/project"))

; Allow process execution
(allow process-exec (literal "/bin/sh"))

; Allow writing to /dev/null
(allow file-write* (literal "/dev/null"))
```

### Path matching predicates

- `(literal "/exact/path")` — matches exactly one path
- `(subpath "/some/dir")` — matches the directory and everything beneath it recursively
- `(regex "^/private/etc/.*")` — regex matching on paths

### Key operation categories

- `file-read*` — all file read operations
- `file-write*` — all file write operations
- `process-exec` — executing a new program
- `process-fork` — forking a new process
- `network*` — all networking
- `network-outbound` — outbound connections only
- `network-inbound` — inbound connections only
- `mach-lookup` — Mach IPC service lookups
- `sysctl-read` — reading kernel parameters
- `signal` — sending signals to processes

### Importing built-in profiles

```scheme
(import "/System/Library/Sandbox/Profiles/bsd.sb")
(deny network*)
```

System profiles are at `/usr/share/sandbox/` and can be examined for reference.

## Parameterization

Pass parameters on the command line with `-D key=value` and reference them in the profile with `(param "KEY")`:

```bash
sandbox-exec -D "USER_HOME=/Users/dave" -D "PROJECT_DIR=/Users/dave/project" -f profile.sb ./cmd
```

```scheme
(version 1)
(deny default)
(allow file-read* (subpath (param "USER_HOME")))
(allow file-write* (subpath (param "PROJECT_DIR")))
```

Conditional logic with parameters:

```scheme
(define NETWORK_ENABLED (param "NETWORK_ENABLED"))
(if (string=? NETWORK_ENABLED "yes")
  (allow network-outbound))
```

## Detecting Sandbox Violations

### What the sandboxed process sees

Blocked system calls fail with `EPERM` ("Operation not permitted"). The process receives this as a normal error return. A profile can override with `(with EBADEXEC)` to return a different errno.

### System log monitoring

The sandbox kernel extension logs violations. Monitor in real-time:

```bash
# All sandbox violations
log stream --style compact --predicate 'sender=="Sandbox"'

# Violations from a specific process
log stream --style compact --predicate 'sender=="Sandbox" and eventMessage contains "python"'
```

Also searchable in Console.app under "Sandbox".

### Controlling logging in profiles

- Suppress logging: `(deny file-read* (literal "/secret") (with no-log))`
- Crash with backtrace (for debugging): `(deny file-read* (literal "/secret") (with send-signal SIGFPE))`

### External detection strategy for Bouncer

There is no callback API for sandbox violations. Options:
1. Parse the macOS unified log stream (as above)
2. Detect `EPERM` errors in ACP tool-call results
3. Both — log stream for comprehensive monitoring, EPERM for immediate feedback

## Limitations

### Deprecation status

Marked deprecated in the man page since ~2016, but still works on macOS 15.x Sequoia. Apple's App Sandbox is built on the same kernel subsystem, so the underlying technology is actively maintained. Claude Code, Cursor, and Codex all rely on it in production.

Apple has not provided a non-deprecated alternative for sandboxing arbitrary CLI processes.

### No official documentation

Apple has never publicly documented SBPL syntax. Everything known comes from reverse engineering, examining system profiles, and community research.

### Network filtering is coarse

Seatbelt can:
- Block all network or allow all network
- Filter to localhost vs. everything: `(allow network* (remote ip "localhost:*"))`

Seatbelt **cannot**:
- Filter by remote domain name
- Filter by specific remote IP address (only `localhost` or `*`)
- Filter by specific port for remote hosts

**Workaround** (used by Claude Code and Cursor): Block all network except localhost proxy ports in the Seatbelt profile. Run HTTP/SOCKS proxy servers outside the sandbox that enforce domain-level allowlists.

### No nesting

Cannot run `sandbox-exec` inside an already-sandboxed process — this is a kernel-level restriction.

However, the sandbox **automatically inherits to all child processes** spawned via `fork`/`exec`. This inheritance is mandatory and cannot be removed from inside the sandbox. This means the entire subprocess tree is constrained, which is exactly what we want for agent sandboxing.

**Exception**: processes launched via `LaunchServices.framework` (i.e., the `open` command) may not inherit the sandbox.

### Potential OS update breakage

Since the tool is deprecated, Apple could change behavior without notice. There was a reported bug where network blocking stopped working on macOS Catalina (later resolved).

## How Others Use It

### Claude Code (`@anthropic-ai/sandbox-runtime`)
- Dynamically generated profiles scoped to CWD
- All network blocked except localhost proxy ports
- HTTP and SOCKS5 proxies outside sandbox enforce domain allowlists
- Source: https://github.com/anthropic-experimental/sandbox-runtime

### Cursor
- Dynamically generates SBPL from workspace settings, admin settings, and `.cursorignore`
- Denies write access to sensitive config (`.vscode/`, `.cursor/`, `.git/config`, git hooks)
- Source: https://cursor.com/blog/agent-sandboxing

### OpenAI Codex
- Base policy file inspired by Chromium's sandbox
- Dynamically constructs profiles from `SandboxPolicy` struct
- Carves out `.git` directories as read-only
- Network is binary: full or none
- Source: https://github.com/openai/codex
