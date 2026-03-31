// scripts/test-gh-shim.ts
//
// Unit tests for the gh shim parser and policy evaluation.
// Does NOT spawn processes — tests exported functions directly.
//
// Usage: npx tsx scripts/test-gh-shim.ts

import assert from "node:assert/strict";
import {
  parseGhArgs,
  evaluatePolicy,
  parseApiEndpoint,
  type ParsedGhCommand,
  type PolicyDecision,
} from "../src/main/gh-shim.js";
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

// --- Test Helpers ---

function makePolicy(overrides: Partial<GitHubPolicy> = {}): GitHubPolicy {
  return {
    repo: "owner/repo",
    allowedPushRefs: ["feature-branch"],
    protectedBranches: ["main"],
    ownedPrNumber: null,
    canCreatePr: true,
    ...overrides,
  };
}

function decide(args: string[], policy?: GitHubPolicy): PolicyDecision {
  return evaluatePolicy(parseGhArgs(args), policy ?? makePolicy());
}

// ==========================================================
// Parser Tests
// ==========================================================

console.log("=== gh Shim Tests ===\n");
console.log("Parser:");

await test("pr create --title foo", () => {
  const p = parseGhArgs(["pr", "create", "--title", "foo"]);
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "create");
});

await test("pr view 42", () => {
  const p = parseGhArgs(["pr", "view", "42"]);
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "view");
  assert.ok(p.positionalArgs.includes("42"));
});

await test("pr edit --title new 42", () => {
  const p = parseGhArgs(["pr", "edit", "--title", "new", "42"]);
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "edit");
  assert.ok(p.positionalArgs.includes("42"));
});

await test("-R other/repo pr list", () => {
  const p = parseGhArgs(["-R", "other/repo", "pr", "list"]);
  assert.equal(p.flags.repo, "other/repo");
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "list");
});

await test("api /repos/{owner}/{repo}/pulls --method GET", () => {
  const p = parseGhArgs(["api", "/repos/{owner}/{repo}/pulls", "--method", "GET"]);
  assert.equal(p.command, "api");
  assert.equal(p.positionalArgs[0], "/repos/{owner}/{repo}/pulls");
  assert.equal(p.flags.method, "GET");
});

await test("api graphql -f query=...", () => {
  const p = parseGhArgs(["api", "graphql", "-f", "query=..."]);
  assert.equal(p.command, "api");
  assert.ok(p.positionalArgs.includes("graphql"));
  assert.equal(p.flags.hasBodyParams, true);
  assert.equal(p.flags.fields.length, 1);
  assert.equal(p.flags.fields[0].key, "query");
  assert.equal(p.flags.fields[0].value, "...");
});

await test("--help (global)", () => {
  const p = parseGhArgs(["--help"]);
  assert.equal(p.command, "--help");
});

await test("pr --help", () => {
  const p = parseGhArgs(["pr", "--help"]);
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "--help");
});

await test("bare args (no command)", () => {
  const p = parseGhArgs([]);
  assert.equal(p.command, "--help");
});

await test("--repo=other/repo pr list (= syntax)", () => {
  const p = parseGhArgs(["--repo=other/repo", "pr", "list"]);
  assert.equal(p.flags.repo, "other/repo");
  assert.equal(p.command, "pr");
  assert.equal(p.subcommand, "list");
});

await test("-Rother/repo pr list (concatenated short flag)", () => {
  const p = parseGhArgs(["-Rother/repo", "pr", "list"]);
  assert.equal(p.flags.repo, "other/repo");
  assert.equal(p.command, "pr");
});

await test("api endpoint --method=POST (= syntax)", () => {
  const p = parseGhArgs(["api", "/repos/owner/repo/pulls", "--method=POST"]);
  assert.equal(p.flags.method, "POST");
});

await test("api endpoint -XPOST (concatenated short flag)", () => {
  const p = parseGhArgs(["api", "/repos/owner/repo/pulls", "-XPOST"]);
  assert.equal(p.flags.method, "POST");
});

// ==========================================================
// API Endpoint Parser Tests
// ==========================================================

console.log("\nAPI endpoint parser:");

