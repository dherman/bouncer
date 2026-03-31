# Milestone 7: Network Boundary — Design Document

**Date**: 2026-03-25

## Goal

Add network-level policy enforcement via an HTTP/HTTPS proxy, completing the sandbox boundary. The proxy becomes the **authoritative security layer** for application-level policies — the `gh` shim and git hooks become UX optimizations (fast-reject with better error messages), not the enforcement mechanism.

After M7, the agent cannot bypass policy by using `curl`, `fetch`, `wget`, or any other HTTP client to reach GitHub's API or push to unauthorized branches — all egress routes through the proxy.

## Motivation

M6 closed most bypass paths by containerizing the agent: the real `gh` binary doesn't exist, hooks are mounted read-only, and the system gitconfig is tamper-resistant. But three gaps remain:

| Gap                                  | How the agent can exploit it today                                 |
| ------------------------------------ | ------------------------------------------------------------------ |
| Raw HTTP to GitHub API               | `curl https://api.github.com/repos/.../pulls -X PUT` to merge a PR |
| `--no-verify` on git push            | Skips the pre-push hook entirely; git still pushes via HTTPS       |
| Node.js `fetch` / other HTTP clients | Any code the agent writes or runs can call any API                 |

All three are HTTP-level operations. A proxy that sits between the container and the internet can inspect and enforce policy on every request, regardless of which tool initiated it.

### Role Evolution After M7

| Mechanism            | Role before M7                          | Role after M7                            |
| -------------------- | --------------------------------------- | ---------------------------------------- |
| `gh` shim            | Security (best-effort in container)     | UX (fast-reject + better error messages) |
| Git hooks            | Security (best-effort, read-only mount) | UX (better error messages)               |
| Network proxy        | N/A                                     | **Authoritative security boundary**      |
| Container filesystem | Filesystem isolation                    | Filesystem isolation (unchanged)         |
| ACP                  | Observability                           | Observability (unchanged)                |

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                 Glitter Ball (Electron)                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │          Session Manager (host)                      │    │
│  │                                                      │    │
│  │  ┌─────────────────────────────────────────────┐     │    │
│  │  │  Bouncer Proxy (per-session)                │     │    │
│  │  │                                             │     │    │
│  │  │  • HTTP CONNECT tunnel (non-GitHub HTTPS)   │     │    │
│  │  │  • TLS MITM for api.github.com + github.com │     │    │
│  │  │  • Domain allowlist enforcement             │     │    │
│  │  │  • GitHub REST API policy matching          │     │    │
│  │  │  • GraphQL query inspection                 │     │    │
│  │  │  • Git smart HTTP ref enforcement           │     │    │
│  │  │  • Policy event logging → ACP               │     │    │
│  │  └─────────────┬───────────────────────────────┘     │    │
│  │                │ HTTP/HTTPS                          │    │
│  │  ┌─────────────▼───────────────────────────────┐     │    │
│  │  │  Docker Network (bouncer-net-{sessionId})   │     │    │
│  │  │                                             │     │    │
│  │  │  Container: --network bouncer-net-{id}      │     │    │
│  │  │  HTTP_PROXY / HTTPS_PROXY → host proxy      │     │    │
│  │  │  no direct internet access                  │     │    │
│  │  └─────────────────────────────────────────────┘     │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Key Insight: Selective TLS Interception

We don't need to MITM all HTTPS traffic. Most domains (npm registry, crates.io, CDNs) only need domain-level allowlisting — the proxy sees the `CONNECT` hostname and allows or denies the tunnel without inspecting content. Only traffic to GitHub-owned domains (`api.github.com`, `github.com`, `uploads.github.com`) requires TLS interception to inspect HTTP method + path + body for policy enforcement.

This minimizes the trust surface: the injected CA only decrypts traffic to domains where we need content-level inspection.

## Detailed Design

### Phase 1: Proxy Server (`src/main/proxy.ts`)

A Node.js HTTP proxy server running on the host, one instance per session. Built on Node's `http.createServer` + `net.connect` for CONNECT tunneling + `tls.createSecureContext` for selective MITM.

