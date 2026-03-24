#!/usr/bin/env node

/**
 * Bouncer gh shim — policy-aware wrapper for the GitHub CLI.
 *
 * Environment:
 *   BOUNCER_GITHUB_POLICY — path to the policy state JSON file
 *   BOUNCER_REAL_GH       — path to the real gh binary
 *
 * Reads policy, parses gh subcommand, evaluates against policy,
 * then either execs real gh or exits with a policy error.
 */

import { execFileSync } from "node:child_process";
import { readPolicyState, writePolicyState } from "./github-policy.js";
import type { GitHubPolicy } from "./types.js";

// --- Subcommand Parser ---

export interface ParsedGhCommand {
  command: string;
  subcommand: string | null;
  positionalArgs: string[];
  flags: {
    repo?: string;
    method?: string;
    hasBodyParams?: boolean;
  };
  /** The raw args to forward to real gh (everything after "gh"). */
  rawArgs: string[];
}

/** Commands that have subcommands. */
const COMMANDS_WITH_SUBCOMMANDS = new Set([
  "pr", "issue", "repo", "release", "run", "workflow", "gist",
]);

/** Flags that consume the next argument as their value. */
const FLAGS_WITH_VALUES = new Set([
  "-R", "--repo", "--method", "-X",
]);

/** Flags whose presence implies a POST body. */
const BODY_PARAM_FLAGS = new Set([
  "-f", "-F", "--field", "--raw-field",
]);

/**
 * Try to extract a flag value from a single argument using = or short-flag syntax.
 * Returns the value if matched, or null otherwise.
 * Handles: --repo=value, -Rvalue, --method=POST, -XPOST
 */
function tryExtractInlineFlag(arg: string): { flag: string; value: string } | null {
  // --long-flag=value
  const eqMatch = arg.match(/^(--[a-z-]+)=(.+)$/);
  if (eqMatch && FLAGS_WITH_VALUES.has(eqMatch[1])) {
    return { flag: eqMatch[1], value: eqMatch[2] };
  }
  // -Rvalue, -Xvalue (short flags with value concatenated)
  if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
    const shortFlag = arg.substring(0, 2);
    if (FLAGS_WITH_VALUES.has(shortFlag)) {
      return { flag: shortFlag, value: arg.substring(2) };
    }
  }
  return null;
}

/**
 * Parse gh CLI arguments into a structured command.
 * Only extracts policy-relevant information; all other flags pass through.
 */
export function parseGhArgs(args: string[]): ParsedGhCommand {
  const result: ParsedGhCommand = {
    command: "",
    subcommand: null,
    positionalArgs: [],
    flags: {},
    rawArgs: [...args],
  };

  let i = 0;

  // Skip global flags before the command
  while (i < args.length && args[i].startsWith("-")) {
    const flag = args[i];
    // Global flags like --help, --version become the "command"
    if (flag === "--help" || flag === "--version") {
      result.command = flag;
      return result;
    }
    // -R / --repo with separate value
    if ((flag === "-R" || flag === "--repo") && i + 1 < args.length) {
      result.flags.repo = args[i + 1];
      i += 2;
      continue;
    }
    // --repo=value, -Rvalue
    const inline = tryExtractInlineFlag(flag);
    if (inline) {
      extractFlag(result, inline.flag, inline.value);
      i++;
      continue;
    }
    i++;
  }

  if (i >= args.length) {
    result.command = "--help"; // bare "gh" acts like --help
    return result;
  }

  // First non-flag arg is the command
  result.command = args[i];
  i++;

  // If this command has subcommands, next non-flag arg is the subcommand
  if (COMMANDS_WITH_SUBCOMMANDS.has(result.command)) {
    // Skip flags to find the subcommand, but treat --help as the subcommand
    while (i < args.length && args[i].startsWith("-")) {
      const flag = args[i];
      if (flag === "--help") {
        result.subcommand = "--help";
        i++;
        break;
      }
      if (FLAGS_WITH_VALUES.has(flag) && i + 1 < args.length) {
        extractFlag(result, flag, args[i + 1]);
        i += 2;
      } else {
        const inline = tryExtractInlineFlag(flag);
        if (inline) {
          extractFlag(result, inline.flag, inline.value);
          i++;
        } else {
          if (BODY_PARAM_FLAGS.has(flag)) result.flags.hasBodyParams = true;
          i++;
        }
      }
    }
    if (result.subcommand === null && i < args.length) {
      result.subcommand = args[i];
      i++;
    }
  }

  // Parse remaining args
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (FLAGS_WITH_VALUES.has(arg) && i + 1 < args.length) {
        extractFlag(result, arg, args[i + 1]);
        i += 2;
      } else {
        const inline = tryExtractInlineFlag(arg);
        if (inline) {
          extractFlag(result, inline.flag, inline.value);
          i++;
        } else {
          if (BODY_PARAM_FLAGS.has(arg)) result.flags.hasBodyParams = true;
          i++;
        }
      }
    } else {
      result.positionalArgs.push(arg);
      i++;
    }
  }

  return result;
}