await test("/repos/owner/repo/pulls — GET", () => {
  const m = parseApiEndpoint("/repos/owner/repo/pulls", { fields: [] });
  assert.equal(m.resource, "pulls");
  assert.equal(m.ownerRepo, "owner/repo");
  assert.equal(m.method, "GET");
  assert.equal(m.isGraphQL, false);
});

await test("/repos/owner/repo/pulls/42 — GET", () => {
  const m = parseApiEndpoint("/repos/owner/repo/pulls/42", { fields: [] });
  assert.equal(m.resource, "pulls");
  assert.equal(m.number, 42);
  assert.equal(m.ownerRepo, "owner/repo");
});

await test("/repos/owner/repo/pulls/42/merge — PUT", () => {
  const m = parseApiEndpoint("/repos/owner/repo/pulls/42/merge", { method: "PUT", fields: [] });
  assert.equal(m.resource, "pulls");
  assert.equal(m.number, 42);
  assert.equal(m.subResource, "merge");
  assert.equal(m.method, "PUT");
});

await test("graphql — POST inferred from body params", () => {
  const m = parseApiEndpoint("graphql", { hasBodyParams: true, fields: [] });
  assert.equal(m.isGraphQL, true);
  assert.equal(m.method, "POST");
});

await test("/repos/{owner}/{repo}/pulls — placeholder", () => {
  const m = parseApiEndpoint("/repos/{owner}/{repo}/pulls", { fields: [] });
  assert.equal(m.resource, "pulls");
  assert.equal(m.ownerRepo, null); // placeholder
});

await test("/repos/owner/repo — repo metadata", () => {
  const m = parseApiEndpoint("/repos/owner/repo", { fields: [] });
  assert.equal(m.resource, "");
  assert.equal(m.ownerRepo, "owner/repo");
});

// ==========================================================
// Policy Evaluation Tests — PR
// ==========================================================

console.log("\nPolicy evaluation — pr:");

await test("pr create (canCreatePr: true) → allow-and-capture-pr", () => {
  const d = decide(["pr", "create", "--title", "foo"]);
  assert.equal(d.action, "allow-and-capture-pr");
});

await test("pr create (canCreatePr: false) → deny", () => {
  const d = decide(["pr", "create"], makePolicy({ canCreatePr: false }));
  assert.equal(d.action, "deny");
});

