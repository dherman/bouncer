/**
 * Test harness for the dataset loader.
 *
 * Loads the full dataset, verifies session count, record count,
 * and sorting within sessions.
 *
 * Usage: npx tsx scripts/test-dataset-loader.ts
 */
import { join } from "node:path";
import { loadDataset, loadSession, datasetSummary, listSessions } from "../src/main/dataset-loader.js";

const datasetPath = join(process.cwd(), "data", "tool-use-dataset.jsonl");

let exitCode = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    console.error(`✗ ${label}`);
    exitCode = 1;
  }
}

try {
  // Load dataset
  console.log("Loading dataset...");
  const sessions = await loadDataset(datasetPath);
  const summary = datasetSummary(sessions);

  console.log(`Sessions: ${summary.sessionCount}`);
  console.log(`Records: ${summary.recordCount}`);
  console.log(`Tools: ${JSON.stringify(summary.toolDistribution)}`);

  // Verify expected counts
  check("Session count is 296", summary.sessionCount === 296);
  check("Record count is 11491", summary.recordCount === 11491);

  // Verify all sessions have at least one call
  let emptyCount = 0;
  for (const [, calls] of sessions) {
    if (calls.length === 0) emptyCount++;
  }
  check("No empty sessions", emptyCount === 0);

  // Verify tool distribution has expected tools
  const expectedTools = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];
  for (const tool of expectedTools) {
    check(`Tool "${tool}" present in distribution`, tool in summary.toolDistribution);
  }

  // Test listSessions
  console.log("\nTesting listSessions...");
  const list = await listSessions(datasetPath);
  check("listSessions count matches", list.length === summary.sessionCount);
  check("listSessions entries have callCount > 0", list.every((s) => s.callCount > 0));
  check("listSessions entries have tools", list.every((s) => s.tools.length > 0));
  check("listSessions entries have project", list.every((s) => s.project.length > 0));

  // Print a few examples
  console.log(`\nFirst 3 sessions:`);
  for (const s of list.slice(0, 3)) {
    console.log(`  ${s.sessionId} (${s.project}): ${s.callCount} calls, tools: ${s.tools.join(", ")}`);
  }

  // Test loadSession
  console.log("\nTesting loadSession...");
  const testSessionId = list[0].sessionId;
  const sessionCalls = await loadSession(datasetPath, testSessionId);
  check("loadSession returns non-empty", sessionCalls.length > 0);
  check("loadSession count matches listSessions", sessionCalls.length === list[0].callCount);

  const unknownCalls = await loadSession(datasetPath, "nonexistent-session");
  check("loadSession returns empty for unknown session", unknownCalls.length === 0);
} catch (err) {
  console.error("Error:", err);
  exitCode = 1;
}

process.exitCode = exitCode;
