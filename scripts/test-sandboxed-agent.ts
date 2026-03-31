/**
 * Test harness for spawning Claude Code under a safehouse sandbox.
 *
 * Spawns the agent via safehouse, runs the ACP handshake, sends a simple
 * prompt, and reports success/failure. Validates that sandboxed agent
 * spawning works end-to-end with stdio piping for ACP.
 *
 * Usage: npx tsx scripts/test-sandboxed-agent.ts [project-dir]
 *
 * Prerequisites:
 *   - safehouse on PATH (brew install eugene1g/safehouse/agent-safehouse)
 *   - @zed-industries/claude-agent-acp installed
 *   - ANTHROPIC_API_KEY set or Claude Code OAuth active (~/.claude.json)
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import {
  defaultSandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
} from '../src/main/sandbox.js'

const require = createRequire(import.meta.url)
const worktreePath = process.argv[2] || process.cwd()
const sessionId = randomUUID()

console.log('=== Sandboxed Agent Test ===\n')

if (!(await isSafehouseAvailable())) {
  console.log('safehouse not found. Install: brew install eugene1g/safehouse/agent-safehouse')
  process.exit(1)
}

// Build sandbox config
await ensurePolicyDir()
const config = defaultSandboxConfig({ sessionId, worktreePath })
console.log(`Worktree: ${worktreePath}`)
console.log(`Policy: ${config.policyOutputPath}`)

// Resolve agent binary
const agentBin = require.resolve('@zed-industries/claude-agent-acp/dist/index.js')

// Spawn via safehouse
const args = buildSafehouseArgs(config, ['node', agentBin])
console.log(`\nSpawning: safehouse ${args.slice(0, 4).join(' ')} ... -- node <agent>\n`)

const agent = spawn('safehouse', args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: worktreePath,
})

agent.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
agent.on('error', (err) => console.error('Spawn error:', err))
agent.on('exit', (code) => console.log(`\nAgent exited: code ${code}`))

// ACP setup
const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>
const stream = acp.ndJsonStream(output, input)

const connection = new acp.ClientSideConnection(
  (_agentInfo) => ({
    async sessionUpdate(params) {
      const update = params.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        process.stdout.write(update.content.text)
      } else if (
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        const meta = update._meta as { claudeCode?: { toolName?: string } } | undefined
        const toolName = meta?.claudeCode?.toolName ?? 'Tool'
        const status = 'status' in update ? (update.status as string) : 'in_progress'
        console.log(`\n  [${toolName}: ${status}]`)
      }
    },
    async requestPermission(params) {
      const opt = params.options.find((o) => o.kind === 'allow_once')
      return {
        outcome: {
          outcome: 'selected' as const,
          optionId: (opt ?? params.options[0]).optionId,
        },
      }
    },
  }),
  stream,
)

try {
  console.log('Initializing ACP...')
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    },
  })
  console.log('✓ Initialize succeeded')

  const sessionResp = await connection.newSession({
    cwd: worktreePath,
    mcpServers: [],
  })
  console.log(`✓ New session: ${sessionResp.sessionId}`)

  // Test 1: Read (list files)
  const readPrompt = 'List the files in the current directory. Be brief.'
  console.log(`\nPrompt 1 (read): "${readPrompt}"\n--- Response ---`)
  const readResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: 'text', text: readPrompt }],
  })
  console.log(`\n--- End (stop: ${readResp.stopReason}) ---`)
  console.log('✓ Read test passed')

  // Test 2: Write (create a file in the worktree)
  const testFileName = `.sandbox-write-test-${sessionId}`
  const writePrompt = `Create a file called ${testFileName} containing 'hello from sandbox'. Do not explain, just create it.`
  console.log(`\nPrompt 2 (write): "${writePrompt}"\n--- Response ---`)
  const writeResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: 'text', text: writePrompt }],
  })
  console.log(`\n--- End (stop: ${writeResp.stopReason}) ---`)

  // Verify the file was created
  const { readFile: readFileAsync, rm: rmAsync } = await import('node:fs/promises')
  const testFilePath = join(worktreePath, testFileName)
  try {
    const content = await readFileAsync(testFilePath, 'utf-8')
    if (content.includes('hello from sandbox')) {
      console.log('✓ Write test passed — file created with expected content')
    } else {
      console.log(`✗ Write test: file exists but content unexpected: "${content.trim()}"`)
      process.exitCode = 1
    }
    await rmAsync(testFilePath, { force: true })
  } catch {
    console.log('✗ Write test failed — file was not created')
    process.exitCode = 1
  }
} catch (err) {
  console.error('\n✗ Error:', err)
  process.exitCode = 1
} finally {
  agent.kill()
  await cleanupPolicy(config.policyOutputPath)
}

console.log('\n=== Done ===')
