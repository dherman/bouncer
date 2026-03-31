/**
 * Test harness for the replay agent.
 *
 * Spawns the replay agent as a child process, drives the ACP protocol
 * (initialize → newSession → prompt), sends a hand-crafted JSON tool-call
 * array with mixed tool types, and verifies replay outcomes.
 *
 * Usage: npx tsx scripts/test-replay-agent.ts
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const require = createRequire(import.meta.url)
const tsxBin = require.resolve('tsx/cli')

const cwd = process.cwd()

// Create a unique temp directory for test files
const testDir = mkdtempSync(join(tmpdir(), 'replay-test-'))
writeFileSync(join(testDir, 'test.txt'), 'hello world\n')

const agent = spawn(process.execPath, [tsxBin, 'src/agents/replay-agent.ts'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, REPLAY_WORKTREE_PATH: testDir },
})

const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>
const stream = acp.ndJsonStream(output, input)

// Collect tool_call updates for verification
interface ToolCallResult {
  toolCallId: string
  title: string
  status: string
  replayOutcome?: string
}
const toolCallUpdates: ToolCallResult[] = []
let summaryText = ''

const connection = new acp.ClientSideConnection(
  (_agent) => ({
    async sessionUpdate(params) {
      const update = params.update
      if (update.sessionUpdate === 'tool_call') {
        const meta = update._meta as { replay?: { replay_outcome?: string } } | undefined
        const status = update.status ?? 'unknown'
        toolCallUpdates.push({
          toolCallId: update.toolCallId,
          title: update.title,
          status,
          replayOutcome: meta?.replay?.replay_outcome,
        })
        console.log(
          `  tool_call: ${update.toolCallId} — ${update.title} [${status}] → ${meta?.replay?.replay_outcome ?? '?'}`,
        )
      } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        summaryText += update.content.text
      }
    },
    async requestPermission(_params) {
      return { outcome: { outcome: 'cancelled' as const } }
    },
  }),
  stream,
)

// Mixed tool calls covering all executor paths + de-anonymization
const toolCalls = [
  // Direct paths (Phase 3 regression)
  { id: 1, tool: 'Read', input: { file_path: join(testDir, 'test.txt') }, original_outcome: 'approved' },
  {
    id: 2,
    tool: 'Write',
    input: { file_path: join(testDir, 'new.txt'), content: 'hello' },
    original_outcome: 'approved',
  },
  {
    id: 3,
    tool: 'Edit',
    input: { file_path: join(testDir, 'test.txt'), old_string: 'hello', new_string: 'goodbye' },
    original_outcome: 'approved',
  },
  { id: 4, tool: 'Bash', input: { command: `ls ${testDir}` }, original_outcome: 'approved' },
  { id: 5, tool: 'Grep', input: { path: testDir, pattern: 'hello' }, original_outcome: 'approved' },
  { id: 6, tool: 'Glob', input: { path: testDir, pattern: '*.txt' }, original_outcome: 'approved' },
  { id: 7, tool: 'TodoWrite', input: { todos: [] }, original_outcome: 'approved' },
  { id: 8, tool: 'Read', input: { file_path: '/nonexistent/path/file.txt' }, original_outcome: 'approved' },
  // De-anonymization: {project} placeholder → testDir
  { id: 9, tool: 'Read', input: { file_path: '{project}/test.txt' }, original_outcome: 'approved' },
  { id: 10, tool: 'Bash', input: { command: 'ls {project}' }, original_outcome: 'approved' },
  // Non-replayable internal paths → skipped
  {
    id: 11,
    tool: 'Read',
    input: { file_path: '{project}/.claude/projects/-Users-{user}-Code-{project-name}/session.jsonl' },
    original_outcome: 'approved',
  },
  { id: 12, tool: 'Read', input: { file_path: '{home}/.claude/settings.json' }, original_outcome: 'approved' },
  // {host} in Bash → skipped
  { id: 13, tool: 'Bash', input: { command: 'curl https://{host}/api' }, original_outcome: 'approved' },
]

// Expected outcomes (unsandboxed)
const expectedOutcomes: Record<number, string> = {
  1: 'allowed', // Read existing file (direct path)
  2: 'allowed', // Write new file
  3: 'allowed', // Edit existing file
  4: 'allowed', // Bash ls
  5: 'allowed', // Grep — read access check
  6: 'allowed', // Glob — readdir
  7: 'skipped', // TodoWrite — non-replayable
  8: 'error', // Read nonexistent file
  9: 'allowed', // Read via {project} de-anonymization
  10: 'allowed', // Bash via {project} de-anonymization
  11: 'skipped', // Non-replayable: {project-name} placeholder
  12: 'skipped', // Non-replayable: .claude/ internal state
  13: 'skipped', // {host} in Bash
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
  // Initialize
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  console.log('✓ Initialized:', JSON.stringify(initResp))

  // Create session
  const sessionResp = await connection.newSession({
    cwd,
    mcpServers: [],
  })
  console.log(`✓ Session created: ${sessionResp.sessionId}`)

  // Send prompt with tool calls
  console.log(`\nSending ${toolCalls.length} tool calls...`)
  const promptResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: 'text', text: JSON.stringify(toolCalls) }],
  })
  console.log(`\n✓ Prompt done: stopReason=${promptResp.stopReason}`)
  console.log(`  Summary: ${summaryText}`)

  // Verify results
  console.log('\n--- Verification ---')

  check(`Received ${toolCalls.length} tool_call updates`, toolCallUpdates.length === toolCalls.length)

  for (let i = 0; i < toolCalls.length; i++) {
    const expected = toolCalls[i]
    const actual = toolCallUpdates[i]
    if (!actual) continue

    const expectedOutcome = expectedOutcomes[expected.id]
    check(
      `Tool ${expected.id} (${expected.tool}): replay_outcome=${actual.replayOutcome} (expected ${expectedOutcome})`,
      actual.replayOutcome === expectedOutcome,
    )
  }
} catch (err) {
  console.error('Error:', err)
  exitCode = 1
} finally {
  agent.kill()
  // Cleanup test files
  const { rmSync } = await import('node:fs')
  rmSync(testDir, { recursive: true, force: true })
  process.exitCode = exitCode
}