```typescript
export interface ProxyConfig {
  /** Session ID (for logging and network naming) */
  sessionId: string;
  /** Port to listen on (0 = auto-assign) */
  port: number;
  /** Domains allowed through the proxy */
  allowedDomains: string[];
  /** Domains requiring TLS interception for content inspection */
  inspectedDomains: string[];
  /** GitHub policy for request-level enforcement */
  githubPolicy: GitHubPolicy | null;
  /** CA certificate + key for TLS interception */
  ca: { cert: string; key: string };
  /** Callback for policy events (logged via ACP) */
  onPolicyEvent: (event: PolicyEvent) => void;
}

export interface ProxyHandle {
  /** Assigned port */
  port: number;
  /** Stop the proxy server */
  stop(): Promise<void>;
  /** Update GitHub policy (e.g., after PR capture) */
  updatePolicy(policy: GitHubPolicy): void;
}

export async function startProxy(config: ProxyConfig): Promise<ProxyHandle>;
```

**Request flow:**

1. Container makes HTTPS request → proxy receives `CONNECT host:443`
2. Proxy checks `host` against `allowedDomains`
   - Not in allowlist → `403 Forbidden`, log deny event
   - In allowlist but not in `inspectedDomains` → tunnel directly (no MITM)
   - In `inspectedDomains` → TLS MITM, inspect request

3. For MITM'd connections, the proxy terminates TLS with a dynamically generated certificate (signed by the injected CA), forwards the plaintext HTTP request to the upstream, and applies policy rules before relaying the response.

**Plain HTTP handling:** The proxy also handles plain HTTP requests (non-CONNECT). These follow the same domain allowlist and policy enforcement. In practice, almost all traffic is HTTPS, but `git://` protocol and some package registries may use plain HTTP.

### Phase 2: TLS Interception (`src/main/proxy-tls.ts`)

**CA generation:** At app startup (or first proxy use), generate a self-signed CA certificate and private key. Store in the app's data directory (`app.getPath("userData")/bouncer-ca/`). The CA is per-installation, not per-session — regenerating per session would require re-injecting into the container trust store each time.

```typescript
export interface BouncerCA {
  cert: string; // PEM-encoded CA certificate
  key: string; // PEM-encoded CA private key
  certPath: string; // Path to cert file on disk
}

/** Generate or load the Bouncer CA. */
export async function ensureCA(): Promise<BouncerCA>;

/**
 * Generate a TLS certificate for a specific hostname,
 * signed by the Bouncer CA. Cached per hostname.
 */
export function generateHostCert(hostname: string, ca: BouncerCA): { cert: string; key: string };
```

**Implementation:** Use Node.js `crypto.generateKeyPairSync` + `crypto.X509Certificate` (Node 15+) or the `node-forge` package for X.509 certificate generation. The CA certificate has a long validity period (10 years); host certificates are short-lived (24 hours) and cached in memory.

**Container trust store injection:** The CA certificate is bind-mounted into the container and added to the system trust store at container start:

```
-v /path/to/bouncer-ca.crt:/usr/local/share/ca-certificates/bouncer-ca.crt:ro
```

The container's entrypoint (or a wrapper script) runs `update-ca-certificates` to install it. This makes Node.js (`NODE_EXTRA_CA_CERTS` is a backup), Python (`requests`, `certifi`), curl, git, and other tools trust the proxy's certificates.

**Alternative: `NODE_EXTRA_CA_CERTS` only.** Since the primary agent is Node.js-based (Claude Code), we could skip system trust store injection and set `NODE_EXTRA_CA_CERTS=/path/to/bouncer-ca.crt`. This is simpler but only covers Node.js processes. Git (which uses OpenSSL/libcurl) and any Python tools the agent runs would reject the proxy's certificates. Full system trust store injection is more robust.

### Phase 3: Container Networking (`src/main/proxy-network.ts`)

