# Milestone 3: Policy Templates — Design

## Goal

Build a usable policy configuration system that maps named policy templates to concrete sandbox configurations. By the end of this milestone, users can select a policy template when creating a session, each template produces a distinct sandbox boundary, and the system is extensible for future policy types.

## Success Criteria

- A `PolicyTemplate` type system defines policies as structured data (TypeScript types, serializable to JSON)
- At least three built-in templates ship: `standard-pr`, `research-only`, and `permissive`
- Each template maps to concrete safehouse flags (and in the future, container configs)
- UI allows viewing available templates and selecting one when creating a session
- The active policy is visible per session (what's allowed, what's restricted)
- Policy selection produces measurably different sandbox behavior (e.g., `standard-pr` blocks network access that `permissive` allows)
- Templates are extensible: adding a new template is a data change, not a plumbing change

## Non-Goals

- Deterministic test agent or batch validation (Milestone 4)
- Application-layer policies like git branch restrictions or `npm publish` blocking (Milestone 5)
- Proxy-based network domain allowlisting (Milestone 6 — `research-only` will initially get full network via safehouse defaults)
- User-defined custom policies (future work — we ship built-in templates only)
- Container-based enforcement (templates are designed to be backend-agnostic, but M3 targets safehouse/Seatbelt only)

---

## Background

### What We Learned in Milestone 2

Milestone 2 ([findings](../../history/seatbelt-sandbox/findings.md)) validated that safehouse-based sandboxing works for typical coding workflows. Key findings that inform policy template design:

1. **The default sandbox config works well.** `defaultSandboxConfig()` with `--enable=all-agents` passed all five test tasks without modification. This becomes our baseline for the `standard-pr` template.

2. **Safehouse's flag system is the right abstraction layer.** The combination of `--workdir`, `--add-dirs`, `--add-dirs-ro`, `--env-pass`, `--enable`, and `--append-profile` gives us enough knobs to express meaningfully different policies without maintaining raw SBPL profiles.

3. **Application-layer gaps exist but are out of scope.** Operations like `git push`, `git checkout main`, and `npm publish` are allowed by any OS-level sandbox that permits network access and git operations. These are Milestone 5 concerns — policy templates define _OS-level_ boundaries only.

4. **Network is the biggest differentiator between policies.** Safehouse allows full network by default. The most meaningful distinction between "standard PR work" and "permissive" is whether network access is restricted. Until Milestone 6 adds proxy-based domain filtering, network is binary: allowed or blocked via `--append-profile`.

5. **The `--append-profile` mechanism enables per-template overlays.** Safehouse supports appending custom SBPL rules on top of its base profile. This is how we'll express template-specific restrictions (e.g., a network-deny overlay for `standard-pr`).

### Design Principles

These follow from the roadmap's [principles](../../roadmap.md#principles):

- **Templates are boundaries, not action classifiers.** Each template defines a capability envelope. The agent operates freely within it. We don't inspect individual actions.
- **Start small, iterate with data.** Three templates covering the most common workflows. Milestone 4 will validate coverage against real session data.
- **Backend-agnostic policy definitions.** Templates describe _what_ the agent can access, not _how_ it's enforced. The same template should be expressible as safehouse flags today and as Dockerfile + bind mount configs tomorrow.
- **Policy is configuration, not code.** Adding a template should require adding a data object to a registry, not wiring up new spawning logic.

---

## Architecture

### How Policy Templates Fit In

Milestone 2 established: `SessionManager → defaultSandboxConfig() → buildSafehouseArgs() → spawn safehouse`. Milestone 3 inserts a policy layer that replaces the hardcoded `defaultSandboxConfig()` with template-driven configuration.

