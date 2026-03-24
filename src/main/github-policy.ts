/**
 * GitHub remote detection and policy state file I/O (M5).
 *
 * Detects the GitHub "owner/repo" from a git worktree, builds per-session
 * GitHubPolicy objects, and manages the policy state JSON file that the
 * gh shim reads at invocation time.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { POLICY_DIR } from "./sandbox.js";
import type { GitHubPolicy } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Detect the GitHub "owner/repo" from the git remote in a directory.
 * Parses the origin remote URL (HTTPS or SSH format).
 * Returns null if no GitHub remote is found.
 */
export async function detectGitHubRepo(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"]);
    return parseGitHubRemoteUrl(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL and extract "owner/repo" if it's a GitHub remote.
 * Handles:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *   - git@github.com:owner/repo
 *   - ssh://git@github.com/owner/repo.git
 */
export function parseGitHubRemoteUrl(url: string): string | null {
  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH shorthand: git@github.com:owner/repo[.git]
  const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // SSH URL: ssh://git@github.com/owner/repo[.git]
  const sshUrlMatch = url.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshUrlMatch) return sshUrlMatch[1];

  return null;
}

/**
 * Build a GitHubPolicy for a new session.
 */
export function buildSessionPolicy(repo: string, branch: string): GitHubPolicy {
  return {
    repo,
    allowedPushRefs: [branch],
    ownedPrNumber: null,
    canCreatePr: true,
  };
}

/**
 * Path to the policy state file for a session.
 */
export function policyStatePath(sessionId: string): string {
  return join(POLICY_DIR, `${sessionId}-github-policy.json`);
}

/**
 * Write the policy state file. Called at session creation and
 * updated by the gh shim after PR creation.
 */
export async function writePolicyState(sessionId: string, policy: GitHubPolicy): Promise<void> {
  await writeFile(policyStatePath(sessionId), JSON.stringify(policy, null, 2), "utf-8");
}

/**
 * Read the policy state file. Called by the gh shim on each invocation.
 */
export async function readPolicyState(path: string): Promise<GitHubPolicy> {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as GitHubPolicy;
}

/**
 * Clean up the policy state file for a session.
 */
export async function cleanupPolicyState(sessionId: string): Promise<void> {
  try {
    await rm(policyStatePath(sessionId));
  } catch {
    // File may not exist — that's fine
  }
}