function extractFlag(result: ParsedGhCommand, flag: string, value: string): void {
  switch (flag) {
    case "-R":
    case "--repo":
      result.flags.repo = value;
      break;
    case "--method":
    case "-X":
      result.flags.method = value;
      break;
  }
}

// --- Policy Evaluation ---

export type PolicyDecision =
  | { action: "allow" }
  | { action: "allow-and-capture-pr" }
  | { action: "deny"; reason: string };

/**
 * Evaluate a parsed gh command against the session policy.
 */
export function evaluatePolicy(
  parsed: ParsedGhCommand,
  policy: GitHubPolicy,
): PolicyDecision {
  const { command, subcommand } = parsed;

  // Global help/version — always allow
  if (command === "--help" || command === "--version") {
    return { action: "allow" };
  }

  // Check -R flag: if targeting a different repo, deny
  if (parsed.flags.repo && parsed.flags.repo !== policy.repo) {
    return { action: "deny", reason: `cross-repo access denied: '${parsed.flags.repo}' (session repo: '${policy.repo}')` };
  }

  switch (command) {
    case "pr":
      return evaluatePrPolicy(subcommand, parsed.positionalArgs, policy);
    case "issue":
      return evaluateIssuePolicy(subcommand);
    case "repo":
      return evaluateRepoPolicy(subcommand);
    case "release":
      return evaluateReleasePolicy(subcommand);
    case "run":
      return evaluateRunPolicy(subcommand);
    case "workflow":
      return evaluateWorkflowPolicy(subcommand);
    case "api":
      return evaluateApiPolicy(parsed.positionalArgs, parsed.flags, policy);
    case "search":
    case "browse":
    case "status":
      return { action: "allow" };
    case "auth":
      return { action: "deny", reason: "auth commands are not allowed" };
    case "config":
      return { action: "deny", reason: "config commands are not allowed" };
    case "gist":
      return { action: "deny", reason: "gist commands are not allowed" };
    case "codespace":
      return { action: "deny", reason: "codespace commands are not allowed" };
    case "ssh-key":
    case "gpg-key":
      return { action: "deny", reason: "credential management is not allowed" };
    case "secret":
    case "variable":
      return { action: "deny", reason: "repository settings commands are not allowed" };
    case "label":
      return { action: "deny", reason: "label commands are not allowed" };
    case "extension":
      return { action: "deny", reason: "extension commands are not allowed" };
    default:
      return { action: "deny", reason: `command '${command}' is not allowed` };
  }
}

// --- PR Policy ---

const PR_READ_ONLY = new Set(["view", "list", "status", "checks", "diff"]);
const PR_OWNED_ONLY = new Set(["edit", "comment", "ready", "update-branch"]);
const PR_ALWAYS_DENY = new Set(["checkout", "close", "merge", "reopen", "review", "lock", "unlock"]);