```
┌──────────────────────────────────────────────────────────────┐
│                   Glitter Ball (Electron)                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                      React UI                          │  │
│  │  ┌──────────────┐  ┌──────────────────────────────┐    │  │
│  │  │ Session List │  │ Chat Interface               │    │  │
│  │  │              │  │ (unchanged from M2)          │    │  │
│  │  │ policy badge │  │                              │    │  │
│  │  │ per session  │  │ Sandbox Event Log            │    │  │
│  │  │       [UPD]  │  │ (unchanged from M2)          │    │  │
│  │  └──────────────┘  └──────────────────────────────┘    │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │ New Session Dialog                         [NEW] │  │  │
│  │  │  Project: [/path/to/project]  [Browse]           │  │  │
│  │  │  Policy:  [standard-pr ▼]                        │  │  │
│  │  │           ┌─────────────────────────────┐        │  │  │
│  │  │           │ ● standard-pr               │        │  │  │
│  │  │           │   Read-write worktree,      │        │  │  │
│  │  │           │   toolchains, no network    │        │  │  │
│  │  │           │ ○ research-only             │        │  │  │
│  │  │           │   Read-only filesystem,     │        │  │  │
│  │  │           │   full network              │        │  │  │
│  │  │           │ ○ permissive                │        │  │  │
│  │  │           │   Broad access for trusted  │        │  │  │
│  │  │           │   tasks                     │        │  │  │
│  │  │           └─────────────────────────────┘        │  │  │
│  │  │  [Create Session]                                │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                 │
│  ┌─────────────────────────▼──────────────────────────────┐  │
│  │         Session Manager (main process)                 │  │
│  │                                                        │  │
│  │  PolicyTemplateRegistry                         [NEW]  │  │
│  │    ├─ templates: Map<string, PolicyTemplate>           │  │
│  │    ├─ get(id) → PolicyTemplate                         │  │
│  │    └─ list() → PolicyTemplateSummary[]                 │  │
│  │                                                        │  │
│  │  policyToSandboxConfig(template, session) [NEW]        │  │
│  │    └─ Maps PolicyTemplate → SandboxConfig              │  │
│  │       (replaces hardcoded defaultSandboxConfig)        │  │
│  │                                                        │  │
│  │  SessionManager (updated)                              │  │
│  │    └─ createSession(projectDir, agentType, policyId)   │  │
│  │       uses PolicyTemplateRegistry + policyToSandbox    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### What Changes from Milestone 2

| Component        | M2                                              | M3                                                            |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Sandbox config   | `defaultSandboxConfig()` — one hardcoded config | `policyToSandboxConfig(template, session)` — template-driven  |
| Session creation | `createSession(projectDir, agentType)`          | `createSession(projectDir, agentType, policyId)`              |
| Session state    | `sandboxConfig: SandboxConfig \| null`          | Adds `policyId: string`                                       |
| Session summary  | `sandboxed: boolean`                            | Adds `policyId: string \| null`, `policyName: string \| null` |
| New session UI   | Directory picker only                           | Directory picker + policy selector                            |
| Session list     | Shield badge for sandboxed                      | Policy name badge per session                                 |
| IPC              | No policy awareness                             | `policies:list` handler, `policyId` in create call            |

---

## Policy Template Data Model

### Core Types

```typescript
/**
 * A policy template defines a capability envelope for an agent session.
 *
 * Templates describe WHAT the agent can access — not HOW it's enforced.
 * The enforcement backend (safehouse, containers, etc.) interprets the
 * template into concrete sandbox configuration.
 */
export interface PolicyTemplate {
  /** Unique identifier (kebab-case). Used in APIs and serialization. */
  id: string

  /** Human-readable name for display. */
  name: string

  /** One-line description of the policy's intent. */
  description: string

  /** Filesystem access rules. */
  filesystem: FilesystemPolicy

  /** Network access rules. */
  network: NetworkPolicy

  /** Environment variable passthrough rules. */
  env: EnvPolicy

  /** Additional safehouse integrations to enable. */
  safehouseIntegrations: string[]

