import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Writable, Readable } from "node:stream";
import type { ReplayToolCall, ReplayResult } from "../main/types.js";

// Environment-based config (set by session manager before spawn)
const WORKTREE_PATH = process.env.REPLAY_WORKTREE_PATH ?? process.cwd();

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

      // Parse the prompt text as a JSON array of ReplayToolCall
      let toolCalls: ReplayToolCall[];
      try {
        const parsed = JSON.parse(userText);
        if (!Array.isArray(parsed)) {
          throw new Error(`Expected array, got ${typeof parsed}`);
        }
        toolCalls = parsed as ReplayToolCall[];
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown parse error";
        const preview = userText.length > 200 ? `${userText.slice(0, 200)}... [truncated]` : userText;
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error parsing ReplayToolCall[]: ${errorMessage}\nInput: ${preview}` },
          },
        });
        return { stopReason: "end_turn" };
      }

      // Emit a tool_call session update for each item (all skipped for now)
      for (const call of toolCalls) {
        const toolCallId = `replay-${call.id}`;
        const result: ReplayResult = {
          id: call.id,
          tool: call.tool,
          replay_outcome: "skipped",
          original_outcome: call.original_outcome,
        };

        // Emit tool_call as completed (skipped — no execution in skeleton)
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: `[replay] ${call.tool}`,
            status: "completed",
            rawInput: call.input,
            rawOutput: JSON.stringify(result),
            _meta: {
              claudeCode: { toolName: call.tool },
              replay: result,
            },
          },
        });
      }

      // Summary message
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Replay complete: ${toolCalls.length} tool call(s) processed (all skipped). Worktree: ${WORKTREE_PATH}`,
          },
        },
      });

      return { stopReason: "end_turn" };
    },

    async cancel(_params) {
      // No-op for replay agent
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

process.stderr.write(`Replay agent started (worktree: ${WORKTREE_PATH})\n`);
