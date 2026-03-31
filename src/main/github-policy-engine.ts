// src/main/github-policy-engine.ts
//
// Shared GitHub policy evaluation logic used by both the gh shim (CLI-level)
// and the proxy (network-level). Extracted from gh-shim.ts in Phase 4.

import type { GitHubPolicy } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'allow-and-capture-pr' }
  | { action: 'inspect-graphql' }
  | { action: 'deny'; reason: string };

export interface ApiEndpointMatch {
  resource: string;
  method: string;
  ownerRepo: string | null;
  number: number | null;
  subResource: string | null;
  isGraphQL: boolean;
}

// ---------------------------------------------------------------------------
// parseApiEndpoint()
// ---------------------------------------------------------------------------

/**
 * Parse and match a GitHub API endpoint path.
 * Accepts either the shim's flags object or a simple { method } for proxy use.
 */
export function parseApiEndpoint(
  endpoint: string,
  flags: { method?: string; hasBodyParams?: boolean; [key: string]: unknown },
): ApiEndpointMatch {
  let method = (flags.method ?? 'GET').toUpperCase();
  if (method === 'GET' && flags.hasBodyParams) {
    method = 'POST';
  }

  // Normalize: strip query string, hash, and trailing slash
  let path = endpoint.split('?')[0].split('#')[0];
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  // Ensure leading slash — gh CLI omits it for convenience (e.g., "repos/owner/repo/pulls")
  if (path && !path.startsWith('/')) {
    path = '/' + path;
  }

  // GraphQL
  if (path === 'graphql' || path === '/graphql') {
    return {
      resource: 'graphql',
      method,
      ownerRepo: null,
      number: null,
      subResource: null,
      isGraphQL: true,
    };
  }

  // Parse /repos/{owner}/{repo}/... paths
  const reposMatch = path.match(/^\/repos\/([^/]+\/[^/]+)(?:\/([^/]+))?(?:\/(\d+))?(?:\/(.+))?$/);

  if (reposMatch) {
    const ownerRepo = expandPlaceholder(reposMatch[1]);
    const resource = reposMatch[2] ?? '';
    const number = reposMatch[3] ? parseInt(reposMatch[3], 10) : null;
    const subResource = reposMatch[4] ?? null;
    return {
      resource,
      method,
      ownerRepo,
      number,
      subResource,
      isGraphQL: false,
    };
  }

  // Unrecognized endpoint
  return {
    resource: path,
    method,
    ownerRepo: null,
    number: null,
    subResource: null,
    isGraphQL: false,
  };
}

/**
 * Expand {owner}/{repo} placeholders to a recognizable marker.
 * gh CLI expands these at runtime, but we need to handle them in parsing.
 */
export function expandPlaceholder(ownerRepo: string): string | null {
  if (ownerRepo.includes('{')) return null;
  return ownerRepo;
}

// ---------------------------------------------------------------------------
// REST API resource evaluators
// ---------------------------------------------------------------------------

export function evaluateApiPulls(match: ApiEndpointMatch, policy: GitHubPolicy): PolicyDecision {
  // PUT /pulls/{number}/merge — always deny with explicit message
  if (match.method === 'PUT' && match.subResource === 'merge') {
    return {
      action: 'deny',
      reason: 'Merging PRs is not allowed in this sandbox. The PR is ready for human review.',
    };
  }

  // Sub-resources on a specific PR (reviews, comments, requested_reviewers)
  if (match.number !== null && match.subResource) {
    // POST to comment/review endpoints is denied (propose, don't post)
    if (
      match.method === 'POST' &&
      (match.subResource === 'comments' ||
        match.subResource === 'reviews' ||
        match.subResource.startsWith('reviews/'))
    ) {
      return {
        action: 'deny',
        reason: 'Posting review comments is not allowed. Propose responses to the user instead.',
      };
    }

    // POST /pulls/{n}/requested_reviewers — request a review (allowed for owned PR)
    if (match.method === 'POST' && match.subResource === 'requested_reviewers') {
      return checkOwnedPrApi(match.number, policy, 'request reviewers');
    }

    // GET on sub-resources (reviews, comments, requested_reviewers) — allow for owned PR
    if (match.method === 'GET') {
      return checkOwnedPrApi(match.number, policy, `read ${match.subResource}`);
    }

    return {
      action: 'deny',
      reason: `API pulls/${match.subResource} ${match.method} is not allowed`,
    };
  }

  // GET /pulls or /pulls/{number} — read-only, allow
  if (match.method === 'GET') {
    return { action: 'allow' };
  }

  // POST /pulls — create PR
  if (match.method === 'POST' && match.number === null) {
    if (!policy.canCreatePr) {
      return { action: 'deny', reason: 'PR already created for this session' };
    }
    return { action: 'allow-and-capture-pr' };
  }

  // PATCH /pulls/{number} — edit PR
  if (match.method === 'PATCH' && match.number !== null) {
    return checkOwnedPrApi(match.number, policy, 'edit');
  }

  return { action: 'deny', reason: `API pulls ${match.method} is not allowed` };
}

