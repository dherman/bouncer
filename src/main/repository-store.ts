import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentType, Repository } from './types.js';

const execFile = promisify(execFileCb);

export class RepositoryStore {
  private repos: Repository[] = [];
  private configPath: string;

  constructor(configDir?: string) {
    const dir = configDir ?? join(homedir(), '.config', 'bouncer');
    this.configPath = join(dir, 'repositories.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.repos = parsed;
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // First run — no config file yet
        this.repos = [];
      } else {
        throw err;
      }
    }
  }

  private async save(): Promise<void> {
    const dir = join(this.configPath, '..');
    await mkdir(dir, { recursive: true });
    const json = JSON.stringify(this.repos, null, 2) + '\n';
    // Atomic write: write to temp file then rename
    const tmpPath = this.configPath + '.tmp';
    await writeFile(tmpPath, json, 'utf-8');
    await rename(tmpPath, this.configPath);
  }

  list(): Repository[] {
    return [...this.repos];
  }

  get(id: string): Repository | null {
    return this.repos.find((r) => r.id === id) ?? null;
  }

  async add(localPath: string): Promise<Repository> {
    // Validate: must be a git repo
    try {
      await execFile('git', ['-C', localPath, 'rev-parse', '--git-dir']);
    } catch {
      throw new Error(`Not a git repository: ${localPath}`);
    }

    // Check for duplicates
    if (this.repos.some((r) => r.localPath === localPath)) {
      throw new Error(`Repository already added: ${localPath}`);
    }

    // Auto-detect name from directory basename
    const name = localPath.split('/').pop() ?? localPath;

    // Auto-detect GitHub repo from origin remote
    let githubRepo: string | null = null;
    try {
      const { stdout } = await execFile('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
      githubRepo = parseGitHubRepo(stdout.trim());
    } catch {
      // No origin remote or not a GitHub repo — that's fine
    }

    const repo: Repository = {
      id: randomUUID(),
      name,
      localPath,
      githubRepo,
      defaultPolicyId: 'standard-pr',
      defaultAgentType: 'claude-code' as AgentType,
      createdAt: Date.now(),
    };

    this.repos.push(repo);
    await this.save();
    return repo;
  }

  async update(id: string, changes: Partial<Omit<Repository, 'id' | 'createdAt'>>): Promise<void> {
    const idx = this.repos.findIndex((r) => r.id === id);
    if (idx < 0) {
      throw new Error(`Repository not found: ${id}`);
    }
    this.repos[idx] = { ...this.repos[idx], ...changes };
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const idx = this.repos.findIndex((r) => r.id === id);
    if (idx < 0) {
      throw new Error(`Repository not found: ${id}`);
    }
    this.repos.splice(idx, 1);
    await this.save();
  }
}

/**
 * Parse a GitHub owner/repo from a git remote URL.
 * Handles both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git).
 */
export function parseGitHubRepo(url: string): string | null {
  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS format: https://github.com/owner/repo.git
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'github.com') {
      const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
      if (path.includes('/')) return path;
    }
  } catch {
    // Not a valid URL
  }

  return null;
}