**Docker network isolation:** Each session gets a dedicated Docker network with restricted egress. The container can only reach the proxy (on the host) and nothing else.

```typescript
export interface SessionNetwork {
  networkName: string;
  /** Remove the network on cleanup */
  cleanup(): Promise<void>;
}

/**
 * Create a Docker network for a session with proxy routing.
 * The container uses this network and routes all traffic through the proxy.
 */
export async function createSessionNetwork(
  sessionId: string,
  proxyPort: number,
): Promise<SessionNetwork>;
```

**Network topology:**

```
docker network create bouncer-net-{sessionId} \
  --driver bridge \
  --label glitterball.managed=true \
  --label glitterball.sessionId={sessionId}
```

The network uses a standard bridge driver. We intentionally do **not** use `--internal` because it blocks DNS resolution of `host.docker.internal`, making the host-based proxy unreachable from the container. Instead, the proxy is the enforcement layer — it blocks disallowed domains via 403 responses. The container reaches the proxy via the Docker host gateway (`host.docker.internal` on Docker Desktop / OrbStack).

**Proxy environment in container:**

```
HTTP_PROXY=http://host.docker.internal:{proxyPort}
HTTPS_PROXY=http://host.docker.internal:{proxyPort}
NO_PROXY=localhost,127.0.0.1
```

These environment variables are respected by `curl`, `wget`, Node.js `fetch` (via `undici`), Python `requests`, `pip`, `npm`, `cargo`, `git` (for HTTP transport), and most other HTTP clients.

**Git configuration:** Git does not respect `HTTP_PROXY`/`HTTPS_PROXY` by default for smart HTTP transport. The system gitconfig (already mounted read-only at `/etc/gitconfig`) needs:

```ini
[http]
    proxy = http://host.docker.internal:{proxyPort}
```

This is added to the generated gitconfig in `generateGitconfig()`.

**Fallback: iptables-based routing.** If `HTTP_PROXY` env vars prove insufficient (some tools ignore them), an alternative is iptables rules inside the container that redirect all TCP port 443 traffic to the proxy. This requires `NET_ADMIN` capability, which weakens the container's security posture. Prefer env var-based routing unless empirical testing reveals gaps.

### Phase 4: Domain Allowlist Enforcement

**Per-policy-template domain lists:**

```typescript
export type NetworkPolicy =
  | { access: 'full' }
  | { access: 'none' }
  | { access: 'filtered'; allowedDomains: string[]; inspectedDomains: string[] };
```

The existing `NetworkPolicy` type gains an `inspectedDomains` field for the `"filtered"` variant. `allowedDomains` controls which domains the proxy tunnels at all; `inspectedDomains` (a subset) controls which get TLS MITM for content inspection.

**Template defaults:**

| Template        | `allowedDomains`                                                                                                                                                     | `inspectedDomains`             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `standard-pr`   | `github.com`, `api.github.com`, `uploads.github.com`, `registry.npmjs.org`, `crates.io`, `static.crates.io`, `index.crates.io`, `pypi.org`, `files.pythonhosted.org` | `api.github.com`, `github.com` |
| `research-only` | `*` (all domains)                                                                                                                                                    | `api.github.com`, `github.com` |
| `permissive`    | `*` (all domains)                                                                                                                                                    | none (no MITM)                 |

**Domain matching rules:**

- Exact match: `api.github.com` matches only `api.github.com`
- Wildcard: `*.github.com` matches `api.github.com`, `uploads.github.com`, etc.
- `*` matches all domains (used for `research-only` and `permissive` templates)

**Denied domain response:** The proxy returns `403 Forbidden` with a body explaining the policy violation:

```
HTTP/1.1 403 Forbidden
Content-Type: text/plain

[bouncer:proxy] domain 'evil.example.com' is not in the allowed domain list for this session.
Policy: standard-pr
Allowed: github.com, api.github.com, registry.npmjs.org, ...
```

### Phase 5: GitHub REST API Policy Enforcement

