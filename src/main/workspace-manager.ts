import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { app } from 'electron';
import { WorktreeManager, type WorktreeInfo } from './worktree-manager.js';
import {
  type SandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
  cleanupOrphanPolicies,
  writeAppendProfile,
} from './sandbox.js';
import { SandboxMonitor } from './sandbox-monitor.js';
import { ContainerMonitor } from './container-monitor.js';
import { PolicyTemplateRegistry } from './policy-registry.js';
import { policyToSandboxConfig } from './policy-sandbox.js';
import { parsePolicyEvent } from './policy-event-parser.js';
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
} from './github-policy.js';
import {
  installHooks,
  cleanupHooks,
  generatePrePushHookForContainer,
  allowedRefsPath,
  updateAllowedRefs,
} from './hooks.js';
import {
  policyToContainerConfig,
  generateGitconfig,
  type ContainerSessionContext,
} from './policy-container.js';
import { writeFile, mkdir, rm, chmod, stat } from 'node:fs/promises';
import { POLICY_DIR } from './sandbox.js';
import {
  persistWorkspace,
  removePersistedWorkspace,
  loadPersistedWorkspaces,
} from './workspace-store.js';
import { appendMessage as persistMessage, loadMessages, removeMessages } from './message-store.js';
import type {
  AgentType,
  GitHubPolicy,
  Message,
  PolicyEvent,
  PolicyTemplate,
  SandboxBackend,
  SandboxViolationInfo,
  WorkspaceSummary,
  WorkspacePhase,
  WorkspaceUpdate,
  ToolCallInfo,
  TopicSource,
} from './types.js';
import type { RepositoryStore } from './repository-store.js';
import {
  isDockerAvailable,
  ensureAgentImage,
  spawnContainer,
  removeContainer,
  cleanupOrphanContainers,
  type ContainerConfig,
  type ContainerHandle,
} from './container.js';
import { ensureCA } from './proxy-tls.js';
import { startProxy, type ProxyConfig, type ProxyHandle } from './proxy.js';
import { createGitHubMitmHandler } from './proxy-github.js';
import {
  createSessionNetwork,
  cleanupOrphanNetworks,
  type SessionNetwork,
} from './proxy-network.js';

