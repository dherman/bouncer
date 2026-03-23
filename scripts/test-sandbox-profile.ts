// scripts/test-sandbox-profile.ts
//
// Generates a sandbox profile and validates it against real sandbox-exec.
//
// Usage: npx tsx scripts/test-sandbox-profile.ts [project-dir]
//
// Defaults to the current directory as the "worktree" path.

import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import {
  defaultPolicy,
  generateProfile,
  writePolicyToDisk,
} from "../src/main/sandbox-profile.js";

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

console.log("=== Sandbox Profile Generator Test ===\n");

// 1. Generate policy and profile
console.log(`Worktree path: ${worktreePath}`);
const policy = defaultPolicy({
  worktreePath,
  homedir: homedir(),
  tmpdir: tmpdir(),
  sessionId,
});
console.log(`Policy: ${policy.writablePaths.length} writable, ${policy.readOnlyPaths.length} read-only, network=${policy.allowNetwork}`);

const profile = generateProfile(policy);
console.log(`\n--- Generated SBPL (${profile.length} chars) ---`);
console.log(profile);
console.log("--- End SBPL ---");

// 2. Write to disk
const profilePath = await writePolicyToDisk(sessionId, profile);
console.log(`Profile written to: ${profilePath}\n`);

// 3. Validate with sandbox-exec
console.log("--- Validation Tests ---\n");

// Test 1: ls the worktree (should succeed)
try {
  const { stdout } = await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/bin/ls", worktreePath],
  );
  pass(`ls worktree: ${stdout.trim().split("\n").length} entries`);
} catch (err: any) {
  fail(`ls worktree FAILED: ${err.message}`);
}

// Test 2: write to worktree (should succeed)
const testFile = `${worktreePath}/.sandbox-test-${sessionId}`;
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/touch", testFile],
  );
  pass("touch in worktree succeeded");
  await rm(testFile, { force: true });
} catch (err: any) {
  fail(`touch in worktree FAILED: ${err.message}`);
}

// Test 3: write outside worktree (should fail)
const badFile = `/tmp/.sandbox-test-bad-${sessionId}`;
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/touch", badFile],
  );
  fail("touch in /tmp succeeded (should have been blocked)");
  await rm(badFile, { force: true });
} catch {
  pass("touch in /tmp blocked (expected)");
}

// Test 4: read system binary (should succeed)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/which", "git"],
  );
  pass("which git succeeded");
} catch (err: any) {
  fail(`which git FAILED: ${err.message}`);
}

// Test 5: read home directory listing (should fail — ~ not broadly readable)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/bin/ls", homedir()],
  );
  fail("ls ~ succeeded (should have been restricted)");
} catch {
  pass("ls ~ blocked (expected — home dir not broadly readable)");
}

// Test 6: network (should fail)
try {
  await execFileAsync(
    "/usr/bin/sandbox-exec",
    ["-f", profilePath, "/usr/bin/curl", "-s", "--max-time", "2", "https://example.com"],
    { timeout: 5000 },
  );
  fail("curl succeeded (should have been blocked)");
} catch {
  pass("curl blocked (expected — network denied)");
}

// Clean up profile
await rm(profilePath, { force: true });

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exitCode = 1;
}
console.log("\n=== Done ===");
