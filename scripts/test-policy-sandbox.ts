// scripts/test-policy-sandbox.ts
//
// Verifies that each policy template produces the expected safehouse args.
// Does NOT spawn agents — just tests the config generation.
//
// Usage: npx tsx scripts/test-policy-sandbox.ts

import assert from 'node:assert/strict'
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
    assert(hasWorktreeWritable, 'standard-pr: worktree should be writable')
    assert(!hasWorktreeReadOnly, 'standard-pr: worktree should not be read-only')
    // Network deny is intentionally skipped — SBPL deny blocks agent API traffic.
    // See docs/milestones/policy-templates/findings.md
    assert(!hasAppendProfile, 'standard-pr: should not have append profile (network deny deferred to M6)')
  } else if (summary.id === 'research-only') {
    assert(hasWorktreeWritable, 'research-only: worktree should be writable (scoped to worktree)')
    assert(!hasWorktreeReadOnly, 'research-only: worktree should not be read-only')
    assert(!hasAppendProfile, 'research-only: should not have append profile')
  } else if (summary.id === 'permissive') {
    assert(hasWorktreeWritable, 'permissive: worktree should be writable')
    assert(!hasWorktreeReadOnly, 'permissive: worktree should not be read-only')
    assert(!hasAppendProfile, 'permissive: should not have append profile')
  }

  console.log(`  ✓ Assertions passed\n`)
}

console.log('=== All tests passed ===')
