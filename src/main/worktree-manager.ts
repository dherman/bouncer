import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorktreeInfo {
  path: string; // Absolute path to the worktree directory
  branch: string; // Branch name: bouncer/<session-id>
  projectDir: string; // Original project directory
}

export class WorktreeManager {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = resolve(basePath ?? join(tmpdir(), "glitterball-worktrees"));
  }

  /** Validate that a directory is a git repository. */
  async validateGitRepo(dir: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: dir });
      return true;
    } catch {
      return false;
    }
  }

  /** Create a worktree for a session, branched from HEAD. */
  async create(sessionId: string, projectDir: string): Promise<WorktreeInfo> {
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`Invalid session ID (expected UUID): ${sessionId}`);
    }

    const branch = `bouncer/${sessionId}`;
    const worktreePath = join(this.basePath, sessionId);

    await mkdir(this.basePath, { recursive: true });

    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branch, "--", worktreePath, "HEAD"],
      { cwd: projectDir }
    );

    return { path: worktreePath, branch, projectDir };
  }

  /** Remove a worktree and delete its session branch. */
  async remove(info: WorktreeInfo): Promise<void> {
    try {
      await execFileAsync(
        "git",
        ["worktree", "remove", "--force", "--", info.path],
        { cwd: info.projectDir }
      );
    } catch (err) {
      console.warn(`Failed to remove worktree ${info.path}:`, err);
    }

    try {
      await execFileAsync("git", ["branch", "-D", "--", info.branch], {
        cwd: info.projectDir,
      });
    } catch {
      // Branch may already be gone or may have been merged
    }
  }
}
