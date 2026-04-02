import { appendFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { Message } from './types.js';

function getWorkspacesDir(): string {
  return join(app.getPath('userData'), 'workspaces');
}

function messagesPath(workspaceId: string): string {
  return join(getWorkspacesDir(), `${workspaceId}-messages.jsonl`);
}

export async function appendMessage(workspaceId: string, message: Message): Promise<void> {
  await mkdir(getWorkspacesDir(), { recursive: true });
  await appendFile(messagesPath(workspaceId), JSON.stringify(message) + '\n', 'utf-8');
}

export async function loadMessages(workspaceId: string): Promise<Message[]> {
  let data: string;
  try {
    data = await readFile(messagesPath(workspaceId), 'utf-8');
  } catch {
    return [];
  }
  const messages: Message[] = [];
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      // Skip corrupt lines (e.g., truncated write from a crash)
    }
  }
  return messages;
}

export async function removeMessages(workspaceId: string): Promise<void> {
  await rm(messagesPath(workspaceId), { force: true });
}
