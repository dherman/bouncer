# Sandboxing Technologies and Agent Sandbox Landscape

Research conducted March 2026 to inform Bouncer's architecture.

## Key Insight: Boundary Upfront vs. Inspect Each Action

Every mature sandboxing system defines a **boundary upfront** and lets the process run freely within it. None try to inspect each action and decide "is this one okay?"

| System | Abstraction Level | Policy Model |
|--------|-------------------|-------------|
| Capsicum/CloudABI | Object capabilities (fd rights) | Boundary upfront — capabilities granted at process start |
| Seccomp-BPF | Syscall numbers + args | BPF filter installed upfront, inspects each syscall against fixed program |
| Landlock | Filesystem paths, network ports | Boundary upfront — stackable rulesets, unprivileged |
| macOS Seatbelt | Mach/BSD operations + paths | Boundary upfront — SBPL profile compiled at process launch |
| WASI | Module imports | Boundary upfront — host-granted capability handles |
| Containers (Docker) | Namespaces + layered policies | Boundary upfront — multi-layer (seccomp + AppArmor + netpol) |
| gVisor | Syscall emulation | Each syscall intercepted + emulated by user-space kernel |
| Firecracker | Hardware virtualization (KVM) | Hardware-enforced boundary — VM config at creation |
| Agent sandboxes (E2B, etc.) | VM or container boundary | Boundary upfront — SDK/API at creation |

This pattern directly informed Bouncer's pivot from per-action tool-use classification to boundary-based sandboxing.

## OS-Level Sandboxing Systems

### Capsicum / CloudABI / WASI Capabilities

Capability-based security operates at the object-reference level. A **capability** is an unforgeable pair of (resource reference, set of rights). If you hold it, you can use it; if you don't, you can't. There is no ambient authority.

- **Capsicum** (FreeBSD): adds "capability mode" to UNIX. When a process enters capability mode, it loses all ambient authority — it can no longer use global namespaces like the filesystem path hierarchy. The only resources it can access are file descriptors it already holds, which can be restricted to specific rights (e.g., read-only).
- **CloudABI**: built on Capsicum to create a portable ABI where all programs run in capability mode from the start. Redesigned the UNIX syscall surface to remove any calls that reference global namespaces.
- **WASI**: the WebAssembly analog. The host "preopens" specific directory handles at module instantiation. All filesystem operations take a directory handle + relative path, and the runtime sandboxes path resolution. A module literally cannot name a file outside its granted directories. Network access similarly requires capability handles.

Capabilities compose by delegation and restriction: a parent can hand a child a subset of its own capabilities. Rights can only be narrowed, never widened. This is directly relevant to Bouncer's subagent boundary composition (Milestone 6).

### Seccomp-BPF (Linux)

Operates at the syscall boundary. A BPF program is attached to a process and receives syscall number + arguments, returning a verdict (allow, kill, trap, log, error). Docker's default seccomp profile disables ~44 of 300+ Linux syscalls.

Filters are inherited by child processes and can only be made more restrictive. A process can add new filters but never remove existing ones.

### Landlock LSM (Linux)

Operates at the filesystem and network access level. A process creates a "ruleset" specifying handled access types, adds rules mapping paths/ports to allowed operations, then enforces the ruleset on itself via `landlock_restrict_self()`.

Key properties:
- **Unprivileged** — any process can sandbox itself without root
- **Stackable** — each enforcement adds a layer; access granted only if all layers permit
- **Filesystem + network** — since Linux 6.7, controls both path access and network ports

Relevant to Bouncer if we expand beyond macOS.

### macOS Seatbelt

See [seatbelt-reference.md](./seatbelt-reference.md) for detailed practical guide.

### Firecracker / MicroVMs

Firecracker uses KVM hardware virtualization. Each microVM gets its own guest kernel — even full kernel compromise only hits the hardware virtualization boundary.

