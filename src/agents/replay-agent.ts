import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Writable, Readable } from "node:stream";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import type { ReplayToolCall, ReplayResult } from "../main/types.js";

// Environment-based config (set by session manager before spawn)
const WORKTREE_PATH = process.env.REPLAY_WORKTREE_PATH ?? process.cwd();

// --- Skip rules for non-replayable tools ---

const SKIP_TOOLS = new Set([
  "WebSearch", "Task", "Agent", "TodoWrite",
  "EnterPlanMode", "ExitPlanMode", "ToolSearch",
  "Skill", "AskUserQuestion", "TaskOutput", "TaskStop",
  "EnterWorktree", "ExitWorktree", "NotebookEdit",
  "SendMessage", "CronCreate", "CronDelete", "CronList",
  "RemoteTrigger", "TeamCreate", "TeamDelete",
]);

function shouldSkip(tool: string): boolean {
  if (SKIP_TOOLS.has(tool)) return true;
  if (tool.startsWith("mcp__")) return true;
  return false;
}

// --- Error classification ---

function classifyError(err: unknown): "blocked" | "error" {
  // Prefer structured error code for Node filesystem/process errors
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return "blocked";
  }
  // Fallback to message matching for non-Node errors (e.g. sandbox stderr)
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("operation not permitted") ||
      msg.includes("permission denied")
    ) {
      return "blocked";
    }
  }
  return "error";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

// --- Tool executors ---

async function executeRead(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const filePath = input.file_path as string;
  if (!filePath) return { replay_outcome: "error", error_message: "missing file_path" };
  try {
    await fs.access(filePath, fsConstants.R_OK);
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

async function executeWrite(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const filePath = input.file_path as string;
  if (!filePath) return { replay_outcome: "error", error_message: "missing file_path" };
  try {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "// replay-stub\n");
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

async function executeEdit(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const filePath = input.file_path as string;
  if (!filePath) return { replay_outcome: "error", error_message: "missing file_path" };
  try {
    let content = await fs.readFile(filePath, "utf-8");
    const oldString = input.old_string as string | undefined;
    const newString = input.new_string as string | undefined;
    if (oldString !== undefined && newString !== undefined) {
      content = content.replace(oldString, newString);
    }
    await fs.writeFile(filePath, content);
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

async function executeGrep(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const path = (input.path as string) ?? WORKTREE_PATH;
  try {
    await fs.access(path, fsConstants.R_OK);
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

async function executeGlob(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const path = (input.path as string) ?? WORKTREE_PATH;
  try {
    await fs.readdir(path);
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

async function executeBash(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const command = input.command as string;
  if (!command) return { replay_outcome: "error", error_message: "missing command" };
  if (command.includes("{host}")) return { replay_outcome: "skipped" };
  try {
    execSync(command, {
      cwd: WORKTREE_PATH,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return { replay_outcome: "allowed" };
  } catch (err) {
    // classifyError handles err.code (EPERM/EACCES) and message fallback
    const outcome = classifyError(err);
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? "";
    const detail = stderr || errorMessage(err);
    return { replay_outcome: outcome, error_message: detail.slice(0, 200) };
  }
}

async function executeWebFetch(input: Record<string, unknown>): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  const url = input.url as string;
  if (!url || url.includes("{host}")) return { replay_outcome: "skipped" };
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { replay_outcome: "allowed" };
  } catch (err) {
    return { replay_outcome: classifyError(err), error_message: errorMessage(err) };
  }
}

// --- Main dispatch ---

async function executeToolCall(call: ReplayToolCall): Promise<Pick<ReplayResult, "replay_outcome" | "error_message">> {
  if (shouldSkip(call.tool)) {
    return { replay_outcome: "skipped" };
  }

  switch (call.tool) {
    case "Read": return executeRead(call.input);
    case "Write": return executeWrite(call.input);
    case "Edit": return executeEdit(call.input);
    case "Grep": return executeGrep(call.input);
    case "Glob": return executeGlob(call.input);
    case "Bash": return executeBash(call.input);
    case "WebFetch": return executeWebFetch(call.input);
    case "WebSearch": return { replay_outcome: "skipped" };
    default:
      return { replay_outcome: "skipped", error_message: `unknown tool: ${call.tool}` };
  }
}

// --- ACP agent ---

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
        const errMsg = err instanceof Error ? err.message : "Unknown parse error";
        const preview = userText.length > 200 ? `${userText.slice(0, 200)}... [truncated]` : userText;
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Error parsing ReplayToolCall[]: ${errMsg}\nInput: ${preview}` },
          },
        });
        return { stopReason: "end_turn" };
      }

      // Execute each tool call and emit results
      const counts = { allowed: 0, blocked: 0, skipped: 0, error: 0 };
      for (const call of toolCalls) {
        const toolCallId = `replay-${call.id}`;
        const outcome = await executeToolCall(call);
        counts[outcome.replay_outcome]++;

        const result: ReplayResult = {
          id: call.id,
          tool: call.tool,
          replay_outcome: outcome.replay_outcome,
          error_message: outcome.error_message,
          original_outcome: call.original_outcome,
        };

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
            text: `Replay complete: ${toolCalls.length} call(s) — ${counts.allowed} allowed, ${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.error} error. Worktree: ${WORKTREE_PATH}`,
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
