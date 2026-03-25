/**
 * Convert a PolicyTemplate + session context into a ContainerConfig.
 * Parallel to policy-sandbox.ts, which does the same for safehouse.
 */

import type { PolicyTemplate } from "./types.js";
import type { ContainerConfig, ContainerMount } from "./container.js";

export interface ContainerSessionContext {
  sessionId: string;
  worktreePath: string;
  gitCommonDir?: string;
  agentBinPath: string;
  nodeModulesPath: string;
  credentialHelperPath?: string;
  shimBundlePath?: string;
  shimScriptPath?: string;
  hooksDir?: string;
  allowedRefsPath?: string;
  policyStatePath?: string;
  gitconfigPath?: string;
  /** Mount ~/.ssh into the container. Only set when SSH access is needed. */
  sshDir?: string;
  /** Mount ~/.claude into the container for agent authentication. */
  claudeConfigDir?: string;
  /** Credentials file extracted from macOS keychain for Linux-mode auth. */
  claudeCredentialsPath?: string;
}

/**
 * Generate the content for a system gitconfig mounted at /etc/gitconfig
 * inside the container. Sets core.hooksPath and the credential helper
 * so git push authenticates via GH_TOKEN.
 */
export function generateGitconfig(opts: {
  hooksPath: string;
  credentialHelperPath: string;
  userName?: string;
  userEmail?: string;
}): string {
  const lines: string[] = [];
  lines.push("[core]");
  lines.push(`    hooksPath = ${opts.hooksPath}`);
  lines.push(`[credential "https://github.com"]`);
  lines.push(`    helper = !node ${opts.credentialHelperPath}`);
  if (opts.userName || opts.userEmail) {
    lines.push("[user]");
    if (opts.userName) lines.push(`    name = ${opts.userName}`);
    if (opts.userEmail) lines.push(`    email = ${opts.userEmail}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Convert a policy template and session context into a ContainerConfig
 * suitable for passing to spawnContainer().
 */
export function policyToContainerConfig(
  template: PolicyTemplate,
  ctx: ContainerSessionContext,
  env: Record<string, string>,
  imageTag: string,
  command: string[],
): ContainerConfig {
  const mounts: ContainerMount[] = [];
  const isReadOnly = template.filesystem.worktreeAccess === "read-only";

  // --- Standard mounts (always present) ---

  // Worktree → /workspace
  mounts.push({
    hostPath: ctx.worktreePath,
    containerPath: "/workspace",
    readOnly: isReadOnly,
  });

  // Git common dir → same absolute path inside container.
  // Must match host path because the worktree's .git file references it.
  if (ctx.gitCommonDir) {
    mounts.push({
      hostPath: ctx.gitCommonDir,
      containerPath: ctx.gitCommonDir,
      readOnly: isReadOnly,
    });
  }

  // Agent package dir → /usr/local/lib/agent/
  // Must include package.json so ESM resolution works (the agent uses "type": "module").
  // Not read-only because Docker needs to create the node_modules mountpoint inside it.
  mounts.push({
    hostPath: ctx.agentBinPath,
    containerPath: "/usr/local/lib/agent",
    readOnly: false,
  });

  // App node_modules → /usr/local/lib/agent/node_modules/
  // Mounted as a child of the agent dir so ESM bare-specifier resolution
  // finds dependencies by walking up from the agent's package.json.
  mounts.push({
    hostPath: ctx.nodeModulesPath,
    containerPath: "/usr/local/lib/agent/node_modules",
    readOnly: true,
  });

  // --- GitHub policy mounts (present when template.github is set) ---

  if (template.github) {
    if (ctx.hooksDir) {
      mounts.push({
        hostPath: ctx.hooksDir,
        containerPath: "/etc/bouncer/hooks",
        readOnly: true,
      });
    }

    if (ctx.allowedRefsPath) {
      mounts.push({
        hostPath: ctx.allowedRefsPath,
        containerPath: "/etc/bouncer/allowed-refs.txt",
        readOnly: true,
      });
    }

    if (ctx.shimScriptPath) {
      mounts.push({
        hostPath: ctx.shimScriptPath,
        containerPath: "/usr/local/bin/gh",
        readOnly: true,
      });
    }

    if (ctx.shimBundlePath) {
      mounts.push({
        hostPath: ctx.shimBundlePath,
        containerPath: "/usr/local/lib/bouncer/gh-shim.js",
        readOnly: true,
      });
    }

    if (ctx.policyStatePath) {
      // Policy state is rw — the gh shim updates it (e.g. PR capture)
      mounts.push({
        hostPath: ctx.policyStatePath,
        containerPath: "/etc/bouncer/github-policy.json",
        readOnly: false,
      });
    }

    if (ctx.gitconfigPath) {
      mounts.push({
        hostPath: ctx.gitconfigPath,
        containerPath: "/etc/gitconfig",
        readOnly: true,
      });
    }

    if (ctx.credentialHelperPath) {
      mounts.push({
        hostPath: ctx.credentialHelperPath,
        containerPath: "/usr/local/lib/bouncer/gh-credential-helper.js",
        readOnly: true,
      });
    }
  }

  // --- Auth mounts (opt-in only) ---

  // Claude Code config/state — the CLI reads and writes session state here.
  // The base image already has the claude binary; we only mount config dirs.
  if (ctx.claudeConfigDir) {
    mounts.push(
      { hostPath: ctx.claudeConfigDir, containerPath: "/home/agent/.claude", readOnly: false },
    );
  }

  // Credentials file extracted from macOS keychain — mounted into .claude dir
  // so the Claude CLI (Linux mode) can read OAuth tokens.
  if (ctx.claudeCredentialsPath) {
    mounts.push({
      hostPath: ctx.claudeCredentialsPath,
      containerPath: "/home/agent/.claude/.credentials.json",
      readOnly: true,
    });
  }

  if (ctx.sshDir) {
    mounts.push({
      hostPath: ctx.sshDir,
      containerPath: "/home/agent/.ssh",
      readOnly: true,
    });
  }

  // --- Additional mounts from container policy ---

  if (template.container?.additionalMounts) {
    for (const m of template.container.additionalMounts) {
      mounts.push(m);
    }
  }

  // --- Build env ---

  const containerEnv: Record<string, string> = {
    NODE_PATH: "/usr/local/lib/agent/node_modules",
    ...env,
  };

  if (template.github && ctx.policyStatePath) {
    containerEnv.BOUNCER_GITHUB_POLICY = "/etc/bouncer/github-policy.json";
  }

  // --- Network mode ---

  const networkMode = template.container?.networkMode ?? "bridge";

  return {
    sessionId: ctx.sessionId,
    image: template.container?.image ?? imageTag,
    command,
    workdir: "/workspace",
    mounts,
    env: containerEnv,
    networkMode,
  };
}
