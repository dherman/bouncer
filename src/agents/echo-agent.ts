import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Writable, Readable } from "node:stream";

const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(output, input);

new acp.AgentSideConnection(
  (connection) => ({
    async initialize(_params) {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      };
    },

    async newSession(_params) {
      return {
        sessionId: randomUUID(),
      };
    },

    async prompt(params) {
      // Extract text from the prompt content blocks
      const userText = params.prompt
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");

      const reply = `Echo: ${userText}`;

      // Stream in small chunks to exercise the streaming path
      const chunkSize = 10;
      for (let i = 0; i < reply.length; i += chunkSize) {
        const chunk = reply.slice(i, i + chunkSize);
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          },
        });
        await new Promise((r) => setTimeout(r, 50));
      }

      return { stopReason: "end_turn" };
    },

    async cancel(params) {
      // No-op for echo agent
    },

    async authenticate(_params) {
      return {};
    },

    async setSessionMode(_params) {
      return {};
    },
  }),
  stream
);

process.stderr.write("Echo agent started\n");