For MITM'd requests to `api.github.com`, the proxy inspects the HTTP method and URL path and applies the same policy logic as the `gh` shim. **The policy engine is shared** — the `evaluatePolicy` and `parseApiEndpoint` functions in `gh-shim.ts` are refactored into a shared module (`src/main/github-policy-engine.ts`) used by both the shim and the proxy.

```typescript
// src/main/github-policy-engine.ts

/** Evaluate an HTTP request against GitHub policy. */
export function evaluateGitHubRequest(
  method: string,
  path: string,
  policy: GitHubPolicy,
): PolicyDecision;
```

**Default-deny design:** The proxy denies all requests to `api.github.com` unless they match an explicitly allowlisted method + path pattern. This is the opposite of a blocklist — unknown endpoints are denied, not allowed. This makes the security posture straightforward: if it's not in the table, it's blocked.

**REST API allowlist (reuses existing `parseApiEndpoint` logic):**

| Pattern                            | Method  | Decision                            |
| ---------------------------------- | ------- | ----------------------------------- |
| `/repos/{owner}/{repo}/pulls`      | `GET`   | Allow                               |
| `/repos/{owner}/{repo}/pulls`      | `POST`  | Allow if `canCreatePr` (capture PR) |
| `/repos/{owner}/{repo}/pulls/{n}`  | `GET`   | Allow                               |
| `/repos/{owner}/{repo}/pulls/{n}`  | `PATCH` | Allow if `n == ownedPrNumber`       |
| `/repos/{owner}/{repo}/issues`     | `GET`   | Allow                               |
| `/repos/{owner}/{repo}/issues/{n}` | `GET`   | Allow                               |
| `/repos/{owner}/{repo}`            | `GET`   | Allow (repo metadata)               |
| Everything else                    | any     | **Deny**                            |

Note that dangerous operations like `PUT /pulls/{n}/merge`, `DELETE` on any path, `POST /issues` (create issue), and `POST /graphql` are all denied implicitly — they simply aren't in the allowlist.

**Why no GraphQL support.** GitHub's GraphQL endpoint (`POST /graphql`) accepts arbitrary queries in the request body. Unlike the REST API, where the HTTP method + path fully determines the operation's intent, GraphQL bundles everything into a single `POST` endpoint. Extracting intent requires parsing the query body, inspecting operation names, and for mutations like `UpdatePullRequest`, inspecting the `input` variables to determine which PR is targeted (using opaque node IDs, not PR numbers). This is a significant parsing burden with an inherently leaky abstraction — the proxy would need to understand GitHub's GraphQL schema to enforce PR-scoped constraints.

Since the `gh` CLI uses the REST API, and the shim's direct API mode (M6) also calls REST endpoints, the agent's standard tooling never hits `/graphql`. An agent would have to deliberately construct GraphQL queries to work around the REST allowlist — and under deny-by-default, those requests are simply blocked. If future agent tooling requires GraphQL access, we can add specific query/mutation allowlisting as an enhancement.

**PR capture via proxy:** When the proxy allows a `POST /repos/{owner}/{repo}/pulls` (create PR), it reads the response body to extract the PR number and updates the session's `GitHubPolicy` (sets `ownedPrNumber`, clears `canCreatePr`). This mirrors the shim's PR capture logic. The proxy calls `onPolicyEvent` to notify the session manager, which persists the updated policy state.

**Cross-repo enforcement:** The proxy checks whether the target repo (parsed from the URL path) matches `policy.repo`. Requests to other repos are denied. This closes the gap where the agent could `curl` a different repo's API.

### Phase 7: Git Smart HTTP Transport

Git's smart HTTP protocol uses two endpoints:

1. **`GET /repo.git/info/refs?service=git-receive-pack`** — ref advertisement (pre-push discovery)
2. **`POST /repo.git/git-receive-pack`** — the actual push (contains ref updates)

The proxy inspects the `git-receive-pack` POST body to enforce branch restrictions.

**Git pack protocol parsing:**

The `git-receive-pack` request body uses the git pkt-line format. Each ref update is encoded as:

```
<old-sha> <new-sha> <ref-name>
```

