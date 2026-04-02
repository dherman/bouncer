import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type {
  AgentType,
  GitHubPolicy,
  SandboxBackend,
  WorkspacePhase,
} from './types.js';

const WORKSPACES_DIR = join(app.getPath('userData'), 'workspaces');

export interface PersistedWorkspace {
  id: string;
  repositoryId: string | null;
  acpSessionId: string;
  projectDir: string;
  agentType: AgentType;
  sandboxBackend: SandboxBackend;
  worktreePath: string | null;
  worktreeGitCommonDir: string | null;
  worktreeBranch: string | null;
  policyId: string | null;
  containerImage: string | null;
  githubPolicy: GitHubPolicy | null;
  phase: WorkspacePhase | null;
  prUrl: string | null;
  promptCount: number;
}

export async function persistWorkspace(ws: PersistedWorkspace): Promise<void> {
  await mkdir(WORKSPACES_DIR, { recursive: true });
  const filePath = join(WORKSPACES_DIR, `${ws.id}.json`);
  await writeFile(filePath, JSON.stringify(ws, null, 2), 'utf-8');
}

export async function loadPersistedWorkspaces(): Promise<PersistedWorkspace[]> {
  let entries: string[];
  try {
    entries = await readdir(WORKSPACES_DIR);
  } catch {
    return [];
  }
  const workspaces: PersistedWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('-messages.jsonl')) continue;
    try {
      const data = await readFile(join(WORKSPACES_DIR, entry), 'utf-8');
      workspaces.push(JSON.parse(data) as PersistedWorkspace);
    } catch {
      // Skip corrupt files
    }
  }
  return workspaces;
}

export async function removePersistedWorkspace(id: string): Promise<void> {
  await rm(join(WORKSPACES_DIR, `${id}.json`), { force: true });
}
