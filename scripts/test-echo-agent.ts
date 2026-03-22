/**
 * Test harness for the echo agent.
 *
 * Spawns the echo agent as a child process, drives the ACP protocol
 * (initialize → newSession → prompt), and prints streamed updates.
 *
 * Usage: npx tsx scripts/test-echo-agent.ts
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);
const tsxBin = require.resolve("tsx/cli");

const agent = spawn(process.execPath, [tsxBin, "src/agents/echo-agent.ts"], {
  stdio: ["pipe", "pipe", "inherit"],
});

const output = Writable.toWeb(agent.stdin!) as WritableStream<Uint8Array>;
const input = Readable.toWeb(agent.stdout!) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

const connection = new acp.ClientSideConnection(
  (_agent) => ({
    async sessionUpdate(params) {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        process.stdout.write(update.content.text);
      } else {
        console.log("Update:", JSON.stringify(update));
      }
    },
    async requestPermission(_params) {
      return { outcome: { outcome: "cancelled" as const } };
    },
  }),
  stream
);

try {
  // Initialize
  const initResp = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  console.log("Initialized:", JSON.stringify(initResp));

  // Create session
  const sessionResp = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log("Session:", sessionResp.sessionId);

  // Send prompt
  console.log("\nSending: Hello world");
  process.stdout.write("Response: ");
  const promptResp = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: "text", text: "Hello world" }],
  });
  console.log(`\nPrompt done: stopReason=${promptResp.stopReason}`);

  // Send a second prompt to verify session reuse
  console.log("\nSending: Testing 1 2 3");
  process.stdout.write("Response: ");
  const promptResp2 = await connection.prompt({
    sessionId: sessionResp.sessionId,
    prompt: [{ type: "text", text: "Testing 1 2 3" }],
  });
  console.log(`\nPrompt done: stopReason=${promptResp2.stopReason}`);
} catch (err) {
  console.error("Error:", err);
  process.exitCode = 1;
} finally {
  agent.kill();
}