function evaluatePrPolicy(
  subcommand: string | null,
  positionalArgs: string[],
  policy: GitHubPolicy,
): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };

  if (PR_ALWAYS_DENY.has(subcommand)) {
    return { action: "deny", reason: `'pr ${subcommand}' is not allowed` };
  }

  if (subcommand === "create") {
    if (!policy.canCreatePr) {
      return { action: "deny", reason: "PR already created for this session" };
    }
    return { action: "allow-and-capture-pr" };
  }

  if (PR_READ_ONLY.has(subcommand)) {
    return { action: "allow" };
  }

  if (PR_OWNED_ONLY.has(subcommand)) {
    return checkOwnedPr(positionalArgs, policy, subcommand);
  }

  return { action: "deny", reason: `'pr ${subcommand}' is not allowed` };
}

/**
 * Check if the target PR is the session's owned PR.
 * If no positional arg, assumes current branch's PR — but only if the session owns a PR.
 */
function checkOwnedPr(
  positionalArgs: string[],
  policy: GitHubPolicy,
  subcommand: string,
): PolicyDecision {
  const targetPr = extractTargetPrNumber(positionalArgs);
  if (targetPr === null) {
    // No explicit PR number — only allow if the session has an owned PR
    if (policy.ownedPrNumber === null) {
      return { action: "deny", reason: `'pr ${subcommand}' denied: no owned PR for this session` };
    }
    return { action: "allow" };
  }
  if (policy.ownedPrNumber !== null && targetPr === policy.ownedPrNumber) {
    return { action: "allow" };
  }
  return {
    action: "deny",
    reason: `'pr ${subcommand}' denied: PR #${targetPr} is not owned by this session (owned: #${policy.ownedPrNumber ?? "none"})`,
  };
}

function extractTargetPrNumber(positionalArgs: string[]): number | null {
  for (const arg of positionalArgs) {
    const n = parseInt(arg, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// --- Issue Policy ---

const ISSUE_READ_ONLY = new Set(["view", "list", "status"]);

function evaluateIssuePolicy(subcommand: string | null): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };
  if (ISSUE_READ_ONLY.has(subcommand)) return { action: "allow" };
  return { action: "deny", reason: `'issue ${subcommand}' is not allowed` };
}

// --- Repo Policy ---

function evaluateRepoPolicy(subcommand: string | null): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };
  if (subcommand === "view") return { action: "allow" };
  return { action: "deny", reason: `'repo ${subcommand}' is not allowed` };
}

// --- Release Policy ---

const RELEASE_READ_ONLY = new Set(["list", "view"]);

function evaluateReleasePolicy(subcommand: string | null): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };
  if (RELEASE_READ_ONLY.has(subcommand)) return { action: "allow" };
  return { action: "deny", reason: `'release ${subcommand}' is not allowed` };
}

// --- Run Policy ---

const RUN_READ_ONLY = new Set(["view", "list"]);

function evaluateRunPolicy(subcommand: string | null): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };
  if (RUN_READ_ONLY.has(subcommand)) return { action: "allow" };
  return { action: "deny", reason: `'run ${subcommand}' is not allowed` };
}

// --- Workflow Policy ---

const WORKFLOW_READ_ONLY = new Set(["view", "list"]);

function evaluateWorkflowPolicy(subcommand: string | null): PolicyDecision {
  if (!subcommand || subcommand === "--help") return { action: "allow" };
  if (WORKFLOW_READ_ONLY.has(subcommand)) return { action: "allow" };
  return { action: "deny", reason: `'workflow ${subcommand}' is not allowed` };
}

// --- API Policy ---

export interface ApiEndpointMatch {
  resource: string;
  method: string;
  ownerRepo: string | null;
  number: number | null;
  subResource: string | null;
  isGraphQL: boolean;
}

/**
 * Parse and match a gh api endpoint path.
 */
