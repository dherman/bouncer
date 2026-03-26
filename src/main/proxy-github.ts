// src/main/proxy-github.ts
//
// GitHub-specific MITM request handler for the proxy.
// Wires evaluateGitHubRequest() into the proxy's onMitmRequest hook
// to enforce REST API policy and capture PR numbers from POST /pulls responses.

import http from "node:http";
import https from "node:https";
import { evaluateGitHubRequest } from "./github-policy-engine.js";
import type { ProxyConfig, MitmRequestHandler } from "./proxy.js";

// ---------------------------------------------------------------------------
// createGitHubMitmHandler()
// ---------------------------------------------------------------------------

/**
 * Create a MITM request handler that enforces GitHub policy on the GitHub
 * API hostname and forwards all other inspected domains without policy checks.
 *
 * @param config - Proxy configuration with GitHub policy
 * @param apiHostname - The GitHub API hostname to match (default: "api.github.com")
 */
export function createGitHubMitmHandler(
  config: ProxyConfig,
  apiHostname: string = "api.github.com",
): MitmRequestHandler {
  return (req, res, hostname, upstream, upstreamPort) => {
    if (hostname === apiHostname && config.githubPolicy) {
      handleGitHubApiRequest(req, res, hostname, upstreamPort, config, upstream);
    } else {
      // Non-GitHub inspected domain — forward without policy check
      upstream(req, res);
    }
  };
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
  const method = req.method ?? "GET";
  const path = req.url ?? "/";
  const policy = config.githubPolicy!;

  const decision = evaluateGitHubRequest(method, path, policy);

  // Log the policy event
  config.onPolicyEvent({
    timestamp: Date.now(),
    tool: "proxy",
    operation: `${method} ${path}`,
    decision: decision.action === "deny" ? "deny" : "allow",
    reason: decision.action === "deny" ? decision.reason : undefined,
  });

  if (decision.action === "deny") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`[bouncer:proxy] DENY ${method} ${path} — ${decision.reason}\n`);
    return;
  }

  if (decision.action === "allow-and-capture-pr") {
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

    proxyRes.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_CAPTURE_BYTES) {
        captureLimitExceeded = true;
      }
    });
    proxyRes.on("end", () => {
      const bodyBuffer = Buffer.concat(chunks);

      // Relay the raw bytes to the client (preserves encoding, binary safety)
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      clientRes.end(bodyBuffer);

      // Attempt PR capture only for successful, uncompressed, reasonably-sized responses
      if (
        !captureLimitExceeded &&
        proxyRes.statusCode &&
        proxyRes.statusCode >= 200 &&
        proxyRes.statusCode < 300
      ) {
        const encoding = proxyRes.headers["content-encoding"];
        if (!encoding || encoding === "identity") {
          try {
            capturePrFromResponse(bodyBuffer.toString("utf-8"), config);
          } catch {
            // Decode failed — skip capture
          }
        }
      }
    });
  });

  proxyReq.on("error", () => {
    clientRes.writeHead(502);
    clientRes.end("Bad Gateway\n");
  });

  clientReq.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// PR capture
// ---------------------------------------------------------------------------

function capturePrFromResponse(body: string, config: ProxyConfig): void {
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
