/**
 * Test harness for the Claude Code ACP agent.
 *
 * Spawns claude-agent-acp, runs the ACP handshake, sends a simple prompt,
 * and logs all Client method calls to discover the real API surface.
 *
 * Usage: npx tsx scripts/test-claude-agent.ts
 *
 * Prerequisites:
 *   - @zed-industries/claude-agent-acp installed
 *   - ANTHROPIC_API_KEY set or Claude Code OAuth active (~/.claude.json)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const require = createRequire(import.meta.url);

// --- Resolve the claude-agent-acp binary ---
const agentBin = require.resolve('@zed-industries/claude-agent-acp/dist/index.js');

const agent = spawn(process.execPath, [agentBin], {
  stdio: ['pipe', 'pipe', 'inherit'], // stderr → console for debugging
  cwd: process.cwd(),
  env: { ...process.env },
});

agent.on('error', (err) => console.error('Agent spawn error:', err));
agent.on('exit', (code) => console.log(`\nAgent exited with code ${code}`));

const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

// --- Terminal tracking ---
interface TerminalState {
  process: ChildProcess;
  output: string;
  exitCode: number | null;
  exitPromise: Promise<number>;
}

const terminals = new Map<string, TerminalState>();

// --- Client implementation with logging ---
const connection = new acp.ClientSideConnection(
  (_agentInterface) => ({
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        process.stdout.write(update.content.text);
      } else {
        console.log('\n[sessionUpdate]', JSON.stringify(update, null, 2));
      }
    },

    async requestPermission(params) {
      console.log('\n[requestPermission]', JSON.stringify(params, null, 2));
      // Auto-approve: select the first allow_once option
      const allowOption = params.options.find((o) => o.kind === 'allow_once');
      if (allowOption) {
        return {
          outcome: { outcome: 'selected' as const, optionId: allowOption.optionId },
        };
      }
      // Fallback: select the first option
      return {
        outcome: { outcome: 'selected' as const, optionId: params.options[0].optionId },
      };
    },

    async readTextFile(params) {
      console.log(`\n[readTextFile] path=${params.path}`);
      const content = await readFile(params.path, 'utf-8');
      return { content };
    },

    async writeTextFile(params) {
      console.log(`\n[writeTextFile] path=${params.path}`);
      await writeFile(params.path, params.content, 'utf-8');
      return {};
    },

    async createTerminal(params) {
      console.log(
        `\n[createTerminal] command=${params.command} args=${JSON.stringify(params.args ?? [])}`,
      );
      const terminalId = `term-${randomUUID()}`;
      const proc = spawn(params.command, params.args ?? [], {
        cwd: params.cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...(params.env ? Object.fromEntries(params.env.map((e) => [e.name, e.value])) : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const state: TerminalState = {
        process: proc,
        output: '',
        exitCode: null,
        exitPromise: new Promise<number>((resolve) => {
          proc.on('exit', (code) => {
            state.exitCode = code ?? 1;
            resolve(code ?? 1);
          });
        }),
      };

      proc.stdout?.on('data', (data: Buffer) => {
        state.output += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        state.output += data.toString();
      });

      terminals.set(terminalId, state);
      return { terminalId };
    },

    async terminalOutput(params) {
      const term = terminals.get(params.terminalId);
      if (!term) throw new Error(`Unknown terminal: ${params.terminalId}`);
      const currentOutput = term.output;
      term.output = '';
      const result: acp.TerminalOutputResponse = {
        output: currentOutput,
        truncated: false,
      };
      if (term.exitCode !== null) {
        result.exitStatus = { exitCode: term.exitCode };
      }
      console.log(
        `\n[terminalOutput] id=${params.terminalId} len=${currentOutput.length} exited=${term.exitCode !== null}`,
      );
      return result;
    },

    async killTerminal(params) {
      console.log(`\n[killTerminal] id=${params.terminalId}`);
      const term = terminals.get(params.terminalId);
      if (term && term.exitCode === null) {
        term.process.kill('SIGTERM');
      }
    },

    async waitForTerminalExit(params) {
      const term = terminals.get(params.terminalId);
      if (!term) return { exitCode: 1 };
      const exitCode = await term.exitPromise;
      console.log(`\n[waitForTerminalExit] id=${params.terminalId} exitCode=${exitCode}`);
      return { exitCode };
    },

    async releaseTerminal(params) {
      console.log(`\n[releaseTerminal] id=${params.terminalId}`);
      const term = terminals.get(params.terminalId);
      if (term) {
        if (term.exitCode === null) term.process.kill('SIGKILL');
        terminals.delete(params.terminalId);
      }
    },
  }),
  stream,
);

// --- Drive the protocol ---
try {
  console.log('Initializing...');
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  console.log('Initialized:', JSON.stringify(initResp, null, 2));

  console.log('\nCreating session...');
  const sessionResp = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log('Session:', sessionResp.sessionId);

  const prompt = 'What files are in the current directory? Just list the filenames, nothing else.';
  console.log(`\nSending prompt: "${prompt}"\n`);
  console.log('--- Response ---');

  const promptResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: 'text', text: prompt }],
  });

  console.log('\n--- End Response ---');
  console.log(`Stop reason: ${promptResp.stopReason}`);
} catch (err) {
  console.error('\nError:', err);
  process.exitCode = 1;
} finally {
  // Clean up terminals
  for (const [, term] of terminals) {
    if (term.exitCode === null) term.process.kill('SIGKILL');
  }
  agent.kill();
}