The proxy extracts ref names from the pkt-line stream and checks each against `policy.allowedPushRefs`.

```typescript
/**
 * Parse git pkt-line format to extract ref updates from a
 * git-receive-pack request body.
 */
export function parseGitReceivePack(body: Buffer): Array<{
  oldSha: string;
  newSha: string;
  refName: string;
}>;

/**
 * Check if a git push is allowed by the session policy.
 * Returns the first denied ref, or null if all refs are allowed.
 */
export function evaluateGitPush(
  refs: Array<{ refName: string }>,
  policy: GitHubPolicy,
): { allowed: boolean; deniedRef?: string };
```

**Enforcement:** If any ref update targets a non-allowed branch, the proxy returns a `403` response before forwarding the request to GitHub. This completely closes the `--no-verify` bypass — the hook never ran, but the proxy blocks the push anyway.

**Git transport URL matching:** Git smart HTTP requests go to `github.com` (not `api.github.com`). The URL pattern is:

```
POST https://github.com/{owner}/{repo}.git/git-receive-pack
```

The proxy recognizes this pattern and applies git-specific policy enforcement.

### Phase 8: Policy Template Updates

**`NetworkPolicy` type update:**

```typescript
export type NetworkPolicy =
  | { access: 'full' }
  | { access: 'none' }
  | { access: 'filtered'; allowedDomains: string[]; inspectedDomains: string[] };
```

**`standard-pr` template update:**

```typescript
export const standardPrTemplate: PolicyTemplate = {
  id: 'standard-pr',
  name: 'Standard PR',
  description: 'Read-write worktree, network filtered to GitHub + package registries',
  filesystem: {
    /* unchanged */
  },
  network: {
    access: 'filtered',
    allowedDomains: [
      'github.com',
      'api.github.com',
      'uploads.github.com',
      'registry.npmjs.org',
      'crates.io',
      'static.crates.io',
      'index.crates.io',
      'pypi.org',
      'files.pythonhosted.org',
    ],
    inspectedDomains: ['api.github.com', 'github.com'],
  },
  // ... rest unchanged
};
```

**`ContainerConfig` update:**

The `networkMode` field changes from `"none" | "bridge"` to `"none" | "bridge" | "proxy"`. When `"proxy"`, the container is attached to a session-specific internal Docker network with proxy routing.

```typescript
export interface ContainerConfig {
  sessionId: string;
  image: string;
  command: string[];
  workdir: string;
  mounts: ContainerMount[];
  env: Record<string, string>;
  networkMode: 'none' | 'bridge' | 'proxy';
  /** Docker network name (required when networkMode is "proxy") */
  networkName?: string;
}
```

### Phase 9: Session Manager Integration

**Session creation flow (additions):**

```
createSession()
  ├─ ... existing M6 steps ...
  ├─ Generate/load Bouncer CA (ensureCA)
  ├─ Start per-session proxy (startProxy)
  ├─ Create per-session Docker network (createSessionNetwork)
  ├─ Build ContainerConfig with networkMode: "proxy"
  ├─ Inject CA cert mount + proxy env vars into container config
  ├─ Spawn container on session network
  └─ ... existing ACP setup ...
```

**Session teardown flow (additions):**

```
closeSession()
  ├─ ... existing M6 steps ...
  ├─ Stop proxy server
  ├─ Remove Docker network
  └─ ... existing cleanup ...
```

**Orphan cleanup:** Networks matching `bouncer-net-*` that don't correspond to active sessions are removed at startup.

**Policy state synchronization:** When the proxy captures a PR (from a `POST /pulls` response), it updates the shared `GitHubPolicy` state via the session manager's `onPolicyEvent` callback. The session manager writes the updated state to the policy file, so the `gh` shim (which still runs first for UX) sees the updated PR number.

### Phase 10: CA Certificate in Container

**Dockerfile update (`docker/agent.Dockerfile`):**