export function parseApiEndpoint(
  endpoint: string,
  flags: ParsedGhCommand["flags"],
): ApiEndpointMatch {
  // Determine HTTP method
  let method = (flags.method ?? "GET").toUpperCase();
  if (method === "GET" && flags.hasBodyParams) {
    method = "POST";
  }

  // GraphQL
  if (endpoint === "graphql" || endpoint === "/graphql") {
    return { resource: "graphql", method, ownerRepo: null, number: null, subResource: null, isGraphQL: true };
  }

  // Parse /repos/{owner}/{repo}/... paths
  const reposMatch = endpoint.match(
    /^\/repos\/([^/]+\/[^/]+)(?:\/([^/]+))?(?:\/(\d+))?(?:\/(.+))?$/
  );

  if (reposMatch) {
    const ownerRepo = expandPlaceholder(reposMatch[1]);
    const resource = reposMatch[2] ?? "";
    const number = reposMatch[3] ? parseInt(reposMatch[3], 10) : null;
    const subResource = reposMatch[4] ?? null;
    return { resource, method, ownerRepo, number, subResource, isGraphQL: false };
  }

  // Unrecognized endpoint
  return { resource: endpoint, method, ownerRepo: null, number: null, subResource: null, isGraphQL: false };
}

/**
 * Expand {owner}/{repo} placeholders to a recognizable marker.
 * gh CLI expands these at runtime, but we need to handle them in parsing.
 */
function expandPlaceholder(ownerRepo: string): string | null {
  // If it contains placeholders like {owner}/{repo}, return null (matches any)
  if (ownerRepo.includes("{")) return null;
  return ownerRepo;
}

function evaluateApiPolicy(
  positionalArgs: string[],
  flags: ParsedGhCommand["flags"],
  policy: GitHubPolicy,
): PolicyDecision {
  const endpoint = positionalArgs[0];
  if (!endpoint) {
    return { action: "deny", reason: "gh api requires an endpoint argument" };
  }

  const match = parseApiEndpoint(endpoint, flags);

  // GraphQL: allow but flag as unaudited (query content not inspected)
  if (match.isGraphQL) {
    return { action: "allow" };
  }

  // DELETE is always denied
  if (match.method === "DELETE") {
    return { action: "deny", reason: "DELETE requests are not allowed" };
  }

  // Check repo scope for /repos/ endpoints
  if (match.ownerRepo !== null && match.ownerRepo !== policy.repo) {
    return { action: "deny", reason: `cross-repo API access denied: '${match.ownerRepo}' (session repo: '${policy.repo}')` };
  }

  // /repos/{owner}/{repo} (repo metadata)
  if (match.resource === "" && match.method === "GET") {
    return { action: "allow" };
  }

  // /repos/{owner}/{repo}/pulls
  if (match.resource === "pulls") {
    return evaluateApiPulls(match, policy);
  }

  // /repos/{owner}/{repo}/issues
  if (match.resource === "issues") {
    return evaluateApiIssues(match);
  }

  // Unrecognized API endpoint — deny
  return { action: "deny", reason: `API endpoint '${endpoint}' (${match.method}) is not allowed` };
}

function evaluateApiPulls(match: ApiEndpointMatch, policy: GitHubPolicy): PolicyDecision {
  // GET /pulls or /pulls/{number} — read-only, allow
  if (match.method === "GET") {
    return { action: "allow" };
  }

  // PUT /pulls/{number}/merge — deny
  if (match.method === "PUT" && match.subResource === "merge") {
    return { action: "deny", reason: "merging PRs via API is not allowed" };
  }

  // POST /pulls — create PR
  if (match.method === "POST" && match.number === null) {
    if (!policy.canCreatePr) {
      return { action: "deny", reason: "PR already created for this session" };
    }
    return { action: "allow-and-capture-pr" };
  }

  // PATCH /pulls/{number} — edit PR
  if (match.method === "PATCH" && match.number !== null) {
    if (policy.ownedPrNumber !== null && match.number === policy.ownedPrNumber) {
      return { action: "allow" };
    }
    if (policy.ownedPrNumber === null) {
      // No PR owned yet — can't edit
      return { action: "deny", reason: `cannot edit PR #${match.number}: no PR owned by this session` };
    }
    return { action: "deny", reason: `cannot edit PR #${match.number}: not owned (owned: #${policy.ownedPrNumber})` };
  }

  return { action: "deny", reason: `API pulls ${match.method} is not allowed` };
}

