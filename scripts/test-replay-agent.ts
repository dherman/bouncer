/**
 * Test harness for the replay agent.
 *
 * Spawns the replay agent as a child process, drives the ACP protocol
 * (initialize → newSession → prompt), sends a hand-crafted JSON tool-call
 * array, and verifies that one tool_call session update is emitted per item.
 *
 * Usage: npx tsx scripts/test-replay-agent.ts
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);
const tsxBin = require.resolve("tsx/cli");

const agent = spawn(process.execPath, [tsxBin, "src/agents/replay-agent.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, REPLAY_WORKTREE_PATH: process.cwd() },
});

const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

// Collect tool_call updates for verification
const toolCallUpdates: Array<{ toolCallId: string; title: string; status: string }> = [];
let summaryText = "";

const connection = new acp.ClientSideConnection(
  (_agent) => ({
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === "tool_call") {
        const status = update.status ?? "unknown";
        toolCallUpdates.push({
          toolCallId: update.toolCallId,
          title: update.title,
          status,
        });
        console.log(`  tool_call: ${update.toolCallId} — ${update.title} [${status}]`);
      } else if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        summaryText += update.content.text;
      }
    },
    async requestPermission(_params) {
      return { outcome: { outcome: "cancelled" as const } };
    },
  }),
  stream
);

// Hand-crafted tool calls to send as the prompt
const toolCalls = [
  { id: 1, tool: "Read", input: { file_path: "/tmp/test.txt" }, original_outcome: "approved" },
  { id: 2, tool: "Bash", input: { command: "echo hello" }, original_outcome: "approved" },
  { id: 3, tool: "Write", input: { file_path: "/tmp/out.txt", content: "hi" }, original_outcome: "blocked" },
];

let exitCode = 0;

try {
  // Initialize
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  console.log("✓ Initialized:", JSON.stringify(initResp));

  // Create session
  const sessionResp = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`✓ Session created: ${sessionResp.sessionId}`);

  // Send prompt with tool calls
  console.log(`\nSending ${toolCalls.length} tool calls...`);
  const promptResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: "text", text: JSON.stringify(toolCalls) }],
  });
  console.log(`\n✓ Prompt done: stopReason=${promptResp.stopReason}`);
  console.log(`  Summary: ${summaryText}`);

  // Verify results
  console.log("\n--- Verification ---");

  if (toolCallUpdates.length !== toolCalls.length) {
    console.error(`✗ Expected ${toolCalls.length} tool_call updates, got ${toolCallUpdates.length}`);
    exitCode = 1;
  } else {
    console.log(`✓ Received ${toolCallUpdates.length} tool_call updates (matches input)`);
  }

  for (let i = 0; i < toolCalls.length; i++) {
    const expected = toolCalls[i];
    const actual = toolCallUpdates[i];
    if (!actual) continue;

    if (actual.toolCallId !== `replay-${expected.id}`) {
      console.error(`✗ Tool call ${i}: expected id replay-${expected.id}, got ${actual.toolCallId}`);
      exitCode = 1;
    }
    if (!actual.title.includes(expected.tool)) {
      console.error(`✗ Tool call ${i}: expected title to contain "${expected.tool}", got "${actual.title}"`);
      exitCode = 1;
    }
    if (actual.status !== "completed") {
      console.error(`✗ Tool call ${i}: expected status "completed", got "${actual.status}"`);
      exitCode = 1;
    }
  }

  if (exitCode === 0) {
    console.log("✓ All tool call updates match expected values");
  }
} catch (err) {
  console.error("Error:", err);
  exitCode = 1;
} finally {
  agent.kill();
  process.exitCode = exitCode;
}
