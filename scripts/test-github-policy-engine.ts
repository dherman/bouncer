// scripts/test-github-policy-engine.ts
//
// Tests for the shared GitHub policy engine: evaluateGitHubRequest,
// parseGitReceivePack, and evaluateGitPush.
//
// Usage: npx tsx scripts/test-github-policy-engine.ts

import assert from "node:assert/strict";
import {
  evaluateGitHubRequest,
  parseGitReceivePack,
  evaluateGitPush,
  type RefUpdate,
} from "../src/main/github-policy-engine.js";
import type { GitHubPolicy } from "../src/main/types.js";

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

function makePolicy(overrides: Partial<GitHubPolicy> = {}): GitHubPolicy {
  return {
    repo: "owner/repo",
    allowedPushRefs: ["feature-branch"],
    ownedPrNumber: null,
    canCreatePr: true,
    ...overrides,
  };
}

// =========================================================================
// evaluateGitHubRequest
// =========================================================================

console.log("\ngithub-policy-engine tests\n");
console.log("  evaluateGitHubRequest:");

await test("GET /repos/owner/repo/pulls → allow", () => {
  const d = evaluateGitHubRequest("GET", "/repos/owner/repo/pulls", makePolicy());
  assert.equal(d.action, "allow");
});

await test("POST /repos/owner/repo/pulls (canCreatePr: true) → allow-and-capture-pr", () => {
  const d = evaluateGitHubRequest("POST", "/repos/owner/repo/pulls", makePolicy());
  assert.equal(d.action, "allow-and-capture-pr");
});

await test("POST /repos/owner/repo/pulls (canCreatePr: false) → deny", () => {
  const d = evaluateGitHubRequest("POST", "/repos/owner/repo/pulls", makePolicy({ canCreatePr: false }));
  assert.equal(d.action, "deny");
});

await test("PUT /repos/owner/repo/pulls/42/merge → deny", () => {
  const d = evaluateGitHubRequest("PUT", "/repos/owner/repo/pulls/42/merge", makePolicy());
  assert.equal(d.action, "deny");
});

await test("POST /graphql → deny", () => {
  const d = evaluateGitHubRequest("POST", "/graphql", makePolicy());
  assert.equal(d.action, "deny");
  assert.ok(d.action === "deny" && d.reason.includes("GraphQL"));
});

await test("DELETE /repos/owner/repo/pulls/42 → deny", () => {
  const d = evaluateGitHubRequest("DELETE", "/repos/owner/repo/pulls/42", makePolicy());
  assert.equal(d.action, "deny");
});

await test("GET /repos/other/repo/pulls → deny (cross-repo)", () => {
  const d = evaluateGitHubRequest("GET", "/repos/other/repo/pulls", makePolicy());
  assert.equal(d.action, "deny");
  assert.ok(d.action === "deny" && d.reason.includes("cross-repo"));
});

await test("GET /some/unknown/endpoint → deny (default-deny)", () => {
  const d = evaluateGitHubRequest("GET", "/some/unknown/endpoint", makePolicy());
  assert.equal(d.action, "deny");
  assert.ok(d.action === "deny" && d.reason.includes("not in allowlist"));
});

await test("GET /repos/owner/repo → allow (repo metadata)", () => {
  const d = evaluateGitHubRequest("GET", "/repos/owner/repo", makePolicy());
  assert.equal(d.action, "allow");
});

await test("GET /repos/owner/repo/issues → allow", () => {
  const d = evaluateGitHubRequest("GET", "/repos/owner/repo/issues", makePolicy());
  assert.equal(d.action, "allow");
});

await test("POST /repos/owner/repo/issues → deny", () => {
  const d = evaluateGitHubRequest("POST", "/repos/owner/repo/issues", makePolicy());
  assert.equal(d.action, "deny");
});

