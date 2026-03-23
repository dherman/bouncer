/**
 * Sandbox integration via agent-safehouse.
 *
 * Instead of generating SBPL profiles directly, we delegate to the
 * `safehouse` CLI (https://agent-safehouse.dev) which maintains curated,
 * community-tested macOS Seatbelt profiles for agent sandboxing.
 *
 * Safehouse handles:
 *   - System runtime permissions (binaries, libraries, Mach IPC, devices)
 *   - Toolchain-specific paths (Node.js, Rust, Python, etc.)
 *   - Agent-specific state directories (Claude Code, Cursor, etc.)
 *   - Git worktree detection and cross-worktree read access
 *   - Shell init files, SSH config, XDG directories
 *
 * We provide:
 *   - Session-specific writable paths (worktree, git common dir)
 *   - Environment variable passthrough for ACP
 *   - Policy file lifecycle management
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export const POLICY_DIR = join(tmpdir(), "glitterball-sandbox");

export const BASE_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "NODE_OPTIONS",
  "NODE_PATH",
  "EDITOR",
  "VISUAL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

export interface SandboxConfig {
  /** Working directory for the sandboxed process (and git root detection). */
  workdir: string;
  /** Additional directories to grant read-write access. */
  writableDirs: string[];
  /** Additional directories to grant read-only access. */
  readOnlyDirs: string[];
  /** Environment variables to pass through to the sandboxed process. */
  envPassthrough: string[];
  /** Path to write the generated policy file. */
  policyOutputPath: string;
  /** Optional SBPL content appended to the generated profile via --append-profile. */
  appendProfileContent?: string;
}

/**
 * Build the safehouse CLI arguments for spawning a sandboxed process.
 *
 * When safehouse is available, the session manager spawns:
 *   safehouse [flags] -- node <agent-bin>
 *
 * When safehouse is unavailable, falls back to unsandboxed execution.
 */
export function buildSafehouseArgs(
  config: SandboxConfig,
  command: string[]
): string[] {
  const args: string[] = [];

  // Persist the policy file so we control its lifecycle
  args.push(`--output=${config.policyOutputPath}`);

  // Load all agent profiles — safehouse selects profiles by command
  // basename, but we spawn "node <agent-bin>" so it can't detect that
  // the wrapped process is Claude Code. --enable=all-agents loads all
  // agent-specific grants (Claude Code state dirs, etc.).
  args.push("--enable=all-agents");

  // Set the working directory for git root detection
  args.push(`--workdir=${config.workdir}`);

  // Writable directories
  if (config.writableDirs.length > 0) {
    args.push(`--add-dirs=${config.writableDirs.join(":")}`);
  }

  // Read-only directories
  if (config.readOnlyDirs.length > 0) {
    args.push(`--add-dirs-ro=${config.readOnlyDirs.join(":")}`);
  }

  // Environment passthrough
  if (config.envPassthrough.length > 0) {
    args.push(`--env-pass=${config.envPassthrough.join(",")}`);
  }

  // Append profile overlay for policy-specific SBPL rules
  if (config.appendProfileContent) {
    const appendPath = config.policyOutputPath.replace(/\.sb$/, "-append.sb");
    args.push(`--append-profile=${appendPath}`);
  }

  // Separator and command
  args.push("--");
  args.push(...command);

  return args;
}

/**
 * Build a SandboxConfig for a Claude Code agent session.
 */
export function defaultSandboxConfig({
  sessionId,
  worktreePath,
  gitCommonDir,
  readOnlyDirs: extraReadOnlyDirs,
}: {
  sessionId: string;
  worktreePath: string;
  /** The git common dir for linked worktrees (parent repo's .git). */
  gitCommonDir?: string;
  /** Additional directories to grant read-only access (e.g., agent binary package dir). */
  readOnlyDirs?: string[];
}): SandboxConfig {
  const writableDirs = [worktreePath];

  // Git worktree common dir: linked worktrees store refs/metadata in
  // the parent repo's .git directory. Without write access, git
  // operations (commit, branch, etc.) fail from within the worktree.
  if (gitCommonDir) {
    writableDirs.push(gitCommonDir);
  }

  return {
    workdir: worktreePath,
    writableDirs,
    readOnlyDirs: extraReadOnlyDirs ?? [],
    envPassthrough: [...BASE_ENV_PASSTHROUGH],
    policyOutputPath: join(POLICY_DIR, `${sessionId}.sb`),
  };
}

/**
 * Check whether the `safehouse` CLI is available on PATH.
 */
let _safehouseAvailable: boolean | null = null;
export async function isSafehouseAvailable(): Promise<boolean> {
  if (_safehouseAvailable !== null) return _safehouseAvailable;
  try {
    await execFileAsync("safehouse", ["--version"]);
    _safehouseAvailable = true;
  } catch {
    _safehouseAvailable = false;
  }
  return _safehouseAvailable;
}

/**
 * Ensure the policy output directory exists.
 */
export async function ensurePolicyDir(): Promise<void> {
  await mkdir(POLICY_DIR, { recursive: true });
}

/**
 * Write the append profile file if the config includes custom SBPL content.
 * Must be called before spawning safehouse.
 */
export async function writeAppendProfile(config: SandboxConfig): Promise<void> {
  if (!config.appendProfileContent) return;
  const appendPath = config.policyOutputPath.replace(/\.sb$/, "-append.sb");
  await writeFile(appendPath, config.appendProfileContent, "utf-8");
}

/**
 * Clean up a session's policy file(s), including any append profile.
 */
export async function cleanupPolicy(policyPath: string): Promise<void> {
  const appendPath = policyPath.replace(/\.sb$/, "-append.sb");
  await rm(policyPath, { force: true }).catch(() => {});
  await rm(appendPath, { force: true }).catch(() => {});
}

/**
 * Clean up orphan policy files from previous sessions.
 */
export async function cleanupOrphanPolicies(
  activeSessionIds: Set<string>
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(POLICY_DIR);
    for (const entry of entries) {
      if (entry.endsWith(".sb")) {
        // Extract session ID from both "uuid.sb" and "uuid-append.sb"
        const sessionId = entry.replace(/-append\.sb$/, "").replace(/\.sb$/, "");
        if (!activeSessionIds.has(sessionId)) {
          await rm(join(POLICY_DIR, entry), { force: true });
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}
