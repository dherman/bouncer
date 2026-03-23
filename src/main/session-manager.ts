import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { app } from "electron";
import { WorktreeManager, type WorktreeInfo } from "./worktree-manager.js";
import {
  type SandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
  cleanupOrphanPolicies,
  writeAppendProfile,
} from "./sandbox.js";
import { SandboxMonitor } from "./sandbox-monitor.js";
import { PolicyTemplateRegistry } from "./policy-registry.js";
import { policyToSandboxConfig } from "./policy-sandbox.js";
import type {
  AgentType,
  Message,
  SandboxViolationInfo,
  SessionSummary,
  SessionUpdate,
  ToolCallInfo,
} from "./types.js";

interface SpawnConfig {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function resolveEchoAgentCommand(): SpawnConfig {
  const isDev = !app.isPackaged;
  if (isDev) {
    const require = createRequire(app.getAppPath() + "/");
    const tsxBin = require.resolve("tsx/cli");
    const agentScript = join(app.getAppPath(), "src", "agents", "echo-agent.ts");
    return {
      cmd: process.execPath,
      args: [tsxBin, agentScript],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  } else {
    const agentScript = join(__dirname, "..", "agents", "echo-agent.js");
    return {
      cmd: process.execPath,
      args: [agentScript],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
}

function resolveClaudeCodeCommand(
  cwd: string,
  sandboxConfig: SandboxConfig | null,
): SpawnConfig {
  const require = createRequire(app.getAppPath() + "/");
  const binPath = require.resolve(
    "@zed-industries/claude-agent-acp/dist/index.js"
  );

  // When safehouse is available, wrap in sandbox
  if (sandboxConfig) {
    const args = buildSafehouseArgs(sandboxConfig, ["node", binPath]);
    return { cmd: "safehouse", args, cwd };
  }

  // Unsandboxed fallback — use node binary rather than process.execPath
  // (Electron) to avoid spawning a second Electron instance with its own
  // Dock icon on macOS.
  return {
    cmd: "node",
    args: [binPath],
    cwd,
  };
}

function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
): SpawnConfig {
  if (agentType === "echo") {
    return resolveEchoAgentCommand(); // no sandbox for echo agent
  }
  return resolveClaudeCodeCommand(cwd, sandboxConfig);
}

interface SessionState {
  id: string;
  acpSessionId: string;
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: "initializing" | "ready" | "error" | "closed";
  errorMessage?: string;
  agentType: AgentType;
  projectDir: string;
  worktree: WorktreeInfo | null;
  sandboxConfig: SandboxConfig | null;
  sandboxMonitor: SandboxMonitor | null;
  sandboxViolations: SandboxViolationInfo[];
  policyId: string | null;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private worktreeManager = new WorktreeManager();
  private safehouseWarningLogged = false;
  readonly policyRegistry = new PolicyTemplateRegistry();

  constructor(private emit: (channel: string, data: SessionUpdate) => void) {}

  async createSession(
    projectDir: string,
    agentType: AgentType = "claude-code",
    policyId?: string,
  ): Promise<SessionSummary> {
    const id = randomUUID();
    let worktree: WorktreeInfo | null = null;

    // Resolve policy template
    const resolvedPolicyId = agentType === "claude-code"
      ? (policyId ?? this.policyRegistry.defaultId)
      : null;
    const template = resolvedPolicyId
      ? this.policyRegistry.get(resolvedPolicyId)
      : null;

    // Create worktree for Claude Code sessions
    if (agentType === "claude-code") {
      const isGitRepo = await this.worktreeManager.validateGitRepo(projectDir);
      if (!isGitRepo) {
        throw new Error(`Not a git repository: ${projectDir}`);
      }
      worktree = await this.worktreeManager.create(id, projectDir);
    }

    const workingDir = worktree?.path ?? projectDir;

    let sandboxConfig: SandboxConfig | null = null;

    const session: SessionState = {
      id,
      acpSessionId: "",
      agentProcess: null!,
      connection: null!,
      messages: [],
      status: "initializing",
      agentType,
      projectDir,
      worktree,
      sandboxConfig,
      sandboxMonitor: null,
      sandboxViolations: [],
      policyId: resolvedPolicyId,
    };
    this.sessions.set(id, session);
    this.emit("session-update", {
      sessionId: id,
      type: "status-change",
      status: "initializing",
    });

    try {
      // Build sandbox config from policy template
      const safehouseAvailable = await isSafehouseAvailable();
      if (agentType === "claude-code" && !safehouseAvailable) {
        if (!this.safehouseWarningLogged) {
          console.warn(
            "safehouse not available — agent will run without OS-level sandboxing"
          );
          this.safehouseWarningLogged = true;
        }
      }
      if (template && safehouseAvailable) {
        await ensurePolicyDir();

        // Grant read-only access to the app's entire node_modules tree.
        // The agent binary lives under node_modules/@zed-industries/claude-agent-acp,
        // but ESM bare-specifier resolution walks up to the parent node_modules
        // to find peer dependencies (e.g. @agentclientprotocol/sdk). Granting
        // only the agent package dir is insufficient.
        const appNodeModules = join(app.getAppPath(), "node_modules");

        sandboxConfig = policyToSandboxConfig(template, {
          sessionId: id,
          worktreePath: workingDir,
          gitCommonDir: worktree?.gitCommonDir,
          readOnlyDirs: [appNodeModules],
        });
        session.sandboxConfig = sandboxConfig;

        // Write append profile file before spawning (if needed)
        await writeAppendProfile(sandboxConfig);
      }
      // Spawn the agent (sandboxed via safehouse if config present)
      const { cmd, args, env, cwd } = resolveAgentCommand(
        agentType,
        workingDir,
        sandboxConfig,
      );
      const agentProcess = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
        cwd,
      });
      session.agentProcess = agentProcess;

      // Capture stderr for error reporting
      let collectedStderr = "";
      agentProcess.stderr?.on("data", (data: Buffer) => {
        collectedStderr += data.toString();
        // Also forward to the main process console for debugging
        process.stderr.write(data);
      });

      // Handle agent crashes
      agentProcess.on("exit", (code) => {
        if (session.status !== "closed") {
          const errorMessage =
            session.status === "initializing"
              ? collectedStderr.trim() ||
                `Agent exited with code ${code}`
              : undefined;
          session.status = "error";
          session.errorMessage = errorMessage;
          this.emit("session-update", {
            sessionId: id,
            type: "status-change",
            status: "error",
            error: errorMessage,
          });
        }
      });
      agentProcess.on("error", (err) => {
        if (session.status !== "closed") {
          const errorMessage = err.message;
          session.status = "error";
          session.errorMessage = errorMessage;
          this.emit("session-update", {
            sessionId: id,
            type: "status-change",
            status: "error",
            error: errorMessage,
          });
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
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              update.content.type === "text"
            ) {
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
            } else if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            ) {
              const agentMsg = session.messages.findLast(
                (m) => m.role === "agent"
              );
              if (agentMsg) {
                const meta = update._meta as
                  | { claudeCode?: { toolName?: string; toolResponse?: unknown } }
                  | undefined;
                const toolCall: ToolCallInfo = {
                  id: update.toolCallId,
                  name: meta?.claudeCode?.toolName ?? "Tool",
                  status:
                    "status" in update
                      ? (update.status as ToolCallInfo["status"])
                      : "in_progress",
                  title: "title" in update ? (update.title as string) : undefined,
                  output:
                    "rawOutput" in update
                      ? (update.rawOutput as string)
                      : undefined,
                };
                agentMsg.toolCalls = agentMsg.toolCalls ?? [];
                const existing = agentMsg.toolCalls.find(
                  (tc) => tc.id === toolCall.id
                );
                if (existing) {
                  Object.assign(existing, toolCall);
                } else {
                  agentMsg.toolCalls.push(toolCall);
                }
                emitUpdate("session-update", {
                  sessionId: id,
                  type: "tool-call",
                  messageId: agentMsg.id,
                  toolCall,
                });
              }
            }
          },
          async requestPermission(params) {
            // Auto-approve: select the first allow_once option
            const allowOption = params.options.find(
              (o) => o.kind === "allow_once"
            );
            if (allowOption) {
              return {
                outcome: {
                  outcome: "selected" as const,
                  optionId: allowOption.optionId,
                },
              };
            }
            // Fallback: select first option
            return {
              outcome: {
                outcome: "selected" as const,
                optionId: params.options[0].optionId,
              },
            };
          },
        }),
        stream
      );
      session.connection = connection;

