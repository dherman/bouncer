import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type {
  AgentType,
  GitHubPolicy,
  SandboxBackend,
  TopicSource,
  WorkspacePhase,
} from './types.js';

function getWorkspacesDir(): string {
  return join(app.getPath('userData'), 'workspaces');
}

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
  topic?: string | null;
  topicSource?: TopicSource;
  archived?: boolean;
}

export async function persistWorkspace(ws: PersistedWorkspace): Promise<void> {
  await mkdir(getWorkspacesDir(), { recursive: true });
  const filePath = join(getWorkspacesDir(), `${ws.id}.json`);
  await writeFile(filePath, JSON.stringify(ws, null, 2), 'utf-8');
}

export async function loadPersistedWorkspaces(): Promise<PersistedWorkspace[]> {
  let entries: string[];
  try {
    entries = await readdir(getWorkspacesDir());
  } catch {
    return [];
  }
  const workspaces: PersistedWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('-messages.jsonl')) continue;
    try {
      const data = await readFile(join(getWorkspacesDir(), entry), 'utf-8');
      workspaces.push(JSON.parse(data) as PersistedWorkspace);
    } catch {
      // Skip corrupt files
    }
  }
  return workspaces;
}

export async function removePersistedWorkspace(id: string): Promise<void> {
  await rm(join(getWorkspacesDir(), `${id}.json`), { force: true });
}