  /**
   * Raw SBPL rules to append via --append-profile.
   * Escape hatch for restrictions that can't be expressed
   * through the structured fields above.
   */
  appendProfile?: string
}

export interface FilesystemPolicy {
  /**
   * How the session worktree is mounted.
   * - "read-write": Agent can read and write files in the worktree.
   * - "read-only": Agent can read but not modify files.
   */
  worktreeAccess: 'read-write' | 'read-only'

  /**
   * Additional writable directories beyond the worktree.
   * Paths can include {gitCommonDir} as a placeholder resolved at session creation.
   */
  additionalWritableDirs: string[]

  /**
   * Additional read-only directories beyond safehouse defaults.
   */
  additionalReadOnlyDirs: string[]
}

export interface NetworkPolicy {
  /**
   * Top-level network access control.
   * - "full": Unrestricted network access (safehouse default).
   * - "none": All network access blocked via --append-profile overlay.
   * - "filtered": Domain allowlist via proxy (Milestone 6 — not yet implemented).
   */
  access: 'full' | 'none' | 'filtered'

  /**
   * Allowed domains when access is "filtered".
   * Not enforced until Milestone 6 adds proxy support.
   * Defined here for forward compatibility so templates can
   * declare intent before enforcement exists.
   */
  allowedDomains?: string[]
}

export interface EnvPolicy {
  /**
   * Environment variables to pass through to the sandboxed process.
   * These are added to the base set (ANTHROPIC_API_KEY, NODE_OPTIONS, etc.).
   */
  additional: string[]

  /**
   * Environment variables to exclude from the base set.
   * Useful for restrictive policies that want to block certain env vars.
   */
  exclude: string[]
}

/**
 * Lightweight summary for UI display and IPC.
 */
