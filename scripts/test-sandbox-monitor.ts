/**
 * Test harness for the SandboxMonitor.
 *
 * Spawns a sandboxed process that deliberately triggers violations,
 * then verifies the monitor detects them.
 *
 * Usage: npx tsx scripts/test-sandbox-monitor.ts
 *
 * Prerequisites:
 *   - safehouse on PATH (brew install eugene1g/safehouse/agent-safehouse)
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { SandboxMonitor, type SandboxViolation } from '../src/main/sandbox-monitor.js'
import {
  defaultSandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
} from '../src/main/sandbox.js'

const sessionId = randomUUID()

console.log('=== Sandbox Monitor Test ===\n')

if (!(await isSafehouseAvailable())) {
  console.log('safehouse not found. Install: brew install eugene1g/safehouse/agent-safehouse')
  process.exit(1)
}

// Create a temp directory to use as the "worktree"
const worktreePath = join(tmpdir(), `sandbox-monitor-test-${sessionId}`)
await mkdir(worktreePath, { recursive: true })

// Build sandbox config
await ensurePolicyDir()
const config = defaultSandboxConfig({ sessionId, worktreePath })

// Start monitor
const monitor = new SandboxMonitor()
const violations: SandboxViolation[] = []
monitor.on('violation', (v) => {
  violations.push(v)
  console.log(`  [VIOLATION] ${v.processName}(${v.pid}) ${v.operation} ${v.path ?? ''}`)
})

// Spawn a longer-lived process via safehouse that triggers violations
// repeatedly so the monitor has time to start and discover the PID tree.
const homedir = (await import('node:os')).homedir()
const badFile = join(homedir, `.sandbox-monitor-test-${sessionId}`)
// Use $1 to avoid shell injection if homedir has special characters
const shellCmd = [`for i in 1 2 3 4 5; do`, `  touch "$1" 2>/dev/null;`, `  sleep 1;`, `done;`, `echo done`].join(' ')

const args = buildSafehouseArgs(config, ['/bin/sh', '-c', shellCmd, '--', badFile])

console.log('Spawning sandboxed process that will trigger violations...\n')
const proc = spawn('safehouse', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: worktreePath,
})

// Start the monitor watching the safehouse wrapper process — the actual
// shell and its children are descendants that the monitor discovers.
monitor.start(proc.pid!)

proc.stdout?.on('data', (d: Buffer) => {
  const text = d.toString().trim()
  if (text) console.log(`  [stdout] ${text}`)
})
proc.stderr?.on('data', (d: Buffer) => {
  // Suppress shell-init noise from sandboxed shell
  const text = d.toString().trim()
  if (text && !text.includes('shell-init')) console.log(`  [stderr] ${text}`)
})

// Wait for process to exit, then wait for log events to arrive
await new Promise<void>((resolve) => proc.on('exit', () => resolve()))
console.log('\nProcess exited. Waiting for log events (3s)...')
await new Promise((resolve) => setTimeout(resolve, 3000))

monitor.stop()

console.log(`\nTotal violations captured: ${violations.length}`)
if (violations.length > 0) {
  console.log('✓ Monitor detected violations')
  for (const v of violations) {
    console.log(`  - ${v.processName}(${v.pid}) ${v.operation} ${v.path ?? ''}`)
  }
} else {
  console.log('✗ No violations detected')
  console.log('  This can happen if:')
  console.log("  - log stream hasn't started fast enough")
  console.log('  - PID filtering missed the short-lived process')
  console.log('  - Full Disk Access may be needed for log stream')
  process.exitCode = 1
}

// Cleanup
await cleanupPolicy(config.policyOutputPath)
await rm(worktreePath, { recursive: true, force: true })
await rm(badFile, { force: true })

console.log('\n=== Done ===')
