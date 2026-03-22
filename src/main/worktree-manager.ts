import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string; // Absolute path to the worktree directory
  branch: string; // Branch name: bouncer/<session-id>
  projectDir: string; // Original project directory
}

export class WorktreeManager {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(tmpdir(), "glitterball-worktrees");
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
    const branch = `bouncer/${sessionId}`;
    const worktreePath = join(this.basePath, sessionId);

    await mkdir(this.basePath, { recursive: true });

    await execFileAsync(
      "git",
      ["worktree", "add", worktreePath, "-b", branch, "HEAD"],
      { cwd: projectDir }
    );

    return { path: worktreePath, branch, projectDir };
  }

  /** Remove a worktree and delete its session branch. */
  async remove(info: WorktreeInfo): Promise<void> {
    try {
      await execFileAsync(
        "git",
        ["worktree", "remove", info.path, "--force"],
        { cwd: info.projectDir }
      );
    } catch (err) {
      console.warn(`Failed to remove worktree ${info.path}:`, err);
    }

    try {
      await execFileAsync("git", ["branch", "-D", info.branch], {
        cwd: info.projectDir,
      });
    } catch {
      // Branch may already be gone or may have been merged
    }
  }
}