await test("pr edit 42 (ownedPrNumber: 42) → allow", () => {
  const d = decide(["pr", "edit", "42"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("pr edit 99 (ownedPrNumber: 42) → deny", () => {
  const d = decide(["pr", "edit", "99"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "deny");
});

await test("pr edit (no number, no owned PR) → deny", () => {
  const d = decide(["pr", "edit", "--title", "new"]);
  assert.equal(d.action, "deny");
});

await test("pr edit (no number, has owned PR) → allow", () => {
  const d = decide(["pr", "edit", "--title", "new"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("pr view 99 → allow (read-only)", () => {
  const d = decide(["pr", "view", "99"]);
  assert.equal(d.action, "allow");
});

await test("pr list → allow", () => {
  const d = decide(["pr", "list"]);
  assert.equal(d.action, "allow");
});

await test("pr status → allow", () => {
  const d = decide(["pr", "status"]);
  assert.equal(d.action, "allow");
});

await test("pr checks → allow", () => {
  const d = decide(["pr", "checks"]);
  assert.equal(d.action, "allow");
});

await test("pr diff → allow", () => {
  const d = decide(["pr", "diff"]);
  assert.equal(d.action, "allow");
});

await test("pr comment (no number, has owned PR) → allow", () => {
  const d = decide(["pr", "comment", "--body", "lgtm"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("pr comment (no number, no owned PR) → deny", () => {
  const d = decide(["pr", "comment", "--body", "lgtm"]);
  assert.equal(d.action, "deny");
});

await test("pr comment 99 (not owned) → deny", () => {
  const d = decide(["pr", "comment", "99", "--body", "x"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "deny");
});

await test("pr ready (owned) → allow", () => {
  const d = decide(["pr", "ready"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("pr update-branch (owned) → allow", () => {
  const d = decide(["pr", "update-branch"], makePolicy({ ownedPrNumber: 42 }));
  assert.equal(d.action, "allow");
});

await test("pr merge 42 → deny", () => {
  const d = decide(["pr", "merge", "42"]);
  assert.equal(d.action, "deny");
});

await test("pr close 42 → deny", () => {
  const d = decide(["pr", "close", "42"]);
  assert.equal(d.action, "deny");
});

await test("pr checkout 42 → deny", () => {
  const d = decide(["pr", "checkout", "42"]);
  assert.equal(d.action, "deny");
});

await test("pr reopen 42 → deny", () => {
  const d = decide(["pr", "reopen", "42"]);
  assert.equal(d.action, "deny");
});

await test("pr review 42 → deny", () => {
  const d = decide(["pr", "review", "42"]);
  assert.equal(d.action, "deny");
});

await test("pr lock 42 → deny", () => {
  const d = decide(["pr", "lock", "42"]);
  assert.equal(d.action, "deny");
});

// ==========================================================
// Policy Evaluation Tests — Issue
// ==========================================================

console.log("\nPolicy evaluation — issue:");

await test("issue view 10 → allow", () => {
  const d = decide(["issue", "view", "10"]);
  assert.equal(d.action, "allow");
});

await test("issue list → allow", () => {
  const d = decide(["issue", "list"]);
  assert.equal(d.action, "allow");
});

await test("issue status → allow", () => {
  const d = decide(["issue", "status"]);
  assert.equal(d.action, "allow");
});

await test("issue create → deny", () => {
  const d = decide(["issue", "create"]);
  assert.equal(d.action, "deny");
});

await test("issue edit 10 → deny", () => {
  const d = decide(["issue", "edit", "10"]);
  assert.equal(d.action, "deny");
});

await test("issue close 10 → deny", () => {
  const d = decide(["issue", "close", "10"]);
  assert.equal(d.action, "deny");
});

await test("issue comment 10 → deny", () => {
  const d = decide(["issue", "comment", "10"]);
  assert.equal(d.action, "deny");
});

await test("issue delete 10 → deny", () => {
  const d = decide(["issue", "delete", "10"]);
  assert.equal(d.action, "deny");
});

// ==========================================================
// Policy Evaluation Tests — Other Commands
// ==========================================================

console.log("\nPolicy evaluation — other commands:");

await test("repo (no subcommand) → allow", () => {
  const d = decide(["repo"]);
  assert.equal(d.action, "allow");
});

await test("repo view → allow", () => {
  const d = decide(["repo", "view"]);
  assert.equal(d.action, "allow");
});

await test("repo clone → deny", () => {
  const d = decide(["repo", "clone"]);
  assert.equal(d.action, "deny");
});

await test("release list → allow", () => {
  const d = decide(["release", "list"]);
  assert.equal(d.action, "allow");
});

await test("release view → allow", () => {
  const d = decide(["release", "view"]);
  assert.equal(d.action, "allow");
});

await test("release create → deny", () => {
  const d = decide(["release", "create"]);
  assert.equal(d.action, "deny");
});

await test("search repos → allow", () => {
  const d = decide(["search", "repos"]);
  assert.equal(d.action, "allow");
});

await test("browse → allow", () => {
  const d = decide(["browse"]);
  assert.equal(d.action, "allow");
});

await test("status → allow", () => {
  const d = decide(["status"]);
  assert.equal(d.action, "allow");
});

await test("run view → allow", () => {
  const d = decide(["run", "view"]);
  assert.equal(d.action, "allow");
});

await test("run list → allow", () => {
  const d = decide(["run", "list"]);
  assert.equal(d.action, "allow");
});

await test("run cancel → deny", () => {
  const d = decide(["run", "cancel"]);
  assert.equal(d.action, "deny");
});

await test("run rerun → deny", () => {
  const d = decide(["run", "rerun"]);
  assert.equal(d.action, "deny");
});

await test("workflow view → allow", () => {
  const d = decide(["workflow", "view"]);
  assert.equal(d.action, "allow");
});

await test("workflow list → allow", () => {
  const d = decide(["workflow", "list"]);
  assert.equal(d.action, "allow");
});

await test("workflow run → deny", () => {
  const d = decide(["workflow", "run"]);
  assert.equal(d.action, "deny");
});

await test("workflow enable → deny", () => {
  const d = decide(["workflow", "enable"]);
  assert.equal(d.action, "deny");
});

await test("auth login → deny", () => {
  const d = decide(["auth", "login"]);
  assert.equal(d.action, "deny");
});

await test("config set → deny", () => {
  const d = decide(["config", "set"]);
  assert.equal(d.action, "deny");
});

await test("gist create → deny", () => {
  const d = decide(["gist", "create"]);
  assert.equal(d.action, "deny");
});

await test("codespace create → deny", () => {
  const d = decide(["codespace", "create"]);
  assert.equal(d.action, "deny");
});

await test("ssh-key add → deny", () => {
  const d = decide(["ssh-key", "add"]);
  assert.equal(d.action, "deny");
});

await test("secret set → deny", () => {
  const d = decide(["secret", "set"]);
  assert.equal(d.action, "deny");
});

await test("extension install → deny", () => {
  const d = decide(["extension", "install"]);
  assert.equal(d.action, "deny");
});

await test("--help → allow", () => {
  const d = decide(["--help"]);
  assert.equal(d.action, "allow");
});

await test("--version → allow", () => {
  const d = decide(["--version"]);
  assert.equal(d.action, "allow");
});

await test("unknown-command → deny", () => {
  const d = decide(["unknown-command"]);
  assert.equal(d.action, "deny");
});

// ==========================================================
// Policy Evaluation Tests — Cross-repo
// ==========================================================

console.log("\nPolicy evaluation — cross-repo:");

await test("-R other/repo pr list → deny", () => {
  const d = decide(["-R", "other/repo", "pr", "list"]);
  assert.equal(d.action, "deny");
});

await test("-R owner/repo pr list → allow (same repo)", () => {
  const d = decide(["-R", "owner/repo", "pr", "list"]);
  assert.equal(d.action, "allow");
});

await test("--repo=other/repo pr list → deny (= syntax)", () => {
  const d = decide(["--repo=other/repo", "pr", "list"]);
  assert.equal(d.action, "deny");
});

// ==========================================================
// Policy Evaluation Tests — API
// ==========================================================

console.log("\nPolicy evaluation — api:");

await test("api /repos/owner/repo/pulls GET → allow", () => {
  const d = decide(["api", "/repos/owner/repo/pulls", "--method", "GET"]);
  assert.equal(d.action, "allow");
});

await test("api /repos/owner/repo/pulls POST (canCreatePr) → allow-and-capture-pr", () => {
  const d = decide(["api", "/repos/owner/repo/pulls", "--method", "POST"]);
  assert.equal(d.action, "allow-and-capture-pr");
});

await test("api /repos/owner/repo/pulls POST (no canCreatePr) → deny", () => {
  const d = decide(["api", "/repos/owner/repo/pulls", "--method", "POST"], makePolicy({ canCreatePr: false }));
  assert.equal(d.action, "deny");
});

await test("api /repos/owner/repo/pulls/42/merge PUT → deny", () => {
  const d = decide(["api", "/repos/owner/repo/pulls/42/merge", "--method", "PUT"]);
  assert.equal(d.action, "deny");
});

await test("api /repos/owner/repo/issues GET → allow", () => {
  const d = decide(["api", "/repos/owner/repo/issues", "--method", "GET"]);
  assert.equal(d.action, "allow");
});

await test("api /repos/owner/repo/issues POST → deny", () => {
  const d = decide(["api", "/repos/owner/repo/issues", "--method", "POST"]);
  assert.equal(d.action, "deny");
});

await test("api graphql → allow", () => {
  const d = decide(["api", "graphql", "-f", "query=..."]);
  assert.equal(d.action, "allow");
});

await test("api DELETE anything → deny", () => {
  const d = decide(["api", "/repos/owner/repo/pulls/42", "-X", "DELETE"]);
  assert.equal(d.action, "deny");
});

await test("api cross-repo → deny", () => {
  const d = decide(["api", "/repos/other/repo/pulls", "--method", "GET"]);
  assert.equal(d.action, "deny");
});

await test("api /repos/{owner}/{repo}/pulls → allow (placeholder)", () => {
  const d = decide(["api", "/repos/{owner}/{repo}/pulls", "--method", "GET"]);
  assert.equal(d.action, "allow");
});

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
