// src/main/proxy-github.ts
//
// GitHub-specific MITM request handler for the proxy.
// Wires evaluateGitHubRequest() into the proxy's onMitmRequest hook
// to enforce REST API policy and capture PR numbers from POST /pulls responses.
// Also enforces git push ref restrictions on github.com smart HTTP transport.

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import {
  evaluateGitHubRequest,
  evaluateGraphQLBody,
  parseGitReceivePack,
  evaluateGitPush,
  isPushWildcard,
} from './github-policy-engine.js';
import type { ProxyConfig, MitmRequestHandler } from './proxy.js';

// ---------------------------------------------------------------------------
// createGitHubMitmHandler()
// ---------------------------------------------------------------------------

/**
 * Create a MITM request handler that enforces GitHub policy on the GitHub
 * API hostname (REST API) and GitHub web hostname (git smart HTTP transport).
 * All other inspected domains are forwarded without policy checks.
 *
 * @param config - Proxy configuration with GitHub policy
 * @param apiHostname - The GitHub API hostname (default: "api.github.com")
 * @param gitHostname - The GitHub git hostname (default: "github.com")
 */
export function createGitHubMitmHandler(
  config: ProxyConfig,
  apiHostname: string = 'api.github.com',
  gitHostname: string = 'github.com',
): MitmRequestHandler {
  const apiNorm = normalizeHost(apiHostname);
  const gitNorm = normalizeHost(gitHostname);
  return (req, res, hostname, upstream, upstreamPort) => {
    const h = normalizeHost(hostname);
    if (h === apiNorm && config.githubPolicy) {
      handleGitHubApiRequest(req, res, hostname, upstreamPort, config, upstream);
    } else if (h === gitNorm && config.githubPolicy) {
      handleGitSmartHttp(req, res, hostname, upstreamPort, config, upstream);
    } else {
      // Non-GitHub inspected domain — forward without policy check
      upstream(req, res);
    }
  };
}

function normalizeHost(h: string): string {
  const lower = h.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

// ---------------------------------------------------------------------------
// GitHub API request handling
// ---------------------------------------------------------------------------

function handleGitHubApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  upstreamPort: number,
  config: ProxyConfig,
  upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const method = req.method ?? 'GET';
  const path = req.url ?? '/';
  const policy = config.githubPolicy!;

  const decision = evaluateGitHubRequest(method, path, policy);
  console.log(
    `[proxy-github] ${method} ${path} → ${decision.action} (canCreatePr=${policy.canCreatePr}, ownedPrNumber=${policy.ownedPrNumber})`,
  );

  if (decision.action === 'inspect-graphql') {
    // Defer policy event — handleGraphQLInspection logs after body inspection
    handleGraphQLInspection(req, res, hostname, upstreamPort, config, upstream);
    return;
  }

  // Log the policy event (skip for inspect-graphql which logs its own)
  config.onPolicyEvent({
    timestamp: Date.now(),
    tool: 'proxy',
    operation: `${method} ${path}`,
    decision: decision.action === 'deny' ? 'deny' : 'allow',
    reason: decision.action === 'deny' ? decision.reason : undefined,
  });

  if (decision.action === 'deny') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`[bouncer:proxy] DENY ${method} ${path} — ${decision.reason}\n`);
    return;
  }

  if (decision.action === 'allow-and-capture-pr') {
    // Eagerly reserve PR creation to prevent concurrent requests from
    // seeing canCreatePr=true before the first response is captured.
    policy.canCreatePr = false;
    // Forward to upstream, but buffer the response to capture PR number
    forwardWithCapture(req, res, hostname, upstreamPort, config);
    return;
  }

  // Standard allow — forward directly via the proxy's built-in upstream
  upstream(req, res);
}

// ---------------------------------------------------------------------------
// GraphQL body inspection
// ---------------------------------------------------------------------------

const MAX_GRAPHQL_BODY_BYTES = 64 * 1024; // 64 KB — GraphQL bodies are small

function handleGraphQLInspection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  upstreamPort: number,
  config: ProxyConfig,
  upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;

  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_GRAPHQL_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('[bouncer:proxy] DENY POST /graphql — request body too large\n');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    const policy = config.githubPolicy!;
    const decision = evaluateGraphQLBody(body, policy);

    config.onPolicyEvent({
      timestamp: Date.now(),
      tool: 'proxy',
      operation: `POST /graphql`,
      decision: decision.action === 'deny' ? 'deny' : 'allow',
      reason: decision.action === 'deny' ? decision.reason : undefined,
    });

    if (decision.action === 'deny') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`[bouncer:proxy] DENY POST /graphql — ${decision.reason}\n`);
      return;
    }

    // Forward the buffered body to upstream
    forwardWithBody(req, res, hostname, upstreamPort, config, Buffer.from(body));
  });
}