interface SpawnConfig {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

function resolveEchoAgentCommand(): SpawnConfig {
  const isDev = !app.isPackaged;
  if (isDev) {
    const require = createRequire(app.getAppPath() + '/');
    const tsxBin = require.resolve('tsx/cli');
    const agentScript = join(app.getAppPath(), 'src', 'agents', 'echo-agent.ts');
    return {
      cmd: process.execPath,
      args: [tsxBin, agentScript],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  } else {
    const agentScript = join(__dirname, '..', 'agents', 'echo-agent.js');
    return {
      cmd: process.execPath,
      args: [agentScript],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
}

function resolveClaudeCodeCommand(cwd: string, sandboxConfig: SandboxConfig | null): SpawnConfig {
  const require = createRequire(app.getAppPath() + '/');
  const binPath = require.resolve('@zed-industries/claude-agent-acp/dist/index.js');

  // When safehouse is available, wrap in sandbox
  if (sandboxConfig) {
    const args = buildSafehouseArgs(sandboxConfig, ['node', binPath]);
    return { cmd: 'safehouse', args, cwd };
  }

  // Unsandboxed fallback — use node binary rather than process.execPath
  // (Electron) to avoid spawning a second Electron instance with its own
  // Dock icon on macOS.
  return {
    cmd: 'node',
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
  const require = createRequire(app.getAppPath() + '/');

  let cmd: string;
  let args: string[];

  let agentArgs: string[];
  if (isDev) {
    const tsxBin = require.resolve('tsx/cli');
    const agentScript = join(app.getAppPath(), 'src', 'agents', 'replay-agent.ts');
    agentArgs = [tsxBin, agentScript];
  } else {
    const agentScript = join(__dirname, '..', 'agents', 'replay-agent.js');
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
    const safehouseArgs = buildSafehouseArgs(sandboxConfig, ['node', ...agentArgs]);
    return { cmd: 'safehouse', args: safehouseArgs, cwd, env };
  }

  cmd = process.execPath;
  args = agentArgs;
  env.ELECTRON_RUN_AS_NODE = '1';
  return { cmd, args, env, cwd };
}

// Resolve the command for non-container agent spawning.
// Container agents are spawned via spawnContainer() directly in createWorkspace.
function resolveAgentCommand(
  agentType: AgentType,
  cwd: string,
  sandboxConfig: SandboxConfig | null,
  worktreePath?: string,
): SpawnConfig {
  if (agentType === 'echo') {
    return resolveEchoAgentCommand();
  }
  if (agentType === 'replay') {
    return resolveReplayAgentCommand(cwd, sandboxConfig, worktreePath ?? cwd);
  }
  return resolveClaudeCodeCommand(cwd, sandboxConfig);
}

/** Heuristic: does the error look like an authentication/token failure? */
function isAuthError(err: unknown): boolean {
  // Extract message from Error objects, JSON-RPC error objects, or plain strings
  const raw =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  const msg = raw.toLowerCase();
  return /\b(401|unauthorized|authentication.*(failed|error|required|expired)|token.*expired|invalid[._ -]?token|unauthenticated)\b/.test(
    msg,
  );
}

/** Derive a human-readable topic from a git branch name. */
function topicFromBranch(branch: string): string {
  // Strip "user/" prefix (everything before and including first slash)
  const stripped = branch.includes('/') ? branch.slice(branch.indexOf('/') + 1) : branch;
  // Replace hyphens and underscores with spaces
  const spaced = stripped.replace(/[-_]/g, ' ');
  // Truncate to 30 chars at word boundary
  if (spaced.length <= 30) return spaced;
  const truncated = spaced.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

interface WorkspaceState {
  id: string;
  repositoryId: string | null;
  acpSessionId: string;
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: 'initializing' | 'ready' | 'error' | 'suspended' | 'resuming' | 'closed' | 'archived';
  errorMessage?: string;
  errorKind?: 'auth';
  agentType: AgentType;
  projectDir: string;
  worktree: WorktreeInfo | null;
  sandboxBackend: SandboxBackend;
  sandboxConfig: SandboxConfig | null;
  sandboxMonitor: SandboxMonitor | null;
  containerMonitor: ContainerMonitor | null;
  sandboxViolations: SandboxViolationInfo[];
  containerHandle: ContainerHandle | null;
  proxyHandle: ProxyHandle | null;
  sessionNetwork: SessionNetwork | null;
  policyId: string | null;
  githubPolicy: GitHubPolicy | null;
  phase: WorkspacePhase | null;
  prUrl: string | null;
  /** Flush any batched stream-chunk events. Called before stream-end. */
  flushChunks: () => void;
  promptCount: number;
  /** Serializes message persistence writes to guarantee ordering. */
  messageWriteChain: Promise<void>;
  /** Message queued while workspace was still initializing. */
  pendingMessage: string | null;
  /** Periodic GH token refresh timer (cleared on close). */
  ghTokenRefreshTimer: ReturnType<typeof setInterval> | null;
  /** Host-side path to the GH token file (for cleanup). */
  ghTokenFilePath: string | null;
  /** Inferred topic label for sidebar display. */
  topic: string | null;
  /** How the topic was derived (controls overwrite precedence). */
  topicSource: TopicSource;
}

export class WorkspaceManager {
  private workspaces = new Map<string, WorkspaceState>();
  private worktreeManager = new WorktreeManager();
  private safehouseWarningLogged = false;
  readonly policyRegistry = new PolicyTemplateRegistry();
  private repoStore: RepositoryStore;
  private emit: (channel: string, data: WorkspaceUpdate) => void;

  constructor(repoStore: RepositoryStore, emit: (channel: string, data: WorkspaceUpdate) => void) {
    this.repoStore = repoStore;
    this.emit = emit;
  }

  /** Create a workspace from a repository's default settings. */
  async createWorkspaceFromRepo(repositoryId: string): Promise<WorkspaceSummary> {
    const repo = this.repoStore.get(repositoryId);
    if (!repo) {
      throw new Error(`Repository not found: ${repositoryId}`);
    }
    return this.createWorkspace(
      repo.localPath,
      repo.defaultAgentType,
      repo.defaultPolicyId,
      repositoryId,
    );
  }

  async createWorkspace(
    projectDir: string,
    agentType: AgentType = 'claude-code',
    policyId?: string,
    repositoryId?: string,
  ): Promise<WorkspaceSummary> {
    const id = randomUUID();
    let worktree: WorktreeInfo | null = null;

    // Resolve policy template — replay agents also get sandboxed
    const resolvedPolicyId =
      agentType === 'claude-code' || agentType === 'replay'
        ? (policyId ?? this.policyRegistry.defaultId)
        : null;
    const template = resolvedPolicyId ? this.policyRegistry.get(resolvedPolicyId) : null;

    // Create worktree for Claude Code and replay sessions
    if (agentType === 'claude-code' || agentType === 'replay') {
      const isGitRepo = await this.worktreeManager.validateGitRepo(projectDir);
      if (!isGitRepo) {
        throw new Error(`Not a git repository: ${projectDir}`);
      }
      worktree = await this.worktreeManager.create(id, projectDir);
    }

    const workingDir = worktree?.path ?? projectDir;

    let sandboxConfig: SandboxConfig | null = null;

    const workspace: WorkspaceState = {
      id,
      repositoryId: repositoryId ?? null,
      acpSessionId: '',
      agentProcess: null!,
      connection: null!,
      messages: [],
      status: 'initializing',
      agentType,
      projectDir,
      worktree,
      sandboxBackend: 'none',
      sandboxConfig,
      sandboxMonitor: null,
      containerMonitor: null,
      sandboxViolations: [],
      containerHandle: null,
      proxyHandle: null,
      sessionNetwork: null,
      policyId: resolvedPolicyId,
      githubPolicy: null,
      phase: null,
      prUrl: null,
      flushChunks: () => {},
      promptCount: 0,
      messageWriteChain: Promise.resolve(),
      pendingMessage: null,
      ghTokenRefreshTimer: null,
      ghTokenFilePath: null,
      topic: worktree ? topicFromBranch(worktree.branch) : null,
      topicSource: worktree ? 'branch' : 'placeholder',
    };
    this.workspaces.set(id, workspace);
    this.emit('workspace-update', {
      workspaceId: id,
      type: 'status-change',
      status: 'initializing',
    });

    // Return summary immediately; initialization continues in the background
    const summary = await this.summarize(workspace);
    this.initializeWorkspace(
      workspace,
      id,
      worktree,
      sandboxConfig,
      workingDir,
      agentType,
      template,
      repositoryId,
    ).catch(() => {
      // Errors are handled inside initializeWorkspace via status-change events
    });
    return summary;
  }

  private async initializeWorkspace(
    workspace: WorkspaceState,
    id: string,
    worktree: WorktreeInfo | null,
    sandboxConfig: SandboxConfig | null,
    workingDir: string,
    agentType: AgentType,
    template: PolicyTemplate | null,
    repositoryId: string | undefined,
  ): Promise<void> {
    try {
      // Build sandbox config from policy template
      const safehouseAvailable = await isSafehouseAvailable();
      if ((agentType === 'claude-code' || agentType === 'replay') && !safehouseAvailable) {
        if (!this.safehouseWarningLogged) {
          console.warn('safehouse not available — agent will run without OS-level sandboxing');
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
        const appNodeModules = join(app.getAppPath(), 'node_modules');

        // The replay agent entrypoint lives in src/agents/ (dev) or
        // dist/agents/ (prod), outside node_modules. Grant read-only
        // access to the app root so the sandbox can read the script.
        const readOnlyDirs = [appNodeModules];
        if (agentType === 'replay') {
          readOnlyDirs.push(app.getAppPath());
        }

        sandboxConfig = policyToSandboxConfig(template, {
          sessionId: id,
          worktreePath: workingDir,
          gitCommonDir: worktree?.gitCommonDir,
          readOnlyDirs,
        });
        workspace.sandboxConfig = sandboxConfig;

        // Write append profile file before spawning (if needed)
        await writeAppendProfile(sandboxConfig);
      }
      // --- Application-layer policy (M5) ---
      let shimEnv: Record<string, string> = {};
      if (template?.github && worktree) {
        const repo = await detectGitHubRepo(workingDir);
        if (repo) {
          const githubPolicy = buildSessionPolicy(repo, worktree.branch);
          // Set on workspace before side effects so error cleanup can find it
          workspace.githubPolicy = githubPolicy;
          workspace.phase = 'implementing';
          await writePolicyState(id, githubPolicy);
          await installHooks(
            id,
            workingDir,
            githubPolicy.allowedPushRefs,
            githubPolicy.protectedBranches,
          );

          // Configure the worktree for HTTPS push with gh credential helper.
          // SSH push fails in the sandbox (SSH_AUTH_SOCK socket is blocked),
          // so switch the remote to HTTPS and configure git to use gh for auth.
          const { execFile: execFileCb } = await import('node:child_process');
          const { promisify: pfy } = await import('node:util');
          const execFileP = pfy(execFileCb);
          const httpsUrl = `https://github.com/${repo}.git`;
          await execFileP('git', ['-C', workingDir, 'remote', 'set-url', 'origin', httpsUrl]).catch(
            () => {},
          );

          // Install gh shim and set up environment (only if gh is available).
          // Also configure git credential helper to use the real gh binary
          // so git push via HTTPS can authenticate.
          const realGhPath = await findRealGh();
          if (realGhPath) {
            const ghShimPath = app.isPackaged
              ? join(app.getAppPath(), 'dist', 'main', 'gh-shim.js')
              : join(app.getAppPath(), 'src', 'main', 'gh-shim.ts');
            const shimDir = await installGhShim(id, ghShimPath, 'node');

            // Resolve GH_TOKEN — gh uses keyring auth which the sandbox blocks.
            let ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
            if (!ghToken) {
              try {
                const { stdout } = await execFileP('gh', ['auth', 'token']);
                ghToken = stdout.trim();
              } catch {
                console.warn('Could not resolve gh auth token — gh commands may fail in sandbox');
              }
            }

            // Configure git credential helper so git push HTTPS uses the token.
            // Point to the *real* gh (not the shim) for credential operations.
            if (ghToken) {
              await execFileP('git', ['-C', workingDir, 'config', 'credential.helper', '']).catch(
                () => {},
              );
              await execFileP('git', [
                '-C',
                workingDir,
                'config',
                `credential.https://github.com.helper`,
                `!${realGhPath} auth git-credential`,
              ]).catch(() => {});
            }

            shimEnv = {
              BOUNCER_GITHUB_POLICY: policyStatePath(id),
              BOUNCER_REAL_GH: realGhPath,
              PATH: `${shimDir}:${process.env.PATH ?? ''}`,
              ...(ghToken ? { GH_TOKEN: ghToken } : {}),
            };
            // Ensure safehouse forwards the shim env vars and GitHub
            // auth/network vars to the agent
            if (sandboxConfig) {
              sandboxConfig.envPassthrough.push(
                'BOUNCER_GITHUB_POLICY',
                'BOUNCER_REAL_GH',
                'PATH',
                // Git push via SSH needs the auth socket
                'SSH_AUTH_SOCK',
                'GIT_SSH_COMMAND',
                // gh CLI auth
                'GH_TOKEN',
                'GITHUB_TOKEN',
              );
            }
          } else {
            console.warn('gh CLI not found — gh shim will not be installed');
          }
        } else {
          console.warn('No GitHub remote detected — skipping application-layer policy');
        }
      }

      // Select sandbox backend: Docker container > safehouse > none
      const dockerAvailable = await isDockerAvailable();
      let containerConfig: ContainerConfig | null = null;

      if (dockerAvailable) {
        const imageTag = await ensureAgentImage();

        if (agentType === 'echo') {
          // Echo agent: simple container with agent script mounted
          const appNodeModules = join(app.getAppPath(), 'node_modules');
          let echoAgentHost: string;
          let echoAgentContainerPath: string;
          let echoCommand: string[];
          if (app.isPackaged) {
            echoAgentHost = join(app.getAppPath(), 'dist', 'agents', 'echo-agent.js');
            echoAgentContainerPath = '/app/agents/echo-agent.js';
            echoCommand = ['node', echoAgentContainerPath];
          } else {
            echoAgentHost = join(app.getAppPath(), 'src', 'agents', 'echo-agent.ts');
            echoAgentContainerPath = '/app/agents/echo-agent.ts';
            echoCommand = ['npx', 'tsx', echoAgentContainerPath];
          }
          containerConfig = {
            sessionId: id,
            image: imageTag,
            command: echoCommand,
            workdir: '/workspace',
            mounts: [
              { hostPath: echoAgentHost, containerPath: echoAgentContainerPath, readOnly: true },
              { hostPath: appNodeModules, containerPath: '/app/node_modules', readOnly: true },
            ],
            env: { NODE_PATH: '/app/node_modules' },
            networkMode: 'bridge',
          };
        } else if (template && (agentType === 'claude-code' || agentType === 'replay')) {
          // Claude Code / replay: full container config via policyToContainerConfig
          const appRequire = createRequire(app.getAppPath() + '/');
          // Resolve to the agent package root (not dist/) so the mount includes package.json
          // which ESM needs for bare-specifier resolution.
          const agentPkgDir = join(
            appRequire.resolve('@zed-industries/claude-agent-acp/package.json'),
            '..',
          );
          const appNodeModules = join(app.getAppPath(), 'node_modules');

          // Build container-specific artifacts on the host
          await mkdir(POLICY_DIR, { recursive: true });

          // Container gh wrapper script
          let containerShimScript: string | undefined;
          let containerGitconfigFile: string | undefined;
          let containerHooksDir: string | undefined;
          let containerCredHelper: string | undefined;

          if (template.github && workspace.githubPolicy) {
            // Write container gh wrapper (points to container paths)
            const wrapperPath = join(POLICY_DIR, `${id}-container-gh-wrapper`);
            await writeFile(
              wrapperPath,
              `#!/bin/bash\nexec node /usr/local/lib/bouncer/gh-shim.js "$@"\n`,
              'utf-8',
            );
            await chmod(wrapperPath, 0o755);
            containerShimScript = wrapperPath;

            // Write container-mode hooks (with container path for allowed-refs)
            containerHooksDir = join(POLICY_DIR, `${id}-container-hooks`);
            await mkdir(containerHooksDir, { recursive: true });
            const hookContent = generatePrePushHookForContainer();
            const hookPath = join(containerHooksDir, 'pre-push');
            await writeFile(hookPath, hookContent, 'utf-8');
            await chmod(hookPath, 0o755);

            // Write gitconfig
            const gitconfigContent = generateGitconfig({
              hooksPath: '/etc/bouncer/hooks',
              credentialHelperPath: '/usr/local/lib/bouncer/gh-credential-helper.js',
              userName: process.env.GIT_AUTHOR_NAME,
              userEmail: process.env.GIT_AUTHOR_EMAIL,
            });
            containerGitconfigFile = join(POLICY_DIR, `${id}-gitconfig`);
            await writeFile(containerGitconfigFile, gitconfigContent, 'utf-8');

            // Write a compiled JS credential helper (can't mount TS source directly)
            const { generateCredentialHelperJs } = await import('./policy-container.js');
            containerCredHelper = join(POLICY_DIR, `${id}-credential-helper.js`);
            await writeFile(containerCredHelper, generateCredentialHelperJs(), { mode: 0o755 });
          }

          // Resolve the shim bundle — mount whenever GitHub policy is active,
          // independent of whether a host gh binary was found.
          const shimBundlePath =
            template.github && workspace.githubPolicy
              ? join(POLICY_DIR, 'gh-shim-bundle.js')
              : undefined;

          // Container env — only explicit vars, no process.env inheritance.
          // The container runs Linux, where the Claude CLI reads credentials
          // from ~/.claude/.credentials.json (not the macOS keychain).
          // Extract from macOS keychain and write a credentials file for the container.
          const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
          // Create a per-workspace session directory that gets bind-mounted as
          // the container's ~/.claude. This makes session JSONL files survive
          // container restarts, enabling session resume.
          const sessionDir = join(app.getPath('userData'), 'sessions', id);
          await mkdir(sessionDir, { recursive: true });

          let claudeCredentialsPath: string | undefined;
          if (!anthropicKey && process.platform === 'darwin') {
            try {
              const { execFile: execFileCb2 } = await import('node:child_process');
              const { promisify: pfy2 } = await import('node:util');
              const execFileP2 = pfy2(execFileCb2);
              const { stdout: credJson } = await execFileP2('security', [
                'find-generic-password',
                '-s',
                'Claude Code-credentials',
                '-w',
              ]);
              // Write credentials into the session dir so they persist with
              // the bind mount and don't need a separate mount point.
              claudeCredentialsPath = join(sessionDir, '.credentials.json');
              await writeFile(claudeCredentialsPath, credJson.trim(), { mode: 0o600 });
              console.log('[container] Wrote Claude credentials file from macOS keychain');
            } catch (err) {
              console.warn('[container] Could not extract Claude credentials from keychain:', err);
              claudeCredentialsPath = undefined;
            }
          }
          const ghToken =
            shimEnv.GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

          // Write GH token to a file that the container can read. The host
          // refreshes this file periodically so long-running sessions don't
          // lose GitHub access when the OAuth token expires.
          let ghTokenFilePath: string | undefined;
          if (ghToken) {
            ghTokenFilePath = join(POLICY_DIR, `${id}-gh-token`);
            await writeFile(ghTokenFilePath, ghToken, { mode: 0o600 });
            workspace.ghTokenFilePath = ghTokenFilePath;
          }

          const containerEnv: Record<string, string> = {
            ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
            ...(ghToken ? { GH_TOKEN: ghToken } : {}),
            ...(process.env.GIT_AUTHOR_NAME
              ? { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME }
              : {}),
            ...(process.env.GIT_AUTHOR_EMAIL
              ? { GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL }
              : {}),
            ...(process.env.GIT_COMMITTER_NAME
              ? { GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME }
              : {}),
            ...(process.env.GIT_COMMITTER_EMAIL
              ? { GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL }
              : {}),
          };

          // --- Network proxy (M7) ---
          // Start the proxy and create a workspace network when the template
          // uses filtered network access and Docker is available.
          let proxyCaCertPath: string | undefined;
          if (template.network.access === 'filtered') {
            const ca = await ensureCA();
            proxyCaCertPath = ca.certPath;

            // Use inspected domains from the template
            const inspectedDomains =
              template.network.access === 'filtered' ? template.network.inspectedDomains : [];

            const proxyConfig: ProxyConfig = {
              sessionId: id,
              port: 0,
              allowedDomains: template.network.allowedDomains,
              inspectedDomains,
              githubPolicy: workspace.githubPolicy,
              ca,
              onPolicyEvent: (event: PolicyEvent) => {
                this.emit('workspace-update', {
                  workspaceId: id,
                  type: 'policy-event',
                  event,
                });
                // Persist policy state on ratchet events
                if (workspace.githubPolicy) {
                  if (event.operation.startsWith('branch-ratchet:')) {
                    writePolicyState(id, workspace.githubPolicy).catch(() => {});
                    updateAllowedRefs(id, workspace.githubPolicy.allowedPushRefs).catch(() => {});
                    this.persistState(workspace);
                  }
                  if (event.operation.startsWith('captured PR')) {
                    writePolicyState(id, workspace.githubPolicy).catch(() => {});
                    // Extract PR URL from event operation if present
                    const urlMatch = event.operation.match(/https:\/\/\S+/);
                    if (urlMatch) {
                      workspace.prUrl = urlMatch[0];
                    }
                    workspace.phase = 'pr-open';
                    this.persistState(workspace);
                    // Emit a summary update so the UI picks up the phase/prUrl change
                    this.summarize(workspace)
                      .then((summary) => {
                        this.emit('workspace-update', {
                          workspaceId: id,
                          type: 'status-change',
                          status: workspace.status,
                          summary,
                        });
                      })
                      .catch(() => {});
                  }
                }
              },
            };

            // Wire the GitHub MITM handler if GitHub policy is active
            if (workspace.githubPolicy) {
              proxyConfig.onMitmRequest = createGitHubMitmHandler(proxyConfig);
            }

            try {
              const proxyHandle = await startProxy(proxyConfig);
              workspace.proxyHandle = proxyHandle;

              const sessionNetwork = await createSessionNetwork(id);
              workspace.sessionNetwork = sessionNetwork;
            } catch (err) {
              // Best-effort cleanup if proxy started but network failed
              if (workspace.proxyHandle) {
                await workspace.proxyHandle.stop().catch(() => {});
              }
              if (workspace.sessionNetwork) {
                await workspace.sessionNetwork.cleanup().catch(() => {});
              }
              workspace.proxyHandle = null;
              workspace.sessionNetwork = null;
              throw err;
            }

            // Add proxy env vars to container env
            const proxyEnvUrl = `http://host.docker.internal:${workspace.proxyHandle.port}`;
            containerEnv.HTTP_PROXY = proxyEnvUrl;
            containerEnv.HTTPS_PROXY = proxyEnvUrl;
            containerEnv.http_proxy = proxyEnvUrl;
            containerEnv.https_proxy = proxyEnvUrl;
            containerEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
            containerEnv.no_proxy = 'localhost,127.0.0.1,::1';
            // Entrypoint uses these for iptables proxy enforcement
            containerEnv.BOUNCER_PROXY_HOST = 'host.docker.internal';
            containerEnv.BOUNCER_PROXY_PORT = String(workspace.proxyHandle.port);

            // Regenerate gitconfig with proxy setting if it was already created
            if (containerGitconfigFile) {
              const gitconfigContent = generateGitconfig({
                hooksPath: '/etc/bouncer/hooks',
                credentialHelperPath: '/usr/local/lib/bouncer/gh-credential-helper.js',
                userName: process.env.GIT_AUTHOR_NAME,
                userEmail: process.env.GIT_AUTHOR_EMAIL,
                proxyUrl: proxyEnvUrl,
              });
              await writeFile(containerGitconfigFile, gitconfigContent, 'utf-8');
            }

            console.log(
              `[workspace] Proxy started on port ${workspace.proxyHandle.port} for workspace ${id}`,
            );
          }

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
            policyStatePath: workspace.githubPolicy ? policyStatePath(id) : undefined,
            gitconfigPath: containerGitconfigFile,
            credentialHelperPath: containerCredHelper,
            caCertPath: proxyCaCertPath,
            userGitconfigPath: await (async () => {
              // Sanitize the user's gitconfig: remove credential helpers that
              // reference host-only paths (e.g. /opt/homebrew/bin/gh).
              const home = (await import('node:os')).homedir();
              const hostGitconfig = join(home, '.gitconfig');
              try {
                const { readFile: rf } = await import('node:fs/promises');
                const raw = await rf(hostGitconfig, 'utf-8');
                const { sanitizeGitconfig } = await import('./policy-container.js');
                const sanitized = sanitizeGitconfig(raw);
                const sanitizedPath = join(POLICY_DIR, `${id}-user-gitconfig`);
                await writeFile(sanitizedPath, sanitized, { encoding: 'utf-8', mode: 0o600 });
                return sanitizedPath;
              } catch {
                return undefined;
              }
            })(),
            // Use per-workspace session dir so session JSONL files survive
            // container restarts, enabling session resume.
            claudeConfigDir: sessionDir,
            claudeCredentialsPath,
            ghTokenFilePath,
          };

          containerConfig = policyToContainerConfig(template, ctx, containerEnv, imageTag, [
            'node',
            '/usr/local/lib/agent/dist/index.js',
          ]);

          // Override network mode when proxy is active
          if (workspace.proxyHandle && workspace.sessionNetwork) {
            containerConfig.networkMode = 'proxy';
            containerConfig.networkName = workspace.sessionNetwork.networkName;
          }
        }

        if (containerConfig) {
          workspace.sandboxBackend = 'container';
          // Unset repo-level core.hooksPath so the system gitconfig
          // (/etc/gitconfig) takes effect inside the container.
          // installHooks() set it earlier for the safehouse path.
          if (worktree) {
            const { execFile: execFileCb3 } = await import('node:child_process');
            const { promisify: pfy3 } = await import('node:util');
            const execFileP3 = pfy3(execFileCb3);
            await execFileP3('git', [
              '-C',
              workingDir,
              'config',
              '--unset',
              'core.hooksPath',
            ]).catch(() => {});
            // Also unset repo-level credential helpers that reference host-only paths.
            // Our /etc/gitconfig provides the correct credential helper for the container.
            await execFileP3('git', [
              '-C',
              workingDir,
              'config',
              '--unset',
              'credential.helper',
            ]).catch(() => {});
            await execFileP3('git', [
              '-C',
              workingDir,
              'config',
              '--unset',
              'credential.https://github.com.helper',
            ]).catch(() => {});
          }
        }
      }

      if (!containerConfig && sandboxConfig) {
        workspace.sandboxBackend = 'safehouse';
      } else if (!containerConfig) {
        workspace.sandboxBackend = workspace.sandboxBackend === 'container' ? 'container' : 'none';
      }

      // Spawn the agent
      let agentProcess: ChildProcess;
      if (containerConfig) {
        const handle = spawnContainer(containerConfig);
        workspace.containerHandle = handle;
        agentProcess = handle.process;
      } else {
        const { cmd, args, env, cwd } = resolveAgentCommand(
          agentType,
          workingDir,
          sandboxConfig,
          worktree?.path,
        );
        agentProcess = spawn(cmd, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...env, ...shimEnv },
          cwd,
        });
      }
      workspace.agentProcess = agentProcess;

      // Start periodic GH token refresh for container sessions.
      // The OAuth token can expire during long sessions; refreshing the
      // token file keeps GitHub API access alive.
      if (workspace.ghTokenFilePath && containerConfig) {
        const GH_TOKEN_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
        const tokenFilePath = workspace.ghTokenFilePath;
        workspace.ghTokenRefreshTimer = setInterval(async () => {
          try {
            const { execFile: ef } = await import('node:child_process');
            const { promisify: p } = await import('node:util');
            const { stdout } = await p(ef)('gh', ['auth', 'token']);
            const newToken = stdout.trim();
            if (newToken) {
              await writeFile(tokenFilePath, newToken, { mode: 0o644 });
              console.log(`[workspace] Refreshed GH token for workspace ${id}`);
            }
          } catch (err) {
            console.warn(`[workspace] Failed to refresh GH token for workspace ${id}:`, err);
          }
        }, GH_TOKEN_REFRESH_MS);
      }

      // Capture stderr for error reporting and parse policy events.
      // Use StringDecoder to handle multibyte characters (e.g. em-dash)
      // that may be split across chunks.
      let collectedStderr = '';
      let stderrBuffer = '';
      const stderrDecoder = new StringDecoder('utf8');
      const flushStderrLine = (line: string): void => {
        const event = parsePolicyEvent(line);
        if (event) {
          this.emit('workspace-update', {
            workspaceId: id,
            type: 'policy-event',
            event,
          });
        }
      };
      agentProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = stderrDecoder.write(data);
        collectedStderr += chunk;
        process.stderr.write(data);

        // Parse policy events from complete lines
        stderrBuffer += chunk;
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() ?? ''; // Keep incomplete last line in buffer
        for (const line of lines) {
          flushStderrLine(line);
        }
      });

      // Handle agent crashes — flush any remaining stderr buffer first
      agentProcess.on('exit', (code) => {
        // Flush remaining bytes from the decoder and parse final line
        const remaining = stderrDecoder.end();
        if (remaining) {
          collectedStderr += remaining;
          stderrBuffer += remaining;
        }
        if (stderrBuffer) {
          flushStderrLine(stderrBuffer);
          stderrBuffer = '';
        }

        // Don't overwrite an existing auth error (e.g. set before killing the process)
        if (workspace.status === 'error' && workspace.errorKind === 'auth') return;
        if (workspace.status !== 'closed' && workspace.status !== 'archived') {
          const errorMessage =
            workspace.status === 'initializing'
              ? collectedStderr.trim() || `Agent exited with code ${code}`
              : undefined;
          const errorKind = isAuthError(collectedStderr) ? ('auth' as const) : undefined;
          workspace.status = 'error';
          workspace.errorMessage = errorKind
            ? 'Authentication expired. Please re-authenticate and retry.'
            : errorMessage;
          workspace.errorKind = errorKind;
          this.emit('workspace-update', {
            workspaceId: id,
            type: 'status-change',
            status: 'error',
            error: workspace.errorMessage,
            errorKind,
          });
        }
      });
      agentProcess.on('error', (err) => {
        if (workspace.status !== 'closed' && workspace.status !== 'archived') {
          const errorMessage = err.message;
          workspace.status = 'error';
          workspace.errorMessage = errorMessage;
          this.emit('workspace-update', {
            workspaceId: id,
            type: 'status-change',
            status: 'error',
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
      const pendingChunks = new Map<
        string,
        { messageId: string; text: string; segmentIndex: number }
      >();
      let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushChunks = (): void => {
        if (chunkFlushTimer) {
          clearTimeout(chunkFlushTimer);
          chunkFlushTimer = null;
        }
        for (const [, chunk] of pendingChunks) {
          emitUpdate('workspace-update', {
            workspaceId: id,
            type: 'stream-chunk',
            messageId: chunk.messageId,
            text: chunk.text,
            segmentIndex: chunk.segmentIndex,
          });
        }
        pendingChunks.clear();
      };
      workspace.flushChunks = flushChunks;
      const scheduleChunkFlush = (): void => {
        if (!chunkFlushTimer) {
          chunkFlushTimer = setTimeout(flushChunks, 50);
        }
      };

      let sawToolCallSinceLastText = false;

      const connection = new acp.ClientSideConnection(
        (_agent) => ({
          async sessionUpdate(params) {
            const update = params.update;
            if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
              const agentMsg = workspace.messages.findLast(
                (m) => m.role === 'agent' && m.streaming,
              );
              if (agentMsg) {
                const segments = agentMsg.textSegments!;
                const parts = agentMsg.parts!;

                // Start a new text segment when text resumes after tool calls
                if (sawToolCallSinceLastText) {
                  segments.push('');
                  parts.push({ type: 'text', index: segments.length - 1 });
                  sawToolCallSinceLastText = false;
                }

                const segIdx = segments.length - 1;
                segments[segIdx] += update.content.text;
                agentMsg.text = segments.join('\n\n');

                // Batch: accumulate text, flush on timer
                // Key by messageId:segmentIndex so segment changes flush separately
                const chunkKey = `${agentMsg.id}:${segIdx}`;
                const pending = pendingChunks.get(chunkKey);
                if (pending) {
                  pending.text += update.content.text;
                } else {
                  pendingChunks.set(chunkKey, {
                    messageId: agentMsg.id,
                    text: update.content.text,
                    segmentIndex: segIdx,
                  });
                }
                scheduleChunkFlush();
              }
            } else if (
              update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update'
            ) {
              sawToolCallSinceLastText = true;
              const agentMsg = workspace.messages.findLast((m) => m.role === 'agent');
              if (agentMsg) {
                const meta = update._meta as
                  | { claudeCode?: { toolName?: string; toolResponse?: unknown } }
                  | undefined;
                const rawInput =
                  'rawInput' in update && update.rawInput != null
                    ? (update.rawInput as Record<string, unknown>)
                    : undefined;
                const toolCall: ToolCallInfo = {
                  id: update.toolCallId,
                  name: meta?.claudeCode?.toolName ?? 'Tool',
                  status:
                    'status' in update ? (update.status as ToolCallInfo['status']) : 'in_progress',
                  title: 'title' in update ? (update.title as string) : undefined,
                  description:
                    rawInput?.description && typeof rawInput.description === 'string'
                      ? rawInput.description
                      : undefined,
                  input: rawInput,
                  output:
                    'rawOutput' in update
                      ? typeof update.rawOutput === 'string'
                        ? update.rawOutput
                        : JSON.stringify(update.rawOutput)
                      : undefined,
                };
                agentMsg.toolCalls = agentMsg.toolCalls ?? [];
                const existing = agentMsg.toolCalls.find((tc) => tc.id === toolCall.id);
                if (!existing && agentMsg.parts) {
                  agentMsg.parts.push({
                    type: 'tool',
                    toolCallId: toolCall.id,
                  });
                }
                if (existing) {
                  // Only overwrite fields that are defined in the update
                  for (const [k, v] of Object.entries(toolCall)) {
                    if (v !== undefined) {
                      (existing as unknown as Record<string, unknown>)[k] = v;
                    }
                  }
                } else {
                  agentMsg.toolCalls.push(toolCall);
                }
                emitUpdate('workspace-update', {
                  workspaceId: id,
                  type: 'tool-call',
                  messageId: agentMsg.id,
                  toolCall,
                });
              }
            }
          },
          async requestPermission(params) {
            // Auto-approve: select the first allow_once option
            const allowOption = params.options.find((o) => o.kind === 'allow_once');
            if (allowOption) {
              return {
                outcome: {
                  outcome: 'selected' as const,
                  optionId: allowOption.optionId,
                },
              };
            }
            // Fallback: select first option
            return {
              outcome: {
                outcome: 'selected' as const,
                optionId: params.options[0].optionId,
              },
            };
          },
        }),
        stream,
      );
      workspace.connection = connection;

      // ACP handshake
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          terminal: true,
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      const sessionResp = await connection.newSession({
        cwd: containerConfig ? '/workspace' : workingDir,
        mcpServers: [],
      });
      workspace.acpSessionId = sessionResp.sessionId;

      // Start sandbox monitor if sandboxed via safehouse
      if (sandboxConfig && !containerConfig && agentProcess.pid) {
        const monitor = new SandboxMonitor();
        monitor.on('violation', (violation) => {
          const info: SandboxViolationInfo = {
            timestamp: violation.timestamp.getTime(),
            operation: violation.operation,
            path: violation.path,
            processName: violation.processName,
          };
          workspace.sandboxViolations.push(info);
          this.emit('workspace-update', {
            workspaceId: id,
            type: 'sandbox-violation',
            violation: info,
          });
        });
        monitor.start(agentProcess.pid);
        workspace.sandboxMonitor = monitor;
      }

      // Start container monitor for container sessions
      if (workspace.containerHandle) {
        const cMonitor = new ContainerMonitor();
        cMonitor.on('violation', (violation) => {
          const info: SandboxViolationInfo = {
            timestamp: violation.timestamp.getTime(),
            operation: violation.operation,
            path: violation.path,
            processName: violation.processName,
          };
          workspace.sandboxViolations.push(info);
          this.emit('workspace-update', {
            workspaceId: id,
            type: 'sandbox-violation',
            violation: info,
          });
        });
        cMonitor.start(workspace.containerHandle.containerName);
        workspace.containerMonitor = cMonitor;
      }

      workspace.status = 'ready';
      const readySummary = await this.summarize(workspace);
      this.emit('workspace-update', {
        workspaceId: id,
        type: 'status-change',
        status: 'ready',
        summary: readySummary,
      });

      // Persist workspace metadata for session resume
      await this.persistState(workspace);

      // Drain any message queued while the workspace was initializing
      if (workspace.pendingMessage !== null) {
        const pending = workspace.pendingMessage;
        workspace.pendingMessage = null;
        this.sendPrompt(workspace, id, pending).catch((err) => {
          console.error(`Failed to send pending message for workspace ${id}:`, err);
        });
      }
    } catch (err) {
      console.error(`Failed to create workspace ${id}:`, err);
      if (workspace.containerHandle) {
        workspace.containerHandle.kill();
      } else {
        workspace.agentProcess?.kill();
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
      const errorKind = isAuthError(err) ? ('auth' as const) : undefined;
      workspace.status = 'error';
      workspace.errorMessage = errorKind
        ? 'Authentication expired. Please re-authenticate and retry.'
        : `Workspace creation failed: ${err instanceof Error ? err.message : String(err)}`;
      workspace.errorKind = errorKind;
      this.emit('workspace-update', {
        workspaceId: id,
        type: 'status-change',
        status: 'error',
        error: workspace.errorMessage,
        errorKind,
      });
    }
  }

  async sendMessage(workspaceId: string, text: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    if (workspace.status === 'initializing') {
      // Queue the message — it will be sent once the session is ready
      workspace.pendingMessage = text;
      const userMsg: Message = {
        id: randomUUID(),
        role: 'user',
        text,
        timestamp: Date.now(),
      };
      workspace.messages.push(userMsg);
      this.emit('workspace-update', {
        workspaceId,
        type: 'message',
        message: userMsg,
      });
      this.queueMessagePersist(workspace, workspaceId, userMsg);
      return;
    }

    if (workspace.status !== 'ready') throw new Error(`Workspace not ready: ${workspace.status}`);

    // Create user message
    const userMsg: Message = {
      id: randomUUID(),
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    workspace.messages.push(userMsg);
    this.emit('workspace-update', { workspaceId, type: 'message', message: userMsg });
    this.queueMessagePersist(workspace, workspaceId, userMsg);

    await this.sendPrompt(workspace, workspaceId, text);
  }

  private async sendPrompt(
    workspace: WorkspaceState,
    workspaceId: string,
    text: string,
  ): Promise<void> {
    // Create placeholder agent message for streaming
    const agentMsg: Message = {
      id: randomUUID(),
      role: 'agent',
      text: '',
      timestamp: Date.now(),
      streaming: true,
      textSegments: [''],
      parts: [{ type: 'text', index: 0 }],
    };
    workspace.messages.push(agentMsg);
    this.emit('workspace-update', { workspaceId, type: 'message', message: agentMsg });

    // Send prompt via ACP
    const promptBlocks: Array<{ type: 'text'; text: string }> = [];

    // On the first prompt, inject behavioral and formatting guidance
    if (workspace.promptCount === 0) {
      const hasGitHub = !!workspace.githubPolicy;
      const systemParts: string[] = [
        'Formatting guidance: After completing tool calls, when you present the results to the user, always start with a brief summary sentence that contextualizes the data before showing it. Do not output raw data or listings without a lead-in. Before making tool calls, keep your introductory text minimal — just proceed to the tool calls without unnecessary preamble.',
      ];
      if (hasGitHub) {
        systemParts.push(
          'Autonomy guidance: You are running inside a sandboxed environment. Work autonomously through the full task without stopping to ask for permission at intermediate steps. Specifically:',
          '1. Implement the requested changes, committing as needed.',
          '2. Push your branch and create a draft PR (use `gh pr create --draft`).',
          '3. Check CI status with `gh pr checks`. If checks fail, read the logs, fix the issues, push again, and re-check. Repeat until CI is green.',
          '4. Once CI is green, mark the PR as ready for review: `gh pr ready`',
          "5. Check if Copilot has been assigned as a reviewer: `gh pr view` and look at the `requested_reviewers` field for a reviewer with login containing 'copilot'.",
          '6. If Copilot is assigned, poll for the review to appear: `gh api repos/{owner}/{repo}/pulls/{number}/reviews`. Wait until a review from Copilot shows up (it may take a minute or two). Once it appears, read the review comments: `gh api repos/{owner}/{repo}/pulls/{number}/comments`.',
          '7. For each review comment, implement the suggested fixes if they are actionable improvements. Push and re-check CI.',
          '8. If Copilot is NOT assigned as a reviewer, skip steps 6-7.',
          '9. When CI is green and all review comments are addressed (or skipped), report the final status to the user.',
          'Do NOT stop to ask the user for confirmation between these steps. The sandbox prevents any dangerous operations (merging, pushing to protected branches, posting review comments). Work through the entire workflow in one shot.',
          'Do NOT attempt to merge the PR — that is a human-only operation and the sandbox will block it.',
          'Do NOT attempt to request reviewers — Copilot review is configured to be automatically assigned by the repository.',
        );
      }
      promptBlocks.push({
        type: 'text',
        text: `<system-instruction>\n${systemParts.join('\n')}\n</system-instruction>`,
      });
    }
    workspace.promptCount++;
    this.persistState(workspace);

    promptBlocks.push({ type: 'text', text });

    try {
      await workspace.connection.prompt({
        sessionId: workspace.acpSessionId,
        prompt: promptBlocks,
      });
    } catch (err) {
      console.error(`Prompt failed for workspace ${workspaceId}:`, err);
      if (isAuthError(err) && workspace.status !== 'closed' && workspace.status !== 'archived') {
        workspace.status = 'error';
        workspace.errorMessage = 'Authentication expired. Please re-authenticate and retry.';
        workspace.errorKind = 'auth';
        this.emit('workspace-update', {
          workspaceId,
          type: 'status-change',
          status: 'error',
          error: workspace.errorMessage,
          errorKind: 'auth',
        });
      }
    }

    // Flush any batched chunks before finalizing
    workspace.flushChunks();

    // Finalize the agent message
    agentMsg.streaming = false;
    this.emit('workspace-update', {
      workspaceId,
      type: 'stream-end',
      messageId: agentMsg.id,
      textSegments: agentMsg.textSegments ?? [agentMsg.text],
      parts: agentMsg.parts ?? [{ type: 'text', index: 0 }],
    });

    // Persist the completed agent message
    this.queueMessagePersist(workspace, workspaceId, agentMsg);
  }

  getMessages(workspaceId: string): Message[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace.messages;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return await Promise.all(Array.from(this.workspaces.values()).map((s) => this.summarize(s)));
  }

  /**
   * Re-extract credentials from the macOS keychain and, for container workspaces,
   * overwrite the mounted credentials file. Resets the workspace from "error" back
   * to "ready" so the user can send a new prompt.
   */
  async refreshCredentials(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    // If the agent process has exited, we can't recover — the ACP connection is gone
    if (workspace.agentProcess.exitCode !== null) {
      throw new Error(
        'Agent process has exited. Please close this workspace and create a new one after re-authenticating.',
      );
    }

    // For container workspaces, re-extract credentials from macOS keychain and overwrite the file
    if (workspace.sandboxBackend === 'container') {
      if (process.platform !== 'darwin') {
        throw new Error('Credential refresh from keychain is only supported on macOS.');
      }
      const { execFile: execFileCb } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(execFileCb);
      const { stdout: credJson } = await execFileP('security', [
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ]);
      // Write to session volume (bind-mounted as container's ~/.claude)
      const credPath = join(app.getPath('userData'), 'sessions', workspaceId, '.credentials.json');
      await writeFile(credPath, credJson.trim(), { mode: 0o600 });
      console.log(`[workspace ${workspaceId}] Refreshed Claude credentials from keychain`);
    }
    // For safehouse: Claude Code reads from keychain directly, so no file update needed.

    // Reset workspace back to ready
    workspace.status = 'ready';
    workspace.errorMessage = undefined;
    workspace.errorKind = undefined;
    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'ready',
    });
  }

  /**
   * Force a workspace into auth-error state for testing the re-auth flow.
   * Kills the agent process to simulate a real auth expiration crash.
   */
  async simulateAuthError(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.status !== 'ready') {
      throw new Error(`Workspace not in ready state: ${workspace.status}`);
    }

    // Kill the agent to simulate a real auth crash
    if (workspace.containerHandle) {
      workspace.containerHandle.kill();
    } else {
      workspace.agentProcess?.kill();
    }

    workspace.status = 'error';
    workspace.errorMessage = 'Authentication expired. Please re-authenticate and retry.';
    workspace.errorKind = 'auth';
    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'error',
      error: workspace.errorMessage,
      errorKind: 'auth',
    });
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    // Graceful ACP close — best-effort, don't block on failure
    if (workspace.connection && workspace.status !== 'error' && workspace.status !== 'suspended') {
      try {
        await Promise.race([
          workspace.connection.unstable_closeSession({ sessionId: workspace.acpSessionId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
      } catch {
        // Agent may already be dead — proceed with cleanup
      }
    }

    workspace.status = 'closed';
    workspace.flushChunks();
    workspace.sandboxMonitor?.stop();
    workspace.containerMonitor?.stop();
    if (workspace.ghTokenRefreshTimer) {
      clearInterval(workspace.ghTokenRefreshTimer);
      workspace.ghTokenRefreshTimer = null;
    }
    if (workspace.containerHandle) {
      workspace.containerHandle.kill();
    } else {
      workspace.agentProcess?.kill();
    }

    // Clean up container and container-specific host artifacts
    if (workspace.sandboxBackend === 'container') {
      await removeContainer(workspaceId).catch((err) =>
        console.warn(`Failed to remove container for workspace ${workspaceId}:`, err),
      );
      // Clean up container-specific files on the host
      await rm(join(POLICY_DIR, `${workspaceId}-container-gh-wrapper`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-container-hooks`), {
        recursive: true,
        force: true,
      }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-gitconfig`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-claude-credentials.json`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-credential-helper.js`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-user-gitconfig`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-gh-token`), { force: true }).catch(() => {});
      // Clean up per-workspace session volume (Claude Code session JSONL files)
      await rm(join(app.getPath('userData'), 'sessions', workspaceId), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }

    // Stop proxy and remove workspace network (M7)
    if (workspace.proxyHandle) {
      await workspace.proxyHandle
        .stop()
        .catch((err) => console.warn(`Failed to stop proxy for workspace ${workspaceId}:`, err));
    }
    if (workspace.sessionNetwork) {
      await workspace.sessionNetwork
        .cleanup()
        .catch((err) =>
          console.warn(`Failed to remove network for workspace ${workspaceId}:`, err),
        );
    }

    // Clean up application-layer policy artifacts
    if (workspace.githubPolicy) {
      if (workspace.worktree) {
        await cleanupHooks(workspaceId, workspace.worktree.path).catch((err) =>
          console.warn(`Failed to clean up hooks for workspace ${workspaceId}:`, err),
        );
      }
      await cleanupPolicyState(workspaceId).catch((err) =>
        console.warn(`Failed to clean up policy state for workspace ${workspaceId}:`, err),
      );
      await cleanupGhShim(workspaceId).catch((err) =>
        console.warn(`Failed to clean up gh shim for workspace ${workspaceId}:`, err),
      );
    }

    // Tear down worktree
    if (workspace.worktree) {
      try {
        await this.worktreeManager.remove(workspace.worktree);
      } catch (err) {
        console.warn(`Failed to remove worktree for workspace ${workspaceId}:`, err);
      }
    }

    // Clean up sandbox policy file
    if (workspace.sandboxConfig) {
      await cleanupPolicy(workspace.sandboxConfig.policyOutputPath);
    }

    // Remove persisted workspace metadata and messages
    await removePersistedWorkspace(workspaceId);
    await removeMessages(workspaceId);

    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'closed',
    });
  }

  /** Archive a workspace: clean up runtime resources but preserve metadata and messages on disk. */
  async archiveWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    // Graceful ACP close — best-effort, don't block on failure
    if (workspace.connection && workspace.status !== 'error' && workspace.status !== 'suspended') {
      try {
        await Promise.race([
          workspace.connection.unstable_closeSession({ sessionId: workspace.acpSessionId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
      } catch {
        // Agent may already be dead — proceed with cleanup
      }
    }

    workspace.status = 'archived';
    workspace.flushChunks();
    workspace.sandboxMonitor?.stop();
    workspace.containerMonitor?.stop();
    if (workspace.ghTokenRefreshTimer) {
      clearInterval(workspace.ghTokenRefreshTimer);
      workspace.ghTokenRefreshTimer = null;
    }
    if (workspace.containerHandle) {
      workspace.containerHandle.kill();
    } else {
      workspace.agentProcess?.kill();
    }

    // Clean up container and container-specific host artifacts
    if (workspace.sandboxBackend === 'container') {
      await removeContainer(workspaceId).catch((err) =>
        console.warn(`Failed to remove container for workspace ${workspaceId}:`, err),
      );
      await rm(join(POLICY_DIR, `${workspaceId}-container-gh-wrapper`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-container-hooks`), {
        recursive: true,
        force: true,
      }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-gitconfig`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-claude-credentials.json`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-credential-helper.js`), { force: true }).catch(
        () => {},
      );
      await rm(join(POLICY_DIR, `${workspaceId}-user-gitconfig`), { force: true }).catch(() => {});
      await rm(join(POLICY_DIR, `${workspaceId}-gh-token`), { force: true }).catch(() => {});
      await rm(join(app.getPath('userData'), 'sessions', workspaceId), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }

    // Stop proxy and remove workspace network
    if (workspace.proxyHandle) {
      await workspace.proxyHandle
        .stop()
        .catch((err) => console.warn(`Failed to stop proxy for workspace ${workspaceId}:`, err));
    }
    if (workspace.sessionNetwork) {
      await workspace.sessionNetwork
        .cleanup()
        .catch((err) =>
          console.warn(`Failed to remove network for workspace ${workspaceId}:`, err),
        );
    }

    // Clean up application-layer policy artifacts
    if (workspace.githubPolicy) {
      if (workspace.worktree) {
        await cleanupHooks(workspaceId, workspace.worktree.path).catch((err) =>
          console.warn(`Failed to clean up hooks for workspace ${workspaceId}:`, err),
        );
      }
      await cleanupPolicyState(workspaceId).catch((err) =>
        console.warn(`Failed to clean up policy state for workspace ${workspaceId}:`, err),
      );
      await cleanupGhShim(workspaceId).catch((err) =>
        console.warn(`Failed to clean up gh shim for workspace ${workspaceId}:`, err),
      );
    }

    // Tear down worktree
    if (workspace.worktree) {
      try {
        await this.worktreeManager.remove(workspace.worktree);
      } catch (err) {
        console.warn(`Failed to remove worktree for workspace ${workspaceId}:`, err);
      }
    }

    // Clean up sandbox policy file
    if (workspace.sandboxConfig) {
      await cleanupPolicy(workspace.sandboxConfig.policyOutputPath);
    }

    // Mark persisted metadata as archived (but do NOT delete metadata or messages)
    await persistWorkspace({
      id: workspace.id,
      repositoryId: workspace.repositoryId,
      acpSessionId: workspace.acpSessionId,
      projectDir: workspace.projectDir,
      agentType: workspace.agentType,
      sandboxBackend: workspace.sandboxBackend,
      worktreePath: null,
      worktreeGitCommonDir: null,
      worktreeBranch: workspace.worktree?.branch ?? null,
      policyId: workspace.policyId,
      containerImage: null,
      githubPolicy: workspace.githubPolicy,
      phase: workspace.phase,
      prUrl: workspace.prUrl,
      promptCount: workspace.promptCount,
      topic: workspace.topic,
      topicSource: workspace.topicSource,
      archived: true,
    });

    // Remove from in-memory map so it no longer appears in listWorkspaces
    this.workspaces.delete(workspaceId);

    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'archived',
    });
  }

  /** Gracefully shut down all active workspaces on app quit.
   *  Unlike closeWorkspace(), this preserves persisted data and worktrees
   *  so sessions can be resumed on next launch. */
  async closeAllWorkspaces(): Promise<void> {
    const activeWorkspaces = Array.from(this.workspaces.values()).filter(
      (s) => s.status !== 'closed',
    );
    await Promise.all(
      activeWorkspaces.map(async (ws) => {
        // Graceful ACP close — best-effort
        if (ws.connection && ws.status !== 'error' && ws.status !== 'suspended') {
          try {
            await Promise.race([
              ws.connection.unstable_closeSession({ sessionId: ws.acpSessionId }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
            ]);
          } catch {
            // Agent may already be dead
          }
        }
        // Kill processes but don't remove persisted state or worktrees
        ws.sandboxMonitor?.stop();
        ws.containerMonitor?.stop();
        if (ws.ghTokenRefreshTimer) {
          clearInterval(ws.ghTokenRefreshTimer);
          ws.ghTokenRefreshTimer = null;
        }
        if (ws.containerHandle) {
          ws.containerHandle.kill();
        } else {
          ws.agentProcess?.kill();
        }
        if (ws.proxyHandle) {
          await ws.proxyHandle.stop().catch(() => {});
        }
        ws.status = 'closed';
      }),
    );
  }

  /** Remove orphan worktree directories, sandbox policies, containers, and container artifacts left behind by a previous crash. */
  async cleanupOrphans(): Promise<void> {
    console.log('[cleanup] Starting orphan cleanup...');
    const activeIds = new Set(this.workspaces.keys());
    await this.worktreeManager.cleanupOrphans(activeIds);
    await cleanupOrphanPolicies(activeIds);
    await cleanupOrphanGitHubArtifacts(activeIds);
    await cleanupOrphanContainers(activeIds).catch((err) =>
      console.warn('Failed to clean up orphan containers:', err),
    );
    await cleanupOrphanNetworks(activeIds).catch((err) =>
      console.warn('Failed to clean up orphan networks:', err),
    );
    // Clean up orphan container artifacts (credentials, gitconfig, wrapper, hooks)
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(POLICY_DIR).catch(() => [] as string[]);
      const suffixes = [
        '-container-gh-wrapper',
        '-container-hooks',
        '-gitconfig',
        '-claude-credentials.json',
        '-credential-helper.js',
        '-user-gitconfig',
        '-gh-token',
      ];
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
    console.log('[cleanup] Orphan cleanup complete.');
  }

  getSandboxViolations(workspaceId: string): SandboxViolationInfo[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace.sandboxViolations.slice();
  }

  private async summarize(workspace: WorkspaceState): Promise<WorkspaceSummary> {
    let policyName: string | null = null;
    if (workspace.policyId) {
      try {
        policyName = this.policyRegistry.get(workspace.policyId).name;
      } catch {
        policyName = workspace.policyId;
      }
    }

    // Read live policy state from disk (the gh shim may have updated it).
    // Only sync forward: take disk values that represent progress (PR created,
    // canCreatePr cleared). Never regress in-memory state, since the proxy may
    // have updated it before the disk write completes.
    let githubRepo = workspace.githubPolicy?.repo ?? null;
    let ownedPrNumber = workspace.githubPolicy?.ownedPrNumber ?? null;
    if (workspace.githubPolicy) {
      try {
        const livePolicy = await readPolicyState(policyStatePath(workspace.id));
        githubRepo = livePolicy.repo;
        // Only adopt disk ownedPrNumber if in-memory is still null
        if (workspace.githubPolicy.ownedPrNumber === null && livePolicy.ownedPrNumber !== null) {
          ownedPrNumber = livePolicy.ownedPrNumber;
          workspace.githubPolicy.ownedPrNumber = livePolicy.ownedPrNumber;
        } else {
          ownedPrNumber = workspace.githubPolicy.ownedPrNumber;
        }
        // Only adopt disk canCreatePr if it transitions from true → false
        // (meaning the gh shim captured a PR). Never go from false → true.
        if (workspace.githubPolicy.canCreatePr && !livePolicy.canCreatePr) {
          workspace.githubPolicy.canCreatePr = false;
        }
      } catch {
        // Policy file may have been cleaned up — use in-memory state
      }
    }

    return {
      id: workspace.id,
      repositoryId: workspace.repositoryId,
      status: workspace.status,
      messageCount: workspace.messages.length,
      agentType: workspace.agentType,
      projectDir: workspace.projectDir,
      sandboxed: workspace.sandboxBackend !== 'none',
      sandboxBackend: workspace.sandboxBackend,
      containerName: workspace.containerHandle?.containerName ?? null,
      policyId: workspace.policyId,
      policyName,
      githubRepo,
      ownedPrNumber,
      prUrl: workspace.prUrl,
      phase: workspace.phase,
      networkAccess: workspace.proxyHandle ? 'filtered' : 'full',
      canResume:
        workspace.acpSessionId !== '' &&
        (workspace.status === 'error' || workspace.status === 'suspended'),
      topic: workspace.topic,
    };
  }

  /** Persist workspace metadata to disk for session resume. */
  private async persistState(workspace: WorkspaceState): Promise<void> {
    await persistWorkspace({
      id: workspace.id,
      repositoryId: workspace.repositoryId,
      acpSessionId: workspace.acpSessionId,
      projectDir: workspace.projectDir,
      agentType: workspace.agentType,
      sandboxBackend: workspace.sandboxBackend,
      worktreePath: workspace.worktree?.path ?? null,
      worktreeGitCommonDir: workspace.worktree?.gitCommonDir ?? null,
      worktreeBranch: workspace.worktree?.branch ?? null,
      policyId: workspace.policyId,
      containerImage: null,
      githubPolicy: workspace.githubPolicy,
      phase: workspace.phase,
      prUrl: workspace.prUrl,
      promptCount: workspace.promptCount,
      topic: workspace.topic,
      topicSource: workspace.topicSource,
    }).catch((err) =>
      console.warn(`[workspace] Failed to persist state for ${workspace.id}:`, err),
    );
  }

  /** Queue a message write through the workspace's serialized write chain. */
  private queueMessagePersist(
    workspace: WorkspaceState,
    workspaceId: string,
    message: Message,
  ): void {
    workspace.messageWriteChain = workspace.messageWriteChain
      .then(() => persistMessage(workspaceId, message))
      .catch((err) =>
        console.warn(`[workspace] Failed to persist message for ${workspaceId}:`, err),
      );
  }

  /**
   * Resume a workspace that's in error or suspended state.
   * Spawns a fresh agent process and calls resumeSession with the saved session ID.
   */
  async resumeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.status !== 'error' && workspace.status !== 'suspended') {
      throw new Error(`Cannot resume workspace in status: ${workspace.status}`);
    }

    const savedSessionId = workspace.acpSessionId;
    if (!savedSessionId) {
      throw new Error('No session ID available for resume');
    }

    workspace.status = 'resuming';
    workspace.errorMessage = undefined;
    workspace.errorKind = undefined;
    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'resuming',
    });

    // Clean up any leftover runtime resources from the previous run
    workspace.sandboxMonitor?.stop();
    workspace.sandboxMonitor = null;
    workspace.containerMonitor?.stop();
    workspace.containerMonitor = null;
    if (workspace.ghTokenRefreshTimer) {
      clearInterval(workspace.ghTokenRefreshTimer);
      workspace.ghTokenRefreshTimer = null;
    }
    if (workspace.proxyHandle) {
      await workspace.proxyHandle.stop().catch(() => {});
      workspace.proxyHandle = null;
    }
    // Kill old agent process before spawning a new one.
    // Remove exit listeners first to prevent spurious error events during intentional restart.
    if (workspace.containerHandle) {
      workspace.agentProcess?.removeAllListeners('exit');
      workspace.containerHandle.kill();
      await removeContainer(workspaceId).catch(() => {});
      workspace.containerHandle = null;
    } else if (workspace.agentProcess?.exitCode === null) {
      workspace.agentProcess.removeAllListeners('exit');
      workspace.agentProcess.kill();
    }

    // Clean up session network after container is removed (network rm fails while container is attached)
    if (workspace.sessionNetwork) {
      await workspace.sessionNetwork.cleanup().catch(() => {});
      workspace.sessionNetwork = null;
    }

    try {
      // For container sessions, refresh credentials before spawning
      if (workspace.sandboxBackend === 'container' && process.platform === 'darwin') {
        const sessionDir = join(app.getPath('userData'), 'sessions', workspaceId);
        await mkdir(sessionDir, { recursive: true });
        try {
          const { execFile: ef } = await import('node:child_process');
          const { promisify: p } = await import('node:util');
          const { stdout: credJson } = await p(ef)('security', [
            'find-generic-password',
            '-s',
            'Claude Code-credentials',
            '-w',
          ]);
          await writeFile(join(sessionDir, '.credentials.json'), credJson.trim(), { mode: 0o600 });
        } catch (err) {
          console.warn('[resume] Could not refresh credentials:', err);
        }
      }

      // Resolve policy template for container/sandbox config reconstruction
      const resolvedPolicyId =
        workspace.agentType === 'claude-code' || workspace.agentType === 'replay'
          ? (workspace.policyId ?? this.policyRegistry.defaultId)
          : null;
      const template = resolvedPolicyId ? this.policyRegistry.get(resolvedPolicyId) : null;

      const workingDir = workspace.worktree?.path ?? workspace.projectDir;

      // Rebuild sandbox config
      let sandboxConfig: SandboxConfig | null = null;
      if (template && (await isSafehouseAvailable())) {
        const appNodeModules = join(app.getAppPath(), 'node_modules');
        const readOnlyDirs = [appNodeModules];
        if (workspace.agentType === 'replay') {
          readOnlyDirs.push(app.getAppPath());
        }
        sandboxConfig = policyToSandboxConfig(template, {
          sessionId: workspaceId,
          worktreePath: workingDir,
          gitCommonDir: workspace.worktree?.gitCommonDir,
          readOnlyDirs,
        });
        workspace.sandboxConfig = sandboxConfig;
        await writeAppendProfile(sandboxConfig);
      }

      // Rebuild container config or spawn agent directly
      const dockerAvailable = await isDockerAvailable();
      let containerConfig: ContainerConfig | null = null;
      let shimEnv: Record<string, string> = {};

      if (
        workspace.sandboxBackend === 'container' &&
        dockerAvailable &&
        template &&
        (workspace.agentType === 'claude-code' || workspace.agentType === 'replay')
      ) {
        // Reconstruct container config — reuse the same initialization logic
        const appRequire = createRequire(app.getAppPath() + '/');
        const agentPkgDir = join(
          appRequire.resolve('@zed-industries/claude-agent-acp/package.json'),
          '..',
        );
        const appNodeModules = join(app.getAppPath(), 'node_modules');
        await mkdir(POLICY_DIR, { recursive: true });

        // Rebuild container artifacts
        let containerShimScript: string | undefined;
        let containerGitconfigFile: string | undefined;
        let containerHooksDir: string | undefined;
        let containerCredHelper: string | undefined;

        if (template.github && workspace.githubPolicy) {
          const wrapperPath = join(POLICY_DIR, `${workspaceId}-container-gh-wrapper`);
          await writeFile(
            wrapperPath,
            `#!/bin/bash\nexec node /usr/local/lib/bouncer/gh-shim.js "$@"\n`,
            'utf-8',
          );
          await chmod(wrapperPath, 0o755);
          containerShimScript = wrapperPath;

          containerHooksDir = join(POLICY_DIR, `${workspaceId}-container-hooks`);
          await mkdir(containerHooksDir, { recursive: true });
          const hookContent = generatePrePushHookForContainer();
          const hookPath = join(containerHooksDir, 'pre-push');
          await writeFile(hookPath, hookContent, 'utf-8');
          await chmod(hookPath, 0o755);

          const gitconfigContent = generateGitconfig({
            hooksPath: '/etc/bouncer/hooks',
            credentialHelperPath: '/usr/local/lib/bouncer/gh-credential-helper.js',
            userName: process.env.GIT_AUTHOR_NAME,
            userEmail: process.env.GIT_AUTHOR_EMAIL,
          });
          containerGitconfigFile = join(POLICY_DIR, `${workspaceId}-gitconfig`);
          await writeFile(containerGitconfigFile, gitconfigContent, 'utf-8');

          const { generateCredentialHelperJs } = await import('./policy-container.js');
          containerCredHelper = join(POLICY_DIR, `${workspaceId}-credential-helper.js`);
          await writeFile(containerCredHelper, generateCredentialHelperJs(), { mode: 0o755 });
        }

        const shimBundlePath =
          template.github && workspace.githubPolicy
            ? join(POLICY_DIR, 'gh-shim-bundle.js')
            : undefined;

        const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
        const sessionDir = join(app.getPath('userData'), 'sessions', workspaceId);

        const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
        let ghTokenFilePath: string | undefined;
        if (ghToken) {
          ghTokenFilePath = join(POLICY_DIR, `${workspaceId}-gh-token`);
          await writeFile(ghTokenFilePath, ghToken, { mode: 0o600 });
          workspace.ghTokenFilePath = ghTokenFilePath;
        }

        const containerEnv: Record<string, string> = {
          ...(anthropicKey ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
          ...(ghToken ? { GH_TOKEN: ghToken } : {}),
          ...(process.env.GIT_AUTHOR_NAME ? { GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME } : {}),
          ...(process.env.GIT_AUTHOR_EMAIL
            ? { GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL }
            : {}),
          ...(process.env.GIT_COMMITTER_NAME
            ? { GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME }
            : {}),
          ...(process.env.GIT_COMMITTER_EMAIL
            ? { GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL }
            : {}),
        };

        // Rebuild proxy if template uses filtered network
        let proxyCaCertPath: string | undefined;
        if (template.network.access === 'filtered') {
          const ca = await ensureCA();
          proxyCaCertPath = ca.certPath;
          const inspectedDomains =
            template.network.access === 'filtered' ? template.network.inspectedDomains : [];
          const proxyConfig: ProxyConfig = {
            sessionId: workspaceId,
            port: 0,
            allowedDomains: template.network.allowedDomains,
            inspectedDomains,
            githubPolicy: workspace.githubPolicy,
            ca,
            onPolicyEvent: (event: PolicyEvent) => {
              this.emit('workspace-update', { workspaceId, type: 'policy-event', event });
              if (workspace.githubPolicy) {
                if (event.operation.startsWith('branch-ratchet:')) {
                  writePolicyState(workspaceId, workspace.githubPolicy).catch(() => {});
                  updateAllowedRefs(workspaceId, workspace.githubPolicy.allowedPushRefs).catch(
                    () => {},
                  );
                  this.persistState(workspace);
                }
                if (event.operation.startsWith('captured PR')) {
                  writePolicyState(workspaceId, workspace.githubPolicy).catch(() => {});
                  const urlMatch = event.operation.match(/https:\/\/\S+/);
                  if (urlMatch) workspace.prUrl = urlMatch[0];
                  workspace.phase = 'pr-open';
                  this.persistState(workspace);
                  this.summarize(workspace)
                    .then((summary) => {
                      this.emit('workspace-update', {
                        workspaceId,
                        type: 'status-change',
                        status: workspace.status,
                        summary,
                      });
                    })
                    .catch(() => {});
                }
              }
            },
          };
          if (workspace.githubPolicy) {
            proxyConfig.onMitmRequest = createGitHubMitmHandler(proxyConfig);
          }
          const proxyHandle = await startProxy(proxyConfig);
          workspace.proxyHandle = proxyHandle;
          const sessionNetwork = await createSessionNetwork(workspaceId);
          workspace.sessionNetwork = sessionNetwork;

          const proxyEnvUrl = `http://host.docker.internal:${proxyHandle.port}`;
          containerEnv.HTTP_PROXY = proxyEnvUrl;
          containerEnv.HTTPS_PROXY = proxyEnvUrl;
          containerEnv.http_proxy = proxyEnvUrl;
          containerEnv.https_proxy = proxyEnvUrl;
          containerEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
          containerEnv.no_proxy = 'localhost,127.0.0.1,::1';
          containerEnv.BOUNCER_PROXY_HOST = 'host.docker.internal';
          containerEnv.BOUNCER_PROXY_PORT = String(proxyHandle.port);

          if (containerGitconfigFile) {
            const gitconfigContent = generateGitconfig({
              hooksPath: '/etc/bouncer/hooks',
              credentialHelperPath: '/usr/local/lib/bouncer/gh-credential-helper.js',
              userName: process.env.GIT_AUTHOR_NAME,
              userEmail: process.env.GIT_AUTHOR_EMAIL,
              proxyUrl: proxyEnvUrl,
            });
            await writeFile(containerGitconfigFile, gitconfigContent, 'utf-8');
          }
        }

        const imageTag = await ensureAgentImage();
        const ctx: ContainerSessionContext = {
          sessionId: workspaceId,
          worktreePath: workingDir,
          gitCommonDir: workspace.worktree?.gitCommonDir,
          agentBinPath: agentPkgDir,
          nodeModulesPath: appNodeModules,
          shimBundlePath: shimBundlePath && containerShimScript ? shimBundlePath : undefined,
          shimScriptPath: containerShimScript,
          hooksDir: containerHooksDir,
          allowedRefsPath: allowedRefsPath(workspaceId),
          policyStatePath: workspace.githubPolicy ? policyStatePath(workspaceId) : undefined,
          gitconfigPath: containerGitconfigFile,
          credentialHelperPath: containerCredHelper,
          caCertPath: proxyCaCertPath,
          claudeConfigDir: sessionDir,
          claudeCredentialsPath: undefined, // Already in sessionDir
          ghTokenFilePath,
        };

        containerConfig = policyToContainerConfig(template, ctx, containerEnv, imageTag, [
          'node',
          '/usr/local/lib/agent/dist/index.js',
        ]);

        if (workspace.proxyHandle && workspace.sessionNetwork) {
          containerConfig.networkMode = 'proxy';
          containerConfig.networkName = workspace.sessionNetwork.networkName;
        }
      }

      // Spawn the agent
      let agentProcess: ChildProcess;
      if (containerConfig) {
        workspace.sandboxBackend = 'container';
        const handle = spawnContainer(containerConfig);
        workspace.containerHandle = handle;
        agentProcess = handle.process;
      } else {
        const { cmd, args, env, cwd } = resolveAgentCommand(
          workspace.agentType,
          workingDir,
          sandboxConfig,
          workspace.worktree?.path,
        );
        agentProcess = spawn(cmd, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...env, ...shimEnv },
          cwd,
        });
      }
      workspace.agentProcess = agentProcess;

      // Start GH token refresh for container sessions
      if (workspace.ghTokenFilePath && containerConfig) {
        const GH_TOKEN_REFRESH_MS = 30 * 60 * 1000;
        const tokenFilePath = workspace.ghTokenFilePath;
        workspace.ghTokenRefreshTimer = setInterval(async () => {
          try {
            const { execFile: ef } = await import('node:child_process');
            const { promisify: p } = await import('node:util');
            const { stdout } = await p(ef)('gh', ['auth', 'token']);
            const newToken = stdout.trim();
            if (newToken) {
              await writeFile(tokenFilePath, newToken, { mode: 0o644 });
            }
          } catch {
            /* best effort */
          }
        }, GH_TOKEN_REFRESH_MS);
      }

      // Capture stderr
      let collectedStderr = '';
      const stderrDecoder = new StringDecoder('utf8');
      agentProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = stderrDecoder.write(data);
        collectedStderr += chunk;
        process.stderr.write(data);
      });

      // Handle agent crashes
      agentProcess.on('exit', (code) => {
        const remaining = stderrDecoder.end();
        if (remaining) collectedStderr += remaining;
        // Don't overwrite an existing auth error (e.g. set before killing the process)
        if (workspace.status === 'error' && workspace.errorKind === 'auth') return;
        if (workspace.status !== 'closed' && workspace.status !== 'archived') {
          const errorKind = isAuthError(collectedStderr) ? ('auth' as const) : undefined;
          workspace.status = 'error';
          workspace.errorMessage = errorKind
            ? 'Authentication expired. Please re-authenticate and retry.'
            : `Agent exited with code ${code}`;
          workspace.errorKind = errorKind;
          this.emit('workspace-update', {
            workspaceId,
            type: 'status-change',
            status: 'error',
            error: workspace.errorMessage,
            errorKind,
          });
        }
      });
      agentProcess.on('error', (err) => {
        if (workspace.status !== 'closed' && workspace.status !== 'archived') {
          workspace.status = 'error';
          workspace.errorMessage = err.message;
          this.emit('workspace-update', {
            workspaceId,
            type: 'status-change',
            status: 'error',
            error: err.message,
          });
        }
      });

      // Set up ACP connection
      const output = Writable.toWeb(agentProcess.stdin!) as WritableStream<Uint8Array>;
      const input = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(output, input);

      const emitUpdate = this.emit.bind(this);
      const pendingChunks = new Map<
        string,
        { messageId: string; text: string; segmentIndex: number }
      >();
      let chunkFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushChunks = (): void => {
        if (chunkFlushTimer) {
          clearTimeout(chunkFlushTimer);
          chunkFlushTimer = null;
        }
        for (const [, chunk] of pendingChunks) {
          emitUpdate('workspace-update', {
            workspaceId,
            type: 'stream-chunk',
            messageId: chunk.messageId,
            text: chunk.text,
            segmentIndex: chunk.segmentIndex,
          });
        }
        pendingChunks.clear();
      };
      workspace.flushChunks = flushChunks;
      const scheduleChunkFlush = (): void => {
        if (!chunkFlushTimer) chunkFlushTimer = setTimeout(flushChunks, 50);
      };

      let sawToolCallSinceLastText = false;

      const connection = new acp.ClientSideConnection(
        (_agent) => ({
          async sessionUpdate(params) {
            const update = params.update;
            if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
              const agentMsg = workspace.messages.findLast(
                (m) => m.role === 'agent' && m.streaming,
              );
              if (agentMsg) {
                const segments = agentMsg.textSegments!;
                const parts = agentMsg.parts!;
                if (sawToolCallSinceLastText) {
                  segments.push('');
                  parts.push({ type: 'text', index: segments.length - 1 });
                  sawToolCallSinceLastText = false;
                }
                const segIdx = segments.length - 1;
                segments[segIdx] += update.content.text;
                agentMsg.text = segments.join('\n\n');
                const chunkKey = `${agentMsg.id}:${segIdx}`;
                const pending = pendingChunks.get(chunkKey);
                if (pending) {
                  pending.text += update.content.text;
                } else {
                  pendingChunks.set(chunkKey, {
                    messageId: agentMsg.id,
                    text: update.content.text,
                    segmentIndex: segIdx,
                  });
                }
                scheduleChunkFlush();
              }
            } else if (
              update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update'
            ) {
              sawToolCallSinceLastText = true;
              const agentMsg = workspace.messages.findLast((m) => m.role === 'agent');
              if (agentMsg) {
                const meta = update._meta as { claudeCode?: { toolName?: string } } | undefined;
                const rawInput =
                  'rawInput' in update && update.rawInput != null
                    ? (update.rawInput as Record<string, unknown>)
                    : undefined;
                const toolCall: ToolCallInfo = {
                  id: update.toolCallId,
                  name: meta?.claudeCode?.toolName ?? 'Tool',
                  status:
                    'status' in update ? (update.status as ToolCallInfo['status']) : 'in_progress',
                  title: 'title' in update ? (update.title as string) : undefined,
                  description:
                    rawInput?.description && typeof rawInput.description === 'string'
                      ? rawInput.description
                      : undefined,
                  input: rawInput,
                  output:
                    'rawOutput' in update
                      ? typeof update.rawOutput === 'string'
                        ? update.rawOutput
                        : JSON.stringify(update.rawOutput)
                      : undefined,
                };
                agentMsg.toolCalls = agentMsg.toolCalls ?? [];
                const existing = agentMsg.toolCalls.find((tc) => tc.id === toolCall.id);
                if (!existing && agentMsg.parts) {
                  agentMsg.parts.push({ type: 'tool', toolCallId: toolCall.id });
                }
                if (existing) {
                  for (const [k, v] of Object.entries(toolCall)) {
                    if (v !== undefined) (existing as unknown as Record<string, unknown>)[k] = v;
                  }
                } else {
                  agentMsg.toolCalls.push(toolCall);
                }
                emitUpdate('workspace-update', {
                  workspaceId,
                  type: 'tool-call',
                  messageId: agentMsg.id,
                  toolCall,
                });
              }
            }
          },
          async requestPermission(params) {
            const allowOption = params.options.find((o) => o.kind === 'allow_once');
            if (allowOption)
              return { outcome: { outcome: 'selected' as const, optionId: allowOption.optionId } };
            return {
              outcome: { outcome: 'selected' as const, optionId: params.options[0].optionId },
            };
          },
        }),
        stream,
      );
      workspace.connection = connection;

      // ACP handshake
      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { terminal: true, fs: { readTextFile: true, writeTextFile: true } },
      });

      // Resume the session
      const cwd = containerConfig ? '/workspace' : workingDir;
      await connection.unstable_resumeSession({ sessionId: savedSessionId, cwd });

      // Start container monitor
      if (workspace.containerHandle) {
        const cMonitor = new ContainerMonitor();
        cMonitor.on('violation', (violation) => {
          const info: SandboxViolationInfo = {
            timestamp: violation.timestamp.getTime(),
            operation: violation.operation,
            path: violation.path,
            processName: violation.processName,
          };
          workspace.sandboxViolations.push(info);
          this.emit('workspace-update', {
            workspaceId,
            type: 'sandbox-violation',
            violation: info,
          });
        });
        cMonitor.start(workspace.containerHandle.containerName);
        workspace.containerMonitor = cMonitor;
      }

      // Add system message to mark the resume point
      const systemMsg: Message = {
        id: randomUUID(),
        role: 'agent',
        text: `_Session resumed at ${new Date().toLocaleTimeString()}_`,
        timestamp: Date.now(),
      };
      workspace.messages.push(systemMsg);
      this.emit('workspace-update', { workspaceId, type: 'message', message: systemMsg });
      this.queueMessagePersist(workspace, workspaceId, systemMsg);

      workspace.status = 'ready';
      const readySummary = await this.summarize(workspace);
      this.emit('workspace-update', {
        workspaceId,
        type: 'status-change',
        status: 'ready',
        summary: readySummary,
      });
    } catch (err) {
      console.error(`[resume] Failed to resume workspace ${workspaceId}:`, err);
      const errorKind = isAuthError(err) ? ('auth' as const) : undefined;
      workspace.status = 'error';
      workspace.errorMessage = errorKind
        ? 'Authentication expired. Please re-authenticate and retry.'
        : `Resume failed: ${err instanceof Error ? err.message : String(err)}`;
      workspace.errorKind = errorKind;
      this.emit('workspace-update', {
        workspaceId,
        type: 'status-change',
        status: 'error',
        error: workspace.errorMessage,
        errorKind,
      });
    }
  }

  /**
   * Restore persisted workspaces from disk as suspended.
   * Called on app startup before the window is shown.
   */
  async restorePersistedWorkspaces(): Promise<void> {
    const persisted = await loadPersistedWorkspaces();
    for (const pw of persisted) {
      // Skip if already loaded (shouldn't happen, but be safe)
      if (this.workspaces.has(pw.id)) continue;

      // Skip archived workspaces — they have no worktree and shouldn't be restored
      if (pw.archived) continue;

      // Validate worktree still exists
      if (pw.worktreePath) {
        const exists = await stat(pw.worktreePath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          console.log(
            `[restore] Worktree missing for workspace ${pw.id}, removing persisted state`,
          );
          await removePersistedWorkspace(pw.id);
          await removeMessages(pw.id);
          continue;
        }
      }

      const messages = await loadMessages(pw.id);

      const workspace: WorkspaceState = {
        id: pw.id,
        repositoryId: pw.repositoryId,
        acpSessionId: pw.acpSessionId,
        agentProcess: null!,
        connection: null!,
        messages,
        status: 'suspended',
        agentType: pw.agentType,
        projectDir: pw.projectDir,
        worktree: pw.worktreePath
          ? {
              path: pw.worktreePath,
              branch: pw.worktreeBranch!,
              projectDir: pw.projectDir,
              gitCommonDir: pw.worktreeGitCommonDir ?? undefined,
            }
          : null,
        sandboxBackend: pw.sandboxBackend,
        sandboxConfig: null,
        sandboxMonitor: null,
        containerMonitor: null,
        sandboxViolations: [],
        containerHandle: null,
        proxyHandle: null,
        sessionNetwork: null,
        policyId: pw.policyId,
        githubPolicy: pw.githubPolicy,
        phase: pw.phase,
        prUrl: pw.prUrl,
        flushChunks: () => {},
        promptCount: pw.promptCount,
        messageWriteChain: Promise.resolve(),
        pendingMessage: null,
        ghTokenRefreshTimer: null,
        ghTokenFilePath: null,
        topic: pw.topic ?? (pw.worktreeBranch ? topicFromBranch(pw.worktreeBranch) : null),
        topicSource: pw.topicSource ?? (pw.worktreeBranch ? 'branch' : 'placeholder'),
      };
      this.workspaces.set(pw.id, workspace);
      console.log(
        `[restore] Restored workspace ${pw.id} as suspended (${messages.length} messages)`,
      );
    }
  }
}
