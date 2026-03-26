import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
import { ContainerMonitor } from "./container-monitor.js";
import { PolicyTemplateRegistry } from "./policy-registry.js";
import { policyToSandboxConfig } from "./policy-sandbox.js";
import { parsePolicyEvent } from "./policy-event-parser.js";
import {
  detectGitHubRepo,
  buildSessionPolicy,
  writePolicyState,
  readPolicyState,
  policyStatePath,
  cleanupPolicyState,
  installGhShim,
  cleanupGhShim,
  findRealGh,
  cleanupOrphanGitHubArtifacts,
} from "./github-policy.js";
import { installHooks, cleanupHooks, generatePrePushHookForContainer, allowedRefsPath } from "./hooks.js";
import { policyToContainerConfig, generateGitconfig, type ContainerSessionContext } from "./policy-container.js";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { POLICY_DIR } from "./sandbox.js";
import type {
  AgentType,
  GitHubPolicy,
  Message,
  SandboxBackend,
  SandboxViolationInfo,
  SessionSummary,
  SessionUpdate,
  ToolCallInfo,
} from "./types.js";
import {
  isDockerAvailable,
  ensureAgentImage,
  spawnContainer,
  removeContainer,
  cleanupOrphanContainers,
  type ContainerConfig,
  type ContainerHandle,
} from "./container.js";

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

function resolveReplayAgentCommand(
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  worktreePath: string,
): SpawnConfig {
  const isDev = !app.isPackaged;
  const require = createRequire(app.getAppPath() + "/");

  let cmd: string;
  let args: string[];

  let agentArgs: string[];
  if (isDev) {
    const tsxBin = require.resolve("tsx/cli");
    const agentScript = join(app.getAppPath(), "src", "agents", "replay-agent.ts");
    agentArgs = [tsxBin, agentScript];
  } else {
    const agentScript = join(__dirname, "..", "agents", "replay-agent.js");
    agentArgs = [agentScript];
  }

  const env: Record<string, string> = {
    REPLAY_WORKTREE_PATH: worktreePath,
  };

  // Under safehouse, use "node" — Electron's native IOKit/GPU init
  // crashes when sandbox blocks IOKit access (before ELECTRON_RUN_AS_NODE
  // takes effect). Without safehouse, use process.execPath with
  // ELECTRON_RUN_AS_NODE so we don't depend on node being on PATH.
  if (sandboxConfig) {
    const safehouseArgs = buildSafehouseArgs(sandboxConfig, ["node", ...agentArgs]);
    return { cmd: "safehouse", args: safehouseArgs, cwd, env };
  }

  cmd = process.execPath;
  args = agentArgs;
  env.ELECTRON_RUN_AS_NODE = "1";
  return { cmd, args, env, cwd };
}