// ---------------------------------------------------------------------------
// Git smart HTTP enforcement (github.com)
// ---------------------------------------------------------------------------

/** Match POST /{owner}/{repo}.git/git-receive-pack */
const GIT_RECEIVE_PACK_RE = /^\/([^/]+\/[^/]+)\.git\/git-receive-pack$/;

function handleGitSmartHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  upstreamPort: number,
  config: ProxyConfig,
  upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): void {
  const method = req.method ?? 'GET';
  const rawPath = req.url ?? '/';
  const policy = config.githubPolicy!;

  // Strip query string before matching to prevent bypass via ?x=y
  const path = rawPath.split('?')[0];

  // Only inspect git-receive-pack (push) requests
  const pushMatch = path.match(GIT_RECEIVE_PACK_RE);
  if (method !== 'POST' || !pushMatch) {
    // Non-push requests (ref advertisement, clone, fetch) — forward directly
    upstream(req, res);
    return;
  }

  const repo = pushMatch[1];

  // Cross-repo check
  if (repo !== policy.repo) {
    config.onPolicyEvent({
      timestamp: Date.now(),
      tool: 'proxy',
      operation: `git push to ${repo}`,
      decision: 'deny',
      reason: `cross-repo push denied (session repo: ${policy.repo})`,
    });
    req.resume(); // drain the request body to avoid tying up the connection
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`[bouncer:proxy] DENY push to ${repo} — cross-repo access denied\n`);
    return;
  }

  // Buffer the entire push body. We need the pkt-line ref header section
  // (typically under 1 KB, before the "0000" flush packet) for policy
  // evaluation, plus the full body (including the packfile) to forward
  // to upstream since we've consumed the request stream.
  const MAX_PUSH_BODY_BYTES = 256 * 1024 * 1024; // 256 MB safety limit
  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  let decided = false;

  req.on('data', (chunk: Buffer) => {
    if (decided) return;
    bodyChunks.push(chunk);
    bodySize += chunk.length;

    if (bodySize > MAX_PUSH_BODY_BYTES) {
      decided = true;
      denyPush(req, res, config, 'git push', 'push body exceeded size limit');
    }
  });

  req.on('end', () => {
    if (decided) return;
    decided = true;

    const body = Buffer.concat(bodyChunks);
    const parseResult = parseGitReceivePack(body);
    const result = evaluateGitPush(parseResult, policy);

    if (!result.allowed) {
      const reason = result.reason ?? `ref ${result.deniedRef} not in allowed list`;
      denyPush(req, res, config, `git push ${result.deniedRef ?? 'unknown'}`, reason);
      return;
    }

    if (parseResult.refs.length === 0) {
      denyPush(req, res, config, 'git push (no refs)', 'push contained no ref updates');
      return;
    }

    // Branch ratchet: on first push (wildcard refs), lock to the specific branch
    if (config.githubPolicy && isPushWildcard(config.githubPolicy)) {
      const pushedRef = parseResult.refs[0].refName;
      config.githubPolicy.allowedPushRefs = [pushedRef];
      config.onPolicyEvent({
        timestamp: Date.now(),
        tool: 'proxy',
        operation: `branch-ratchet: locked to ${pushedRef}`,
        decision: 'allow',
      });
    }

    // Push allowed — log and forward the buffered body
    config.onPolicyEvent({
      timestamp: Date.now(),
      tool: 'proxy',
      operation: `git push (${parseResult.refs.map((r) => r.refName).join(', ')})`,
      decision: 'allow',
    });
    forwardWithBody(req, res, hostname, upstreamPort, config, body);
  });
}

function denyPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ProxyConfig,
  operation: string,
  reason: string,
): void {
  config.onPolicyEvent({
    timestamp: Date.now(),
    tool: 'proxy',
    operation,
    decision: 'deny',
    reason,
  });
  req.resume(); // drain remaining body
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end(`[bouncer:proxy] DENY push to ${operation.replace('git push ', '')} — ${reason}\n`);
}

/**
 * Forward a request to upstream with a pre-buffered body (since we already
 * consumed the request stream for inspection).
 */
