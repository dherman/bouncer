import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { app } from "electron";
import type { Message, SessionSummary, SessionUpdate } from "./types.js";

function resolveAgentCommand(): { cmd: string; args: string[] } {
  // In dev, run the TypeScript source via tsx
  // In production, run the compiled JS directly
  const isDev = !app.isPackaged;
  if (isDev) {
    const projectRoot = app.getAppPath();
    const tsxBin = join(projectRoot, "node_modules", ".bin", "tsx");
    const agentScript = join(projectRoot, "src", "agents", "echo-agent.ts");
    return { cmd: tsxBin, args: [agentScript] };
  } else {
    const agentScript = join(__dirname, "..", "agents", "echo-agent.js");
    return { cmd: process.execPath, args: [agentScript] };
  }
}

interface SessionState {
  id: string;
  acpSessionId: string;
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: "initializing" | "ready" | "error" | "closed";
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  constructor(private emit: (channel: string, data: SessionUpdate) => void) {}

  async createSession(): Promise<SessionSummary> {
    const id = randomUUID();

    const session: SessionState = {
      id,
      acpSessionId: "",
      agentProcess: null!,
      connection: null!,
      messages: [],
      status: "initializing",
    };
    this.sessions.set(id, session);
    this.emit("session-update", { sessionId: id, type: "status-change", status: "initializing" });

    try {
      // Spawn the echo agent
      const { cmd, args } = resolveAgentCommand();
      const agentProcess = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "inherit"],
      });
      session.agentProcess = agentProcess;

      // Handle agent crashes
      agentProcess.on("exit", () => {
        if (session.status !== "closed") {
          session.status = "error";
          this.emit("session-update", { sessionId: id, type: "status-change", status: "error" });
        }
      });
      agentProcess.on("error", () => {
        if (session.status !== "closed") {
          session.status = "error";
          this.emit("session-update", { sessionId: id, type: "status-change", status: "error" });
        }
      });

      // Set up ACP connection
      const output = Writable.toWeb(agentProcess.stdin!) as WritableStream<Uint8Array>;
      const input = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(output, input);

      const emitUpdate = this.emit.bind(this);
      const connection = new acp.ClientSideConnection(
        (_agent) => ({
          async sessionUpdate(params) {
            const update = params.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              // Find the streaming agent message and append text
              const agentMsg = session.messages.findLast(
                (m) => m.role === "agent" && m.streaming
              );
              if (agentMsg) {
                agentMsg.text += update.content.text;
                emitUpdate("session-update", {
                  sessionId: id,
                  type: "stream-chunk",
                  messageId: agentMsg.id,
                  text: update.content.text,
                });
              }
            }
          },
          async requestPermission(_params) {
            return { outcome: { outcome: "cancelled" as const } };
          },
        }),
        stream
      );
      session.connection = connection;

      // ACP handshake
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const sessionResp = await connection.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      session.acpSessionId = sessionResp.sessionId;

      session.status = "ready";
      this.emit("session-update", { sessionId: id, type: "status-change", status: "ready" });
    } catch (err) {
      console.error(`Failed to create session ${id}:`, err);
      session.status = "error";
      this.emit("session-update", { sessionId: id, type: "status-change", status: "error" });
    }

    return this.summarize(session);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "ready") throw new Error(`Session not ready: ${session.status}`);

    // Create user message
    const userMsg: Message = {
      id: randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);
    this.emit("session-update", { sessionId, type: "message", message: userMsg });

    // Create placeholder agent message for streaming
    const agentMsg: Message = {
      id: randomUUID(),
      role: "agent",
      text: "",
      timestamp: Date.now(),
      streaming: true,
    };
    session.messages.push(agentMsg);
    this.emit("session-update", { sessionId, type: "message", message: agentMsg });

    // Send prompt via ACP
    try {
      await session.connection.prompt({
        sessionId: session.acpSessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (err) {
      console.error(`Prompt failed for session ${sessionId}:`, err);
    }

    // Finalize the agent message
    agentMsg.streaming = false;
    this.emit("session-update", { sessionId, type: "stream-end", messageId: agentMsg.id });
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((s) => this.summarize(s));
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = "closed";
    session.agentProcess?.kill();
    this.emit("session-update", { sessionId, type: "status-change", status: "closed" });
  }

  private summarize(session: SessionState): SessionSummary {
    return {
      id: session.id,
      status: session.status,
      messageCount: session.messages.length,
    };
  }
}
