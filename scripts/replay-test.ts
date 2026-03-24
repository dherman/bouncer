/**
 * Replay test harness — single-session mode.
 *
 * Loads a dataset session, scaffolds a worktree, spawns the replay agent
 * (optionally sandboxed), and produces a ReplayReport JSON.
 *
 * Usage: npx tsx scripts/replay-test.ts [options]
 *
 * Options:
 *   --policy <id>        Policy template ID (default: standard-pr)
 *   --session <id>       Session ID to replay (default: first in dataset)
 *   --project-dir <dir>  Git repo for worktree creation (default: .)
 *   --dataset <path>     Dataset JSONL path (default: data/tool-use-dataset.jsonl)
 *   --output <path>      Output file for JSON report (default: stdout)
 *   --no-sandbox         Run without safehouse sandbox
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { loadDataset } from "../src/main/dataset-loader.js";
import { buildScaffoldPlan, applyScaffold } from "../src/main/replay-scaffold.js";
import { WorktreeManager } from "../src/main/worktree-manager.js";
import { PolicyTemplateRegistry } from "../src/main/policy-registry.js";
import { policyToSandboxConfig } from "../src/main/policy-sandbox.js";
import {
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  writeAppendProfile,
  cleanupPolicy,
} from "../src/main/sandbox.js";
import type { ReplayToolCall, ReplayResult } from "../src/main/types.js";

// --- CLI arg parsing ---

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts = {
    policy: "standard-pr",
    session: "",
    projectDir: process.cwd(),
    dataset: join(process.cwd(), "data", "tool-use-dataset.jsonl"),
    output: "",
    noSandbox: false,
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = (): string => {
      if (i + 1 >= args.length) {
        console.error(`Missing value for ${flag}`);
        process.exit(1);
      }
      return args[++i];
    };
    switch (flag) {
      case "--policy": opts.policy = next(); break;
      case "--session": opts.session = next(); break;
      case "--project-dir": opts.projectDir = next(); break;
      case "--dataset": opts.dataset = next(); break;
      case "--output": opts.output = next(); break;
      case "--no-sandbox": opts.noSandbox = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  return opts;
}

// --- De-anonymization ---

function getSafeUsername(): string {
  try { return userInfo().username; } catch { return process.env.USER || process.env.USERNAME || "unknown"; }
}

function makeDeanonymize(worktreePath: string) {
  const home = homedir();
  const user = getSafeUsername();
  return (path: string) =>
    path
      .replace(/\{project\}/g, worktreePath)
      .replace(/\{home\}/g, home)
      .replace(/\{user\}/g, user);
}

// --- Report types ---

interface SessionReplayResult {
  sessionId: string;
  toolCallCount: number;
  results: ReplayResult[];
  scaffoldedFiles: number;
  replayDurationMs: number;
}

interface ReplayReport {
  metadata: {
    timestamp: string;
    dataset: string;
    policyId: string;
    sessionsTotal: number;
    sessionsCompleted: number;
    sessionsFailed: number;
  };
  summary: {
    totalToolCalls: number;
    allowed: number;
    blocked: number;
    skipped: number;
    error: number;
    allowedRate: number;
    falseBlockRate: number;
  };
  byTool: Record<string, { allowed: number; blocked: number; skipped: number; error: number }>;
  sessions: SessionReplayResult[];
}

function computeByToolBreakdown(
  results: ReplayResult[],
): Record<string, { allowed: number; blocked: number; skipped: number; error: number }> {
  const byTool: Record<string, { allowed: number; blocked: number; skipped: number; error: number }> = {};
  for (const r of results) {
    if (!byTool[r.tool]) {
      byTool[r.tool] = { allowed: 0, blocked: 0, skipped: 0, error: 0 };
    }
    byTool[r.tool][r.replay_outcome]++;
  }
  return byTool;
}

function buildReport(
  policyId: string,
  sessionResults: SessionReplayResult[],
  datasetPath: string,
): ReplayReport {
  const allResults = sessionResults.flatMap((s) => s.results);
  const allowed = allResults.filter((r) => r.replay_outcome === "allowed").length;
  const blocked = allResults.filter((r) => r.replay_outcome === "blocked").length;
  const skipped = allResults.filter((r) => r.replay_outcome === "skipped").length;
  const error = allResults.filter((r) => r.replay_outcome === "error").length;

  const falseBlocks = allResults.filter(
    (r) => r.replay_outcome === "blocked" && r.original_outcome === "approved",
  ).length;
  const actionable = allowed + blocked;

  return {
    metadata: {
      timestamp: new Date().toISOString(),
      dataset: datasetPath,
      policyId,
      sessionsTotal: sessionResults.length,
      sessionsCompleted: sessionResults.filter((s) => s.results.length > 0).length,
      sessionsFailed: sessionResults.filter((s) => s.results.length === 0).length,
    },
    summary: {
      totalToolCalls: allResults.length,
      allowed,
      blocked,
      skipped,
      error,
      allowedRate: actionable > 0 ? allowed / actionable : 1,
      falseBlockRate: allowed + falseBlocks > 0 ? falseBlocks / (allowed + falseBlocks) : 0,
    },
    byTool: computeByToolBreakdown(allResults),
    sessions: sessionResults,
  };
}

// --- Single-session replay ---

async function replaySession(
  sessionId: string,
  toolCalls: ReplayToolCall[],
  policyId: string,
  projectDir: string,
  noSandbox: boolean,
): Promise<SessionReplayResult> {
  const startTime = Date.now();
  const worktreeManager = new WorktreeManager();
  const wtId = randomUUID();
  const worktree = await worktreeManager.create(wtId, projectDir);

  let sandboxConfig: Awaited<ReturnType<typeof policyToSandboxConfig>> | null = null;
  let agentProcess: ReturnType<typeof spawn> | null = null;

  try {
    // Scaffold files
    const deanonymize = makeDeanonymize(worktree.path);
    const plan = buildScaffoldPlan(toolCalls, deanonymize, worktree.path);
    const scaffoldedFiles = await applyScaffold(worktree.path, plan);
    process.stderr.write(`  Scaffolded ${scaffoldedFiles} files\n`);

    // Build sandbox config
    const safehouseAvailable = await isSafehouseAvailable();
    if (!noSandbox && safehouseAvailable) {
      const registry = new PolicyTemplateRegistry();
      const template = registry.get(policyId);
      await ensurePolicyDir();
      sandboxConfig = policyToSandboxConfig(template, {
        sessionId: wtId,
        worktreePath: worktree.path,
        gitCommonDir: worktree.gitCommonDir,
      });
      await writeAppendProfile(sandboxConfig);
    } else if (!noSandbox) {
      process.stderr.write("  Warning: safehouse not available, running unsandboxed\n");
    }

    // Resolve replay agent spawn args
    const require = createRequire(import.meta.url);
    const tsxBin = require.resolve("tsx/cli");
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const agentScript = join(scriptDir, "..", "src", "agents", "replay-agent.ts");
    let cmd = process.execPath;
    let args = [tsxBin, agentScript];
    const env: Record<string, string> = {
      REPLAY_WORKTREE_PATH: worktree.path,
    };

    if (sandboxConfig) {
      const safehouseArgs = buildSafehouseArgs(sandboxConfig, [cmd, ...args]);
      cmd = "safehouse";
      args = safehouseArgs;
    }

    // Spawn agent
    agentProcess = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd: worktree.path,
    });

    agentProcess.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    // ACP connection
    const output = Writable.toWeb(agentProcess.stdin!) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(agentProcess.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const results: ReplayResult[] = [];

    const connection = new acp.ClientSideConnection(
      (_agent) => ({
        async sessionUpdate(params) {
          const update = params.update;
          if (update.sessionUpdate === "tool_call") {
            const meta = update._meta as { replay?: ReplayResult } | undefined;
            if (meta?.replay) {
              results.push(meta.replay);
            }
          }
        },
        async requestPermission(_params) {
          return { outcome: { outcome: "cancelled" as const } };
        },
      }),
      stream,
    );

    // ACP handshake
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const acpSession = await connection.newSession({
      cwd: worktree.path,
      mcpServers: [],
    });

    // Send tool calls
    await connection.prompt({
      sessionId: acpSession.sessionId,
      prompt: [{ type: "text", text: JSON.stringify(toolCalls) }],
    });

    return {
      sessionId,
      toolCallCount: toolCalls.length,
      results,
      scaffoldedFiles,
      replayDurationMs: Date.now() - startTime,
    };
  } finally {
    agentProcess?.kill();
    if (sandboxConfig) {
      await cleanupPolicy(sandboxConfig.policyOutputPath).catch(() => {});
    }
    await worktreeManager.remove(worktree);
  }
}

// --- Main ---

const opts = parseArgs(process.argv);

try {
  process.stderr.write(`Loading dataset: ${opts.dataset}\n`);
  const sessions = await loadDataset(opts.dataset);

  // Resolve session
  let sessionId = opts.session;
  if (!sessionId) {
    sessionId = sessions.keys().next().value!;
    process.stderr.write(`No --session specified, using first: ${sessionId}\n`);
  }

  const toolCalls = sessions.get(sessionId);
  if (!toolCalls) {
    console.error(`Session not found: ${sessionId}`);
    console.error(`Available sessions: ${[...sessions.keys()].slice(0, 10).join(", ")}...`);
    process.exit(1);
  }

  process.stderr.write(`Replaying ${sessionId} (${toolCalls.length} tool calls) with policy ${opts.policy}\n`);

  const result = await replaySession(
    sessionId,
    toolCalls,
    opts.policy,
    opts.projectDir,
    opts.noSandbox,
  );

  const report = buildReport(opts.policy, [result], opts.dataset);

  // Output report
  const reportJson = JSON.stringify(report, null, 2);
  if (opts.output) {
    writeFileSync(opts.output, reportJson, "utf-8");
    process.stderr.write(`Report written to ${opts.output}\n`);
  } else {
    console.log(reportJson);
  }

  // Print summary to stderr
  process.stderr.write(`\n--- Summary ---\n`);
  process.stderr.write(`Tool calls: ${report.summary.totalToolCalls}\n`);
  process.stderr.write(`Allowed: ${report.summary.allowed}, Blocked: ${report.summary.blocked}, Skipped: ${report.summary.skipped}, Error: ${report.summary.error}\n`);
  process.stderr.write(`Allowed rate: ${(report.summary.allowedRate * 100).toFixed(1)}%\n`);
  process.stderr.write(`False block rate: ${(report.summary.falseBlockRate * 100).toFixed(1)}%\n`);
  process.stderr.write(`Duration: ${result.replayDurationMs}ms\n`);
} catch (err) {
  console.error("Fatal:", err);
  process.exit(1);
}
