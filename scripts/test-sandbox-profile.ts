// scripts/test-sandbox-profile.ts
//
// Tests the sandbox integration via agent-safehouse.
//
// Usage: npx tsx scripts/test-sandbox-profile.ts [project-dir]
//
// Prerequisites: `safehouse` must be on PATH
//   brew install eugene1g/safehouse/agent-safehouse
//
// Defaults to the current directory as the "worktree" path.

import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import {
  defaultSandboxConfig,
  buildSafehouseArgs,
  isSafehouseAvailable,
  ensurePolicyDir,
  cleanupPolicy,
} from "../src/main/sandbox.js";

const execFileAsync = promisify(execFile);
const worktreePath = process.argv[2] || process.cwd();
const sessionId = randomUUID();

let passed = 0;
let failed = 0;

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
  passed++;
}
function fail(msg: string) {
  console.log(`  ✗ ${msg}`);
  failed++;
}

console.log("=== Sandbox Integration Test (agent-safehouse) ===\n");

// Check safehouse availability
const available = await isSafehouseAvailable();
if (!available) {
  console.log("safehouse CLI not found on PATH.");
  console.log("Install: brew install eugene1g/safehouse/agent-safehouse");
  process.exit(1);
}
pass("safehouse CLI available");

// Build config
const config = defaultSandboxConfig({
  sessionId,
  worktreePath,
});
console.log(`\nWorktree: ${worktreePath}`);
console.log(`Policy output: ${config.policyOutputPath}`);
console.log(`Writable dirs: ${config.writableDirs.join(", ")}`);
console.log(`Env passthrough: ${config.envPassthrough.join(", ")}`);

// Build args for a simple ls command
const args = buildSafehouseArgs(config, ["/bin/ls", worktreePath]);
console.log(`\nSafehouse args: safehouse ${args.join(" ")}`);

// Ensure policy dir exists
await ensurePolicyDir();

// Test 1: Generate policy and run ls in worktree (should succeed)
console.log("\n--- Validation Tests ---\n");
try {
  const { stdout } = await execFileAsync("safehouse", args);
  const lines = stdout.trim().split("\n").filter(Boolean);
  pass(`ls worktree via safehouse: ${lines.length} entries`);
} catch (err: any) {
  fail(`ls worktree FAILED: ${err.stderr || err.message}`);
}

// Test 2: Inspect the generated policy file
try {
  const policy = await readFile(config.policyOutputPath, "utf-8");
  const ruleCount = (policy.match(/^\(allow /gm) || []).length;
  const denyCount = (policy.match(/^\(deny /gm) || []).length;
  pass(`policy file generated: ${policy.length} chars, ${ruleCount} allow rules, ${denyCount} deny rules`);
} catch (err: any) {
  fail(`policy file not found: ${err.message}`);
}

// Test 3: Write to worktree (should succeed)
const testFile = `${worktreePath}/.sandbox-test-${sessionId}`;
const writeArgs = buildSafehouseArgs(config, ["/usr/bin/touch", testFile]);
try {
  await execFileAsync("safehouse", writeArgs);
  pass("touch in worktree succeeded");
  await rm(testFile, { force: true });
} catch (err: any) {
  fail(`touch in worktree FAILED: ${err.stderr || err.message}`);
}

// Test 4: Write to home directory (should fail)
const badFile = `${homedir()}/.sandbox-test-bad-${sessionId}`;
const badArgs = buildSafehouseArgs(config, ["/usr/bin/touch", badFile]);
try {
  await execFileAsync("safehouse", badArgs);
  fail("touch in ~ succeeded (should have been blocked)");
  await rm(badFile, { force: true });
} catch {
  pass("touch in ~ blocked (expected)");
}

// Test 5: System binary access (should succeed)
const whichArgs = buildSafehouseArgs(config, ["/usr/bin/which", "git"]);
try {
  await execFileAsync("safehouse", whichArgs);
  pass("which git succeeded");
} catch (err: any) {
  fail(`which git FAILED: ${err.stderr || err.message}`);
}

// Test 6: Stdio piping works (critical for ACP)
try {
  const result = await new Promise<string>((resolve, reject) => {
    const echoArgs = buildSafehouseArgs(config, ["/bin/echo", "hello-acp"]);
    const proc = spawn("safehouse", echoArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exit ${code}`));
    });
    proc.on("error", reject);
  });
  if (result === "hello-acp") {
    pass("stdio piping works (critical for ACP JSON-RPC)");
  } else {
    fail(`stdio piping returned unexpected output: "${result}"`);
  }
} catch (err: any) {
  fail(`stdio piping FAILED: ${err.message}`);
}

// Clean up
await cleanupPolicy(config.policyOutputPath);

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exitCode = 1;
}
console.log("\n=== Done ===");
