// scripts/test-app-layer-policy.ts
//
// Integration test for the application-layer policy lifecycle.
// Exercises the full flow: detect repo → build policy → write state →
// install shim → install hooks → verify artifacts → cleanup.
//
// Does NOT require Electron — tests the helper functions directly.
//
// Usage: npx tsx scripts/test-app-layer-policy.ts

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  detectGitHubRepo,
  buildSessionPolicy,
  writePolicyState,
  readPolicyState,
  policyStatePath,
  cleanupPolicyState,
  installGhShim,
  cleanupGhShim,
  shimBinDir,
  findRealGh,
  cleanupOrphanGitHubArtifacts,
} from "../src/main/github-policy.js";
import {
  installHooks,
  cleanupHooks,
  hooksDir,
  allowedRefsPath,
} from "../src/main/hooks.js";
import { POLICY_DIR } from "../src/main/sandbox.js";

const execFileAsync = promisify(execFile);

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

// --- Test helpers ---

interface TestRepo {
  bareDir: string;
  mainDir: string;
  worktreeDir: string;
  branch: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const baseDir = await mkdtemp(join(tmpdir(), "bouncer-app-layer-test-"));
  const bareDir = join(baseDir, "bare.git");
  const mainDir = join(baseDir, "main");
  const worktreeDir = join(baseDir, "worktree");
  const branch = "bouncer/test-session";

  // Create a bare repo as the push target
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bareDir]);

  // Clone it and set up for testing
  await execFileAsync("git", ["clone", bareDir, mainDir]);
  await execFileAsync("git", ["-C", mainDir, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", mainDir, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", mainDir, "checkout", "-b", "main"]);
  await execFileAsync("git", ["-C", mainDir, "commit", "--allow-empty", "-m", "init"]);
  await execFileAsync("git", ["-C", mainDir, "push", "-u", "origin", "main"]);

  // Create worktree
  await execFileAsync("git", ["-C", mainDir, "worktree", "add", "-b", branch, worktreeDir]);

  // Add a "local" remote for actual pushes (shared across all worktrees).
  // Then repoint origin to a GitHub URL so detectGitHubRepo works.
  await execFileAsync("git", ["-C", mainDir, "remote", "add", "local", bareDir]);
  await execFileAsync("git", ["-C", mainDir, "remote", "set-url", "origin", "https://github.com/test-owner/test-repo.git"]);

  return { bareDir, mainDir, worktreeDir, branch };
}

async function cleanupTestRepo(repo: TestRepo): Promise<void> {
  try {
    await execFileAsync("git", ["-C", repo.mainDir, "worktree", "remove", "--force", repo.worktreeDir]);
  } catch { /* may be gone */ }
  await rm(join(repo.bareDir, ".."), { recursive: true, force: true });
}

// ==========================================================
// Tests
// ==========================================================

console.log("=== Application-Layer Policy Integration Tests ===\n");

const sessionId = `test-app-layer-${Date.now()}`;
let repo: TestRepo;

// --- Setup ---

console.log("Setup:");

await test("create test repo with GitHub remote", async () => {
  repo = await createTestRepo();
  assert.ok(existsSync(repo.worktreeDir));
});

// --- Full lifecycle ---

console.log("\nPolicy lifecycle:");

await test("detect GitHub repo from worktree", async () => {
  const detected = await detectGitHubRepo(repo.worktreeDir);
  assert.equal(detected, "test-owner/test-repo");
});

await test("build and write policy state", async () => {
  const policy = buildSessionPolicy("test-owner/test-repo", repo.branch);
  assert.equal(policy.repo, "test-owner/test-repo");
  assert.deepEqual(policy.allowedPushRefs, [repo.branch]);
  assert.equal(policy.canCreatePr, true);
  assert.equal(policy.ownedPrNumber, null);

  await writePolicyState(sessionId, policy);
  assert.ok(existsSync(policyStatePath(sessionId)));

  const loaded = await readPolicyState(policyStatePath(sessionId));
  assert.deepEqual(loaded, policy);
});