export interface PolicyTemplateSummary {
  id: string
  name: string
  description: string
}
```

### Built-in Templates

#### `standard-pr` — Standard PR Implementation

The default policy for typical coding work: implement a feature, fix a bug, write tests. The agent gets full read-write access to its worktree and standard toolchains, but no network access. This is the tightest practical boundary for offline coding tasks.

```typescript
{
  id: "standard-pr",
  name: "Standard PR",
  description: "Read-write worktree, standard toolchains, no network",
  filesystem: {
    worktreeAccess: "read-write",
    additionalWritableDirs: [],  // gitCommonDir handled automatically
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "none",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
}
```

**What it allows:**

- Read and write files in the worktree
- Run build tools, linters, test suites (via safehouse toolchain profiles)
- Git operations (add, commit, branch) within the worktree
- Read system binaries, libraries, toolchain caches

**What it blocks:**

- All network access (no `git push`, `npm install` from registry, web requests)
- Writing outside the worktree (no modifying `~/.gitconfig`, other repos, etc.)

**Practical implication:** The agent must work with dependencies already installed in the worktree (or installed during worktree setup). This is the right constraint for most PR implementation work where you don't want the agent reaching out to external services.

**Open question for M3 iteration:** Should we pre-install `node_modules` during worktree creation? M2 findings showed the agent had to run `npm install` itself. With `standard-pr` blocking network, this won't work. Options:

1. Copy `node_modules` from the source repo during `worktree create` (fast if source has them)
2. Run `npm install` before applying sandbox (adds latency)
3. Accept that `standard-pr` requires pre-installed deps and document this

#### `research-only` — Read-Only Research

For tasks where the agent should analyze code but not modify it: code review, architecture analysis, documentation research. The agent gets read-only filesystem access but full network for web research.

```typescript
{
  id: "research-only",
  name: "Research Only",
  description: "Read-only filesystem, full network access",
  filesystem: {
    worktreeAccess: "read-only",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "full",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
  appendProfile: `
;; Deny all file writes within the worktree.
;; Safehouse grants worktree write access by default when using --add-dirs;
;; for research-only we override to read-only via --add-dirs-ro instead,
;; and this overlay catches any remaining write paths.
(deny file-write* (subpath (param "WORKTREE")))
`,
}
```

**What it allows:**

- Read all files in the worktree and standard system paths
- Full network access (web browsing, API calls, package registry queries)
- Read safehouse-granted paths (toolchain caches, git config, etc.)

**What it blocks:**

- Writing any files (worktree is mounted read-only)
- No git commits, no file creation, no build artifact generation

**Implementation note:** Since safehouse's `--add-dirs` grants read-write, we need a different approach for read-only worktree mounting. Two options:

1. Use `--add-dirs-ro` instead of `--add-dirs` for the worktree path (preferred — no SBPL overlay needed)
2. Use `--add-dirs` and append an SBPL deny overlay for writes

Option 1 is cleaner. The `policyToSandboxConfig()` function will put the worktree in `readOnlyDirs` instead of `writableDirs` when `worktreeAccess` is `"read-only"`.

#### `permissive` — Broad Access

For trusted tasks that need both filesystem mutation and network access: setting up a new project, running migrations, tasks involving package installation or API integration. This is essentially the M2 default config — the safehouse baseline with no additional restrictions.

```typescript
{
  id: "permissive",
  name: "Permissive",
  description: "Read-write worktree, toolchains, full network access",
  filesystem: {
    worktreeAccess: "read-write",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "full",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
}
```

**What it allows:**

- Everything `standard-pr` allows, plus full network access
- `git push`, `npm install`, web API calls, etc.

**What it blocks:**

- Writing outside the worktree (safehouse default)
- Accessing paths not in safehouse's curated profiles

**When to use:** When the task requires network access (installing dependencies, pushing code, accessing external APIs) and you trust the agent with those capabilities. This is the closest to "unsandboxed" while still having OS-level filesystem boundaries.

### Template Comparison Matrix

| Capability                  | `standard-pr` | `research-only` | `permissive` |
| --------------------------- | :-----------: | :-------------: | :----------: |
| Read worktree files         |      Yes      |       Yes       |     Yes      |
| Write worktree files        |      Yes      |       No        |     Yes      |
| Run build/test tools        |      Yes      |       No        |     Yes      |
| Git commit (local)          |      Yes      |       No        |     Yes      |
| Git push                    |      No       |       No        |     Yes      |
| npm install (from registry) |      No       |       No        |     Yes      |
| Web access                  |      No       |       Yes       |     Yes      |
| Write outside worktree      |      No       |       No        |      No      |

---

## Components

### 1. Policy Template Registry (`src/main/policy-registry.ts`) [NEW]

A simple registry that holds the built-in templates and provides lookup/listing for the session manager and IPC layer.

```typescript
import type { PolicyTemplate, PolicyTemplateSummary } from './types.js'

const BUILT_IN_TEMPLATES: PolicyTemplate[] = [
  standardPrTemplate,
  researchOnlyTemplate,
  permissiveTemplate,
]

export class PolicyTemplateRegistry {
  private templates: Map<string, PolicyTemplate>

  constructor() {
    this.templates = new Map(BUILT_IN_TEMPLATES.map((t) => [t.id, t]))
  }

  /** Get a template by ID. Throws if not found. */
  get(id: string): PolicyTemplate {
    const template = this.templates.get(id)
    if (!template) throw new Error(`Unknown policy template: ${id}`)
    return template
  }

  /** List all available templates (summaries for UI). */
  list(): PolicyTemplateSummary[] {
    return Array.from(this.templates.values()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }))
  }

  /** Default template ID for new sessions. */
  get defaultId(): string {
    return 'standard-pr'
  }
}
```

**Design choice: class, not module-level functions.** A registry instance is created once in the main process and shared. This makes it easy to add user-defined templates later (load from disk, merge into the registry) without changing the interface.

### 2. Policy-to-Sandbox Mapper (`src/main/policy-sandbox.ts`) [NEW]

Maps a `PolicyTemplate` + session context into a concrete `SandboxConfig`. This replaces the role of `defaultSandboxConfig()` as the source of sandbox configuration.

```typescript
import type { PolicyTemplate } from './types.js'
import type { SandboxConfig } from './sandbox.js'

interface SessionContext {
  sessionId: string
  worktreePath: string
  gitCommonDir?: string
  readOnlyDirs?: string[]
}

/**
 * Map a policy template to a concrete SandboxConfig for safehouse.
 *
 * This is the translation layer between the backend-agnostic PolicyTemplate
 * and the safehouse-specific SandboxConfig. When we migrate to containers,
 * we'll add a policyToDockerConfig() alongside this function.
 */
export function policyToSandboxConfig(
  template: PolicyTemplate,
  ctx: SessionContext,
): SandboxConfig {
  const writableDirs: string[] = []
  const readOnlyDirs: string[] = [...(ctx.readOnlyDirs ?? [])]

  // Worktree access
  if (template.filesystem.worktreeAccess === 'read-write') {
    writableDirs.push(ctx.worktreePath)
  } else {
    readOnlyDirs.push(ctx.worktreePath)
  }

  // Git common dir (always writable when worktree is writable,
  // read-only when worktree is read-only)
  if (ctx.gitCommonDir) {
    if (template.filesystem.worktreeAccess === 'read-write') {
      writableDirs.push(ctx.gitCommonDir)
    } else {
      readOnlyDirs.push(ctx.gitCommonDir)
    }
  }

  // Additional dirs from template
  writableDirs.push(...template.filesystem.additionalWritableDirs)
  readOnlyDirs.push(...template.filesystem.additionalReadOnlyDirs)

  // Environment variables
  const BASE_ENV = [
    'ANTHROPIC_API_KEY',
    'NODE_OPTIONS',
    'NODE_PATH',
    'EDITOR',
    'VISUAL',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]
  const envPassthrough = [
    ...BASE_ENV.filter((v) => !template.env.exclude.includes(v)),
    ...template.env.additional,
  ]

  return {
    workdir: ctx.worktreePath,
    writableDirs,
    readOnlyDirs,
    envPassthrough,
    policyOutputPath: join(POLICY_DIR, `${ctx.sessionId}.sb`),
  }
}
```

**Network enforcement** is handled separately because it requires an `--append-profile` overlay rather than a `SandboxConfig` field change. The `buildSafehouseArgs()` function will be extended to accept an optional `appendProfile` string:

```typescript
// Updated in sandbox.ts
export function buildSafehouseArgs(
  config: SandboxConfig,
  command: string[],
  options?: { appendProfile?: string },
): string[] {
  const args: string[] = [...existingLogic...];

  // Append custom SBPL profile if provided
  if (options?.appendProfile) {
    // Write appendProfile to a temp file, pass via --append-profile
    // (safehouse reads from file path, not inline string)
    args.push(`--append-profile=${options.appendProfilePath}`);
  }

  args.push("--");
  args.push(...command);
  return args;
}
```

**Network deny overlay (SBPL):**

```scheme
;; Block all outbound network access.
;; Used by standard-pr template to prevent git push, npm publish, web requests.
(deny network-outbound)
(deny network-bind)
```

This is the simplest possible network restriction. Milestone 6 will replace this with proxy-based domain filtering for more granular control.

### 3. Session Manager Updates (`src/main/session-manager.ts`) [UPDATED]

The session manager gains policy awareness.

**Changes to `createSession()`:**

```typescript
async createSession(
  projectDir: string,
  agentType: AgentType = "claude-code",
  policyId?: string,                            // NEW
): Promise<SessionSummary> {
  const id = randomUUID();

  // Resolve policy template
  const resolvedPolicyId = policyId ?? this.policyRegistry.defaultId;
  const template = this.policyRegistry.get(resolvedPolicyId);

  // ... (unchanged: create worktree) ...

  // Build sandbox config FROM POLICY TEMPLATE (replaces defaultSandboxConfig)
  if (agentType === "claude-code" && safehouseAvailable) {
    sandboxConfig = policyToSandboxConfig(template, {
      sessionId: id,
      worktreePath: workingDir,
      gitCommonDir: worktree?.gitCommonDir,
      readOnlyDirs: [agentPkgDir],
    });
  }

  // ... (rest unchanged) ...
}
```

**Changes to `SessionState`:**

```typescript
interface SessionState {
  // ... existing fields ...
  policyId: string // NEW — which template was selected
}
```

**Changes to `SessionSummary`:**

```typescript
export interface SessionSummary {
  // ... existing fields ...
  policyId: string | null // NEW
  policyName: string | null // NEW — human-readable for UI
}
```

### 4. Sandbox Module Updates (`src/main/sandbox.ts`) [UPDATED]

**`defaultSandboxConfig()` is retained but deprecated.** It becomes a convenience wrapper that delegates to `policyToSandboxConfig()` with the `standard-pr` template. This maintains backward compatibility if anything calls it directly, but the session manager now uses the policy path.

**New: `--append-profile` support.** `buildSafehouseArgs()` gains support for writing and referencing an append profile file:

```typescript
export interface SandboxConfig {
  workdir: string
  writableDirs: string[]
  readOnlyDirs: string[]
  envPassthrough: string[]
  policyOutputPath: string
  appendProfileContent?: string // NEW — SBPL content for --append-profile
}
```

When `appendProfileContent` is present, `buildSafehouseArgs()` writes it to a sibling file (`<sessionId>-append.sb`) and passes `--append-profile=<path>`.

### 5. Types Updates (`src/main/types.ts`) [UPDATED]

```typescript
// New types
export interface PolicyTemplate { ... }       // As defined above
export interface FilesystemPolicy { ... }
export interface NetworkPolicy { ... }
export interface EnvPolicy { ... }
export interface PolicyTemplateSummary { ... }

// Updated types
export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
  agentType: AgentType;
  projectDir: string;
  sandboxed: boolean;
  policyId: string | null;    // NEW
  policyName: string | null;  // NEW
}
```

### 6. IPC Bridge Updates (`src/preload/index.ts`, `src/main/index.ts`) [UPDATED]

**New IPC handlers:**

```typescript
// In main/index.ts
ipcMain.handle('policies:list', () => {
  return sessionManager.policyRegistry.list()
})