// Resolve the command for non-container agent spawning.
// Container agents are spawned via spawnContainer() directly in createSession.
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  worktreePath?: string,
): SpawnConfig {
  if (agentType === "echo") {
    return resolveEchoAgentCommand();
  }
  if (agentType === "replay") {
    return resolveReplayAgentCommand(cwd, sandboxConfig, worktreePath ?? cwd);
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
  sandboxBackend: SandboxBackend;
  sandboxConfig: SandboxConfig | null;
  sandboxMonitor: SandboxMonitor | null;
  containerMonitor: ContainerMonitor | null;
  sandboxViolations: SandboxViolationInfo[];
  containerHandle: ContainerHandle | null;
  policyId: string | null;
  githubPolicy: GitHubPolicy | null;
  /** Flush any batched stream-chunk events. Called before stream-end. */
  flushChunks: () => void;
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

    // Resolve policy template — replay agents also get sandboxed
    const resolvedPolicyId = (agentType === "claude-code" || agentType === "replay")
      ? (policyId ?? this.policyRegistry.defaultId)
      : null;
    const template = resolvedPolicyId
      ? this.policyRegistry.get(resolvedPolicyId)
      : null;

    // Create worktree for Claude Code and replay sessions
    if (agentType === "claude-code" || agentType === "replay") {

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
      sandboxBackend: "none",
      sandboxConfig,
      sandboxMonitor: null,
      containerMonitor: null,
      sandboxViolations: [],
      containerHandle: null,
      policyId: resolvedPolicyId,
      githubPolicy: null,
      flushChunks: () => {},
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
      if ((agentType === "claude-code" || agentType === "replay") && !safehouseAvailable) {
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

        // The replay agent entrypoint lives in src/agents/ (dev) or
        // dist/agents/ (prod), outside node_modules. Grant read-only
        // access to the app root so the sandbox can read the script.
        const readOnlyDirs = [appNodeModules];
        if (agentType === "replay") {
          readOnlyDirs.push(app.getAppPath());
        }

        sandboxConfig = policyToSandboxConfig(template, {
          sessionId: id,
          worktreePath: workingDir,
          gitCommonDir: worktree?.gitCommonDir,
          readOnlyDirs,
        });
        session.sandboxConfig = sandboxConfig;

        // Write append profile file before spawning (if needed)
        await writeAppendProfile(sandboxConfig);
      }
      // --- Application-layer policy (M5) ---
      let shimEnv: Record<string, string> = {};
      if (template?.github && worktree) {
        const repo = await detectGitHubRepo(workingDir);
        if (repo) {
          const githubPolicy = buildSessionPolicy(repo, worktree.branch);
          // Set on session before side effects so error cleanup can find it
          session.githubPolicy = githubPolicy;
          await writePolicyState(id, githubPolicy);
          await installHooks(id, workingDir, githubPolicy.allowedPushRefs);

          // Configure the worktree for HTTPS push with gh credential helper.
          // SSH push fails in the sandbox (SSH_AUTH_SOCK socket is blocked),
          // so switch the remote to HTTPS and configure git to use gh for auth.
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify: pfy } = await import("node:util");
          const execFileP = pfy(execFileCb);
          const httpsUrl = `https://github.com/${repo}.git`;
          await execFileP("git", ["-C", workingDir, "remote", "set-url", "origin", httpsUrl]).catch(() => {});

          // Install gh shim and set up environment (only if gh is available).
          // Also configure git credential helper to use the real gh binary
          // so git push via HTTPS can authenticate.
          const realGhPath = await findRealGh();
          if (realGhPath) {
            const ghShimPath = app.isPackaged
              ? join(app.getAppPath(), "dist", "main", "gh-shim.js")
              : join(app.getAppPath(), "src", "main", "gh-shim.ts");
            const shimDir = await installGhShim(id, ghShimPath, "node");

            // Resolve GH_TOKEN — gh uses keyring auth which the sandbox blocks.
            let ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
            if (!ghToken) {
              try {
                const { stdout } = await execFileP("gh", ["auth", "token"]);
                ghToken = stdout.trim();
              } catch {
                console.warn("Could not resolve gh auth token — gh commands may fail in sandbox");
              }
            }

            // Configure git credential helper so git push HTTPS uses the token.
            // Point to the *real* gh (not the shim) for credential operations.
            if (ghToken) {
              await execFileP("git", ["-C", workingDir, "config", "credential.helper", ""]).catch(() => {});
              await execFileP("git", ["-C", workingDir, "config",
                `credential.https://github.com.helper`,
                `!${realGhPath} auth git-credential`,
              ]).catch(() => {});
            }

            shimEnv = {
              BOUNCER_GITHUB_POLICY: policyStatePath(id),
              BOUNCER_REAL_GH: realGhPath,
              PATH: `${shimDir}:${process.env.PATH ?? ""}`,
              ...(ghToken ? { GH_TOKEN: ghToken } : {}),
            };
            // Ensure safehouse forwards the shim env vars and GitHub
            // auth/network vars to the agent
            if (sandboxConfig) {
              sandboxConfig.envPassthrough.push(
                "BOUNCER_GITHUB_POLICY",
                "BOUNCER_REAL_GH",
                "PATH",
                // Git push via SSH needs the auth socket
                "SSH_AUTH_SOCK",
                "GIT_SSH_COMMAND",
                // gh CLI auth
                "GH_TOKEN",
                "GITHUB_TOKEN",
              );
            }
          } else {
            console.warn("gh CLI not found — gh shim will not be installed");
          }
        } else {
          console.warn("No GitHub remote detected — skipping application-layer policy");
        }
      }

      // Select sandbox backend: Docker container > safehouse > none
      const dockerAvailable = await isDockerAvailable();
      let containerConfig: ContainerConfig | null = null;

      if (dockerAvailable) {
        const imageTag = await ensureAgentImage();

        if (agentType === "echo") {
          // Echo agent: simple container with agent script mounted
          const appNodeModules = join(app.getAppPath(), "node_modules");
          let echoAgentHost: string;
          let echoAgentContainerPath: string;
          let echoCommand: string[];
          if (app.isPackaged) {
            echoAgentHost = join(app.getAppPath(), "dist", "agents", "echo-agent.js");
            echoAgentContainerPath = "/app/agents/echo-agent.js";
            echoCommand = ["node", echoAgentContainerPath];
          } else {
            echoAgentHost = join(app.getAppPath(), "src", "agents", "echo-agent.ts");
            echoAgentContainerPath = "/app/agents/echo-agent.ts";
            echoCommand = ["npx", "tsx", echoAgentContainerPath];
          }
          containerConfig = {
            sessionId: id,
            image: imageTag,
            command: echoCommand,
            workdir: "/workspace",
            mounts: [
              { hostPath: echoAgentHost, containerPath: echoAgentContainerPath, readOnly: true },
              { hostPath: appNodeModules, containerPath: "/app/node_modules", readOnly: true },
            ],
            env: { NODE_PATH: "/app/node_modules" },
            networkMode: "bridge",
          };
        } else if (template && (agentType === "claude-code" || agentType === "replay")) {
          // Claude Code / replay: full container config via policyToContainerConfig
          const appRequire = createRequire(app.getAppPath() + "/");
          // Resolve to the agent package root (not dist/) so the mount includes package.json
          // which ESM needs for bare-specifier resolution.
          const agentPkgDir = join(appRequire.resolve("@zed-industries/claude-agent-acp/package.json"), "..");
          const appNodeModules = join(app.getAppPath(), "node_modules");

          // Build container-specific artifacts on the host
          await mkdir(POLICY_DIR, { recursive: true });

          // Container gh wrapper script
          let containerShimScript: string | undefined;
          let containerGitconfigFile: string | undefined;
          let containerHooksDir: string | undefined;
          let containerCredHelper: string | undefined;

          if (template.github && session.githubPolicy) {
            // Write container gh wrapper (points to container paths)
            const wrapperPath = join(POLICY_DIR, `${id}-container-gh-wrapper`);
            await writeFile(wrapperPath, `#!/bin/bash\nexec node /usr/local/lib/bouncer/gh-shim.js "$@"\n`, "utf-8");
            await chmod(wrapperPath, 0o755);
            containerShimScript = wrapperPath;

            // Write container-mode hooks (with container path for allowed-refs)
            containerHooksDir = join(POLICY_DIR, `${id}-container-hooks`);
            await mkdir(containerHooksDir, { recursive: true });
            const hookContent = generatePrePushHookForContainer();
            const hookPath = join(containerHooksDir, "pre-push");
            await writeFile(hookPath, hookContent, "utf-8");
            await chmod(hookPath, 0o755);

            // Write gitconfig
            const gitconfigContent = generateGitconfig({
              hooksPath: "/etc/bouncer/hooks",
              credentialHelperPath: "/usr/local/lib/bouncer/gh-credential-helper.js",
              userName: process.env.GIT_AUTHOR_NAME,
              userEmail: process.env.GIT_AUTHOR_EMAIL,
            });
            containerGitconfigFile = join(POLICY_DIR, `${id}-gitconfig`);
            await writeFile(containerGitconfigFile, gitconfigContent, "utf-8");

            // Write a compiled JS credential helper (can't mount TS source directly)
            const { generateCredentialHelperJs } = await import("./policy-container.js");
            containerCredHelper = join(POLICY_DIR, `${id}-credential-helper.js`);
            await writeFile(containerCredHelper, generateCredentialHelperJs(), { mode: 0o755 });
          }

          // Resolve the shim bundle — mount whenever GitHub policy is active,
          // independent of whether a host gh binary was found.
          const shimBundlePath = (template.github && session.githubPolicy)
            ? join(POLICY_DIR, "gh-shim-bundle.js")
            : undefined;

          // Container env — only explicit vars, no process.env inheritance.
          // The container runs Linux, where the Claude CLI reads credentials
          // from ~/.claude/.credentials.json (not the macOS keychain).
          // Extract from macOS keychain and write a credentials file for the container.
          const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
          let claudeCredentialsPath: string | undefined;
          if (!anthropicKey && process.platform === "darwin") {
            try {
              const { execFile: execFileCb2 } = await import("node:child_process");
              const { promisify: pfy2 } = await import("node:util");
              const execFileP2 = pfy2(execFileCb2);
              const { stdout: credJson } = await execFileP2("security", [
                "find-generic-password", "-s", "Claude Code-credentials", "-w",
              ]);
              claudeCredentialsPath = join(POLICY_DIR, `${id}-claude-credentials.json`);
              await writeFile(claudeCredentialsPath, credJson.trim(), { mode: 0o600 });
              console.log("[container] Wrote Claude credentials file from macOS keychain");
            } catch (err) {
              console.warn("[container] Could not extract Claude credentials from keychain:", err);
              claudeCredentialsPath = undefined;
            }
          }
          const ghToken = shimEnv.GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
          const containerEnv: Record<string, string> = {
            ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
            ...(process.env.GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME } : {}),
            ...(process.env.GIT_AUTHOR_EMAIL ? { GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL } : {}),
            ...(process.env.GIT_COMMITTER_NAME ? { GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME } : {}),
            ...(process.env.GIT_COMMITTER_EMAIL ? { GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL } : {}),
          };

          const ctx: ContainerSessionContext = {
            sessionId: id,
            worktreePath: workingDir,
            gitCommonDir: worktree?.gitCommonDir,
            agentBinPath: agentPkgDir,
            nodeModulesPath: appNodeModules,
            shimBundlePath: shimBundlePath && containerShimScript ? shimBundlePath : undefined,
            shimScriptPath: containerShimScript,
            hooksDir: containerHooksDir,
            allowedRefsPath: allowedRefsPath(id),
            policyStatePath: session.githubPolicy ? policyStatePath(id) : undefined,
            gitconfigPath: containerGitconfigFile,
            credentialHelperPath: containerCredHelper,
            userGitconfigPath: await (async () => {
              // Sanitize the user's gitconfig: remove credential helpers that
              // reference host-only paths (e.g. /opt/homebrew/bin/gh).
              const home = (await import("node:os")).homedir();
              const hostGitconfig = join(home, ".gitconfig");
              try {
                const { readFile: rf } = await import("node:fs/promises");
                const raw = await rf(hostGitconfig, "utf-8");
                const { sanitizeGitconfig } = await import("./policy-container.js");
                const sanitized = sanitizeGitconfig(raw);
                const sanitizedPath = join(POLICY_DIR, `${id}-user-gitconfig`);
                await writeFile(sanitizedPath, sanitized, { encoding: "utf-8", mode: 0o600 });
                return sanitizedPath;
              } catch {
                return undefined;
              }
            })(),
            claudeConfigDir: join((await import("node:os")).homedir(), ".claude"),
            claudeCredentialsPath,
          };

          containerConfig = policyToContainerConfig(
            template,
            ctx,
            containerEnv,
            imageTag,
            ["node", "/usr/local/lib/agent/dist/index.js"],
          );
        }

        if (containerConfig) {
          session.sandboxBackend = "container";
          // Unset repo-level core.hooksPath so the system gitconfig
          // (/etc/gitconfig) takes effect inside the container.
          // installHooks() set it earlier for the safehouse path.
          if (worktree) {
            const { execFile: execFileCb3 } = await import("node:child_process");
            const { promisify: pfy3 } = await import("node:util");
            const execFileP3 = pfy3(execFileCb3);
            await execFileP3("git", ["-C", workingDir, "config", "--unset", "core.hooksPath"]).catch(() => {});
            // Also unset repo-level credential helpers that reference host-only paths.
            // Our /etc/gitconfig provides the correct credential helper for the container.
            await execFileP3("git", ["-C", workingDir, "config", "--unset", "credential.helper"]).catch(() => {});
            await execFileP3("git", ["-C", workingDir, "config", "--unset", "credential.https://github.com.helper"]).catch(() => {});
          }
        }
      }

      if (!containerConfig && sandboxConfig) {
        session.sandboxBackend = "safehouse";
      } else if (!containerConfig) {
        session.sandboxBackend = session.sandboxBackend === "container" ? "container" : "none";
      }

      // Spawn the agent
      let agentProcess: ChildProcess;
      if (containerConfig) {
        const handle = spawnContainer(containerConfig);
        session.containerHandle = handle;
        agentProcess = handle.process;
      } else {
        const { cmd, args, env, cwd } = resolveAgentCommand(
          agentType,
          workingDir,
          sandboxConfig,
          worktree?.path,
        );
        agentProcess = spawn(cmd, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env, ...shimEnv },
          cwd,
        });
      }
      session.agentProcess = agentProcess;

      // Capture stderr for error reporting and parse policy events.
      // Use StringDecoder to handle multibyte characters (e.g. em-dash)
      // that may be split across chunks.
      let collectedStderr = "";
      let stderrBuffer = "";
      const stderrDecoder = new StringDecoder("utf8");
      const flushStderrLine = (line: string): void => {
        const event = parsePolicyEvent(line);
        if (event) {
          this.emit("session-update", {
            sessionId: id,
            type: "policy-event",
            event,
          });
        }
      };
      agentProcess.stderr?.on("data", (data: Buffer) => {
        const chunk = stderrDecoder.write(data);
        collectedStderr += chunk;
        process.stderr.write(data);

        // Parse policy events from complete lines
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
        for (const line of lines) {
          flushStderrLine(line);
        }
      });

      // Handle agent crashes — flush any remaining stderr buffer first
      agentProcess.on("exit", (code) => {
        // Flush remaining bytes from the decoder and parse final line
        const remaining = stderrDecoder.end();
        if (remaining) {
          collectedStderr += remaining;
          stderrBuffer += remaining;
        }
        if (stderrBuffer) {
          flushStderrLine(stderrBuffer);
          stderrBuffer = "";
        }

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

      // Batch stream-chunk events to reduce IPC/render pressure.
      // Accumulate text per message and flush every 50ms.
      const pendingChunks = new Map<string, { messageId: string; text: string }>();
      let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushChunks = (): void => {
        if (chunkFlushTimer) {
          clearTimeout(chunkFlushTimer);
          chunkFlushTimer = null;
        }
        for (const [, chunk] of pendingChunks) {
          emitUpdate("session-update", {
            sessionId: id,
            type: "stream-chunk",
            messageId: chunk.messageId,
            text: chunk.text,
          });
        }
        pendingChunks.clear();
      };
      session.flushChunks = flushChunks;
      const scheduleChunkFlush = (): void => {
        if (!chunkFlushTimer) {
          chunkFlushTimer = setTimeout(flushChunks, 50);
        }
      };

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
                // Batch: accumulate text, flush on timer
                const pending = pendingChunks.get(agentMsg.id);
                if (pending) {
                  pending.text += update.content.text;
                } else {
                  pendingChunks.set(agentMsg.id, {
                    messageId: agentMsg.id,
                    text: update.content.text,
                  });
                }
                scheduleChunkFlush();
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
                      ? (typeof update.rawOutput === "string"
                          ? update.rawOutput
                          : JSON.stringify(update.rawOutput))
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
        cwd: containerConfig ? "/workspace" : workingDir,
        mcpServers: [],
      });
      session.acpSessionId = sessionResp.sessionId;

      // Start sandbox monitor if sandboxed via safehouse
      if (sandboxConfig && !containerConfig && agentProcess.pid) {
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

      // Start container monitor for container sessions
      if (session.containerHandle) {
        const cMonitor = new ContainerMonitor();
        cMonitor.on("violation", (violation) => {
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
        cMonitor.start(session.containerHandle.containerName);
        session.containerMonitor = cMonitor;
      }

      session.status = "ready";
      this.emit("session-update", {
        sessionId: id,
        type: "status-change",
        status: "ready",
      });
    } catch (err) {
      console.error(`Failed to create session ${id}:`, err);
      if (session.containerHandle) {
        session.containerHandle.kill();
      } else {
        session.agentProcess?.kill();
      }
      await removeContainer(id).catch(() => {});
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
      // Best-effort cleanup of GitHub artifacts (may have been partially created)
      await cleanupPolicyState(id).catch(() => {});
      await cleanupGhShim(id).catch(() => {});
      if (worktree) {
        await cleanupHooks(id, worktree.path).catch(() => {});
      }
      session.status = "error";
      this.emit("session-update", {
        sessionId: id,
        type: "status-change",
        status: "error",
      });
    }

    return await this.summarize(session);
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

    // Flush any batched chunks before finalizing
    session.flushChunks();

    // Finalize the agent message
    agentMsg.streaming = false;
    this.emit("session-update", {
      sessionId,
      type: "stream-end",
      messageId: agentMsg.id,
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await Promise.all(
      Array.from(this.sessions.values()).map((s) => this.summarize(s))
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.status = "closed";
    session.flushChunks();
    session.sandboxMonitor?.stop();
    session.containerMonitor?.stop();
    if (session.containerHandle) {
      session.containerHandle.kill();
    } else {
      session.agentProcess?.kill();
    }

    // Clean up container and container-specific host artifacts
    if (session.sandboxBackend === "container") {
      await removeContainer(sessionId).catch((err) =>
        console.warn(`Failed to remove container for session ${sessionId}:`, err)
      );
      // Clean up container-specific files on the host
      await rm(join(POLICY_DIR, `${sessionId}-container-gh-wrapper`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${sessionId}-container-hooks`), { recursive: true, force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${sessionId}-gitconfig`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${sessionId}-claude-credentials.json`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${sessionId}-credential-helper.js`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${sessionId}-user-gitconfig`), { force: true }).catch(() => {});
    }

    // Clean up application-layer policy artifacts
    if (session.githubPolicy) {
      if (session.worktree) {
        await cleanupHooks(sessionId, session.worktree.path).catch((err) =>
          console.warn(`Failed to clean up hooks for session ${sessionId}:`, err)
        );
      }
      await cleanupPolicyState(sessionId).catch((err) =>
        console.warn(`Failed to clean up policy state for session ${sessionId}:`, err)
      );
      await cleanupGhShim(sessionId).catch((err) =>
        console.warn(`Failed to clean up gh shim for session ${sessionId}:`, err)
      );
    }

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

  /** Remove orphan worktree directories, sandbox policies, containers, and container artifacts left behind by a previous crash. */
  async cleanupOrphans(): Promise<void> {
    const activeIds = new Set(this.sessions.keys());
    await this.worktreeManager.cleanupOrphans(activeIds);
    await cleanupOrphanPolicies(activeIds);
    await cleanupOrphanGitHubArtifacts(activeIds);
    await cleanupOrphanContainers(activeIds).catch((err) =>
      console.warn("Failed to clean up orphan containers:", err)
    );
    // Clean up orphan container artifacts (credentials, gitconfig, wrapper, hooks)
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(POLICY_DIR).catch(() => [] as string[]);
      const suffixes = ["-container-gh-wrapper", "-container-hooks", "-gitconfig", "-claude-credentials.json", "-credential-helper.js", "-user-gitconfig"];
      for (const f of files) {
        for (const suffix of suffixes) {
          if (f.endsWith(suffix)) {
            const sessionId = f.slice(0, -suffix.length);
            if (sessionId && !activeIds.has(sessionId)) {
              await rm(join(POLICY_DIR, f), { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      }
    } catch {
      // Best effort
    }
  }

  getSandboxViolations(sessionId: string): SandboxViolationInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.sandboxViolations.slice();
  }

  private async summarize(session: SessionState): Promise<SessionSummary> {
    let policyName: string | null = null;
    if (session.policyId) {
      try {
        policyName = this.policyRegistry.get(session.policyId).name;
      } catch {
        policyName = session.policyId;
      }
    }

    // Read live policy state from disk (the gh shim may have updated it)
    let githubRepo = session.githubPolicy?.repo ?? null;
    let ownedPrNumber = session.githubPolicy?.ownedPrNumber ?? null;
    if (session.githubPolicy) {
      try {
        const livePolicy = await readPolicyState(policyStatePath(session.id));
        githubRepo = livePolicy.repo;
        ownedPrNumber = livePolicy.ownedPrNumber;
        // Sync in-memory state
        session.githubPolicy.ownedPrNumber = livePolicy.ownedPrNumber;
        session.githubPolicy.canCreatePr = livePolicy.canCreatePr;
      } catch {
        // Policy file may have been cleaned up — use in-memory state
      }
    }

    return {
      id: session.id,
      status: session.status,
      messageCount: session.messages.length,
      agentType: session.agentType,
      projectDir: session.projectDir,
      sandboxed: session.sandboxBackend !== "none",
      sandboxBackend: session.sandboxBackend,
      containerName: session.containerHandle?.containerName ?? null,
      policyId: session.policyId,
      policyName,
      githubRepo,
      ownedPrNumber,
    };
  }
}