```dockerfile
# ... existing content ...

# Prepare CA trust store directory for runtime injection
# The CA cert is bind-mounted at container start
RUN mkdir -p /usr/local/share/ca-certificates/bouncer

# Entrypoint wrapper that installs the CA cert before starting the agent
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**`docker/entrypoint.sh`:**

```bash
#!/bin/bash
set -e

# Install Bouncer CA certificate if present
CA_CERT="/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt"
if [ -f "$CA_CERT" ]; then
  update-ca-certificates 2>/dev/null || true
  # Also set NODE_EXTRA_CA_CERTS as a belt-and-suspenders measure
  export NODE_EXTRA_CA_CERTS="$CA_CERT"
fi

exec "$@"
```

**Mount:** The CA cert is added to the container's mount table:

```typescript
mounts.push({
  hostPath: ca.certPath,
  containerPath: '/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt',
  readOnly: true,
});
```

### Phase 11: Proxy Bypass Prevention

The proxy is only effective if the container's traffic goes through it. Since we use a standard bridge network (not `--internal` — see Phase 3 note), network-level blocking is not available. Instead, enforcement relies on proxy env vars, read-only config mounts, and the fact that all standard tooling (curl, git, npm, cargo, pip, Node.js) respects `HTTP_PROXY`/`HTTPS_PROXY`.

| Attack                                        | Mitigation                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct IP connection (bypass proxy env vars)  | Most tools respect proxy env vars; a determined agent could bypass, but this requires explicit low-level socket code — unlikely in normal agent workflows. Future hardening: iptables rules or `--internal` network with sidecar proxy container. |
| DNS resolution to external IP                 | Standard tools resolve via the proxy when `HTTPS_PROXY` is set (CONNECT tunnel); direct DNS is available but connections without the proxy are unmonitored, not blocked                                                                           |
| Agent unsets `HTTP_PROXY` env vars            | Env vars set at container start; agent can unset in child processes. Mitigated by read-only gitconfig with proxy setting, and by the fact that Claude Code itself respects env vars.                                                              |
| Agent modifies `/etc/gitconfig` proxy setting | System gitconfig is mounted read-only                                                                                                                                                                                                             |
| Agent uses a SOCKS proxy or tunnel            | Outbound connectivity is available on the bridge network; this is a known gap accepted for M7 scope                                                                                                                                               |

**Why not `--internal`?** Docker's `--internal` flag blocks all egress including DNS resolution of `host.docker.internal`, making the host-based proxy unreachable. An alternative architecture (sidecar proxy container on the same internal network) would restore network-level isolation but adds operational complexity. For M7, proxy-based enforcement is sufficient — the threat model assumes a non-adversarial agent that may be careless but is not actively trying to exfiltrate data.

**Verification test:** From inside the container, `curl --proxy http://host.docker.internal:{port} https://api.github.com` should succeed. `curl --proxy http://host.docker.internal:{port} https://evil.example.com` should return 403.

### Phase 12: Observability

**Policy events from the proxy** use the same `PolicyEvent` type as the `gh` shim and git hooks:

```typescript
{
  timestamp: number;
  tool: "proxy";  // New tool type
  operation: string;  // e.g., "CONNECT api.github.com", "POST /repos/.../pulls"
  decision: "allow" | "deny";
  reason?: string;
}
```

The `PolicyEvent.tool` type is extended to include `"proxy"`.

**Logging levels:**

- **Deny events:** Always logged via ACP (surfaced in the UI event log)
- **Allow events for inspected domains:** Logged at debug level (available in session details)
- **Allow events for tunneled (non-inspected) domains:** Not logged individually (too noisy); the CONNECT hostname is logged at trace level

**UI additions:**

- Proxy status indicator in session details (running/stopped/error)
- Network policy badge: "Filtered" / "Full" / "None"
- Proxy deny events appear in the sandbox event log alongside `gh` shim and git hook events

## Implementation Phases

### Phase A: Proxy Foundation

