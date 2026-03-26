# Milestone 7: Network Boundary — Implementation Plan

**Date**: 2026-03-26
**Design**: [design.md](design.md)

This plan breaks M7 into phases, each delivering a testable increment. The core sequencing is: proxy infrastructure first (Phases 1-3), then policy enforcement (Phases 4-6), then integration (Phases 7-8). Phase 4 (policy engine extraction) can be developed in parallel with Phases 1-3.

## Progress

- [x] **[Phase 1: CA Generation + TLS Primitives](#phase-1-ca-generation--tls-primitives)**
  - [x] 1.1 Implement `ensureCA()` in `proxy-tls.ts`
  - [x] 1.2 Implement `generateHostCert()` with in-memory caching
  - [x] 1.3 Store CA in `app.getPath("userData")/bouncer-ca/`
  - [x] 1.4 Test: generate CA, mint host cert, verify chain with `tls.connect`
- [x] **[Phase 2: HTTP Proxy with Domain Filtering](#phase-2-http-proxy-with-domain-filtering)**
  - [x] 2.1 Implement `startProxy()` in `proxy.ts` — HTTP CONNECT handler + domain allowlist
  - [x] 2.2 Add plain HTTP request forwarding with domain check
  - [x] 2.3 Add selective TLS MITM for inspected domains
  - [x] 2.4 Implement `domainMatches()` with exact, wildcard, and `*` patterns
  - [x] 2.5 Test: allowed domain tunnels through; denied domain gets 403; inspected domain is MITM'd
- [x] **[Phase 3: Container Networking](#phase-3-container-networking)**
  - [x] 3.1 Implement `createSessionNetwork()` and `cleanup()` in `proxy-network.ts`
  - [x] 3.2 Update `docker/agent.Dockerfile` with entrypoint for CA cert installation
  - [x] 3.3 Create `docker/entrypoint.sh`
  - [x] 3.4 Add `"proxy"` to `ContainerConfig.networkMode` and `buildDockerRunArgs()`
  - [x] 3.5 Test: container on session network routes traffic through proxy, proxy blocks denied domains
- [x] **[Phase 4: GitHub Policy Engine Extraction](#phase-4-github-policy-engine-extraction)** *(parallel with Phases 1-3)*
  - [x] 4.1 Create `github-policy-engine.ts` with `evaluateGitHubRequest()`
  - [x] 4.2 Extract `parseApiEndpoint()` and REST allowlist logic from `gh-shim.ts`
  - [x] 4.3 Update `gh-shim.ts` to import from shared module
  - [x] 4.4 Test: all existing `gh-shim` policy tests pass with shared engine
- [x] **[Phase 5: GitHub REST API Enforcement in Proxy](#phase-5-github-rest-api-enforcement-in-proxy)**
  - [x] 5.1 Wire MITM request handler for `api.github.com` to `evaluateGitHubRequest()`
  - [x] 5.2 Implement PR capture from `POST /pulls` response body
  - [x] 5.3 Implement cross-repo enforcement (URL repo vs. `policy.repo`)
  - [x] 5.4 Default-deny: unrecognized endpoints return 403
  - [x] 5.5 Test: REST allowlist enforced; `POST /graphql` denied; PR captured
- [ ] **[Phase 6: Git Smart HTTP Enforcement](#phase-6-git-smart-http-enforcement)**
  - [ ] 6.1 Implement `parseGitReceivePack()` pkt-line parser in `github-policy-engine.ts`
  - [ ] 6.2 Implement `evaluateGitPush()` ref-name checker
  - [ ] 6.3 Wire MITM handler for `github.com` `git-receive-pack` requests
  - [ ] 6.4 Test: push to allowed branch passes; push to `main` blocked; `--no-verify` still blocked
- [ ] **[Phase 7: Session Manager Integration](#phase-7-session-manager-integration)**
  - [ ] 7.1 Update `createSession` to start proxy + create network before spawning container
  - [ ] 7.2 Update `policyToContainerConfig()` to inject proxy env vars, CA cert mount, git proxy config
  - [ ] 7.3 Update `generateGitconfig()` to add `[http] proxy` setting
  - [ ] 7.4 Update `closeSession` to stop proxy + remove network
  - [ ] 7.5 Update orphan cleanup for networks
  - [ ] 7.6 Wire proxy policy events to ACP session event stream
  - [ ] 7.7 Test: end-to-end PR workflow through proxy
- [ ] **[Phase 8: Policy Templates, UI, and Validation](#phase-8-policy-templates-ui-and-validation)**
  - [ ] 8.1 Update `NetworkPolicy` type with `inspectedDomains`
  - [ ] 8.2 Update `standard-pr` template with domain allowlist
  - [ ] 8.3 Update `PolicyEvent.tool` to include `"proxy"`
  - [ ] 8.4 Update `policy-event-parser.ts` to parse `[bouncer:proxy]` lines
  - [ ] 8.5 Add proxy status and network policy badges to session UI
  - [ ] 8.6 Full validation checklist
  - [ ] 8.7 Update `docs/roadmap.md` — mark M7 complete

---

## Phase 1: CA Generation + TLS Primitives

**Goal**: Generate a self-signed CA and mint per-hostname certificates that form a valid TLS chain.

### New file: `src/main/proxy-tls.ts`

**`BouncerCA` interface:**
```typescript
export interface BouncerCA {
  cert: string;      // PEM-encoded CA certificate
  key: string;       // PEM-encoded CA private key
  certPath: string;  // Path to cert file on disk (for container bind-mount)
}
```

**`ensureCA(): Promise<BouncerCA>`**
- Compute CA directory: `join(app.getPath("userData"), "bouncer-ca")`
- If `bouncer-ca.crt` and `bouncer-ca.key` exist, load and return them
- Otherwise generate a new CA:
  - `crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })` for the CA key pair
  - Use the `node-forge` package to build a self-signed X.509 certificate:
    - Subject/Issuer: `CN=Bouncer Proxy CA, O=Bouncer`
    - Validity: 10 years
    - Basic Constraints: `cA: true`
    - Key Usage: `keyCertSign`, `cRLSign`
  - Write `bouncer-ca.crt` and `bouncer-ca.key` to the CA directory (mode `0o600` for key)
  - Return the `BouncerCA`

**Why `node-forge`**: Node's built-in `crypto` module can generate keys but has limited X.509 certificate construction support (no `crypto.createCertificate`). `node-forge` is a mature, well-maintained library specifically for this purpose. It adds ~500KB to the bundle. Alternative: shell out to `openssl` — simpler but creates a runtime dependency on the OpenSSL CLI being installed.

**`generateHostCert(hostname, ca): { cert: string; key: string }`**
- Check in-memory cache (`Map<string, { cert, key, expiresAt }>`)
- If cached and not expired, return it
- Otherwise generate:
  - New RSA key pair (2048-bit)
  - X.509 certificate signed by the CA:
    - Subject: `CN={hostname}`
    - SAN (Subject Alternative Name): `DNS:{hostname}`
    - Validity: 24 hours
    - Issuer: CA's subject
    - Signed with CA's private key
  - Cache with 24-hour TTL
  - Return `{ cert, key }`

### Changes to `package.json`

Add `node-forge` as a dependency:
```
npm install node-forge
npm install -D @types/node-forge
```

### Testing

Unit tests for `proxy-tls.ts`:
- `ensureCA()` generates a valid CA cert (parse with `crypto.X509Certificate`, verify `ca` flag is true)
- `ensureCA()` is idempotent — second call loads from disk, returns same cert
- `generateHostCert("api.github.com", ca)` returns a cert signed by the CA
- Verify the chain: `tls.connect` to a test HTTPS server using the host cert succeeds when the CA is trusted (via `ca` option)
- Cache behavior: second call for same hostname returns cached cert; different hostname generates a new one

### Exit criteria
- CA persists across app restarts (loaded from disk)
- Host certificates form a valid TLS chain with the CA
- Certificate generation is fast (<50ms per hostname)

---

## Phase 2: HTTP Proxy with Domain Filtering

**Goal**: A working HTTP proxy that tunnels allowed domains, blocks denied domains, and performs TLS MITM on inspected domains.

### New file: `src/main/proxy.ts`

**`ProxyConfig` and `ProxyHandle`** — as specified in design doc.

**`startProxy(config: ProxyConfig): Promise<ProxyHandle>`**

Creates an `http.Server` that handles two types of requests:

**1. CONNECT requests (HTTPS tunneling)**

```typescript
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");

  if (!domainAllowed(host, config.allowedDomains)) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.write(formatDenyMessage(host, config));
    clientSocket.destroy();
    config.onPolicyEvent({ /* deny event */ });
    return;
  }

  if (domainInspected(host, config.inspectedDomains)) {
    // TLS MITM path — see below
    handleMitm(host, port, clientSocket, head, config);
    return;
  }

  // Tunnel path — connect directly to upstream
  const upstream = net.connect(parseInt(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
});
```

**2. Plain HTTP requests**

```typescript
server.on("request", (req, res) => {
  const url = new URL(req.url);
  if (!domainAllowed(url.hostname, config.allowedDomains)) {
    res.writeHead(403);
    res.end(formatDenyMessage(url.hostname, config));
    return;
  }
  // Forward the request to upstream
  forwardHttpRequest(req, res, url);
});
```

**3. TLS MITM handler (`handleMitm`)**

When a CONNECT request targets an inspected domain:
1. Tell the client the tunnel is established (`200 Connection Established`)
2. Create a TLS server socket using `generateHostCert(host, config.ca)`:
   ```typescript
   const tlsSocket = new tls.TLSSocket(clientSocket, {
     isServer: true,
     cert: hostCert.cert,
     key: hostCert.key,
   });
   ```
3. Parse HTTP requests from the decrypted stream (use Node's `http` module with `createServer` on the TLS socket, or a lightweight HTTP parser)
4. For each request, apply policy (Phase 5 wires this up — for now, forward all requests)
5. Forward to the real upstream via a new TLS connection to `host:443`
6. Relay the response back through the MITM'd socket

**Implementation note on parsing MITM'd HTTP:** The simplest approach is to use `httpProxy` or manually pipe the decrypted stream. However, for policy enforcement we need to inspect the request before forwarding. Options:

| Approach | Pros | Cons |
|---|---|---|
| **A: Full HTTP parse** — use `http.createServer` on the decrypted socket | Clean request/response API; can modify or reject before forwarding | Requires wrapping the TLS socket in a new HTTP server |
| **B: Manual stream parse** — read headers, buffer body if needed | Lower overhead; minimal dependencies | Must handle chunked encoding, keep-alive, etc. |
| **C: Use `http-mitm-proxy` or similar library** | Handles the hard parts (HTTP parsing, keep-alive, connection pooling) | External dependency; may not be maintained |

**Recommended: Approach A** — create an `http.Server` bound to the decrypted TLS socket. This gives us a standard `(req, res)` callback where we can inspect the request, call the policy engine, and either forward to upstream or return 403. Node's `http` module handles chunked encoding, keep-alive, and other HTTP details.

**`domainMatches(hostname, pattern): boolean`**
- `*` matches everything
- `*.example.com` matches `foo.example.com`, `bar.example.com`, but not `example.com`
- `example.com` matches only `example.com`

**`ProxyHandle.updatePolicy(policy)`**: Replaces the `githubPolicy` reference. Called by the session manager when the proxy itself captures a PR (or when the shim captures one and the session manager synchronizes state).

**Port assignment**: Listen on port `0` (OS-assigned), then read `server.address().port`. Return it in the `ProxyHandle` so the session manager can inject it into the container env.

**`ProxyHandle.stop()`**: Close the HTTP server, destroy all open sockets, resolve when fully shut down.

### Testing

Unit tests:
- `domainMatches`: exact, wildcard, `*`, no-match cases
- `startProxy` + `curl --proxy http://localhost:{port}`:
  - Allowed domain: `curl --proxy ... http://httpbin.org/get` → 200
  - Denied domain: `curl --proxy ... http://evil.example.com/` → 403
  - CONNECT to allowed non-inspected domain: tunnel established
  - CONNECT to denied domain: 403

Integration test (requires CA from Phase 1):
- Start proxy with MITM for `api.github.com`
- `curl --proxy ... --cacert bouncer-ca.crt https://api.github.com/` → response returned (MITM'd but forwarded)
- Verify the certificate presented to the client is signed by the Bouncer CA

### Exit criteria
- Proxy correctly tunnels allowed domains
- Proxy blocks denied domains with 403 and a descriptive message
- MITM'd connections present a valid certificate chain (Bouncer CA → host cert)
- Proxy handles concurrent connections without deadlock or resource leaks

---

## Phase 3: Container Networking

**Goal**: Route container egress through the proxy via an internal Docker network, preventing direct internet access.

### New file: `src/main/proxy-network.ts`

**`createSessionNetwork(sessionId): Promise<SessionNetwork>`**
```typescript
const networkName = `bouncer-net-${sessionId}`;
await execFileAsync("docker", [
  "network", "create", networkName,
  "--driver", "bridge",
  // Note: we intentionally do NOT use --internal because it blocks
  // host.docker.internal resolution, making the host proxy unreachable.
  // The proxy is the enforcement layer instead.
  "--label", "glitterball.managed=true",
  "--label", `glitterball.sessionId=${sessionId}`,
]);
return {
  networkName,
  async cleanup() {
    await execFileAsync("docker", ["network", "rm", networkName])
      .catch(() => {}); // idempotent
  },
};
```

**`cleanupOrphanNetworks(activeSessionIds): Promise<void>`**
- `docker network ls --filter label=glitterball.managed=true --format '{{.Name}}'`
- For each network, extract session ID from the name (`bouncer-net-{sessionId}`)
- If not in `activeSessionIds`, `docker network rm {name}`

### Changes to `docker/agent.Dockerfile`

Add entrypoint for CA cert installation:

```dockerfile
# ... existing content (Rust install, gh removal, etc.) ...

# Prepare CA trust store directory for runtime injection
USER root
RUN mkdir -p /usr/local/share/ca-certificates/bouncer
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

Note: adding an `ENTRYPOINT` changes how the container is invoked. Currently `spawnContainer` passes `config.command` as the Docker `CMD`. With an entrypoint, `config.command` becomes arguments to the entrypoint (which `exec`s them via `exec "$@"`). This is transparent — the entrypoint installs the CA cert and then `exec`s the original command.

### New file: `docker/entrypoint.sh`

```bash
#!/bin/bash
set -e

# Install Bouncer CA certificate if present (bind-mounted at runtime)
CA_CERT="/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt"
if [ -f "$CA_CERT" ]; then
  update-ca-certificates 2>/dev/null || true
  export NODE_EXTRA_CA_CERTS="$CA_CERT"
fi

exec "$@"
```

**Note on `update-ca-certificates`:** This requires the `ca-certificates` package, which should already be present in the `docker/sandbox-templates:claude-code` base image (it's a standard Debian/Ubuntu package needed by curl, git, etc.). If not, add `RUN apt-get install -y ca-certificates` to the Dockerfile.

### Changes to `src/main/container.ts`

Update `ContainerConfig.networkMode` type:
```typescript
networkMode: "none" | "bridge" | "proxy";
```

Add optional `networkName` field:
```typescript
networkName?: string;
```

Update `buildDockerRunArgs`:
```typescript
if (config.networkMode === "proxy" && config.networkName) {
  args.push("--network", config.networkName);
} else {
  args.push("--network", config.networkMode);
}
```

### Changes to `src/main/types.ts`

Update `ContainerPolicy`:
```typescript
export interface ContainerPolicy {
  image?: string;
  additionalMounts?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
  networkMode?: "none" | "bridge" | "proxy";
}
```

### Testing

Integration test (requires Docker/OrbStack):
1. Generate CA (Phase 1)
2. Start proxy on auto-assigned port (Phase 2)
3. Create Docker bridge network
4. Start a container on the network with `HTTP_PROXY`/`HTTPS_PROXY` pointing to `host.docker.internal:{port}`
5. Mount the CA cert
6. From inside the container:
   - `curl https://api.github.com/` → succeeds (through proxy)
   - `curl https://evil.example.com/` → blocked by proxy (curl error from 403 CONNECT response)
7. Clean up network and container

### Exit criteria
- Container can reach the internet through the proxy (env vars respected)
- Proxy blocks denied domains with 403
- CA certificate is trusted by curl, git, and Node.js inside the container
- Network cleanup is idempotent

---

## Phase 4: GitHub Policy Engine Extraction

**Goal**: Extract the policy evaluation logic from `gh-shim.ts` into a shared module used by both the shim and the proxy.

*This phase has no dependency on Phases 1-3 and can be developed in parallel.*

### New file: `src/main/github-policy-engine.ts`

Extract from `gh-shim.ts`:
- `parseApiEndpoint()` — parses `/repos/{owner}/{repo}/...` URL paths
- `ApiEndpointMatch` type
- `expandPlaceholder()` helper

Add new function:
```typescript
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
  // Reuse parseApiEndpoint to extract resource, method, repo, number
  const match = parseApiEndpoint(path, { method });

  // Cross-repo check
  if (match.ownerRepo !== null && match.ownerRepo !== policy.repo) {
    return { action: "deny", reason: `cross-repo access denied` };
  }

  // Default-deny allowlist
  if (match.resource === "pulls") return evaluateApiPulls(match, policy);
  if (match.resource === "issues") return evaluateApiIssues(match);
  if (match.resource === "" && method === "GET") return { action: "allow" }; // repo metadata

  return { action: "deny", reason: `endpoint not in allowlist` };
}
```

The existing functions `evaluateApiPulls` and `evaluateApiIssues` are also moved here. The key difference from the shim's `evaluateApiPolicy` is that this function is **default-deny**: if the endpoint doesn't match a known pattern, it returns deny. The shim's version was also default-deny for the `api` subcommand, but the proxy function is the canonical allowlist for all HTTP traffic.

Also add git push evaluation:
```typescript
/**
 * Parse git pkt-line format to extract ref updates.
 */
export function parseGitReceivePack(body: Buffer): Array<{
  oldSha: string;
  newSha: string;
  refName: string;
}>;

/**
 * Check if a git push is allowed by the session policy.
 */
export function evaluateGitPush(
  refs: Array<{ refName: string }>,
  policy: GitHubPolicy,
): { allowed: boolean; deniedRef?: string };
```

### Changes to `src/main/gh-shim.ts`

Replace the extracted functions with imports:
```typescript
import {
  parseApiEndpoint,
  evaluateApiPulls,
  evaluateApiIssues,
  type ApiEndpointMatch,
} from "./github-policy-engine.js";
```

The shim's `evaluateApiPolicy` function now delegates to the shared module. The shim retains its `evaluatePolicy` function (which handles `gh` subcommand routing), since that's CLI-specific logic the proxy doesn't need.

**Careful**: the shim is bundled via esbuild for container use (see `buildShimBundle()` in `github-policy.ts`). The shared module must be included in the bundle. Since esbuild follows imports, this should work automatically — but verify that the bundle includes the extracted code.

### Testing

- All existing `gh-shim` policy evaluation tests must pass unchanged (they test the same logic, just imported from a different module)
- New tests for `evaluateGitHubRequest`:
  - `GET /repos/owner/repo/pulls` → allow
  - `POST /repos/owner/repo/pulls` with `canCreatePr: true` → allow-and-capture-pr
  - `PUT /repos/owner/repo/pulls/42/merge` → deny
  - `POST /graphql` → deny (not in allowlist)
  - `DELETE /repos/owner/repo/pulls/42` → deny
  - `GET /repos/other/repo/pulls` → deny (cross-repo)
  - `GET /some/unknown/endpoint` → deny (default-deny)
- New tests for `parseGitReceivePack`:
  - Parse a valid pkt-line stream with one ref update
  - Parse a stream with multiple ref updates
  - Handle the flush packet (`0000`)
  - Handle capabilities appended to the first line
- New tests for `evaluateGitPush`:
  - Push to allowed ref → allowed
  - Push to `refs/heads/main` with `allowedPushRefs: ["feature-branch"]` → denied

### Exit criteria
- Shared module is the single source of truth for REST API policy evaluation
- `gh` shim works identically after refactor (no behavioral changes)
- esbuild bundle for the shim includes the shared module
- Git pkt-line parser handles real-world push payloads

---

## Phase 5: GitHub REST API Enforcement in Proxy

**Goal**: The proxy enforces GitHub REST API policy on MITM'd requests to `api.github.com`.

### Changes to `src/main/proxy.ts`

Wire the MITM request handler for `api.github.com`:

```typescript
async function handleMitmRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  config: ProxyConfig,
): Promise<void> {
  if (hostname === "api.github.com" && config.githubPolicy) {
    const decision = evaluateGitHubRequest(
      req.method ?? "GET",
      req.url ?? "/",
      config.githubPolicy,
    );

    config.onPolicyEvent({
      timestamp: Date.now(),
      tool: "proxy",
      operation: `${req.method} ${req.url}`,
      decision: decision.action === "deny" ? "deny" : "allow",
      reason: decision.action === "deny" ? decision.reason : undefined,
    });

    if (decision.action === "deny") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`[bouncer:proxy] DENY ${req.method} ${req.url} — ${decision.reason}\n`);
      return;
    }

    // Forward to upstream and optionally capture response
    const upstreamRes = await forwardToUpstream(req, hostname);

    if (decision.action === "allow-and-capture-pr") {
      // Read response body to capture PR number
      const body = await readResponseBody(upstreamRes);
      capturePrFromResponse(body, config);
      relayResponse(upstreamRes, res, body);
    } else {
      pipeResponse(upstreamRes, res);
    }
    return;
  }

  // Non-GitHub inspected domain — forward without policy check
  const upstreamRes = await forwardToUpstream(req, hostname);
  pipeResponse(upstreamRes, res);
}
```

**PR capture from response:**
```typescript
function capturePrFromResponse(
  body: string,
  config: ProxyConfig,
): void {
  try {
    const data = JSON.parse(body);
    if (typeof data.number === "number" && config.githubPolicy) {
      config.githubPolicy.canCreatePr = false;
      config.githubPolicy.ownedPrNumber = data.number;
      config.onPolicyEvent({
        timestamp: Date.now(),
        tool: "proxy",
        operation: `captured PR #${data.number}`,
        decision: "allow",
      });
    }
  } catch {
    // Response wasn't JSON — skip capture
  }
}
```

**Policy state synchronization**: When the proxy captures a PR, it mutates the `githubPolicy` object in the `ProxyConfig` (which is a shared reference held by the session manager). The session manager's `onPolicyEvent` callback persists the updated state to the policy file on disk, so the `gh` shim sees the updated PR number on its next invocation.

### Testing

Integration tests (require proxy + CA from Phases 1-2, plus a GitHub token):
- `curl --proxy ... --cacert bouncer-ca.crt https://api.github.com/repos/{owner}/{repo}/pulls` → 200 (allowed)
- `curl --proxy ... --cacert bouncer-ca.crt -X PUT https://api.github.com/repos/{owner}/{repo}/pulls/1/merge` → 403 (denied)
- `curl --proxy ... --cacert bouncer-ca.crt -X POST https://api.github.com/graphql -d '{}'` → 403 (not in allowlist)
- `curl --proxy ... --cacert bouncer-ca.crt https://api.github.com/repos/OTHER/repo/pulls` → 403 (cross-repo)
- PR capture: `POST /pulls` → response body parsed, PR number extracted, policy state updated

Unit tests (mocked upstream):
- Verify policy decision is checked before forwarding
- Verify 403 response includes `[bouncer:proxy]` prefix for policy event parsing
- Verify PR capture updates the policy object

### Exit criteria
- All REST allowlist entries enforced correctly
- Unrecognized endpoints denied (default-deny)
- PR creation captured from response body
- Policy events emitted for all allow/deny decisions

---

## Phase 6: Git Smart HTTP Enforcement

**Goal**: The proxy inspects git push requests and enforces branch restrictions, closing the `--no-verify` bypass.

### Changes to `src/main/proxy.ts`

Wire the MITM request handler for `github.com` (git smart HTTP transport):

```typescript
async function handleGitHubMitmRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ProxyConfig,
): Promise<void> {
  // Match: POST /{owner}/{repo}.git/git-receive-pack
  const pushMatch = req.url?.match(
    /^\/([^/]+\/[^/]+)\.git\/git-receive-pack$/
  );

  if (req.method === "POST" && pushMatch && config.githubPolicy) {
    const repo = pushMatch[1];

    // Cross-repo check
    if (repo !== config.githubPolicy.repo) {
      res.writeHead(403);
      res.end(`[bouncer:proxy] DENY push to ${repo} — cross-repo\n`);
      return;
    }

    // Buffer the request body to inspect ref updates
    const body = await readRequestBody(req);
    const refs = parseGitReceivePack(body);
    const result = evaluateGitPush(refs, config.githubPolicy);

    if (!result.allowed) {
      config.onPolicyEvent({
        timestamp: Date.now(),
        tool: "proxy",
        operation: `git push ${result.deniedRef}`,
        decision: "deny",
        reason: `ref not in allowed list`,
      });
      res.writeHead(403);
      res.end(`[bouncer:proxy] DENY push to ${result.deniedRef}\n`);
      return;
    }

    // Forward the buffered body to upstream
    const upstreamRes = await forwardToUpstreamWithBody(req, "github.com", body);
    pipeResponse(upstreamRes, res);
    return;
  }

  // All other github.com requests (ref advertisement, web UI, etc.) — forward
  const upstreamRes = await forwardToUpstream(req, "github.com");
  pipeResponse(upstreamRes, res);
}
```

### `parseGitReceivePack` implementation details

The git pkt-line format:
- Each line starts with a 4-character hex length prefix (including the prefix itself)
- `0000` is the flush packet (end of section)
- The first ref update line may have capabilities appended after a NUL byte
- Ref update format: `<old-sha1> <new-sha1> <ref-name>[\0<capabilities>]`

```typescript
export function parseGitReceivePack(body: Buffer): Array<{
  oldSha: string;
  newSha: string;
  refName: string;
}> {
  const refs: Array<{ oldSha: string; newSha: string; refName: string }> = [];
  let offset = 0;

  while (offset < body.length) {
    const lenHex = body.subarray(offset, offset + 4).toString("ascii");
    const len = parseInt(lenHex, 16);

    if (len === 0) break; // flush packet
    if (len < 4) break;   // invalid

    const line = body.subarray(offset + 4, offset + len).toString("utf-8");
    offset += len;

    // Strip capabilities (after NUL byte)
    const nulIdx = line.indexOf("\0");
    const payload = nulIdx !== -1 ? line.substring(0, nulIdx) : line;

    // Parse: "<old-sha> <new-sha> <ref-name>\n"
    const parts = payload.trim().split(" ");
    if (parts.length >= 3) {
      refs.push({
        oldSha: parts[0],
        newSha: parts[1],
        refName: parts[2],
      });
    }
  }

  return refs;
}
```

### `evaluateGitPush` implementation

```typescript
export function evaluateGitPush(
  refs: Array<{ refName: string }>,
  policy: GitHubPolicy,
): { allowed: boolean; deniedRef?: string } {
  for (const ref of refs) {
    // Extract branch name from "refs/heads/branch-name"
    const branch = ref.refName.replace(/^refs\/heads\//, "");
    if (!policy.allowedPushRefs.includes(branch)) {
      return { allowed: false, deniedRef: ref.refName };
    }
  }
  return { allowed: true };
}
```

### Testing

Unit tests for `parseGitReceivePack`:
- Construct a valid pkt-line buffer with known ref updates, verify parsing
- Single ref update with capabilities on first line
- Multiple ref updates
- Empty push (flush packet only)
- Malformed input — returns empty array (fail closed)

Integration test (requires proxy + container):
1. Set up a test git repo with a GitHub remote
2. Configure proxy with `allowedPushRefs: ["test-branch"]`
3. From inside the container:
   - `git push origin test-branch` → succeeds (ref allowed)
   - `git push origin main` → 403 from proxy (ref denied)
   - `git push --no-verify origin main` → still 403 (proxy doesn't care about hooks)
4. Verify policy events logged for both allow and deny

### Exit criteria
- Git push ref enforcement works at the network level
- `--no-verify` does not bypass the proxy
- Pkt-line parser handles real git push payloads correctly
- Malformed pkt-lines fail closed (deny)

---

## Phase 7: Session Manager Integration

**Goal**: Wire the proxy and network into the session lifecycle so that container sessions automatically route through the proxy.

### Changes to `src/main/session-manager.ts`

**New fields on `SessionState`:**
```typescript
interface SessionState {
  // ... existing fields ...
  proxyHandle: ProxyHandle | null;
  sessionNetwork: SessionNetwork | null;
}
```

**`createSession` additions** — after building the container config, before spawning:

```typescript
// --- Network proxy (M7) ---
let proxyHandle: ProxyHandle | null = null;
let sessionNetwork: SessionNetwork | null = null;

if (dockerAvailable && template?.network?.access === "filtered") {
  const ca = await ensureCA();

  proxyHandle = await startProxy({
    sessionId: id,
    port: 0, // auto-assign
    allowedDomains: template.network.allowedDomains,
    inspectedDomains: template.network.inspectedDomains,
    githubPolicy: session.githubPolicy,
    ca: { cert: ca.cert, key: ca.key },
    onPolicyEvent: (event) => {
      this.emit("session-update", {
        sessionId: id,
        type: "policy-event",
        event,
      });
      // Persist policy state if PR was captured
      if (session.githubPolicy && event.operation.startsWith("captured PR")) {
        writePolicyState(id, session.githubPolicy).catch(() => {});
      }
    },
  });
  session.proxyHandle = proxyHandle;

  sessionNetwork = await createSessionNetwork(id, proxyHandle.port);
  session.sessionNetwork = sessionNetwork;
}
```

Then, when building the `ContainerConfig`:

```typescript
// If proxy is active, use proxy network mode
if (proxyHandle && sessionNetwork) {
  containerConfig.networkMode = "proxy";
  containerConfig.networkName = sessionNetwork.networkName;

  // Add proxy env vars
  containerEnv.HTTP_PROXY = `http://host.docker.internal:${proxyHandle.port}`;
  containerEnv.HTTPS_PROXY = `http://host.docker.internal:${proxyHandle.port}`;
  containerEnv.NO_PROXY = "localhost,127.0.0.1";
}
```

### Changes to `src/main/policy-container.ts`

**`policyToContainerConfig` additions:**

Add CA cert mount when proxy is active:
```typescript
// New field in ContainerSessionContext:
export interface ContainerSessionContext {
  // ... existing fields ...
  /** Bouncer CA cert path (for proxy TLS interception) */
  caCertPath?: string;
  /** Proxy port (for git http.proxy config) */
  proxyPort?: number;
}
```

In `policyToContainerConfig`:
```typescript
if (ctx.caCertPath) {
  mounts.push({
    hostPath: ctx.caCertPath,
    containerPath: "/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt",
    readOnly: true,
  });
}
```

**`generateGitconfig` additions:**

Add `[http] proxy` when a proxy port is provided:
```typescript
export function generateGitconfig(opts: {
  hooksPath: string;
  credentialHelperPath: string;
  userName?: string;
  userEmail?: string;
  proxyUrl?: string;  // New
}): string {
  // ... existing lines ...
  if (opts.proxyUrl) {
    lines.push("[http]");
    lines.push(`    proxy = ${opts.proxyUrl}`);
  }
  // ...
}
```

### Changes to `closeSession`

```typescript
// Stop proxy and remove network
if (session.proxyHandle) {
  await session.proxyHandle.stop();
}
if (session.sessionNetwork) {
  await session.sessionNetwork.cleanup();
}
```

### Changes to orphan cleanup

In `startup` / `cleanupOrphans`:
```typescript
await cleanupOrphanNetworks(activeSessionIds);
```

### Testing

End-to-end test — full PR workflow through proxy:
1. Create a Claude Code session with `standard-pr` policy
2. Agent edits files, commits, pushes to session branch → succeeds (git push through proxy, ref allowed)
3. Agent runs `gh pr create` → succeeds (shim catches first for UX, REST API allowed by proxy)
4. Agent tries `curl -X PUT https://api.github.com/.../pulls/N/merge` → 403 from proxy
5. Agent tries `git push origin main` → 403 from proxy (ref denied)
6. Agent tries `curl https://evil.example.com/` → 403 from proxy (domain denied)
7. Agent runs `npm install` → succeeds (registry.npmjs.org is in the allowlist, tunneled)
8. Close session → proxy stopped, network removed, container removed

### Exit criteria
- Proxy starts and stops with the session lifecycle
- Container routes all traffic through the proxy
- Policy events from the proxy appear in the UI event log
- PR capture from the proxy updates the shared policy state
- Session teardown is clean (no orphan proxies or networks)

---

## Phase 8: Policy Templates, UI, and Validation

**Goal**: Update types, templates, UI, and run the full validation suite.

### Changes to `src/main/types.ts`

Update `NetworkPolicy`:
```typescript
export type NetworkPolicy =
  | { access: "full" }
  | { access: "none" }
  | { access: "filtered"; allowedDomains: string[]; inspectedDomains: string[] };
```

Update `PolicyEvent.tool`:
```typescript
export interface PolicyEvent {
  timestamp: number;
  tool: "gh" | "git" | "proxy";
  operation: string;
  decision: "allow" | "deny";
  reason?: string;
}
```

### Changes to `src/main/policy-templates.ts`

Update `standardPrTemplate`:
```typescript
network: {
  access: "filtered",
  allowedDomains: [
    "github.com",
    "api.github.com",
    "uploads.github.com",
    "registry.npmjs.org",
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "pypi.org",
    "files.pythonhosted.org",
  ],
  inspectedDomains: [
    "api.github.com",
    "github.com",
  ],
},
```

`researchOnlyTemplate` and `permissiveTemplate` keep `access: "full"` — no proxy filtering. (The proxy still runs for observability on `research-only` if we want to add MITM inspection later, but for now these templates use `"bridge"` network mode with no proxy.)

### Changes to `src/main/policy-event-parser.ts`

Update the regex to match `[bouncer:proxy]`:
```typescript
const POLICY_LINE_RE = /^\[bouncer:(gh|git|proxy)\] (ALLOW|DENY) (.+)$/;
```

Update the tool type:
```typescript
const tool = match[1] as "gh" | "git" | "proxy";
```

### UI changes

**`SessionList.tsx`**: Add network policy badge next to the sandbox backend badge:
- `"filtered"` → "Filtered Network" badge (with tooltip showing allowed domains)
- `"full"` → "Full Network" badge
- `"none"` → "No Network" badge

**`SandboxLog.tsx`**: Already handles `PolicyEvent` objects generically — proxy events appear automatically. Optionally, add an icon or color for `tool: "proxy"` events to distinguish them from `gh` shim and git hook events.

**`ChatPanel.tsx` or session details**: Add proxy status line:
- "Network: Filtered via proxy (port {N})" when proxy is active
- "Network: Bridge (no proxy)" when proxy is not active

### Validation checklist

**Proxy enforcement — REST API:**
- [ ] `GET /repos/{owner}/{repo}/pulls` → allowed
- [ ] `POST /repos/{owner}/{repo}/pulls` (with `canCreatePr`) → allowed, PR captured
- [ ] `PATCH /repos/{owner}/{repo}/pulls/{ownedPr}` → allowed
- [ ] `PATCH /repos/{owner}/{repo}/pulls/{otherPr}` → denied
- [ ] `PUT /repos/{owner}/{repo}/pulls/{n}/merge` → denied
- [ ] `GET /repos/{owner}/{repo}/issues` → allowed
- [ ] `POST /repos/{owner}/{repo}/issues` → denied
- [ ] `POST /graphql` → denied
- [ ] `DELETE` on any path → denied
- [ ] Request to different repo → denied
- [ ] Unknown endpoint → denied

**Proxy enforcement — git push:**
- [ ] `git push origin {session-branch}` → allowed
- [ ] `git push origin main` → denied by proxy
- [ ] `git push --no-verify origin main` → denied by proxy (hook bypass doesn't help)
- [ ] Push to different repo → denied

**Proxy enforcement — domain filtering:**
- [ ] `curl https://registry.npmjs.org/` (from container) → tunneled, succeeds
- [ ] `curl https://evil.example.com/` (from container) → blocked by proxy (403 CONNECT)

**Config integrity:**
- [ ] Agent can't modify `/etc/gitconfig` proxy setting (read-only mount)
- [ ] Proxy env vars set at container start and respected by standard tooling

**Session lifecycle:**
- [ ] Proxy starts with session, stops on close
- [ ] Docker network created with session, removed on close
- [ ] Orphan proxies/networks cleaned up on app restart
- [ ] Safehouse fallback still works (no proxy, bridge network)

**UX:**
- [ ] `gh` shim denies with friendly error before proxy (fast-reject)
- [ ] Git hook denies with friendly error before proxy (fast-reject)
- [ ] Proxy deny events visible in sandbox event log
- [ ] Network policy badge shows correct state

### Cleanup tasks

- Remove any `TODO(M7)` comments
- Update `docs/roadmap.md`: mark M7 complete, update role evolution table
- Update architecture diagram to show proxy layer
- Verify all three policy templates work correctly with the new network infrastructure

### Exit criteria
- All validation checklist items pass
- Roadmap updated
- No regressions in M6 functionality

---

## Phase Dependency Graph

```
Phase 1 (CA generation)
  │
  ▼
Phase 2 (HTTP proxy + domain filtering)    Phase 4 (policy engine extraction)
  │                                               │
  ▼                                               │
Phase 3 (container networking)                    │
  │                                               │
  ▼                                               ▼
Phase 5 (GitHub REST API enforcement) ◄───────────┘
  │
  ▼
Phase 6 (git smart HTTP enforcement)
  │
  ▼
Phase 7 (session manager integration)
  │
  ▼
Phase 8 (templates, UI, validation)
```

Phase 4 (policy engine extraction) can be developed in parallel with Phases 1-3. It has no dependency on the proxy infrastructure — it's a pure refactor of existing `gh-shim.ts` code into a shared module. It merges into the main flow at Phase 5, where the proxy wires the shared engine into its MITM request handler.

---

## Risk Checkpoints

After each phase merges, verify:

| After Phase | Check |
|---|---|
| Phase 1 | CA generates, persists across restarts, host certs form valid chain |
| Phase 2 | Proxy tunnels, blocks, and MITM's correctly; no resource leaks under concurrent connections |
| Phase 3 | Container on session network routes traffic through proxy; proxy blocks denied domains; CA trusted by all tools in container |
| Phase 4 | All existing `gh-shim` tests pass; esbuild bundle includes shared module |
| Phase 5 | REST allowlist enforced at proxy; PR captured from response; cross-repo denied |
| Phase 6 | Git push ref enforcement works; `--no-verify` does not bypass proxy |
| Phase 7 | Full session lifecycle works with proxy; no orphan resources on crash |
| Phase 8 | All validation items pass; no regressions |
