// scripts/test-github-policy.ts
//
// Tests GitHub remote detection, policy building, and state file I/O.
//
// Usage: npx tsx scripts/test-github-policy.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { POLICY_DIR } from "../src/main/sandbox.js";
import {
  detectGitHubRepo,
  parseGitHubRemoteUrl,
  buildSessionPolicy,
  policyStatePath,
  writePolicyState,
  readPolicyState,
  cleanupPolicyState,
} from "../src/main/github-policy.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn())
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err}`);
      failed++;
    });
}

console.log("=== GitHub Policy Tests ===\n");

// --- URL Parsing ---

console.log("URL parsing:");

await test("HTTPS with .git", () => {
  assert.equal(parseGitHubRemoteUrl("https://github.com/owner/repo.git"), "owner/repo");
});

await test("HTTPS without .git", () => {
  assert.equal(parseGitHubRemoteUrl("https://github.com/owner/repo"), "owner/repo");
});

await test("SSH shorthand with .git", () => {
  assert.equal(parseGitHubRemoteUrl("git@github.com:owner/repo.git"), "owner/repo");
});

await test("SSH shorthand without .git", () => {
  assert.equal(parseGitHubRemoteUrl("git@github.com:owner/repo"), "owner/repo");
});

await test("SSH URL with .git", () => {
  assert.equal(parseGitHubRemoteUrl("ssh://git@github.com/owner/repo.git"), "owner/repo");
});

await test("SSH URL without .git", () => {
  assert.equal(parseGitHubRemoteUrl("ssh://git@github.com/owner/repo"), "owner/repo");
});

await test("Non-GitHub HTTPS returns null", () => {
  assert.equal(parseGitHubRemoteUrl("https://gitlab.com/owner/repo.git"), null);
});

await test("Non-GitHub SSH returns null", () => {
  assert.equal(parseGitHubRemoteUrl("git@gitlab.com:owner/repo.git"), null);
});

await test("Empty string returns null", () => {
  assert.equal(parseGitHubRemoteUrl(""), null);
});

// --- Live remote detection ---

console.log("\nRemote detection:");

await test("detects GitHub repo from this repo", async () => {
  const repo = await detectGitHubRepo(process.cwd());
  console.log(`    detected: ${repo}`);
  assert.ok(repo !== null, "should detect a GitHub remote");
  assert.ok(repo!.includes("/"), "should be owner/repo format");
});

await test("returns null for non-git directory", async () => {
  const repo = await detectGitHubRepo("/tmp");
  assert.equal(repo, null);
});

// --- buildSessionPolicy ---

console.log("\nbuildSessionPolicy:");

await test("builds policy with correct defaults", () => {
  const policy = buildSessionPolicy("owner/repo", "feature-branch");
  assert.equal(policy.repo, "owner/repo");
  assert.deepEqual(policy.allowedPushRefs, ["feature-branch"]);
  assert.equal(policy.ownedPrNumber, null);
  assert.equal(policy.canCreatePr, true);
});

// --- State file round-trip ---

console.log("\nState file I/O:");

const testSessionId = `test-github-policy-${Date.now()}`;

// Ensure policy dir exists
if (!existsSync(POLICY_DIR)) {
  await mkdir(POLICY_DIR, { recursive: true });
}

await test("write and read round-trip", async () => {
  const policy = buildSessionPolicy("dherman/bouncer", "my-branch");
  await writePolicyState(testSessionId, policy);

  const loaded = await readPolicyState(policyStatePath(testSessionId));
  assert.deepEqual(loaded, policy);
});

await test("cleanup removes the file", async () => {
  await cleanupPolicyState(testSessionId);
  assert.ok(!existsSync(policyStatePath(testSessionId)), "file should be removed");
});

await test("cleanup is idempotent (no error on missing file)", async () => {
  await cleanupPolicyState(testSessionId); // already cleaned up
});

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