function evaluateApiIssues(match: ApiEndpointMatch): PolicyDecision {
  if (match.method === "GET") {
    return { action: "allow" };
  }
  return { action: "deny", reason: `API issues ${match.method} is not allowed` };
}

// --- Main (standalone entry point) ---

function parsePrNumberFromOutput(output: string): number | null {
  // gh pr create prints: https://github.com/owner/repo/pull/42
  const match = output.match(/\/pull\/(\d+)\s*$/m);
  return match ? parseInt(match[1], 10) : null;
}

async function main(): Promise<void> {
  const policyPath = process.env.BOUNCER_GITHUB_POLICY;
  const realGh = process.env.BOUNCER_REAL_GH;

  if (!policyPath || !realGh) {
    process.stderr.write(
      "[bouncer:gh] error: BOUNCER_GITHUB_POLICY and BOUNCER_REAL_GH must be set\n"
    );
    process.exit(1);
  }

  let policy: GitHubPolicy;
  try {
    policy = await readPolicyState(policyPath);
  } catch (err) {
    process.stderr.write(`[bouncer:gh] error: failed to read policy: ${err}\n`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const parsed = parseGhArgs(args);
  const decision = evaluatePolicy(parsed, policy);

  // Log the decision to stderr in structured format for the policy event parser
  const op = [parsed.command, parsed.subcommand, ...parsed.positionalArgs]
    .filter(Boolean)
    .join(" ");
  const isGraphQL = parsed.command === "api" && parsed.positionalArgs[0] === "graphql";
  const unauditedTag = isGraphQL ? " [unaudited]" : "";
  if (decision.action === "deny") {
    process.stderr.write(`[bouncer:gh] DENY ${op} — ${decision.reason}\n`, () => {
      process.exit(1);
    });
    return;
  } else {
    process.stderr.write(`[bouncer:gh] ALLOW ${op}${unauditedTag}\n`);
  }

  if (decision.action === "allow-and-capture-pr") {
    // Spawn real gh, capture stdout to extract PR number
    try {
      const result = execFileSync(realGh, args, {
        stdio: ["inherit", "pipe", "inherit"],
        encoding: "utf-8",
      });
      const stdout = result as string;
      process.stdout.write(stdout);

      let prNumber = parsePrNumberFromOutput(stdout);
      if (prNumber === null) {
        // Fallback: attempt to parse JSON output (e.g. from gh api)
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === "object" && typeof (parsed as { number?: unknown }).number === "number") {
            prNumber = (parsed as { number: number }).number;
          }
        } catch {
          // Not JSON — ignore
        }
      }

      const sessionId = deriveSessionId(policyPath);
      if (sessionId) {
        // Always prevent further PR creation after a successful PR-create command
        policy.canCreatePr = false;
        if (prNumber !== null) {
          policy.ownedPrNumber = prNumber;
          process.stderr.write(`[bouncer:gh] captured PR #${prNumber}\n`);
        }
        await writePolicyState(sessionId, policy);
      }
    } catch (err: unknown) {
      const exitCode = (err as { status?: number }).status ?? 1;
      process.exit(exitCode);
    }
    return;
  }

  // action === "allow" — exec real gh with inherited stdio
  try {
    execFileSync(realGh, args, { stdio: "inherit" });
  } catch (err: unknown) {
    const exitCode = (err as { status?: number }).status ?? 1;
    process.exit(exitCode);
  }
}

/**
 * Derive session ID from policy file path.
 * Path format: <POLICY_DIR>/<sessionId>-github-policy.json
 */
function deriveSessionId(policyPath: string): string | null {
  const basename = policyPath.split("/").pop();
  if (!basename) return null;
  const match = basename.match(/^(.+)-github-policy\.json$/);
  return match ? match[1] : null;
}

// Run main if this is the entry point.
// Check both argv[1] and the BOUNCER env vars to avoid triggering when imported as a library.
if (process.env.BOUNCER_GITHUB_POLICY && process.env.BOUNCER_REAL_GH) {
  main().catch((err) => {
    process.stderr.write(`[bouncer:gh] fatal: ${err}\n`);
    process.exit(1);
  });
}