await test("install gh shim", async () => {
  const ghShimTs = join(process.cwd(), "src", "main", "gh-shim.ts");
  const dir = await installGhShim(sessionId, ghShimTs, process.execPath);

  assert.equal(dir, shimBinDir(sessionId));
  assert.ok(existsSync(join(dir, "gh")), "gh shim should exist");

  // Verify it's executable
  const stats = statSync(join(dir, "gh"));
  assert.ok(stats.mode & 0o111, "gh shim should be executable");

  // Verify it references the right paths
  const content = await readFile(join(dir, "gh"), "utf-8");
  assert.ok(content.includes("gh-shim-bundle.js"), "should reference the bundled shim");
});

await test("install hooks", async () => {
  await installHooks(sessionId, repo.worktreeDir, [repo.branch]);

  assert.ok(existsSync(hooksDir(sessionId)), "hooks dir should exist");
  assert.ok(existsSync(allowedRefsPath(sessionId)), "allowed-refs should exist");

  const { stdout } = await execFileAsync("git", ["-C", repo.worktreeDir, "config", "core.hooksPath"]);
  assert.equal(stdout.trim(), hooksDir(sessionId));
});

console.log("\nArtifact verification:");

await test("all artifacts exist", async () => {
  assert.ok(existsSync(policyStatePath(sessionId)), "policy state file");
  assert.ok(existsSync(shimBinDir(sessionId)), "shim bin dir");
  assert.ok(existsSync(join(shimBinDir(sessionId), "gh")), "gh shim script");
  assert.ok(existsSync(hooksDir(sessionId)), "hooks dir");
  assert.ok(existsSync(join(hooksDir(sessionId), "pre-push")), "pre-push hook");
  assert.ok(existsSync(allowedRefsPath(sessionId)), "allowed-refs file");
});

await test("push to allowed ref works through hooks", async () => {
  await execFileAsync("git", ["-C", repo.worktreeDir, "commit", "--allow-empty", "-m", "test"]);
  // Push to the local bare remote (origin points to GitHub and would need auth)
  await execFileAsync("git", ["-C", repo.worktreeDir, "push", "local", repo.branch]);
});

await test("push to denied ref blocked by hooks", async () => {
  try {
    await execFileAsync("git", ["-C", repo.worktreeDir, "push", "local", "HEAD:refs/heads/unauthorized"]);
    assert.fail("should have been denied");
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    assert.ok(stderr.includes("[bouncer:git] DENY"));
  }
});

// --- Cleanup ---

console.log("\nCleanup:");

await test("cleanup hooks", async () => {
  await cleanupHooks(sessionId, repo.worktreeDir);
  assert.ok(!existsSync(hooksDir(sessionId)));
  assert.ok(!existsSync(allowedRefsPath(sessionId)));
});

await test("cleanup policy state", async () => {
  await cleanupPolicyState(sessionId);
  assert.ok(!existsSync(policyStatePath(sessionId)));
});

await test("cleanup gh shim", async () => {
  await cleanupGhShim(sessionId);
  assert.ok(!existsSync(shimBinDir(sessionId)));
});

await test("all artifacts removed", async () => {
  assert.ok(!existsSync(policyStatePath(sessionId)));
  assert.ok(!existsSync(shimBinDir(sessionId)));
  assert.ok(!existsSync(hooksDir(sessionId)));
  assert.ok(!existsSync(allowedRefsPath(sessionId)));
});

// --- Orphan cleanup ---

console.log("\nOrphan cleanup:");

const orphanId = `orphan-${Date.now()}`;

await test("orphan artifacts are cleaned up", async () => {
  // Create artifacts for a fake session
  await writePolicyState(orphanId, buildSessionPolicy("owner/repo", "branch"));
  await installGhShim(orphanId, "/fake/path.ts", "/fake/node");
  assert.ok(existsSync(policyStatePath(orphanId)));
  assert.ok(existsSync(shimBinDir(orphanId)));

  // Clean up orphans (orphanId not in active set)
  await cleanupOrphanGitHubArtifacts(new Set());
  assert.ok(!existsSync(policyStatePath(orphanId)), "orphan policy state should be removed");
  assert.ok(!existsSync(shimBinDir(orphanId)), "orphan shim bin should be removed");
});

// --- findRealGh ---

console.log("\ngh detection:");

await test("findRealGh returns a path or null", async () => {
  const ghPath = await findRealGh();
  if (ghPath === null) {
    console.log("    (gh not installed — returned null as expected)");
  } else {
    assert.ok(ghPath.length > 0);
    assert.ok(ghPath.includes("gh"));
  }
});

// --- Teardown ---

await cleanupTestRepo(repo!);

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