await test("PATCH /repos/owner/repo/pulls/42 (owned) → allow", () => {
  const d = evaluateGitHubRequest("PATCH", "/repos/owner/repo/pulls/42", makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("PATCH /repos/owner/repo/pulls/99 (not owned) → deny", () => {
  const d = evaluateGitHubRequest("PATCH", "/repos/owner/repo/pulls/99", makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "deny");
});

// =========================================================================
// parseGitReceivePack
// =========================================================================

console.log("\n  parseGitReceivePack:");

function makePktLine(line: string): Buffer {
  const payload = line + "\n";
  const len = (payload.length + 4).toString(16).padStart(4, "0");
  return Buffer.from(len + payload, "ascii");
}

const FLUSH = Buffer.from("0000", "ascii");

await test("parse a single ref update", () => {
  const body = Buffer.concat([
    makePktLine("0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/feature-branch"),
    FLUSH,
  ]);
  const refs = parseGitReceivePack(body);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].oldSha, "0000000000000000000000000000000000000000");
  assert.equal(refs[0].newSha, "abc123abc123abc123abc123abc123abc123abc1");
  assert.equal(refs[0].refName, "refs/heads/feature-branch");
});

await test("parse multiple ref updates", () => {
  const body = Buffer.concat([
    makePktLine("aaaa000000000000000000000000000000000000 bbbb000000000000000000000000000000000000 refs/heads/branch-a"),
    makePktLine("cccc000000000000000000000000000000000000 dddd000000000000000000000000000000000000 refs/heads/branch-b"),
    FLUSH,
  ]);
  const refs = parseGitReceivePack(body);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].refName, "refs/heads/branch-a");
  assert.equal(refs[1].refName, "refs/heads/branch-b");
});

await test("handle capabilities appended to first line", () => {
  const line = "0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/main\0 report-status side-band-64k";
  const body = Buffer.concat([makePktLine(line), FLUSH]);
  const refs = parseGitReceivePack(body);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].refName, "refs/heads/main");
});

await test("handle flush packet with no data", () => {
  const refs = parseGitReceivePack(FLUSH);
  assert.equal(refs.length, 0);
});

await test("handle empty buffer", () => {
  const refs = parseGitReceivePack(Buffer.alloc(0));
  assert.equal(refs.length, 0);
});

// =========================================================================
// evaluateGitPush
// =========================================================================

console.log("\n  evaluateGitPush:");

await test("push to allowed ref → allowed", () => {
  const refs: RefUpdate[] = [
    { oldSha: "aaa", newSha: "bbb", refName: "refs/heads/feature-branch" },
  ];
  const result = evaluateGitPush(refs, makePolicy());
  assert.equal(result.allowed, true);
});

await test("push to refs/heads/main with allowedPushRefs: ['feature-branch'] → denied", () => {
  const refs: RefUpdate[] = [
    { oldSha: "aaa", newSha: "bbb", refName: "refs/heads/main" },
  ];
  const result = evaluateGitPush(refs, makePolicy());
  assert.equal(result.allowed, false);
  assert.equal(result.deniedRef, "refs/heads/main");
});

await test("push to multiple refs — one denied → denied", () => {
  const refs: RefUpdate[] = [
    { oldSha: "aaa", newSha: "bbb", refName: "refs/heads/feature-branch" },
    { oldSha: "ccc", newSha: "ddd", refName: "refs/heads/main" },
  ];
  const result = evaluateGitPush(refs, makePolicy());
  assert.equal(result.allowed, false);
  assert.equal(result.deniedRef, "refs/heads/main");
});

await test("push to multiple allowed refs → allowed", () => {
  const refs: RefUpdate[] = [
    { oldSha: "aaa", newSha: "bbb", refName: "refs/heads/feature-branch" },
    { oldSha: "ccc", newSha: "ddd", refName: "refs/heads/dev" },
  ];
  const result = evaluateGitPush(refs, makePolicy({ allowedPushRefs: ["feature-branch", "dev"] }));
  assert.equal(result.allowed, true);
});

await test("empty refs → allowed", () => {
  const result = evaluateGitPush([], makePolicy());
  assert.equal(result.allowed, true);
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
