import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ReplayToolCall } from './types.js';

interface DatasetRecord {
  id: number;
  tool: string;
  input: Record<string, unknown>;
  outcome: string;
  error_type?: string;
  project: string;
  session: string;
  is_subagent: boolean;
  permission_mode: string;
  timestamp_relative: number;
}

function toReplayToolCall(record: DatasetRecord): ReplayToolCall {
  return {
    id: record.id,
    tool: record.tool,
    input: record.input,
    original_outcome: record.outcome,
  };
}

/**
 * Load the dataset and group records by session.
 * Returns a Map from session ID to sorted tool-call array.
 */
export async function loadDataset(datasetPath: string): Promise<Map<string, ReplayToolCall[]>> {
  const sessions = new Map<string, { calls: ReplayToolCall[]; timestamps: number[] }>();

  const rl = createInterface({
    input: createReadStream(datasetPath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as DatasetRecord;
    let session = sessions.get(record.session);
    if (!session) {
      session = { calls: [], timestamps: [] };
      sessions.set(record.session, session);
    }
    session.calls.push(toReplayToolCall(record));
    session.timestamps.push(record.timestamp_relative);
  }

  // Sort each session's tool calls by timestamp_relative
  const result = new Map<string, ReplayToolCall[]>();
  for (const [sessionId, { calls, timestamps }] of sessions) {
    const indices = calls.map((_, i) => i);
    indices.sort((a, b) => timestamps[a] - timestamps[b]);
    result.set(
      sessionId,
      indices.map((i) => calls[i]),
    );
  }

  return result;
}

/**
 * Load a single session's tool calls from the dataset.
 * Streams the file and only keeps matching records — avoids loading
 * the entire dataset into memory.
 */
export async function loadSession(
  datasetPath: string,
  sessionId: string,
): Promise<ReplayToolCall[]> {
  const calls: ReplayToolCall[] = [];
  const timestamps: number[] = [];

  const rl = createInterface({
    input: createReadStream(datasetPath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as DatasetRecord;
    if (record.session !== sessionId) continue;
    calls.push(toReplayToolCall(record));
    timestamps.push(record.timestamp_relative);
  }

  // Sort by timestamp_relative
  const indices = calls.map((_, i) => i);
  indices.sort((a, b) => timestamps[a] - timestamps[b]);
  return indices.map((i) => calls[i]);
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  callCount: number;
  tools: string[];
}

/**
 * List sessions with basic metadata.
 * Requires a second pass over the raw dataset to extract project info.
 */
export async function listSessions(datasetPath: string): Promise<SessionInfo[]> {
  const sessionMap = new Map<string, { project: string; callCount: number; tools: Set<string> }>();

  const rl = createInterface({
    input: createReadStream(datasetPath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as DatasetRecord;
    let info = sessionMap.get(record.session);
    if (!info) {
      info = { project: record.project, callCount: 0, tools: new Set() };
      sessionMap.set(record.session, info);
    }
    info.callCount++;
    info.tools.add(record.tool);
  }

  return Array.from(sessionMap.entries()).map(([sessionId, info]) => ({
    sessionId,
    project: info.project,
    callCount: info.callCount,
    tools: [...info.tools].sort(),
  }));
}

/**
 * Get summary statistics for the loaded dataset.
 */
export function datasetSummary(sessions: Map<string, ReplayToolCall[]>): {
  sessionCount: number;
  recordCount: number;
  toolDistribution: Record<string, number>;
} {
  let recordCount = 0;
  const toolDistribution: Record<string, number> = {};

  for (const calls of sessions.values()) {
    recordCount += calls.length;
    for (const call of calls) {
      toolDistribution[call.tool] = (toolDistribution[call.tool] ?? 0) + 1;
    }
  }

  return {
    sessionCount: sessions.size,
    recordCount,
    toolDistribution,
  };
}
