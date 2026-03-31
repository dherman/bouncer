/**
 * Test harness for the WorktreeManager.
 *
 * Creates a worktree, verifies it exists, removes it, and verifies cleanup.
 * Uses the bouncer repo itself as the test project.
 *
 * Usage: npx tsx scripts/test-worktree.ts
 */
import { WorktreeManager } from '../src/main/worktree-manager.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)
const manager = new WorktreeManager()

const projectDir = process.cwd()
const sessionId = randomUUID()

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}`)
    failed++
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['branch', '--list', branch], { cwd })
  return stdout.trim().length > 0
}

console.log('=== WorktreeManager Test ===\n')

// --- validateGitRepo ---
console.log('1. validateGitRepo()')
const isGitRepo = await manager.validateGitRepo(projectDir)
assert(isGitRepo, 'bouncer root is a git repo')

const notGitRepo = await manager.validateGitRepo('/tmp')
assert(!notGitRepo, '/tmp is not a git repo')

// --- create / verify / remove ---
let info: Awaited<ReturnType<typeof manager.create>> | undefined
let removed = false

try {
  console.log(`\n2. create() — session ${sessionId.slice(0, 8)}...`)
  info = await manager.create(sessionId, projectDir)
  console.log(`   path:   ${info.path}`)
  console.log(`   branch: ${info.branch}`)

  assert(await pathExists(info.path), 'worktree directory exists')
  assert(await branchExists(info.branch, projectDir), `branch ${info.branch} exists`)

  assert(await pathExists(join(info.path, 'package.json')), 'worktree contains package.json')

  const { stdout: worktreeList } = await execFileAsync('git', ['worktree', 'list'], { cwd: projectDir })
  assert(worktreeList.includes(info.path), 'worktree appears in git worktree list')

  // --- remove ---
  console.log('\n3. remove()')
  await manager.remove(info)
  removed = true

  assert(!(await pathExists(info.path)), 'worktree directory removed')
  assert(!(await branchExists(info.branch, projectDir)), `branch ${info.branch} deleted`)

  const { stdout: worktreeListAfter } = await execFileAsync('git', ['worktree', 'list'], { cwd: projectDir })
  assert(!worktreeListAfter.includes(info.path), 'worktree gone from git worktree list')
} finally {
  if (info && !removed) {
    try {
      await manager.remove(info)
    } catch (err) {
      console.error('Failed to clean up worktree in test harness:', err)
    }
  }
}

// --- summary ---
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