      // ACP handshake
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          terminal: true,
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      const sessionResp = await connection.newSession({
        cwd: workingDir,
        mcpServers: [],
      });
      session.acpSessionId = sessionResp.sessionId;

      // Start sandbox monitor if sandboxed
      if (sandboxConfig && agentProcess.pid) {
        const monitor = new SandboxMonitor();
        monitor.on("violation", (violation) => {
          const info: SandboxViolationInfo = {
            timestamp: violation.timestamp.getTime(),
            operation: violation.operation,
            path: violation.path,
            processName: violation.processName,
          };
          session.sandboxViolations.push(info);
          this.emit("session-update", {
            sessionId: id,
            type: "sandbox-violation",
            violation: info,
          });
        });
        monitor.start(agentProcess.pid);
        session.sandboxMonitor = monitor;
      }

      session.status = "ready";
      this.emit("session-update", {
        sessionId: id,
        type: "status-change",
        status: "ready",
      });
    } catch (err) {
      console.error(`Failed to create session ${id}:`, err);
      session.agentProcess?.kill();
      if (worktree) {
        try {
          await this.worktreeManager.remove(worktree);
        } catch {
          // Best effort cleanup
        }
      }
      if (sandboxConfig) {
        await cleanupPolicy(sandboxConfig.policyOutputPath);
      }
      session.status = "error";
      this.emit("session-update", {
        sessionId: id,
        type: "status-change",
        status: "error",
      });
    }

    return this.summarize(session);
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "ready")
      throw new Error(`Session not ready: ${session.status}`);

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
    this.emit("session-update", {
      sessionId,
      type: "stream-end",
      messageId: agentMsg.id,
    });
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((s) => this.summarize(s));
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = "closed";
    session.sandboxMonitor?.stop();
    session.agentProcess?.kill();

    // Tear down worktree
    if (session.worktree) {
      try {
        await this.worktreeManager.remove(session.worktree);
      } catch (err) {
        console.warn(
          `Failed to remove worktree for session ${sessionId}:`,
          err
        );
      }
    }

    // Clean up sandbox policy file
    if (session.sandboxConfig) {
      await cleanupPolicy(session.sandboxConfig.policyOutputPath);
    }

    this.emit("session-update", {
      sessionId,
      type: "status-change",
      status: "closed",
    });
  }

  /** Close all active sessions. Called on app quit. */
  async closeAllSessions(): Promise<void> {
    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.status !== "closed"
    );
    await Promise.all(
      activeSessions.map((s) => this.closeSession(s.id).catch(() => {}))
    );
  }

  /** Remove orphan worktree directories and sandbox policies left behind by a previous crash. */
  async cleanupOrphans(): Promise<void> {
    const activeIds = new Set(this.sessions.keys());
    await this.worktreeManager.cleanupOrphans(activeIds);
    await cleanupOrphanPolicies(activeIds);
  }

  getSandboxViolations(sessionId: string): SandboxViolationInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.sandboxViolations.slice();
  }

  private summarize(session: SessionState): SessionSummary {
    let policyName: string | null = null;
    if (session.policyId) {
      try {
        policyName = this.policyRegistry.get(session.policyId).name;
      } catch {
        policyName = session.policyId;
      }
    }
    return {
      id: session.id,
      status: session.status,
      messageCount: session.messages.length,
      agentType: session.agentType,
      projectDir: session.projectDir,
      sandboxed: session.sandboxConfig !== null,
      policyId: session.policyId,
      policyName,
    };
  }
}