- VMM is ~50K lines of Rust (vs. QEMU's ~2M lines of C)
- Minimal virtual device model: only virtio-net, virtio-block, serial console
- Boot time ~125ms, memory overhead <5 MiB per VM
- The Firecracker process itself runs inside a "Jailer" that applies cgroups, namespaces, seccomp, and chroot — defense in depth
- Used by AWS Lambda for per-request isolation

## Agent Sandboxing Landscape (2024-2026)

### E2B

- **Isolation**: Firecracker microVMs (dedicated kernel per sandbox)
- **Policy**: Host defines filesystem mounts, network policies, resource limits at sandbox creation via SDK
- **Scale**: ~15M sessions/month (as of March 2025). Open source (Apache 2.0), self-hostable
- **Tradeoff**: Strongest isolation but higher overhead than containers

### Daytona

- **Isolation**: Docker containers (shared kernel, faster startup)
- **Policy**: Standard Docker container workflows, sub-90ms cold starts
- **Tradeoff**: Faster startup but weaker isolation than microVMs

### Modal

- **Isolation**: gVisor-based containers with autoscaling
- **Policy**: Code-first Python SDK, per-sandbox egress policies. No YAML — everything in code

### Cursor

- **Isolation**: OS-native sandboxing (Seatbelt on macOS)
- **Policy**: Dynamically generates SBPL profiles restricting filesystem access to project directory; network routed through localhost proxy with domain allowlists
- **Result**: Sandboxed agents stop 40% less often than unsandboxed ones
- Evaluated VMs, containers, and App Sandbox before choosing Seatbelt for low overhead and fine granularity
- Blog post: https://cursor.com/blog/agent-sandboxing

### Claude Code

- **Isolation**: Seatbelt on macOS, Bubblewrap (bwrap) on Linux
- **Policy**: Filesystem restricted to CWD and necessary paths; network routed through HTTP/SOCKS proxies that enforce domain allowlists. Seccomp-BPF on Linux additionally blocks Unix domain socket creation
- **Result**: 84% fewer permission prompts
- Open source: `@anthropic-ai/sandbox-runtime` npm package
- Blog post: https://www.anthropic.com/engineering/claude-code-sandboxing

### OpenAI Codex

- **Isolation**: Seatbelt on macOS with base policy file (`seatbelt_base_policy.sbpl`) inspired by Chromium's sandbox
- **Policy**: Dynamically constructs profiles from a `SandboxPolicy` struct. Enumerates writable roots but carves out `.git` as read-only. Network is binary: full or none
- Source: https://github.com/openai/codex

### Kubernetes Agent Sandbox

- Google/GKE open-source project for running agent workloads on Kubernetes
- gVisor isolation, pod-level network policies, ephemeral lifecycle management

## Claude Code Sandbox Gap Analysis

Based on analysis from Agent Safehouse (https://agent-safehouse.dev):

**Architectural gaps in Claude Code's current sandbox:**

1. **Bash-only**: The sandbox applies only to the Bash tool. Read, Write, Edit, WebSearch, WebFetch, MCP tools, hooks, and internal commands all operate outside sandbox protection.
2. **MCP tools unprotected**: MCP tools can make arbitrary network calls outside the sandbox.
3. **Hook system**: Hooks execute arbitrary code. While `allowManagedHooksOnly` exists, user-defined hooks provide uncontrolled execution paths.
4. **WebFetch/WebSearch**: Only complete denial works — no URL-level allowlisting.
5. **Pattern matching fragility**: Permission rules support command pattern matching but have had a history of bypasses (command injection via line continuation, wildcard rule bypasses via compound commands).

These gaps directly motivate Bouncer's approach of sandboxing at the process level (the entire agent and its subprocesses) rather than at the tool level.

## Sources

- Capsicum: https://en.wikipedia.org/wiki/Capsicum_(Unix)
- WASI 0.2: https://bytecodealliance.org/articles/WASI-0.2
- Landlock: https://landlock.io/ and https://docs.kernel.org/userspace-api/landlock.html
- Seccomp-BPF: https://www.kernel.org/doc/html/v4.19/userspace-api/seccomp_filter.html
- Firecracker: https://github.com/firecracker-microvm/firecracker
- gVisor: https://gvisor.dev/docs/architecture_guide/security/
- Cursor agent sandboxing: https://cursor.com/blog/agent-sandboxing
- Claude Code sandboxing: https://www.anthropic.com/engineering/claude-code-sandboxing
- Agent Safehouse: https://agent-safehouse.dev/docs/agent-investigations/claude-code.html
- Agent sandbox comparison: https://modal.com/blog/top-code-agent-sandbox-products
- OpenAI Codex sandbox: https://github.com/openai/codex