1. Implement `src/main/proxy-tls.ts` — CA generation and host certificate minting
2. Implement `src/main/proxy.ts` — HTTP proxy server with CONNECT tunneling and domain allowlist
3. Unit tests: domain matching, CA generation, certificate signing
4. Manual test: proxy a curl request through it, verify domain filtering

### Phase B: TLS Interception

5. Add selective MITM for inspected domains (TLS termination + re-encryption)
6. Implement dynamic host certificate generation (signed by Bouncer CA)
7. Test: MITM'd request to api.github.com returns correct response
8. Test: non-inspected domain is tunneled without MITM

### Phase C: Container Networking

9. Implement `src/main/proxy-network.ts` — Docker network creation/cleanup
10. Update `docker/agent.Dockerfile` with entrypoint for CA cert installation
11. Update `ContainerConfig` type with `"proxy"` network mode
12. Update `policyToContainerConfig()` to inject proxy env vars, CA cert mount, git proxy config
13. Integration test: container routes traffic through proxy, direct egress blocked

### Phase D: GitHub Policy Engine Extraction

14. Extract `evaluatePolicy`/`parseApiEndpoint` from `gh-shim.ts` into `src/main/github-policy-engine.ts`
15. Update `gh-shim.ts` to import from the shared module
16. Wire proxy request handler to call the shared policy engine
17. Test: proxy enforces same policy decisions as `gh` shim

### Phase E: GitHub API Enforcement

18. Implement REST API policy matching in proxy (method + path → allow/deny via allowlist)
19. Implement PR capture from proxy response body
20. Test: `POST /pulls` allowed and PR captured; `PUT /pulls/{n}/merge` denied
21. Test: `POST /graphql` denied (not in allowlist); unknown endpoints denied

### Phase F: Git Smart HTTP Enforcement

22. Implement `git-receive-pack` pkt-line parser
23. Implement ref-update extraction and branch policy enforcement
24. Test: push to allowed branch goes through; push to `main` blocked at proxy
25. Test: `--no-verify` does NOT bypass the proxy (the whole point)

### Phase G: Session Manager Integration

26. Update `createSession` to start proxy + create network before spawning container
27. Update `closeSession` to stop proxy + remove network
28. Update orphan cleanup for networks
29. Wire proxy policy events to ACP session event stream
30. End-to-end test: full PR workflow through proxy

### Phase H: Policy Templates and UI

31. Update `NetworkPolicy` type with `inspectedDomains`
32. Update `standard-pr` template with domain allowlist
33. Update `PolicyEvent.tool` to include `"proxy"`
34. Add proxy status and network policy badges to session UI
35. Proxy deny events visible in sandbox event log

## Files Changed