// Updated: createSession now accepts policyId
ipcMain.handle('sessions:create', (_event, projectDir, agentType, policyId) => {
  return sessionManager.createSession(projectDir, agentType, policyId)
})
```

**Updated preload API:**

```typescript
window.glitterball = {
  sessions: {
    // ... existing methods ...
    create(projectDir: string, agentType?: string, policyId?: string): Promise<SessionSummary>;
  },
  policies: {                    // NEW
    list(): Promise<PolicyTemplateSummary[]>;
  },
  dialog: { ... },
};
```

### 7. React UI Updates (`src/renderer/src/`) [UPDATED]

#### New Session Dialog [NEW]

Replace the current "click New Session → pick directory → session starts" flow with a dialog that also shows policy selection.

```
┌──────────────────────────────────────┐
│  New Session                         │
│                                      │
│  Project: /Users/.../my-project      │
│           [Browse...]                │
│                                      │
│  Policy:                             │
│  ┌────────────────────────────────┐  │
│  │ ● Standard PR                 │  │
│  │   Read-write worktree,        │  │
│  │   toolchains, no network      │  │
│  ├────────────────────────────────┤  │
│  │ ○ Research Only               │  │
│  │   Read-only filesystem,       │  │
│  │   full network access         │  │
│  ├────────────────────────────────┤  │
│  │ ○ Permissive                  │  │
│  │   Read-write worktree,        │  │
│  │   toolchains, full network    │  │
│  └────────────────────────────────┘  │
│                                      │
│         [Cancel]  [Create Session]   │
└──────────────────────────────────────┘
```

**Component:** `NewSessionDialog.tsx` — a modal or inline panel with:

- Directory picker (existing `dialog:selectDirectory` call)
- Policy radio group (fetched via `policies:list` on mount)
- Create button (calls `sessions:create` with selected directory and policy)
- Default selection: `standard-pr`

#### Session List Updates [UPDATED]

Replace the generic shield badge with the policy template name:

```
┌─────────────────────┐
│ Session 1           │
│ standard-pr   ● 3   │  ← policy badge + violation count
│                     │
│ Session 2           │
│ research-only  ●    │
│                     │
│ Session 3           │
│ permissive    ●     │
└─────────────────────┘
```

The policy name serves as both the sandbox indicator (if a policy is present, the session is sandboxed) and a meaningful label for what restrictions are in place.

#### Policy Info Panel [NEW, lightweight]

When hovering or clicking on the policy badge in the session list (or in a dedicated section of the chat panel), show the template's capability summary:

```
┌──────────────────────────────┐
│ Standard PR                  │
│                              │
│ Filesystem: read-write       │
│ Network:    blocked          │
│ Worktree:   /tmp/glitter...  │
└──────────────────────────────┘
```

This is a tooltip or small popover, not a full panel. Enough to confirm what the policy does without requiring the user to remember template names.

---

## Append Profile Lifecycle

Templates that include `appendProfile` content (like `standard-pr`'s network deny rule) need the SBPL content written to a temp file that safehouse can reference.

**Lifecycle:**

1. **Session creation:** `policyToSandboxConfig()` populates `appendProfileContent` on the `SandboxConfig`.
2. **Before spawn:** If `appendProfileContent` is present, write it to `{POLICY_DIR}/{sessionId}-append.sb`.
3. **Safehouse invocation:** `buildSafehouseArgs()` includes `--append-profile={path}`.
4. **Session close:** `cleanupPolicy()` also removes the append profile file.
5. **Orphan cleanup:** `cleanupOrphanPolicies()` also cleans `*-append.sb` files.

---

## Network Deny Implementation

The most impactful policy difference is network access. Here's how the `standard-pr` template's `network.access: "none"` translates to enforcement:

**SBPL overlay (`standard-pr-network-deny.sb`):**

```scheme
(version 1)
(deny network-outbound)
(deny network-bind)
```

This is appended to safehouse's base profile via `--append-profile`. Since SBPL profiles are additive (deny rules can be added on top of allow rules), this effectively blocks all network access regardless of what safehouse's base profile allows.

**Verification approach:** After implementing, test that:

- `curl https://example.com` fails with EPERM under `standard-pr`
- `git push` fails under `standard-pr`
- Both succeed under `permissive`
- The sandbox monitor captures network-outbound violations

