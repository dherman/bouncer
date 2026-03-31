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
} from './hooks.js';
import {
  policyToContainerConfig,
  generateGitconfig,
  type ContainerSessionContext,
} from './policy-container.js';
import { writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { POLICY_DIR } from './sandbox.js';
import type {
  AgentType,
  GitHubPolicy,
  Message,
  PolicyEvent,
  PolicyTemplate,
  SandboxBackend,
  SandboxViolationInfo,
  WorkspaceSummary,
  WorkspaceUpdate,
  ToolCallInfo,
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

interface WorkspaceState {
  id: string;
  repositoryId: string | null;
  acpSessionId: string;
  agentProcess: ChildProcess;
  connection: acp.ClientSideConnection;
  messages: Message[];
  status: 'initializing' | 'ready' | 'error' | 'closed';
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
  /** Flush any batched stream-chunk events. Called before stream-end. */
  flushChunks: () => void;
  promptCount: number;
  /** Message queued while workspace was still initializing. */
  pendingMessage: string | null;
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
      flushChunks: () => {},
      promptCount: 0,
      pendingMessage: null,
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
          await writePolicyState(id, githubPolicy);
          await installHooks(id, workingDir, githubPolicy.allowedPushRefs);

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
              claudeCredentialsPath = join(POLICY_DIR, `${id}-claude-credentials.json`);
              await writeFile(claudeCredentialsPath, credJson.trim(), { mode: 0o600 });
              console.log('[container] Wrote Claude credentials file from macOS keychain');
            } catch (err) {
              console.warn('[container] Could not extract Claude credentials from keychain:', err);
              claudeCredentialsPath = undefined;
            }
          }
          const ghToken =
            shimEnv.GH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
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
                // Persist policy state if PR was captured
                if (workspace.githubPolicy && event.operation.startsWith('captured PR')) {
                  writePolicyState(id, workspace.githubPolicy).catch(() => {});
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
            claudeConfigDir: join((await import('node:os')).homedir(), '.claude'),
            claudeCredentialsPath,
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

        if (workspace.status !== 'closed') {
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
        if (workspace.status !== 'closed') {
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
      workspace.status = 'error';
      this.emit('workspace-update', {
        workspaceId: id,
        type: 'status-change',
        status: 'error',
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

    // On the first prompt, inject UI formatting guidance
    if (workspace.promptCount === 0) {
      promptBlocks.push({
        type: 'text',
        text: '<system-instruction>\nFormatting guidance: After completing tool calls, when you present the results to the user, always start with a brief summary sentence that contextualizes the data before showing it. Do not output raw data or listings without a lead-in. Before making tool calls, keep your introductory text minimal — just proceed to the tool calls without unnecessary preamble.\n</system-instruction>',
      });
    }
    workspace.promptCount++;

    promptBlocks.push({ type: 'text', text });

    try {
      await workspace.connection.prompt({
        sessionId: workspace.acpSessionId,
        prompt: promptBlocks,
      });
    } catch (err) {
      console.error(`Prompt failed for workspace ${workspaceId}:`, err);
      if (isAuthError(err) && workspace.status !== 'closed') {
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
      const credPath = join(POLICY_DIR, `${workspaceId}-claude-credentials.json`);
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

  async closeWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    workspace.status = 'closed';
    workspace.flushChunks();
    workspace.sandboxMonitor?.stop();
    workspace.containerMonitor?.stop();
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

    this.emit('workspace-update', {
      workspaceId,
      type: 'status-change',
      status: 'closed',
    });
  }

  /** Close all active workspaces. Called on app quit. */
  async closeAllWorkspaces(): Promise<void> {
    const activeWorkspaces = Array.from(this.workspaces.values()).filter(
      (s) => s.status !== 'closed',
    );
    await Promise.all(activeWorkspaces.map((s) => this.closeWorkspace(s.id).catch(() => {})));
  }

  /** Remove orphan worktree directories, sandbox policies, containers, and container artifacts left behind by a previous crash. */
  async cleanupOrphans(): Promise<void> {
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

    // Read live policy state from disk (the gh shim may have updated it)
    let githubRepo = workspace.githubPolicy?.repo ?? null;
    let ownedPrNumber = workspace.githubPolicy?.ownedPrNumber ?? null;
    if (workspace.githubPolicy) {
      try {
        const livePolicy = await readPolicyState(policyStatePath(workspace.id));
        githubRepo = livePolicy.repo;
        ownedPrNumber = livePolicy.ownedPrNumber;
        // Sync in-memory state
        workspace.githubPolicy.ownedPrNumber = livePolicy.ownedPrNumber;
        workspace.githubPolicy.canCreatePr = livePolicy.canCreatePr;
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
      networkAccess: workspace.proxyHandle ? 'filtered' : 'full',
    };
  }
}