/** Check if a PR number matches the session's owned PR. */
function checkOwnedPrApi(
  prNumber: number,
  policy: GitHubPolicy,
  operation: string,
): PolicyDecision {
  if (policy.ownedPrNumber !== null && prNumber === policy.ownedPrNumber) {
    return { action: 'allow' };
  }
  if (policy.ownedPrNumber === null) {
    return {
      action: 'deny',
      reason: `cannot ${operation} PR #${prNumber}: no PR owned by this session`,
    };
  }
  return {
    action: 'deny',
    reason: `cannot ${operation} PR #${prNumber}: not owned (owned: #${policy.ownedPrNumber})`,
  };
}

export function evaluateApiIssues(match: ApiEndpointMatch): PolicyDecision {
  if (match.method === 'GET') {
    return { action: 'allow' };
  }
  return {
    action: 'deny',
    reason: `API issues ${match.method} is not allowed`,
  };
}

// ---------------------------------------------------------------------------
// GraphQL mutation allowlist
// ---------------------------------------------------------------------------

/** Mutations allowed through the proxy, with their required policy checks. */
const ALLOWED_GRAPHQL_MUTATIONS = new Set(['markPullRequestReadyForReview']);

/**
 * Evaluate a GraphQL request body against policy.
 * Only specific allowlisted mutations are permitted.
 */
