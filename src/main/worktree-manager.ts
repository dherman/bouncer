import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WorktreeInfo {
  path: string // Absolute path to the worktree directory
  branch: string // Branch name: bouncer/<session-id>
  projectDir: string // Original project directory
  gitCommonDir?: string // Git common dir (parent repo's .git for linked worktrees)
}

export class WorktreeManager {
  private basePath: string
  private metadataPath: string

  constructor(basePath?: string) {
    this.basePath = resolve(basePath ?? join(tmpdir(), 'bouncer-worktrees'))
    this.metadataPath = join(homedir(), '.cache', 'bouncer', 'worktrees')
  }

  /** Validate that a directory is a git repository. */
  async validateGitRepo(dir: string): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir })
      return true
    } catch {
      return false
    }
  }

  /** Create a worktree for a session, branched from HEAD. */
  async create(sessionId: string, projectDir: string): Promise<WorktreeInfo> {
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`Invalid session ID (expected UUID): ${sessionId}`)
    }

    const branch = `bouncer/${sessionId}`
    const worktreePath = join(this.basePath, sessionId)

    await mkdir(this.basePath, { recursive: true })

    await execFileAsync('git', ['worktree', 'add', '-b', branch, '--', worktreePath, 'HEAD'], {
      cwd: projectDir,
    })

    // Resolve the git common dir — linked worktrees store refs/metadata
    // in the parent repo's .git directory. Without write access to this
    // path, git operations (commit, branch, etc.) fail from the worktree.
    const { stdout: commonDirRaw } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
    })
    const resolvedCommonDir = resolve(worktreePath, commonDirRaw.trim())

    // Validate that the common dir is under the project directory to avoid
    // granting sandbox write access to unexpected locations (e.g., repos
    // created with --separate-git-dir or a crafted .git file).
    const expectedPrefix = resolve(projectDir) + '/'
    let gitCommonDir: string | undefined
    if (resolvedCommonDir.startsWith(expectedPrefix)) {
      gitCommonDir = resolvedCommonDir
    } else {
      console.warn(
        `Git common dir ${resolvedCommonDir} is outside project ${projectDir} — skipping sandbox grant`,
      )
    }

    // Store project dir breadcrumb so orphan cleanup can find the parent repo
    await mkdir(this.metadataPath, { recursive: true })
    await writeFile(join(this.metadataPath, sessionId), projectDir, 'utf-8')

    return { path: worktreePath, branch, projectDir, gitCommonDir }
  }

  /** Remove a worktree and delete its session branch. */
  async remove(info: WorktreeInfo): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', '--', info.path], {
        cwd: info.projectDir,
      })
    } catch (err) {
      console.warn(`Failed to remove worktree ${info.path}:`, err)
    }

    try {
      await execFileAsync('git', ['branch', '-D', '--', info.branch], {
        cwd: info.projectDir,
      })
    } catch {
      // Branch may already be gone or may have been merged
    }

    // Clean up metadata breadcrumb
    const sessionId = info.path.split('/').pop()
    if (sessionId) {
      await rm(join(this.metadataPath, sessionId), { force: true })
    }
  }

  /**
   * Remove orphan worktree directories left behind by a previous crash.
   * @param activeSessionIds - IDs of sessions currently active (skip these)
   */
  async cleanupOrphans(activeSessionIds: Set<string>): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.metadataPath)
    } catch {
      return // No metadata directory — nothing to clean
    }

    for (const entry of entries) {
      if (activeSessionIds.has(entry)) continue
      if (!UUID_RE.test(entry)) continue

      const worktreePath = join(this.basePath, entry)
      const branch = `bouncer/${entry}`

      // Read the project dir from the metadata breadcrumb
      let projectDir: string | null = null
      try {
        projectDir = (await readFile(join(this.metadataPath, entry), 'utf-8')).trim()
      } catch {
        // No breadcrumb — just rm the directory
      }

      console.log(`Cleaning up orphan worktree: ${entry}`)

      // Remove the worktree directory
      await rm(worktreePath, { recursive: true, force: true })

      // Remove the metadata file
      await rm(join(this.metadataPath, entry), { force: true })

      if (projectDir) {
        // Prune stale worktree entries from git
        try {
          await execFileAsync('git', ['worktree', 'prune'], {
            cwd: projectDir,
          })
        } catch {
          // Best effort
        }

        // Delete the orphan branch
        try {
          await execFileAsync('git', ['branch', '-D', '--', branch], {
            cwd: projectDir,
          })
        } catch {
          // Branch may already be gone
        }
      }
    }
  }
}