**Edge case: localhost.** The network deny overlay blocks _all_ network, including localhost. This could break:

- ACP communication (but ACP uses stdio, not network — safe)
- Any MCP servers running on localhost (if configured in the future)

If localhost access is needed, the overlay can be refined:

```scheme
(deny network-outbound (remote ip "localhost:*"))
;; Allow only localhost
(allow network-outbound (remote ip "localhost:*"))
```

This is a refinement we can add if needed during testing.

---

## Migration Path from M2 to M3

The transition should be non-breaking:

1. **Add new files:** `policy-registry.ts`, `policy-sandbox.ts`, template definitions
2. **Update `session-manager.ts`:** Accept `policyId` parameter, use `policyToSandboxConfig()` instead of `defaultSandboxConfig()`
3. **Update `sandbox.ts`:** Add `appendProfileContent` to `SandboxConfig`, extend `buildSafehouseArgs()`
4. **Update types:** Add `PolicyTemplate` types, extend `SessionSummary`
5. **Update IPC:** Add `policies:list`, extend `sessions:create`
6. **Update UI:** Add `NewSessionDialog`, update session list badges
7. **Deprecate `defaultSandboxConfig()`:** Keep it as a wrapper for backward compatibility but route through the new policy system

**Default behavior when no policy is specified:** `standard-pr` is selected automatically. This means M3 changes the default network behavior from "allow all" (M2) to "deny all" (M3 `standard-pr`). This is intentional — the M2 default was always intended to be tightened. Sessions that need network access should explicitly select `permissive`.

