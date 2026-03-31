/**
 * Test harness for worktree scaffolding.
 *
 * Loads a real dataset session, builds a scaffold plan, applies it to a
 * temp directory, and verifies the resulting file tree.
 *
 * Usage: npx tsx scripts/test-scaffold.ts [session-id]
 */
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildScaffoldPlan, applyScaffold } from '../src/main/replay-scaffold.js'
import type { ReplayToolCall } from '../src/main/types.js'

const sessionId = process.argv[2] ?? 'session-308'
const datasetPath = join(process.cwd(), 'data', 'tool-use-dataset.jsonl')

// Load dataset and filter to target session
const lines = readFileSync(datasetPath, 'utf-8').split('\n').filter(Boolean)
interface DatasetRecord {
  id: number
  tool: string
  input: Record<string, unknown>
  outcome: string
  session: string
}

const sessionRecords: DatasetRecord[] = []
for (const line of lines) {
  const record = JSON.parse(line) as DatasetRecord
  if (record.session === sessionId) {
    sessionRecords.push(record)
  }
}

if (sessionRecords.length === 0) {
  console.error(`No records found for session "${sessionId}"`)
  process.exit(1)
}

console.log(`Session ${sessionId}: ${sessionRecords.length} records`)
console.log(`Tools used: ${[...new Set(sessionRecords.map((r) => r.tool))].sort().join(', ')}`)

// Convert to ReplayToolCall format
const toolCalls: ReplayToolCall[] = sessionRecords.map((r) => ({
  id: r.id,
  tool: r.tool,
  input: r.input,
  original_outcome: r.outcome,
}))

// Create temp worktree directory
const worktreeDir = mkdtempSync(join(tmpdir(), 'scaffold-test-'))
console.log(`Worktree: ${worktreeDir}\n`)

// Simple deanonymize function for testing
function deanonymize(path: string): string {
  return path
    .replace(/\{project\}/g, worktreeDir)
    .replace(/\{home\}/g, tmpdir())
    .replace(/\{user\}/g, 'testuser')
}

let exitCode = 0

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`✓ ${label}`)
  } else {
    console.error(`✗ ${label}`)
    exitCode = 1
  }
}

try {
  // Build scaffold plan
  const plan = buildScaffoldPlan(toolCalls, deanonymize, worktreeDir)
  console.log(`Scaffold plan: ${plan.files.size} files, ${plan.directories.size} directories`)

  // Print plan details
  if (plan.files.size > 0) {
    console.log('\nFiles to create:')
    for (const [relPath, content] of plan.files) {
      const preview = content.length > 60 ? content.slice(0, 60) + '...' : content
      console.log(`  ${relPath} (${content.length} bytes): ${preview.replace(/\n/g, '\\n')}`)
    }
  }
  if (plan.directories.size > 0) {
    console.log('\nDirectories to create:')
    for (const dir of plan.directories) {
      console.log(`  ${dir}/`)
    }
  }

  // Apply scaffold
  const filesCreated = await applyScaffold(worktreeDir, plan)
  console.log(`\nApplied scaffold: ${filesCreated} files created`)

  // Walk the resulting tree
  function walkDir(dir: string, prefix = ''): string[] {
    const entries: string[] = []
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const relPath = prefix ? `${prefix}/${entry}` : entry
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        entries.push(`${relPath}/`)
        entries.push(...walkDir(fullPath, relPath))
      } else {
        entries.push(relPath)
      }
    }
    return entries
  }

  const tree = walkDir(worktreeDir)
  console.log(`\nResulting tree (${tree.length} entries):`)
  for (const entry of tree) {
    console.log(`  ${entry}`)
  }

  // Verification
  console.log('\n--- Verification ---')
  check('Plan has at least one file', plan.files.size > 0)
  check('Files created matches plan', filesCreated === plan.files.size)
  check('No .claude/ paths in plan', ![...plan.files.keys()].some((p) => p.includes('.claude/')))
  check(
    'No {project-name} in plan',
    ![...plan.files.keys()].some((p) => p.includes('{project-name}')),
  )
  check('No {home} paths in plan', ![...plan.files.keys()].some((p) => p.includes('{home}')))
  check(
    'All plan files exist on disk',
    [...plan.files.keys()].every((relPath) => {
      try {
        statSync(join(worktreeDir, relPath))
        return true
      } catch {
        return false
      }
    }),
  )

  // Spot-check: Edit files should contain old_string content
  const editCalls = toolCalls.filter(
    (c) => c.tool === 'Edit' && typeof c.input.old_string === 'string',
  )
  if (editCalls.length > 0) {
    const firstEdit = editCalls[0]
    const raw = firstEdit.input.file_path as string
    if (raw && !raw.includes('{project-name}') && !raw.includes('.claude/')) {
      const abs = deanonymize(raw)
      try {
        const content = readFileSync(abs, 'utf-8')
        check(
          `Edit file contains old_string seed`,
          content.includes(firstEdit.input.old_string as string),
        )
      } catch {
        // File might be outside worktree
      }
    }
  }
} catch (err) {
  console.error('Error:', err)
  exitCode = 1
} finally {
  rmSync(worktreeDir, { recursive: true, force: true })
  process.exitCode = exitCode
}