function forwardWithBody(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  hostname: string,
  port: number,
  config: ProxyConfig,
  body: Buffer,
): void {
  const { 'transfer-encoding': _te, ...forwardHeaders } = clientReq.headers;
  const options: https.RequestOptions = {
    hostname,
    port,
    path: clientReq.url,
    method: clientReq.method,
    headers: {
      ...forwardHeaders,
      host: hostname,
      'content-length': String(body.length),
    },
    ...(config.insecureUpstreamTls ? { rejectUnauthorized: false } : {}),
  };

  const proxyReq = https.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', () => {
    clientRes.writeHead(502);
    clientRes.end('Bad Gateway\n');
  });

  proxyReq.end(body);
}

// ---------------------------------------------------------------------------
// Upstream forwarding with response capture (for PR creation)
// ---------------------------------------------------------------------------

// Maximum response body size to buffer for PR capture (1 MB).
// PR creation responses are typically < 10 KB. If exceeded, the response
// is still forwarded to the client but capture is skipped.
const MAX_CAPTURE_BYTES = 1024 * 1024;

function forwardWithCapture(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  hostname: string,
  port: number,
  config: ProxyConfig,
): void {
  const options: https.RequestOptions = {
    hostname,
    port,
    path: clientReq.url,
    method: clientReq.method,
    headers: { ...clientReq.headers, host: hostname },
    ...(config.insecureUpstreamTls ? { rejectUnauthorized: false } : {}),
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let captureLimitExceeded = false;

    proxyRes.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_CAPTURE_BYTES) {
        captureLimitExceeded = true;
      }
    });
    proxyRes.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);

      // Relay the raw bytes to the client (preserves encoding, binary safety)
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      clientRes.end(bodyBuffer);

      // Attempt PR capture only for successful, reasonably-sized responses
      if (
        !captureLimitExceeded &&
        proxyRes.statusCode &&
        proxyRes.statusCode >= 200 &&
        proxyRes.statusCode < 300
      ) {
        const encoding = proxyRes.headers['content-encoding'];
        if (!encoding || encoding === 'identity') {
          try {
            capturePrFromResponse(bodyBuffer.toString('utf-8'), config);
          } catch (err) {
            console.warn('[proxy] PR capture decode failed:', err);
          }
        } else if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
          // Decompress before parsing — GitHub may gzip even without Accept-Encoding
          try {
            let decompressed: Buffer;
            if (encoding === 'gzip') {
              decompressed = zlib.gunzipSync(bodyBuffer);
            } else if (encoding === 'deflate') {
              decompressed = zlib.inflateSync(bodyBuffer);
            } else {
              decompressed = zlib.brotliDecompressSync(bodyBuffer);
            }
            capturePrFromResponse(decompressed.toString('utf-8'), config);
          } catch (err) {
            console.warn(`[proxy] PR capture: failed to decompress ${encoding}:`, err);
          }
        } else {
          console.warn(`[proxy] PR capture skipped: unsupported content-encoding '${encoding}'`);
        }
      } else {
        // PR creation failed upstream — restore canCreatePr so the agent can retry
        // (e.g., after pushing the branch). Without this, the eager reservation on
        // the allow-and-capture-pr path permanently blocks retries.
        if (config.githubPolicy) {
          config.githubPolicy.canCreatePr = true;
        }
        console.warn(
          `[proxy] PR capture skipped: status=${proxyRes.statusCode}, limitExceeded=${captureLimitExceeded}`,
        );
      }
    });
  });

  proxyReq.on('error', () => {
    // Restore canCreatePr on connection errors too
    if (config.githubPolicy) {
      config.githubPolicy.canCreatePr = true;
    }
    clientRes.writeHead(502);
    clientRes.end('Bad Gateway\n');
  });

  clientReq.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// PR capture
// ---------------------------------------------------------------------------

function capturePrFromResponse(body: string, config: ProxyConfig): void {
  try {
    const data = JSON.parse(body);
    if (typeof data.number === 'number' && config.githubPolicy) {
      config.githubPolicy.canCreatePr = false;
      config.githubPolicy.ownedPrNumber = data.number;
      const prUrl = typeof data.html_url === 'string' ? data.html_url : null;
      console.log(`[proxy] PR captured: #${data.number}${prUrl ? ` ${prUrl}` : ''}`);
      config.onPolicyEvent({
        timestamp: Date.now(),
        tool: 'proxy',
        operation: `captured PR #${data.number}${prUrl ? ` ${prUrl}` : ''}`,
        decision: 'allow',
      });
    } else {
      console.warn(
        `[proxy] PR capture: response parsed but no number field (keys: ${Object.keys(data).join(', ')})`,
      );
    }
  } catch (err) {
    console.warn('[proxy] PR capture: JSON parse failed:', err);
  }
}