---

## Risks and Open Questions

### `node_modules` and network-deny in `standard-pr`

The `standard-pr` template blocks network access, but many coding tasks require installed dependencies. If the worktree doesn't have `node_modules` (or equivalent), the agent can't install them.

**Options:**

1. **Symlink or copy `node_modules` during worktree creation.** Fast if source repo has them. Could be a worktree manager enhancement.
2. **Run `npm install` before applying sandbox.** Adds latency to session creation.
3. **Accept the constraint.** Document that `standard-pr` assumes pre-installed deps. Users who need to install packages should use `permissive`.

**Recommendation:** Start with option 3 (document the constraint) and iterate based on user feedback. Option 1 is a natural follow-up if this is a frequent friction point.

### SBPL append profile ordering

Safehouse's `--append-profile` loads the custom SBPL rules _after_ the base profile. We need to verify that deny rules in the append profile override allow rules in the base profile. SBPL evaluation is last-match-wins for same-specificity rules, so an explicit `(deny network-outbound)` should override an earlier `(allow network-outbound)`.

**Mitigation:** Test this empirically in the first implementation phase. If ordering is an issue, we may need to use `--append-profile` with a more specific deny rule.

### `research-only` worktree mounting

The `research-only` template wants read-only worktree access. Safehouse's `--add-dirs-ro` should handle this, but we need to verify that it truly prevents all writes (file creation, modification, deletion) within the worktree path.

