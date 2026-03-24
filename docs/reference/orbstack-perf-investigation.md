# OrbStack Bind-Mount Performance Investigation

**Date**: 2026-03-24

## Summary

Tested OrbStack bind-mount performance for a representative Node.js project to validate the feasibility of migrating from Seatbelt to containers. Result: **bind-mount performance is at parity with native macOS**, eliminating the key risk identified in the roadmap.

## Test Setup

- **Host**: macOS (Darwin 24.6.0)
- **Container runtime**: OrbStack (Docker-compatible, active context)
- **Container image**: `node:20`
- **Test repo**: Bouncer (6,578 files, 462MB `node_modules`, 4,599 files in `node_modules`)
- **Mount type**: Standard bind mount (`-v /host/path:/workspace`)

## Results

| Operation | Native (ms) | OrbStack Bind Mount (ms) | Ratio |
|---|---|---|---|
| `git status` | 44 | 7 | 0.16x (faster) |
| `find . -type f` (6,578 files) | 41 | 63 | 1.5x |
| `find node_modules` (4,599 files) | 23 | 31 | 1.3x |
| `tsc --noEmit` | 410 | 173 | 0.4x (faster) |

## Analysis

- File enumeration (`find`) shows 1.3-1.5x overhead — negligible for interactive agent sessions.
- Git and TypeScript compiler operations were actually **faster** in the container, likely due to Linux kernel IO scheduling and filesystem caching advantages.
- The previously identified risk ("macOS Docker file-sharing performance with large Node.js projects") is a non-issue with OrbStack. Docker Desktop with virtiofs was not separately tested, as OrbStack is the planned container runtime.

## Implications

- Container migration (Milestone 6) is feasible from a performance perspective.
- No need for hybrid approaches (container + host worktree via high-performance mount) — standard bind mounts work well.
- OrbStack should be the target container runtime for macOS development.
