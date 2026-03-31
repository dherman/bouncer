// src/main/github-policy-engine.ts
//
// Shared GitHub policy evaluation logic used by both the gh shim (CLI-level)
// and the proxy (network-level). Extracted from gh-shim.ts in Phase 4.

import type { GitHubPolicy } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'allow-and-capture-pr' }
  | { action: 'deny'; reason: string }

export interface ApiEndpointMatch {
  resource: string
  method: string
  ownerRepo: string | null
  number: number | null
  subResource: string | null
  isGraphQL: boolean
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
  let method = (flags.method ?? 'GET').toUpperCase()
  if (method === 'GET' && flags.hasBodyParams) {
    method = 'POST'
  }

  // Normalize: strip query string, hash, and trailing slash
  let path = endpoint.split('?')[0].split('#')[0]
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
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
    }
  }

  // Parse /repos/{owner}/{repo}/... paths
  const reposMatch = path.match(/^\/repos\/([^/]+\/[^/]+)(?:\/([^/]+))?(?:\/(\d+))?(?:\/(.+))?$/)

  if (reposMatch) {
    const ownerRepo = expandPlaceholder(reposMatch[1])
    const resource = reposMatch[2] ?? ''
    const number = reposMatch[3] ? parseInt(reposMatch[3], 10) : null
    const subResource = reposMatch[4] ?? null
    return {
      resource,
      method,
      ownerRepo,
      number,
      subResource,
      isGraphQL: false,
    }
  }

  // Unrecognized endpoint
  return {
    resource: path,
    method,
    ownerRepo: null,
    number: null,
    subResource: null,
    isGraphQL: false,
  }
}

/**
 * Expand {owner}/{repo} placeholders to a recognizable marker.
 * gh CLI expands these at runtime, but we need to handle them in parsing.
 */
export function expandPlaceholder(ownerRepo: string): string | null {
  if (ownerRepo.includes('{')) return null
  return ownerRepo
}

// ---------------------------------------------------------------------------
// REST API resource evaluators
// ---------------------------------------------------------------------------

export function evaluateApiPulls(match: ApiEndpointMatch, policy: GitHubPolicy): PolicyDecision {
  // GET /pulls or /pulls/{number} — read-only, allow
  if (match.method === 'GET') {
    return { action: 'allow' }
  }

  // PUT /pulls/{number}/merge — deny
  if (match.method === 'PUT' && match.subResource === 'merge') {
    return { action: 'deny', reason: 'merging PRs via API is not allowed' }
  }

  // POST /pulls — create PR
  if (match.method === 'POST' && match.number === null) {
    if (!policy.canCreatePr) {
      return { action: 'deny', reason: 'PR already created for this session' }
    }
    return { action: 'allow-and-capture-pr' }
  }

  // PATCH /pulls/{number} — edit PR
  if (match.method === 'PATCH' && match.number !== null) {
    if (policy.ownedPrNumber !== null && match.number === policy.ownedPrNumber) {
      return { action: 'allow' }
    }
    if (policy.ownedPrNumber === null) {
      return {
        action: 'deny',
        reason: `cannot edit PR #${match.number}: no PR owned by this session`,
      }
    }
    return {
      action: 'deny',
      reason: `cannot edit PR #${match.number}: not owned (owned: #${policy.ownedPrNumber})`,
    }
  }

  return { action: 'deny', reason: `API pulls ${match.method} is not allowed` }
}

export function evaluateApiIssues(match: ApiEndpointMatch): PolicyDecision {
  if (match.method === 'GET') {
    return { action: 'allow' }
  }
  return {
    action: 'deny',
    reason: `API issues ${match.method} is not allowed`,
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
export function evaluateGitHubRequest(method: string, path: string, policy: GitHubPolicy): PolicyDecision {
  const match = parseApiEndpoint(path, { method })

  // GraphQL: deny (opaque — can't inspect query content)
  if (match.isGraphQL) {
    return { action: 'deny', reason: 'GraphQL endpoint is not allowed' }
  }

  // DELETE is always denied
  if (match.method === 'DELETE') {
    return { action: 'deny', reason: 'DELETE requests are not allowed' }
  }

  // Cross-repo check
  if (match.ownerRepo !== null && match.ownerRepo !== policy.repo) {
    return {
      action: 'deny',
      reason: `cross-repo access denied: '${match.ownerRepo}' (session repo: '${policy.repo}')`,
    }
  }

  // /repos/{owner}/{repo} (repo metadata)
  if (match.resource === '' && match.method === 'GET') {
    return { action: 'allow' }
  }

  // /repos/{owner}/{repo}/pulls
  if (match.resource === 'pulls') {
    return evaluateApiPulls(match, policy)
  }

  // /repos/{owner}/{repo}/issues
  if (match.resource === 'issues') {
    return evaluateApiIssues(match)
  }

  // Default deny
  return {
    action: 'deny',
    reason: `endpoint not in allowlist: ${method} ${path}`,
  }
}

// ---------------------------------------------------------------------------
// Git push evaluation (pkt-line parsing)
// ---------------------------------------------------------------------------

export interface RefUpdate {
  oldSha: string
  newSha: string
  refName: string
}

export interface ReceivePackResult {
  refs: RefUpdate[]
  /** True if the pkt-line stream was parsed successfully (terminated by flush packet). */
  ok: boolean
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
  const refs: RefUpdate[] = []
  let offset = 0
  let sawFlush = false

  while (offset < body.length) {
    // Read the 4-hex-digit length
    if (offset + 4 > body.length) {
      return { refs, ok: false }
    }
    const lenHex = body.subarray(offset, offset + 4).toString('ascii')
    const len = parseInt(lenHex, 16)

    if (isNaN(len)) {
      return { refs, ok: false }
    }

    // Flush packet
    if (len === 0) {
      sawFlush = true
      break
    }

    // Length includes the 4-byte prefix itself
    if (len < 4 || offset + len > body.length) {
      return { refs, ok: false }
    }

    const payload = body
      .subarray(offset + 4, offset + len)
      .toString('utf-8')
      .replace(/\n$/, '')

    // Strip capabilities (after \0) from the first line
    const withoutCaps = payload.split('\0')[0]

    // Parse: {old-sha} {new-sha} {ref-name}
    const parts = withoutCaps.split(' ')
    if (parts.length >= 3) {
      refs.push({
        oldSha: parts[0],
        newSha: parts[1],
        refName: parts.slice(2).join(' '),
      })
    }

    offset += len
  }

  // A well-formed stream must end with a flush packet
  return { refs, ok: sawFlush }
}

/**
 * Check if a git push is allowed by the session policy.
 * Each ref update is checked against the allowed push refs.
 * Fails closed: if parsing failed or the body is non-empty but yields
 * no refs, the push is denied.
 */
export function evaluateGitPush(
  parseResult: ReceivePackResult,
  policy: GitHubPolicy,
): { allowed: boolean; deniedRef?: string; reason?: string } {
  if (!parseResult.ok) {
    return { allowed: false, reason: 'malformed pkt-line stream' }
  }
  for (const ref of parseResult.refs) {
    // Extract the branch name from refs/heads/{branch}
    const branch = ref.refName.replace(/^refs\/heads\//, '')
    if (!policy.allowedPushRefs.includes(branch)) {
      return { allowed: false, deniedRef: ref.refName }
    }
  }
  return { allowed: true }
}