| File                               | Change                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/proxy.ts`                | **New** — HTTP/HTTPS proxy server with domain filtering and GitHub policy enforcement                                                      |
| `src/main/proxy-tls.ts`            | **New** — CA generation, host certificate minting, certificate caching                                                                     |
| `src/main/proxy-network.ts`        | **New** — Docker network creation/cleanup for proxy routing                                                                                |
| `src/main/github-policy-engine.ts` | **New** — shared policy evaluation logic (extracted from gh-shim.ts)                                                                       |
| `docker/entrypoint.sh`             | **New** — container entrypoint that installs CA cert before running agent                                                                  |
| `docker/agent.Dockerfile`          | **Modified** — add entrypoint, CA cert directory                                                                                           |
| `src/main/gh-shim.ts`              | **Modified** — import policy logic from shared module                                                                                      |
| `src/main/types.ts`                | **Modified** — `NetworkPolicy` gains `inspectedDomains`; `PolicyEvent.tool` gains `"proxy"`; `ContainerConfig.networkMode` gains `"proxy"` |
| `src/main/policy-templates.ts`     | **Modified** — `standard-pr` gets domain allowlist and filtered network                                                                    |
| `src/main/container.ts`            | **Modified** — support `"proxy"` network mode (attach to named network instead of `--network bridge`)                                      |
| `src/main/policy-container.ts`     | **Modified** — inject proxy env vars, CA cert mount, git proxy config into container config                                                |
| `src/main/session-manager.ts`      | **Modified** — proxy lifecycle, network lifecycle, policy state sync from proxy                                                            |
| `src/main/container-monitor.ts`    | **Modified** — minor: proxy-related container events                                                                                       |

## Risks and Mitigations

| Risk                                                             | Likelihood | Impact                                                               | Mitigation                                                                                                                                    |
| ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS interception breaks pinned certificates                      | Medium     | Tools that pin GitHub's cert will reject proxy's cert                | `NODE_EXTRA_CA_CERTS` + system trust store covers most tools; document known incompatibilities                                                |
| Proxy adds latency to every HTTP request                         | Low-Medium | Noticeable for high-frequency API calls (npm install)                | Non-inspected domains are tunneled directly (no TLS termination overhead); proxy runs on localhost                                            |
| Git pkt-line parsing is incorrect or incomplete                  | Medium     | Push allowed/denied incorrectly                                      | Extensive test coverage against known git push payloads; fall back to deny on parse error                                                     |
| REST allowlist too narrow for future use cases                   | Low        | Agent can't perform legitimate API operations beyond the PR workflow | Allowlist is easy to extend per-template; `research-only` and `permissive` templates can use broader allowlists or bypass inspection          |
| Some HTTP clients ignore `HTTP_PROXY`                            | Low        | Traffic bypasses proxy and reaches the internet unmonitored          | Standard tools (curl, git, npm, cargo, pip, Node.js) all respect proxy env vars; iptables fallback or sidecar proxy if gaps found empirically |
| Agent deliberately bypasses proxy env vars                       | Low        | Unmonitored egress via direct socket connections                     | Accepted for M7 — threat model assumes non-adversarial agent; future hardening via iptables or sidecar proxy on `--internal` network          |
| Container startup latency increases (CA install + network setup) | Low        | `update-ca-certificates` adds ~100ms; network creation adds ~200ms   | Acceptable; CA install is one-time per container start                                                                                        |

## Open Questions

1. **Per-session vs. shared proxy?** This design uses one proxy per session for isolation (each session has its own policy). A shared proxy would reduce resource usage but require multiplexing session identity (e.g., via the source container IP). Start with per-session; consolidate if resource usage is a problem.

2. **npm/cargo/pip registry authentication.** If the agent needs to install packages from private registries, the proxy must tunnel those credentials. For M7, we assume public registries only. Private registry support can be added by extending the allowlist and forwarding auth headers.

3. **WebSocket support.** Some GitHub features use WebSocket (e.g., Copilot). The proxy's CONNECT handler naturally supports WebSocket upgrade through tunneled connections. For inspected domains, WebSocket MITM would require additional handling. Defer until needed.

4. **Proxy process lifecycle.** If the proxy crashes, the container loses all network access (which is safe — it fails closed). Should we auto-restart the proxy? For M7, let the session error out; the user can create a new session.

5. **Performance impact on `npm install`.** A large `npm install` makes hundreds of HTTPS requests to `registry.npmjs.org`. These are tunneled (not MITM'd), so overhead is minimal (one extra TCP hop through localhost). Measure to confirm.

## Non-Goals

- **UDP traffic inspection** — DNS over UDP is handled by the Docker network's DNS configuration; all other relevant traffic is TCP/HTTP
- **GitHub GraphQL API support** — the `gh` CLI and shim use the REST API; GraphQL is denied by default under the allowlist model and can be added later if agent tooling requires it
- **Non-GitHub API enforcement** — generalizing to npm publish, AWS API, etc. is deferred to a future milestone
- **Certificate pinning bypass** — if a tool pins GitHub's certificate, it will fail; we document this rather than working around it
- **Windows/Linux host support** — OrbStack is macOS-only; Docker Desktop support is a future consideration
- **Proxy chaining** — if the host is behind a corporate proxy, the Bouncer proxy would need to chain through it; deferred
- **HTTP/2 or HTTP/3 inspection** — the proxy handles HTTP/1.1; most tools fall back to HTTP/1.1 through a proxy
