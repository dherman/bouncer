/**
 * Quick experiment: test whether ACP `resumeSession` works with Claude Code.
 *
 * Flow:
 *   1. Spawn agent, initialize, newSession
 *   2. Send a prompt with a unique codeword
 *   3. Wait for response, kill the agent
 *   4. Spawn a fresh agent, initialize, resumeSession with the same sessionId
 *   5. Ask the agent what the codeword was
 *   6. If it remembers → resume works; if not → it doesn't
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import * as acp from '@agentclientprotocol/sdk';

const require = createRequire(import.meta.url);
const AGENT_BIN = require.resolve('@zed-industries/claude-agent-acp/dist/index.js');
const CWD = process.cwd();
const CODEWORD = 'PINEAPPLE-TELESCOPE-7742';

function spawnAgent(): ChildProcess {
  const proc = spawn('node', [AGENT_BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: CWD,
  });
  proc.stderr!.on('data', (d: Buffer) => {
    process.stderr.write(`[agent stderr] ${d}`);
  });
  return proc;
}

function makeConnection(proc: ChildProcess): acp.ClientSideConnection {
  const output = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  return new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(params) {
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
          process.stdout.write(u.content.text);
        }
      },
      async requestPermission(params) {
        // Auto-approve everything
        const opt = params.options[0];
        return { outcome: { outcome: 'selected' as const, optionId: opt?.optionId ?? 'allow_once' } };
      },
    }),
    stream,
  );
}

async function initConnection(conn: acp.ClientSideConnection): Promise<void> {
  const resp = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  console.log('\n[test] Agent capabilities:', JSON.stringify(resp.agentCapabilities?.sessionCapabilities));
}

async function sendPrompt(conn: acp.ClientSideConnection, sessionId: string, text: string): Promise<void> {
  console.log(`\n[test] >>> ${text}\n`);
  await conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text }],
  });
  console.log('\n');
}

function killAgent(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
  });
}

async function main() {
  // ── Phase 1: Create session and establish context ──
  console.log('[test] Phase 1: Creating session and establishing context...');
  let proc = spawnAgent();
  let conn = makeConnection(proc);
  await initConnection(conn);

  const { sessionId } = await conn.newSession({ cwd: CWD, mcpServers: [] });
  console.log(`[test] Session ID: ${sessionId}`);

  await sendPrompt(
    conn,
    sessionId,
    `Remember this codeword exactly: "${CODEWORD}". Just acknowledge that you've noted it — don't use any tools, keep your response to one sentence.`,
  );

  // ── Kill the agent ──
  console.log('[test] Killing agent process...');
  await killAgent(proc);
  console.log('[test] Agent killed.\n');

  // ── Phase 2: Spawn fresh agent and resume ──
  console.log('[test] Phase 2: Spawning fresh agent and resuming session...');
  proc = spawnAgent();
  conn = makeConnection(proc);
  await initConnection(conn);

  console.log(`[test] Calling resumeSession(${sessionId})...`);
  try {
    const resumeResp = await conn.unstable_resumeSession({ sessionId, cwd: CWD });
    console.log('[test] Resume response:', JSON.stringify(resumeResp));
  } catch (err) {
    console.error('[test] resumeSession FAILED:', err);
    console.log('\n[test] Falling back to loadSession...');
    try {
      const loadResp = await conn.loadSession({ sessionId, cwd: CWD, mcpServers: [] });
      console.log('[test] loadSession response:', JSON.stringify(loadResp));
    } catch (err2) {
      console.error('[test] loadSession ALSO FAILED:', err2);
      await killAgent(proc);
      process.exit(1);
    }
  }

  // ── Ask about the codeword ──
  await sendPrompt(
    conn,
    sessionId,
    'What was the codeword I asked you to remember? Reply with just the codeword, nothing else.',
  );

  // ── Cleanup ──
  console.log('[test] Done. Cleaning up...');
  try {
    await conn.unstable_closeSession({ sessionId });
  } catch {
    // ignore
  }
  await killAgent(proc);
  process.exit(0);
}

main().catch((err) => {
  console.error('[test] Fatal:', err);
  process.exit(1);
});