export function evaluateGraphQLBody(body: string, policy: GitHubPolicy): PolicyDecision {
  try {
    const parsed = JSON.parse(body);
    const query = (parsed.query ?? '') as string;
    // Extract the mutation name from `mutation ... { mutationName(...) { ... } }`
    const mutationMatch = query.match(/mutation\b[^{]*\{\s*(\w+)/);
    if (!mutationMatch) {
      return { action: 'deny', reason: 'GraphQL queries are not allowed, only specific mutations' };
    }
    const mutationName = mutationMatch[1];
    if (!ALLOWED_GRAPHQL_MUTATIONS.has(mutationName)) {
      return { action: 'deny', reason: `GraphQL mutation '${mutationName}' is not allowed` };
    }
    // markPullRequestReadyForReview — session must have created a PR.
    // Check canCreatePr (set to false after PR creation) rather than ownedPrNumber,
    // because the proxy's response capture may not have set ownedPrNumber yet
    // (e.g. if the response was compressed and capture failed silently).
    // The gh-shim validates PR ownership at the CLI level before reaching here.
    if (mutationName === 'markPullRequestReadyForReview') {
      if (policy.canCreatePr) {
        return { action: 'deny', reason: 'no PR created in this session' };
      }
      return { action: 'allow' };
    }
    return { action: 'allow' };
  } catch {
    return { action: 'deny', reason: 'could not parse GraphQL request body' };
  }
}

// ---------------------------------------------------------------------------
// evaluateGitHubRequest() — proxy-level HTTP request evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a raw HTTP request against GitHub policy.
 * Used by the proxy to enforce policy at the network level.
 * Default-deny: returns "deny" for unrecognized endpoints.
 */
export function evaluateGitHubRequest(
  method: string,
  path: string,
  policy: GitHubPolicy,
): PolicyDecision {
  const match = parseApiEndpoint(path, { method });

  // GraphQL: can't evaluate from URL alone — defer to caller to inspect body
  if (match.isGraphQL) {
    return { action: 'inspect-graphql' };
  }

  // DELETE is always denied
  if (match.method === 'DELETE') {
    return { action: 'deny', reason: 'DELETE requests are not allowed' };
  }

  // Cross-repo check
  if (match.ownerRepo !== null && match.ownerRepo !== policy.repo) {
    return {
      action: 'deny',
      reason: `cross-repo access denied: '${match.ownerRepo}' (session repo: '${policy.repo}')`,
    };
  }

  // /repos/{owner}/{repo} (repo metadata)
  if (match.resource === '' && match.method === 'GET') {
    return { action: 'allow' };
  }

  // /repos/{owner}/{repo}/pulls
  if (match.resource === 'pulls') {
    return evaluateApiPulls(match, policy);
  }

  // /repos/{owner}/{repo}/issues
  if (match.resource === 'issues') {
    return evaluateApiIssues(match);
  }

  // /repos/{owner}/{repo}/actions — CI/Actions (read-only)
  if (match.resource === 'actions') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API actions ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/check-runs, check-suites — CI checks (read-only)
  if (match.resource === 'check-runs' || match.resource === 'check-suites') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API ${match.resource} ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/commits — commit status/checks (read-only)
  if (match.resource === 'commits') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API commits ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/statuses — commit statuses (read-only)
  if (match.resource === 'statuses') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API statuses ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/branches — branch listing and info (read-only)
  if (match.resource === 'branches') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API branches ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/git — git refs, trees, blobs (read-only)
  if (match.resource === 'git') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API git ${match.method} is not allowed` };
  }

  // /repos/{owner}/{repo}/contents — file contents (read-only)
  if (match.resource === 'contents') {
    if (match.method === 'GET') return { action: 'allow' };
    return { action: 'deny', reason: `API contents ${match.method} is not allowed` };
  }

  // Default deny
  return {
    action: 'deny',
    reason: `endpoint not in allowlist: ${method} ${path}`,
  };
}

// ---------------------------------------------------------------------------
// Git push evaluation (pkt-line parsing)
// ---------------------------------------------------------------------------

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  refName: string;
}

export interface ReceivePackResult {
  refs: RefUpdate[];
  /** True if the pkt-line stream was parsed successfully (terminated by flush packet). */
  ok: boolean;
}

/**
 * Parse git pkt-line format to extract ref updates from a git-receive-pack body.
 *
 * The pkt-line format uses 4-hex-digit length prefixes. Each line is:
 *   {4-hex length}{payload}\n
 * The flush packet "0000" marks the end of the ref update section.
 *
 * Each ref update line has the format:
 *   {old-sha} {new-sha} {ref-name}[\0{capabilities}]
 *
 * Returns `{ refs, ok }`. If `ok` is false, the stream was malformed or
 * truncated — callers should deny the push (fail-closed).
 */
export function parseGitReceivePack(body: Buffer): ReceivePackResult {
  const refs: RefUpdate[] = [];
  let offset = 0;
  let sawFlush = false;

  while (offset < body.length) {
    // Read the 4-hex-digit length
    if (offset + 4 > body.length) {
      return { refs, ok: false };
    }
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);

    if (isNaN(len)) {
      return { refs, ok: false };
    }

    // Flush packet
    if (len === 0) {
      sawFlush = true;
      break;
    }

    // Length includes the 4-byte prefix itself
    if (len < 4 || offset + len > body.length) {
      return { refs, ok: false };
    }

    const payload = body
      .subarray(offset + 4, offset + len)
      .toString('utf-8')
      .replace(/\n$/, '');

    // Strip capabilities (after \0) from the first line
    const withoutCaps = payload.split('\0')[0];

    // Parse: {old-sha} {new-sha} {ref-name}
    const parts = withoutCaps.split(' ');
    if (parts.length >= 3) {
      refs.push({
        oldSha: parts[0],
        newSha: parts[1],
        refName: parts.slice(2).join(' '),
      });
    }

    offset += len;
  }

  // A well-formed stream must end with a flush packet
  return { refs, ok: sawFlush };
}

/**
 * Check if a ref matches the allowed push refs list.
 * Supports exact matches and wildcard patterns (e.g., "refs/heads/*").
 */
function refMatchesAllowed(refName: string, allowedPushRefs: string[]): boolean {
  for (const pattern of allowedPushRefs) {
    if (pattern === refName) return true;
    // Wildcard: "refs/heads/*" matches any ref under refs/heads/
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // "refs/heads/"
      if (refName.startsWith(prefix)) return true;
    }
    // Legacy: bare branch name matching (e.g., "bouncer/abc-123")
    const branch = refName.replace(/^refs\/heads\//, '');
    if (pattern === branch) return true;
  }
  return false;
}

/**
 * Check if a ref targets a protected branch.
 */
function isProtectedRef(refName: string, protectedBranches: string[]): boolean {
  const branch = refName.replace(/^refs\/heads\//, '');
  return protectedBranches.includes(branch);
}

/**
 * Check if the policy is in the pre-ratchet state (has wildcard push refs).
 */
export function isPushWildcard(policy: GitHubPolicy): boolean {
  return policy.allowedPushRefs.some((r) => r.includes('*'));
}

/**
 * Check if a git push is allowed by the session policy.
 * Each ref update is checked against the allowed push refs and protected branches.
 * Fails closed: if parsing failed or the body is non-empty but yields
 * no refs, the push is denied.
 */
export function evaluateGitPush(
  parseResult: ReceivePackResult,
  policy: GitHubPolicy,
): { allowed: boolean; deniedRef?: string; reason?: string } {
  if (!parseResult.ok) {
    return { allowed: false, reason: 'malformed pkt-line stream' };
  }
  const protectedBranches = policy.protectedBranches ?? [];
  for (const ref of parseResult.refs) {
    // Protected branches are always denied, regardless of allowedPushRefs
    if (isProtectedRef(ref.refName, protectedBranches)) {
      return {
        allowed: false,
        deniedRef: ref.refName,
        reason: `push to protected branch '${ref.refName.replace(/^refs\/heads\//, '')}' is not allowed`,
      };
    }
    if (!refMatchesAllowed(ref.refName, policy.allowedPushRefs)) {
      return { allowed: false, deniedRef: ref.refName };
    }
  }
  return { allowed: true };
}
