// scripts/test-hooks.ts
//
// Tests git hook installation, ref enforcement, and cleanup.
// Creates temporary git repos to test the pre-push hook end-to-end.
//
// Usage: npx tsx scripts/test-hooks.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  hooksDir,
  allowedRefsPath,
  generatePrePushHook,
  installHooks,
  cleanupHooks,
} from "../src/main/hooks.js";

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

// --- Helper to create a test git repo with a remote and worktree ---

interface TestRepo {
  bareDir: string;
  mainDir: string;
  worktreeDir: string;
  worktreeBranch: string;
}

async function createTestRepo(): Promise<TestRepo> {
  const baseDir = await mkdtemp(join(tmpdir(), "bouncer-hooks-test-"));
  const bareDir = join(baseDir, "bare.git");
  const mainDir = join(baseDir, "main");
  const worktreeDir = join(baseDir, "worktree");
  const worktreeBranch = "bouncer/test-branch";

  // Create a bare remote repo with explicit default branch
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bareDir]);

  // Clone it to create a main working copy
  await execFileAsync("git", ["clone", bareDir, mainDir]);
  await execFileAsync("git", ["-C", mainDir, "config", "user.email", "test@test.com"]);
  await execFileAsync("git", ["-C", mainDir, "config", "user.name", "Test"]);

  // Create an initial commit and push to establish the main branch
  await execFileAsync("git", ["-C", mainDir, "checkout", "-b", "main"]);
  await execFileAsync("git", ["-C", mainDir, "commit", "--allow-empty", "-m", "init"]);
  await execFileAsync("git", ["-C", mainDir, "push", "-u", "origin", "main"]);

  // Create a worktree on the test branch
  await execFileAsync("git", ["-C", mainDir, "worktree", "add", "-b", worktreeBranch, worktreeDir]);

  return { bareDir, mainDir, worktreeDir, worktreeBranch };
}

async function cleanupTestRepo(repo: TestRepo): Promise<void> {
  // Remove worktree first, then the rest
  try {
    await execFileAsync("git", ["-C", repo.mainDir, "worktree", "remove", "--force", repo.worktreeDir]);
  } catch {
    // May already be gone
  }
  await rm(join(repo.bareDir, ".."), { recursive: true, force: true });
}

// ==========================================================
// Tests
// ==========================================================

console.log("=== Git Hooks Tests ===\n");

// --- Unit tests (no repo needed) ---

console.log("Hook generation:");

await test("hooksDir returns expected path", () => {
  const dir = hooksDir("test-session");
  assert.ok(dir.includes("test-session-hooks"));
});

await test("allowedRefsPath returns expected path", () => {
  const p = allowedRefsPath("test-session");
  assert.ok(p.includes("test-session-allowed-refs.txt"));
});

await test("generatePrePushHook contains the refs file path", () => {
  const script = generatePrePushHook("/tmp/test-refs.txt");
  assert.ok(script.includes("/tmp/test-refs.txt"));
  assert.ok(script.startsWith("#!/bin/bash"));
  assert.ok(script.includes("[bouncer:git]"));
});

// --- Integration tests (real git repos) ---

console.log("\nHook installation:");

const sessionId = `test-hooks-${Date.now()}`;
let repo: TestRepo;

await test("create test repo with worktree", async () => {
  repo = await createTestRepo();
  assert.ok(existsSync(repo.worktreeDir));
  // Verify the worktree branch exists
  const { stdout } = await execFileAsync("git", ["-C", repo.worktreeDir, "branch", "--show-current"]);
  assert.equal(stdout.trim(), repo.worktreeBranch);
});

await test("installHooks creates hook file and sets core.hooksPath", async () => {
  await installHooks(sessionId, repo.worktreeDir, [repo.worktreeBranch]);

  // Verify hook file exists and is executable
  const hookPath = join(hooksDir(sessionId), "pre-push");
  assert.ok(existsSync(hookPath), "pre-push hook should exist");

  const hookContent = await readFile(hookPath, "utf-8");
  assert.ok(hookContent.includes("#!/bin/bash"), "hook should be a bash script");

  // Verify allowed-refs file
  const refsContent = await readFile(allowedRefsPath(sessionId), "utf-8");
  assert.ok(refsContent.includes(repo.worktreeBranch), "allowed-refs should contain the branch");

  // Verify core.hooksPath is set
  const { stdout } = await execFileAsync("git", ["-C", repo.worktreeDir, "config", "core.hooksPath"]);
  assert.equal(stdout.trim(), hooksDir(sessionId));
});

console.log("\nHook enforcement:");

await test("push to allowed ref succeeds", async () => {
  // Create a commit in the worktree and push
  await execFileAsync("git", ["-C", repo.worktreeDir, "commit", "--allow-empty", "-m", "test commit"]);
  await execFileAsync("git", ["-C", repo.worktreeDir, "push", "origin", repo.worktreeBranch]);
  // If we get here without error, the push succeeded through the hook
});

await test("push to denied ref fails", async () => {
  // Try to push to main (not in allowed refs)
  // First create a commit on a different branch in the worktree
  try {
    // Push current branch to a different remote ref — this should be denied
    await execFileAsync("git", [
      "-C", repo.worktreeDir, "push", "origin",
      `HEAD:refs/heads/unauthorized-branch`,
    ]);
    assert.fail("push to unauthorized branch should have been denied");
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    assert.ok(
      stderr.includes("[bouncer:git] DENY"),
      `expected bouncer denial message, got: ${stderr}`,
    );
  }
});

console.log("\nHook cleanup:");

await test("cleanupHooks removes hooks dir and unsets core.hooksPath", async () => {
  await cleanupHooks(sessionId, repo.worktreeDir);

  // Hooks directory should be gone
  assert.ok(!existsSync(hooksDir(sessionId)), "hooks dir should be removed");

  // Allowed refs file should be gone
  assert.ok(!existsSync(allowedRefsPath(sessionId)), "allowed-refs file should be removed");

  // core.hooksPath should be unset
  try {
    await execFileAsync("git", ["-C", repo.worktreeDir, "config", "core.hooksPath"]);
    assert.fail("core.hooksPath should be unset");
  } catch {
    // Expected — config key not found
  }
});

await test("cleanupHooks is idempotent", async () => {
  await cleanupHooks(sessionId, repo.worktreeDir);
});

await test("push works after hook cleanup", async () => {
  await execFileAsync("git", ["-C", repo.worktreeDir, "commit", "--allow-empty", "-m", "after cleanup"]);
  await execFileAsync("git", ["-C", repo.worktreeDir, "push", "origin", repo.worktreeBranch]);
});

// --- Cleanup ---

await cleanupTestRepo(repo!);

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