**Mitigation:** Test empirically. If `--add-dirs-ro` doesn't provide strong enough write protection, fall back to the SBPL deny overlay approach.

### Template extensibility for containers

The `PolicyTemplate` type is designed to be backend-agnostic, but the `appendProfile` and `safehouseIntegrations` fields are safehouse-specific. When we migrate to containers:

- `filesystem` maps to bind mounts and volume configurations
- `network` maps to Docker network policies
- `env` maps to container environment variables
- `safehouseIntegrations` has no container equivalent (toolchains are in the image)
- `appendProfile` has no container equivalent

**Recommendation:** Accept this. The structured fields (`filesystem`, `network`, `env`) transfer cleanly. The safehouse-specific fields are clearly labeled and can be ignored by a container backend. We may add a `containerConfig` section to `PolicyTemplate` when that migration happens.

### Policy switching mid-session

Should users be able to change policy after a session starts? No — the sandbox is applied at process spawn time and can't be changed without restarting the agent. This is a fundamental constraint of Seatbelt (and most OS-level sandboxes).

**UI implication:** The policy selector only appears in the new session dialog, not in the active session view. The active session view shows the policy as read-only information.

---

## What This Unblocks

Completing Milestone 3 gives us:

- **Meaningfully different sandbox boundaries** for different workflow types, answering the roadmap's question: "Can a small number of policy templates cover most workflows?"
- **A template system** that Milestone 4 can batch-test against real session data (replay a session → did the template allow/block the right operations?)
- **Network deny enforcement** as a stepping stone to Milestone 6's proxy-based domain filtering
- **A policy data model** that Milestone 5 can extend with application-layer fields (git branch restrictions, command allowlists, etc.)
- **UI infrastructure** (policy selector, policy display) that supports future policy features without redesigning the session creation flow
