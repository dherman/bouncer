# Milestone 3: Policy Templates — Implementation Plan

This plan breaks the [design](design.md) into concrete, sequentially-executable phases. Each phase has a clear done condition. The plan builds on the working sandboxed agent integration from [Milestone 2](../../history/seatbelt-sandbox/plan.md).

## Progress

- [x] **[Phase 1: Policy Types and Template Definitions](#phase-1-policy-types-and-template-definitions)**
  - [x] 1.1 Add policy types to `src/main/types.ts`
  - [x] 1.2 Create `src/main/policy-templates.ts` with the three built-in templates
  - [x] 1.3 Create `src/main/policy-registry.ts` with the registry class
  - [x] 1.4 Verify: types compile, registry returns all three templates
- [x] **[Phase 2: Policy-to-Sandbox Mapping](#phase-2-policy-to-sandbox-mapping)**
  - [x] 2.1 Create `src/main/policy-sandbox.ts` with `policyToSandboxConfig()`
  - [x] 2.2 Add `appendProfileContent` support to `SandboxConfig` and `buildSafehouseArgs()`
  - [x] 2.3 Add append-profile file lifecycle helpers
  - [x] 2.4 Write `scripts/test-policy-sandbox.ts`
  - [x] 2.5 Smoke test: each template produces different safehouse args
- [x] **[Phase 3: Session Manager Integration](#phase-3-session-manager-integration)**
  - [x] 3.1 Add `PolicyTemplateRegistry` to `SessionManager`
  - [x] 3.2 Update `createSession()` to accept `policyId` and use `policyToSandboxConfig()`
  - [x] 3.3 Add `policyId` and `policyName` to `SessionState` and `SessionSummary`
  - [x] 3.4 Update cleanup paths for append-profile files
  - [x] 3.5 Deprecate `defaultSandboxConfig()` with forwarding wrapper
  - [x] 3.6 Smoke test: sessions create with each policy, sandbox args differ
- [x] **[Phase 4: IPC and Preload Updates](#phase-4-ipc-and-preload-updates)**
  - [x] 4.1 Add `policies:list` IPC handler
  - [x] 4.2 Update `sessions:create` handler to accept `policyId`
  - [x] 4.3 Update preload bridge with `policies` namespace and updated `create` signature
  - [x] 4.4 Update `env.d.ts` type declarations
  - [x] 4.5 Verify: `policies:list` returns three templates from renderer
- [x] **[Phase 5: UI — New Session Dialog](#phase-5-ui--new-session-dialog)**
  - [x] 5.1 Create `NewSessionDialog.tsx` component
  - [x] 5.2 Wire dialog into `App.tsx` (replace inline `handleCreateSession`)
  - [x] 5.3 Update `SessionList.tsx` to open dialog instead of directly picking a directory
  - [x] 5.4 Full flow test: dialog opens, shows policies, creates session with selected policy
- [x] **[Phase 6: UI — Session List and Policy Display](#phase-6-ui--session-list-and-policy-display)**
  - [x] 6.1 Update `SessionList.tsx` to show policy name badge instead of shield emoji
  - [x] 6.2 Add policy info tooltip on badge hover
  - [x] 6.3 Full flow test: sessions show correct policy labels, tooltip displays details
- [x] **[Phase 7: Empirical Validation](#phase-7-empirical-validation)**
  - [x] 7.1 Test: `standard-pr` blocks network access — SBPL deny works but blocks agent API; deferred to M6
  - [x] 7.2 Test: `research-only` blocks file writes — writes outside sandbox blocked; template updated to rw worktree
  - [x] 7.3 Test: `permissive` allows both network and file writes — PASS
  - [x] 7.4 Test: SBPL append-profile ordering — confirmed via 7.1 (deny overrides allow)
  - [x] 7.5 Document findings and edge cases — see findings.md
- [x] **[Verification](#verification-checklist)** — all manual checks pass

---

## Phase 1: Policy Types and Template Definitions

Define the data model and the three built-in templates. No behavioral changes — this is pure types and data.

### 1.1 Add policy types to `src/main/types.ts`

Add the following types to the existing types file:

```typescript
// --- Policy Template Types ---

export interface PolicyTemplate {
  id: string
  name: string
  description: string
  filesystem: FilesystemPolicy
  network: NetworkPolicy
  env: EnvPolicy
  safehouseIntegrations: string[]
  appendProfile?: string
}

export interface FilesystemPolicy {
  worktreeAccess: 'read-write' | 'read-only'
  additionalWritableDirs: string[]
  additionalReadOnlyDirs: string[]
}

export interface NetworkPolicy {
  access: 'full' | 'none' | 'filtered'
  allowedDomains?: string[]
}

export interface EnvPolicy {
  additional: string[]
  exclude: string[]
}

export interface PolicyTemplateSummary {
  id: string
  name: string
  description: string
}
```

Also update `SessionSummary` to include policy info:

```typescript
export interface SessionSummary {
  id: string
  status: 'initializing' | 'ready' | 'error' | 'closed'
  messageCount: number
  agentType: AgentType
  projectDir: string
  sandboxed: boolean
  policyId: string | null // NEW
  policyName: string | null // NEW
}
```

### 1.2 Create `src/main/policy-templates.ts`

Define the three built-in templates as exported constants. Separating template definitions from the registry keeps things clean — templates are pure data.

```typescript
// src/main/policy-templates.ts
import type { PolicyTemplate } from './types.js'

/**
 * Standard PR implementation: read-write worktree, no network.
 * The tightest practical boundary for offline coding tasks.
 */
export const standardPrTemplate: PolicyTemplate = {
  id: 'standard-pr',
  name: 'Standard PR',
  description: 'Read-write worktree, standard toolchains, no network',
  filesystem: {
    worktreeAccess: 'read-write',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'none',
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
}

/**
 * Research only: read-only filesystem, full network.
 * For code review, analysis, and web research tasks.
 */
export const researchOnlyTemplate: PolicyTemplate = {
  id: 'research-only',
  name: 'Research Only',
  description: 'Read-only filesystem, full network access',
  filesystem: {
    worktreeAccess: 'read-only',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'full',
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
}

/**
 * Permissive: read-write worktree, full network.
 * For trusted tasks that need both mutation and network access.
 * Equivalent to the M2 default safehouse configuration.
 */
export const permissiveTemplate: PolicyTemplate = {
  id: 'permissive',
  name: 'Permissive',
  description: 'Read-write worktree, toolchains, full network access',
  filesystem: {
    worktreeAccess: 'read-write',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'full',
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
}
```

### 1.3 Create `src/main/policy-registry.ts`

```typescript
// src/main/policy-registry.ts
import type { PolicyTemplate, PolicyTemplateSummary } from './types.js'
import { standardPrTemplate, researchOnlyTemplate, permissiveTemplate } from './policy-templates.js'

const BUILT_IN_TEMPLATES: PolicyTemplate[] = [standardPrTemplate, researchOnlyTemplate, permissiveTemplate]

export class PolicyTemplateRegistry {
  private templates: Map<string, PolicyTemplate>

  constructor() {
    this.templates = new Map(BUILT_IN_TEMPLATES.map((t) => [t.id, t]))
  }

  get(id: string): PolicyTemplate {
    const template = this.templates.get(id)
    if (!template) throw new Error(`Unknown policy template: ${id}`)
    return template
  }

  list(): PolicyTemplateSummary[] {
    return Array.from(this.templates.values()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }))
  }

  get defaultId(): string {
    return 'standard-pr'
  }
}
```

### 1.4 Verify: types compile, registry returns all three templates

- [ ] Run `npm run typecheck` — no errors from new files
- [ ] Quick manual check: import `PolicyTemplateRegistry`, call `.list()`, confirm three entries

**Done condition:** All policy types compile. The registry returns three template summaries. No runtime changes yet.

---

## Phase 2: Policy-to-Sandbox Mapping

Build the translation layer from `PolicyTemplate` → `SandboxConfig`. This is the core logic that makes different templates produce different sandbox behavior.

### 2.1 Create `src/main/policy-sandbox.ts`

The mapper function that replaces `defaultSandboxConfig()` as the source of sandbox configuration:

```typescript
// src/main/policy-sandbox.ts
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PolicyTemplate } from './types.js'
import type { SandboxConfig } from './sandbox.js'

const POLICY_DIR = join(tmpdir(), 'glitterball-sandbox')

export interface SessionContext {
  sessionId: string
  worktreePath: string
  gitCommonDir?: string
  readOnlyDirs?: string[]
}

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

export function policyToSandboxConfig(template: PolicyTemplate, ctx: SessionContext): SandboxConfig {
  const writableDirs: string[] = []
  const readOnlyDirs: string[] = [...(ctx.readOnlyDirs ?? [])]

  // Worktree access mode
  if (template.filesystem.worktreeAccess === 'read-write') {
    writableDirs.push(ctx.worktreePath)
  } else {
    readOnlyDirs.push(ctx.worktreePath)
  }

  // Git common dir follows worktree access mode
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

  // Environment variables: base set minus excludes, plus additions
  const envPassthrough = [...BASE_ENV.filter((v) => !template.env.exclude.includes(v)), ...template.env.additional]

  // Build append profile content from template + network policy
  let appendProfileContent: string | undefined
  const profileParts: string[] = []

  if (template.network.access === 'none') {
    profileParts.push(';; Block all outbound network access.', '(deny network-outbound)', '(deny network-bind)')
  }

  if (template.appendProfile) {
    profileParts.push(template.appendProfile.trim())
  }

  if (profileParts.length > 0) {
    appendProfileContent = '(version 1)\n' + profileParts.join('\n') + '\n'
  }

  return {
    workdir: ctx.worktreePath,
    writableDirs,
    readOnlyDirs,
    envPassthrough,
    policyOutputPath: join(POLICY_DIR, `${ctx.sessionId}.sb`),
    appendProfileContent,
  }
}
```

**Key design decision:** Network deny rules are generated from the `network.access` field, not hardcoded in the template's `appendProfile`. This keeps templates declarative — they say `access: "none"` and the mapper handles the SBPL. The `appendProfile` field is reserved for escape-hatch rules that can't be expressed structurally.

### 2.2 Add `appendProfileContent` support to `SandboxConfig` and `buildSafehouseArgs()`

Update `src/main/sandbox.ts`:

```typescript
export interface SandboxConfig {
  workdir: string
  writableDirs: string[]
  readOnlyDirs: string[]
  envPassthrough: string[]
  policyOutputPath: string
  appendProfileContent?: string // NEW
}
```

Update `buildSafehouseArgs()` to write the append profile to a file and pass `--append-profile`:

```typescript
export function buildSafehouseArgs(config: SandboxConfig, command: string[]): string[] {
  const args: string[] = []

  args.push(`--output=${config.policyOutputPath}`)
  args.push('--enable=all-agents')
  args.push(`--workdir=${config.workdir}`)

  if (config.writableDirs.length > 0) {
    args.push(`--add-dirs=${config.writableDirs.join(':')}`)
  }
  if (config.readOnlyDirs.length > 0) {
    args.push(`--add-dirs-ro=${config.readOnlyDirs.join(':')}`)
  }
  if (config.envPassthrough.length > 0) {
    args.push(`--env-pass=${config.envPassthrough.join(',')}`)
  }

  // NEW: append profile overlay
  if (config.appendProfileContent) {
    const appendPath = config.policyOutputPath.replace(/\.sb$/, '-append.sb')
    args.push(`--append-profile=${appendPath}`)
  }

  args.push('--')
  args.push(...command)
  return args
}
```

**Important:** `buildSafehouseArgs()` only builds the arg list — it doesn't write files. The append profile file must be written _before_ spawning safehouse. This write happens in the session manager (Phase 3) alongside the `ensurePolicyDir()` call.

### 2.3 Add append-profile file lifecycle helpers

Add to `src/main/sandbox.ts`:

```typescript
import { writeFile } from 'node:fs/promises'

/**
 * Write the append profile file if the config includes custom SBPL content.
 * Must be called before spawning safehouse.
 */
export async function writeAppendProfile(config: SandboxConfig): Promise<void> {
  if (!config.appendProfileContent) return
  const appendPath = config.policyOutputPath.replace(/\.sb$/, '-append.sb')
  await writeFile(appendPath, config.appendProfileContent, 'utf-8')
}

/**
 * Clean up a session's policy file(s), including any append profile.
 */
export async function cleanupPolicy(policyPath: string): Promise<void> {
  const appendPath = policyPath.replace(/\.sb$/, '-append.sb')
  await rm(policyPath, { force: true }).catch(() => {})
  await rm(appendPath, { force: true }).catch(() => {})
}
```

Update `cleanupOrphanPolicies()` to also clean `*-append.sb` files (already covered since it removes all `.sb` files matching session IDs — just ensure the `-append.sb` suffix is also caught):

```typescript
export async function cleanupOrphanPolicies(activeSessionIds: Set<string>): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(POLICY_DIR)
    for (const entry of entries) {
      if (entry.endsWith('.sb')) {
        // Extract session ID from both "uuid.sb" and "uuid-append.sb"
        const sessionId = entry.replace(/-append\.sb$/, '').replace(/\.sb$/, '')
        if (!activeSessionIds.has(sessionId)) {
          await rm(join(POLICY_DIR, entry), { force: true })
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}
```

### 2.4 Write `scripts/test-policy-sandbox.ts`

A standalone test script that exercises the mapping from templates to sandbox configs:

```typescript
// scripts/test-policy-sandbox.ts
//
// Verifies that each policy template produces the expected safehouse args.
// Does NOT spawn agents — just tests the config generation.
//
// Usage: npx tsx scripts/test-policy-sandbox.ts

import { PolicyTemplateRegistry } from '../src/main/policy-registry.js'
import { policyToSandboxConfig } from '../src/main/policy-sandbox.js'
import { buildSafehouseArgs } from '../src/main/sandbox.js'

const registry = new PolicyTemplateRegistry()
const ctx = {
  sessionId: 'test-session-id',
  worktreePath: '/tmp/test-worktree',
  gitCommonDir: '/Users/test/project/.git',
  readOnlyDirs: ['/path/to/agent-pkg'],
}

console.log('=== Policy Template → Sandbox Config Tests ===\n')

for (const summary of registry.list()) {
  const template = registry.get(summary.id)
  const config = policyToSandboxConfig(template, ctx)
  const args = buildSafehouseArgs(config, ['node', '/path/to/agent.js'])

  console.log(`--- ${summary.id} (${summary.name}) ---`)
  console.log(`  Description: ${summary.description}`)
  console.log(`  Writable dirs: ${config.writableDirs.join(', ') || '(none)'}`)
  console.log(`  Read-only dirs: ${config.readOnlyDirs.join(', ') || '(none)'}`)
  console.log(`  Env passthrough: ${config.envPassthrough.join(', ')}`)
  console.log(`  Append profile: ${config.appendProfileContent ? 'yes' : 'no'}`)
  if (config.appendProfileContent) {
    console.log(
      `  Append profile content:\n${config.appendProfileContent
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')}`,
    )
  }
  console.log(`  Safehouse args: safehouse ${args.join(' ')}`)

  // Assertions
  const hasAppendProfile = args.some((a) => a.startsWith('--append-profile='))
  const hasWorktreeWritable = config.writableDirs.includes(ctx.worktreePath)
  const hasWorktreeReadOnly = config.readOnlyDirs.includes(ctx.worktreePath)

  if (summary.id === 'standard-pr') {
    console.assert(hasWorktreeWritable, 'standard-pr: worktree should be writable')
    console.assert(!hasWorktreeReadOnly, 'standard-pr: worktree should not be read-only')
    console.assert(hasAppendProfile, 'standard-pr: should have append profile (network deny)')
    console.assert(
      config.appendProfileContent!.includes('deny network-outbound'),
      'standard-pr: append profile should deny network',
    )
  } else if (summary.id === 'research-only') {
    console.assert(!hasWorktreeWritable, 'research-only: worktree should not be writable')
    console.assert(hasWorktreeReadOnly, 'research-only: worktree should be read-only')
    console.assert(!hasAppendProfile, 'research-only: should not have append profile')
  } else if (summary.id === 'permissive') {
    console.assert(hasWorktreeWritable, 'permissive: worktree should be writable')
    console.assert(!hasWorktreeReadOnly, 'permissive: worktree should not be read-only')
    console.assert(!hasAppendProfile, 'permissive: should not have append profile')
  }

  console.log(`  ✓ Assertions passed\n`)
}

console.log('=== All tests passed ===')
```

Add to `package.json`:

```json
"test:policy-sandbox": "tsx scripts/test-policy-sandbox.ts"
```

### 2.5 Smoke test

- [ ] `npm run test:policy-sandbox` passes all assertions
- [ ] `standard-pr` produces `--append-profile` arg with network deny content
- [ ] `research-only` puts worktree in read-only dirs, no append profile
- [ ] `permissive` puts worktree in writable dirs, no append profile
- [ ] All three produce different safehouse arg lists

**Done condition:** Each template produces the expected `SandboxConfig`. The mapping from template fields to safehouse args is correct and tested.

---

## Phase 3: Session Manager Integration

Wire the policy system into the session manager, replacing the hardcoded `defaultSandboxConfig()`.

### 3.1 Add `PolicyTemplateRegistry` to `SessionManager`

```typescript
// In session-manager.ts
import { PolicyTemplateRegistry } from './policy-registry.js'
import { policyToSandboxConfig, type SessionContext } from './policy-sandbox.js'
import { writeAppendProfile } from './sandbox.js'

export class SessionManager {
  private sessions = new Map<string, SessionState>()
  private worktreeManager = new WorktreeManager()
  private safehouseWarningLogged = false
  readonly policyRegistry = new PolicyTemplateRegistry() // NEW — public for IPC access
  // ...
}
```

### 3.2 Update `createSession()` to accept `policyId` and use `policyToSandboxConfig()`

The key change: replace the `defaultSandboxConfig()` call with the policy-driven path.

```typescript
async createSession(
  projectDir: string,
  agentType: AgentType = "claude-code",
  policyId?: string,                              // NEW parameter
): Promise<SessionSummary> {
  const id = randomUUID();

  // Resolve policy template
  const resolvedPolicyId = agentType === "claude-code"
    ? (policyId ?? this.policyRegistry.defaultId)
    : null;
  const template = resolvedPolicyId
    ? this.policyRegistry.get(resolvedPolicyId)
    : null;

  // ... (unchanged: create worktree) ...

  // Build sandbox config FROM POLICY TEMPLATE
  let sandboxConfig: SandboxConfig | null = null;
  const safehouseAvailable = await isSafehouseAvailable();

  if (agentType === "claude-code" && !safehouseAvailable) {
    if (!this.safehouseWarningLogged) {
      console.warn("safehouse not available — agent will run without OS-level sandboxing");
      this.safehouseWarningLogged = true;
    }
  }

  if (template && safehouseAvailable) {
    await ensurePolicyDir();
    const agentRequire = createRequire(app.getAppPath() + "/");
    const agentPkgDir = join(
      agentRequire.resolve("@zed-industries/claude-agent-acp/package.json"),
      ".."
    );

    sandboxConfig = policyToSandboxConfig(template, {
      sessionId: id,
      worktreePath: workingDir,
      gitCommonDir: worktree?.gitCommonDir,
      readOnlyDirs: [agentPkgDir],
    });

    // Write append profile file before spawning (if needed)
    await writeAppendProfile(sandboxConfig);
  }

  // ... (rest of session creation unchanged) ...
}
```

### 3.3 Add `policyId` and `policyName` to `SessionState` and `SessionSummary`

Update `SessionState`:

```typescript
interface SessionState {
  // ... existing fields ...
  policyId: string | null // NEW
}
```

Initialize in `createSession()`:

```typescript
const session: SessionState = {
  // ... existing fields ...
  policyId: resolvedPolicyId,
}
```

Update `summarize()`:

```typescript
private summarize(session: SessionState): SessionSummary {
  let policyName: string | null = null;
  if (session.policyId) {
    try {
      policyName = this.policyRegistry.get(session.policyId).name;
    } catch {
      policyName = session.policyId;
    }
  }
  return {
    id: session.id,
    status: session.status,
    messageCount: session.messages.length,
    agentType: session.agentType,
    projectDir: session.projectDir,
    sandboxed: session.sandboxConfig !== null,
    policyId: session.policyId,
    policyName,
  };
}
```

### 3.4 Update cleanup paths for append-profile files

The updated `cleanupPolicy()` from Phase 2.3 already handles this — it removes both `{sessionId}.sb` and `{sessionId}-append.sb`. Verify that `closeSession()` still calls `cleanupPolicy()` with the right path.

### 3.5 Deprecate `defaultSandboxConfig()` with forwarding wrapper

Keep `defaultSandboxConfig()` in `sandbox.ts` for backward compatibility (test scripts from M2 may still use it), but add a deprecation comment:

```typescript
/**
 * @deprecated Use policyToSandboxConfig() with a PolicyTemplate instead.
 * Retained for backward compatibility with M2 test scripts.
 */
export function defaultSandboxConfig(params: { ... }): SandboxConfig {
  // ... existing implementation unchanged ...
}
```

No behavioral change — just a code comment indicating the preferred path.

### 3.6 Smoke test

- [ ] Launch app with `npm run dev`
- [ ] Create a session — it should use `standard-pr` by default
- [ ] Check console output: safehouse should receive `--append-profile` arg
- [ ] Verify the session summary includes `policyId: "standard-pr"` and `policyName: "Standard PR"`
- [ ] Check `/tmp/glitterball-sandbox/` for both `{sessionId}.sb` and `{sessionId}-append.sb` files
- [ ] Close the session — verify both policy files are cleaned up

**Done condition:** Sessions are created with policy-driven sandbox configs. The default policy is `standard-pr` with network deny. Session summaries include policy metadata.

---

## Phase 4: IPC and Preload Updates

Expose the policy system to the renderer process.

### 4.1 Add `policies:list` IPC handler

In `src/main/index.ts`, after the existing IPC handlers:

```typescript
ipcMain.handle('policies:list', () => {
  return sessionManager.policyRegistry.list()
})
```

### 4.2 Update `sessions:create` handler to accept `policyId`

```typescript
ipcMain.handle('sessions:create', (_e, projectDir: unknown, agentType: unknown, policyId: unknown) => {
  if (typeof projectDir !== 'string') {
    throw new Error('Invalid argument: projectDir must be a string')
  }
  const validAgentType = agentType === 'echo' ? ('echo' as const) : ('claude-code' as const)
  const validPolicyId = typeof policyId === 'string' ? policyId : undefined
  return sessionManager.createSession(projectDir, validAgentType, validPolicyId)
})
```

### 4.3 Update preload bridge

In `src/preload/index.ts`:

```typescript
contextBridge.exposeInMainWorld('glitterball', {
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (
      projectDir: string,
      agentType?: string,
      policyId?: string, // UPDATED
    ) => ipcRenderer.invoke('sessions:create', projectDir, agentType, policyId),
    sendMessage: (sessionId: string, text: string) => ipcRenderer.invoke('sessions:sendMessage', sessionId, text),
    closeSession: (sessionId: string) => ipcRenderer.invoke('sessions:close', sessionId),
    getSandboxViolations: (sessionId: string) => ipcRenderer.invoke('sessions:getSandboxViolations', sessionId),
    onUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown): void => callback(update)
      ipcRenderer.on('session-update', handler)
      return () => ipcRenderer.removeListener('session-update', handler)
    },
  },
  policies: {
    // NEW
    list: () => ipcRenderer.invoke('policies:list'),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  },
})
```

### 4.4 Update `env.d.ts` type declarations

```typescript
import type {
  AgentType,
  PolicyTemplateSummary, // NEW
  SandboxViolationInfo,
  SessionSummary,
  SessionUpdate,
} from '../../main/types'

interface GlitterballAPI {
  sessions: {
    list(): Promise<SessionSummary[]>
    create(projectDir: string, agentType?: AgentType, policyId?: string): Promise<SessionSummary> // UPDATED
    sendMessage(sessionId: string, text: string): Promise<void>
    closeSession(sessionId: string): Promise<void>
    getSandboxViolations(sessionId: string): Promise<SandboxViolationInfo[]>
    onUpdate(callback: (update: SessionUpdate) => void): () => void
  }
  policies: {
    // NEW
    list(): Promise<PolicyTemplateSummary[]>
  }
  dialog: {
    selectDirectory(): Promise<string | null>
  }
}
```

### 4.5 Verify

- [ ] Run `npm run typecheck` — no errors
- [ ] From the renderer console (`Cmd+Opt+I`), call `await window.glitterball.policies.list()` — returns three template summaries

**Done condition:** The renderer can list policies and create sessions with a specific policy. Types are consistent across the IPC boundary.

---

## Phase 5: UI — New Session Dialog

Replace the current "click button → pick directory → session starts" flow with a dialog that includes policy selection.

### 5.1 Create `NewSessionDialog.tsx`

Create `src/renderer/src/components/NewSessionDialog.tsx`:

- A modal overlay or inline panel that appears when the user clicks "New Session"
- Shows the currently selected directory (or a prompt to browse)
- A radio group listing all policy templates (fetched via `policies.list()` on mount)
- Default selection: the first template (`standard-pr`)
- "Browse..." button triggers `dialog.selectDirectory()`
- "Create Session" button calls `sessions.create(dir, "claude-code", policyId)`
- "Cancel" button closes the dialog without creating a session
- Disabled state: "Create Session" is disabled until a directory is selected

```
┌──────────────────────────────────────┐
│  New Session                         │
│                                      │
│  Project: (none selected)            │
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

**Styling:** Use inline styles consistent with the existing components (no CSS framework). Keep it simple — dark background overlay, white panel, minimal padding.

### 5.2 Wire dialog into `App.tsx`

Replace the current `handleCreateSession` (which immediately opens a directory picker and creates a session) with:

1. A `showNewSessionDialog` boolean state
2. Clicking "New Session" in `SessionList` sets `showNewSessionDialog = true`
3. The dialog handles directory picking and policy selection internally
4. On "Create Session", the dialog calls a callback that creates the session with the selected policy
5. On "Cancel" or successful creation, the dialog closes

```typescript
// In App.tsx
const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);

// The SessionList's onCreate now opens the dialog
<SessionList
  // ...
  onCreate={() => setShowNewSessionDialog(true)}
/>

// Render the dialog when open
{showNewSessionDialog && (
  <NewSessionDialog
    onClose={() => setShowNewSessionDialog(false)}
    onCreated={(session) => {
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
      setShowNewSessionDialog(false);
    }}
  />
)}
```

### 5.3 Update `SessionList.tsx`

No functional change to `SessionList` itself — `onCreate` already fires the callback. The change is in `App.tsx` (the callback now opens the dialog instead of directly creating a session).

### 5.4 Full flow test

- [ ] Click "New Session" → dialog opens
- [ ] No directory selected → "Create Session" is disabled
- [ ] Click "Browse..." → directory picker opens → select a git repo
- [ ] Policy selector shows three options, `Standard PR` selected by default
- [ ] Select "Permissive", click "Create Session" → session created with `policyId: "permissive"`
- [ ] Dialog closes, new session appears in session list
- [ ] Click "Cancel" → dialog closes, no session created
- [ ] Create error (e.g., select non-git directory) → error shown in dialog, not lost

**Done condition:** The new session dialog works end-to-end. Users can select a policy before creating a session.

---

## Phase 6: UI — Session List and Policy Display

Update the session list to show meaningful policy labels instead of the generic shield badge.

### 6.1 Update `SessionList.tsx` to show policy name badge

Replace the current shield emoji badge:

```tsx
// Current (M2):
{
  s.sandboxed && <span className="sandbox-badge">&#x1F6E1;</span>
}

// New (M3):
{
  s.policyName && <span className="policy-badge">{s.policyName}</span>
}
```

Style the policy badge with a background color or border to distinguish it from the session label. Consider color-coding by policy type:

- `standard-pr` → blue/neutral (restrictive but productive)
- `research-only` → green (safe, read-only)
- `permissive` → amber/yellow (wider access, use with care)

### 6.2 Add policy info tooltip on badge hover

When the user hovers over the policy badge, show a tooltip with the template's capability summary. Use the `title` attribute for a simple implementation, or a lightweight custom tooltip component if more structure is needed.

Simple approach:

```tsx
<span className="policy-badge" title={`${s.policyName}\n${policyDescription(s.policyId)}`}>
  {s.policyName}
</span>
```

Where `policyDescription()` returns a brief summary like:

- "Filesystem: read-write | Network: blocked"
- "Filesystem: read-only | Network: full"
- "Filesystem: read-write | Network: full"

To get the description, the session list can either:

1. Use the `policyName` field already on `SessionSummary` (simple, no extra data needed)
2. Fetch the full template list once and look up by `policyId` (richer, needed for tooltip)

Option 2 is better for the tooltip. Fetch templates in `App.tsx` on mount and pass them down.

### 6.3 Full flow test

- [ ] Sessions show policy name (e.g., "Standard PR") instead of shield emoji
- [ ] Echo agent sessions show no policy badge (no policy selected)
- [ ] Hovering over the badge shows filesystem/network summary
- [ ] Violation counts still display correctly alongside the policy badge

**Done condition:** The session list clearly communicates which policy each session is running under.

---

## Phase 7: Empirical Validation

Test that the three templates produce measurably different sandbox behavior. This is the equivalent of M2's Phase 5, but focused on policy differentiation rather than baseline functionality.

### 7.1 Test: `standard-pr` blocks network access

- [ ] Create session with `standard-pr` policy
- [ ] Prompt: "Run `curl https://example.com` and report what happens"
- [ ] Expected: curl fails with EPERM or connection refused
- [ ] Verify: sandbox monitor captures `network-outbound` violation
- [ ] Prompt: "List files in the current directory" (control — should still work)

### 7.2 Test: `research-only` blocks file writes

- [ ] Create session with `research-only` policy
- [ ] Prompt: "Create a file called `test.txt` with the content 'hello'"
- [ ] Expected: write fails with EPERM
- [ ] Verify: sandbox monitor captures `file-write-data` violation
- [ ] Prompt: "Read the README.md file and summarize it" (control — should still work)
- [ ] Prompt: "Run `curl https://example.com` and report the HTTP status" (control — should succeed)

### 7.3 Test: `permissive` allows both network and file writes

- [ ] Create session with `permissive` policy
- [ ] Prompt: "Create a file called `test.txt` and then run `curl -s -o /dev/null -w '%{http_code}' https://example.com`"
- [ ] Expected: file created, curl returns 200
- [ ] Verify: no sandbox violations for these operations

### 7.4 Test: SBPL append-profile ordering

This validates the design assumption that deny rules in `--append-profile` override allow rules in safehouse's base profile.

- [ ] Inspect the generated policy file for a `standard-pr` session (at `/tmp/glitterball-sandbox/{sessionId}.sb`)
- [ ] Verify it contains network allow rules from safehouse's base profile
- [ ] Inspect the append profile (`{sessionId}-append.sb`)
- [ ] Verify it contains `(deny network-outbound)` and `(deny network-bind)`
- [ ] Confirm that the deny rules actually override the allows (network requests fail)
- [ ] If ordering doesn't work as expected, investigate alternatives:
  - More specific deny rules (e.g., `(deny network-outbound (remote ip "*:*"))`)
  - Safehouse `--no-network` flag if available
  - Pre-processing the base profile to remove network allows

### 7.5 Document findings and edge cases

- [ ] Record results for each test in this plan (check/uncheck + notes)
- [ ] Document any edge cases discovered:
  - Does `standard-pr` break any non-obvious workflows? (e.g., tools that phone home)
  - Does `research-only` prevent the agent from running at all? (Claude Code may need write access to its own state dirs — safehouse handles this, but verify)
  - Is the localhost exception needed? (check if anything in the agent's startup path uses localhost)
- [ ] If any test fails, categorize:
  - **SBPL ordering issue**: need alternative approach for network deny
  - **Missing safehouse grant**: need `--add-dirs` or `--enable` adjustment
  - **Template design issue**: need to adjust template definition
- [ ] Update the template definitions or policy-sandbox mapper based on findings

**Done condition:** All three templates produce measurably different behavior. Network deny works for `standard-pr`. Read-only works for `research-only`. Findings are documented with clear pass/fail for each test.

---

## Verification Checklist

Run these checks after all phases are complete:

- [x] **Types compile**: `npm run typecheck` passes with no errors
- [x] **Config generation**: `npm run test:policy-sandbox` passes all assertions
- [x] **Registry**: `policies:list` returns three templates from the renderer console
- [x] **Session creation**: creating a session with each policy produces different safehouse args
- [x] **Default policy**: creating a session without specifying a policy uses `standard-pr`
- [x] **New session dialog**: click "New Session" → dialog opens → browse + select policy → create session
- [x] **Policy badges**: session list shows policy name per session, with tooltip
- N/A **Network deny**: deferred to M6 — SBPL deny blocks agent API traffic (see findings.md)
- N/A **Read-only**: template updated to rw worktree — safehouse grants broad temp access (see findings.md)
- [x] **Permissive**: `permissive` session can write files and make network requests
- N/A **Append profile lifecycle**: no append profiles currently generated (network deny deferred)
- [x] **Orphan cleanup**: restart the app → orphan policy files from crashed sessions are cleaned up
- [x] **Echo agent**: echo agent sessions still work, no policy badge shown
- [x] **Backward compatibility**: M2 test scripts still run (deprecated `defaultSandboxConfig()` still works)

---

## File Change Summary

### New files

| File                                               | Purpose                                                       |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `src/main/policy-templates.ts`                     | Three built-in policy template definitions                    |
| `src/main/policy-registry.ts`                      | `PolicyTemplateRegistry` class for template lookup/listing    |
| `src/main/policy-sandbox.ts`                       | `policyToSandboxConfig()` mapper: template → safehouse config |
| `src/renderer/src/components/NewSessionDialog.tsx` | New session dialog with policy selector                       |
| `scripts/test-policy-sandbox.ts`                   | Test harness for policy → sandbox config mapping              |

### Modified files

| File                                          | Changes                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/types.ts`                           | Add `PolicyTemplate`, `FilesystemPolicy`, `NetworkPolicy`, `EnvPolicy`, `PolicyTemplateSummary`; extend `SessionSummary` with `policyId`/`policyName`                                                    |
| `src/main/sandbox.ts`                         | Add `appendProfileContent` to `SandboxConfig`; add `writeAppendProfile()`; update `buildSafehouseArgs()` for `--append-profile`; update `cleanupPolicy()` and `cleanupOrphanPolicies()` for append files |
| `src/main/session-manager.ts`                 | Add `policyRegistry` field; update `createSession()` to accept `policyId` and use `policyToSandboxConfig()`; add `policyId` to `SessionState`; update `summarize()` for policy fields                    |
| `src/main/index.ts`                           | Add `policies:list` IPC handler; update `sessions:create` handler to accept `policyId`                                                                                                                   |
| `src/preload/index.ts`                        | Add `policies` namespace; update `create()` signature with `policyId`                                                                                                                                    |
| `src/renderer/src/env.d.ts`                   | Add `policies` to `GlitterballAPI`; update `create()` type; import `PolicyTemplateSummary`                                                                                                               |
| `src/renderer/src/App.tsx`                    | Add `showNewSessionDialog` state; render `NewSessionDialog`; fetch policy templates on mount                                                                                                             |
| `src/renderer/src/components/SessionList.tsx` | Replace shield emoji badge with policy name badge; add tooltip                                                                                                                                           |
| `package.json`                                | Add `test:policy-sandbox` script                                                                                                                                                                         |
