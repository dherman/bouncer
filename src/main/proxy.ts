// src/main/proxy.ts
//
// HTTP proxy server with domain filtering and selective TLS MITM.
// One instance per session — started by the session manager.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { generateHostCert } from "./proxy-tls.js";
import type { BouncerCA } from "./proxy-tls.js";
import type { GitHubPolicy, PolicyEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  /** Session ID (for logging and network naming) */
  sessionId: string;
  /** Port to listen on (0 = auto-assign) */
  port: number;
  /** Host to bind to (default: "0.0.0.0" for container access) */
  listenHost?: string;
  /** Domains allowed through the proxy */
  allowedDomains: string[];
  /** Domains requiring TLS interception for content inspection */
  inspectedDomains: string[];
  /** GitHub policy for request-level enforcement */
  githubPolicy: GitHubPolicy | null;
  /** CA certificate + key for TLS interception */
  ca: BouncerCA;
  /** Callback for policy events (logged via ACP) */
  onPolicyEvent: (event: PolicyEvent) => void;
  /** Optional MITM request handler — wired up in Phase 5 for policy enforcement */
  onMitmRequest?: MitmRequestHandler;
  /** Disable upstream TLS verification (for testing only) */
  insecureUpstreamTls?: boolean;
}

export type MitmRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hostname: string,
  upstream: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void,
) => void;

export interface ProxyHandle {
  /** Assigned port */
  port: number;
  /** Stop the proxy server */
  stop(): Promise<void>;
  /** Update GitHub policy (e.g., after PR capture) */
  updatePolicy(policy: GitHubPolicy): void;
}

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  const lower = s.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Check if `hostname` matches a domain `pattern`.
 * - `"*"` matches everything
 * - `"*.example.com"` matches `foo.example.com` but not `example.com`
 * - `"example.com"` matches only `example.com`
 *
 * Matching is case-insensitive and ignores trailing dots.
 */
export function domainMatches(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const h = normalize(hostname);
  const p = normalize(pattern);
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return h === p;
}

function domainAllowed(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((p) => domainMatches(hostname, p));
}

function domainInspected(
  hostname: string,
  inspectedDomains: string[],
): boolean {
  return inspectedDomains.some((p) => domainMatches(hostname, p));
}

// ---------------------------------------------------------------------------
// startProxy()
// ---------------------------------------------------------------------------

export async function startProxy(config: ProxyConfig): Promise<ProxyHandle> {
  const openSockets = new Set<net.Socket | Duplex>();

  function trackSocket(socket: net.Socket | Duplex): void {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  }

  const server = http.createServer();

  // Track all incoming connections for clean shutdown
  server.on("connection", trackSocket);

  // --- Plain HTTP requests ---
  server.on("request", (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad request\n");
      return;
    }

    let url: URL;
    try {
      // Proxy clients typically send absolute URLs (http://host/path).
      // Some may send origin-form (/path) with a Host header instead.
      if (req.url.startsWith("/")) {
        const host = req.headers.host;
        if (!host) {
          res.writeHead(400);
          res.end("Bad request: origin-form URL without Host header\n");
          return;
        }
        url = new URL(req.url, `http://${host}`);
      } else {
        url = new URL(req.url);
      }
    } catch {
      res.writeHead(400);
      res.end("Bad request URL\n");
      return;
    }

    if (!domainAllowed(url.hostname, config.allowedDomains)) {
      emitDenyEvent(config, url.hostname, `HTTP ${req.method} ${req.url}`);
      res.writeHead(403);
      res.end(formatDenyMessage(url.hostname));
      return;
    }

    forwardHttpRequest(req, res, url);
  });

  // --- CONNECT requests (HTTPS tunneling) ---
  server.on("connect", (req, clientSocket, head) => {
    trackSocket(clientSocket);
    const [host, portStr] = (req.url ?? "").split(":");
    const port = parseInt(portStr) || 443;

    if (!host || !domainAllowed(host, config.allowedDomains)) {
      emitDenyEvent(config, host ?? "unknown", `CONNECT ${req.url}`);
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\n\r\n" +
          formatDenyMessage(host ?? "unknown"),
      );
      return;
    }

    if (domainInspected(host, config.inspectedDomains)) {
      handleMitm(host, port, clientSocket, head, config, trackSocket);
      return;
    }

    // Tunnel: connect directly to upstream
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    trackSocket(upstream);
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  // Start listening
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.listenHost ?? "0.0.0.0", resolve);
  });

  const addr = server.address() as net.AddressInfo;

  return {
    port: addr.port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of openSockets) s.destroy();
        server.close(() => resolve());
      }),
    updatePolicy: (policy: GitHubPolicy) => {
      config.githubPolicy = policy;
    },
  };
}

// ---------------------------------------------------------------------------
// TLS MITM handler
// ---------------------------------------------------------------------------

function handleMitm(
  hostname: string,
  port: number,
  clientSocket: Duplex,
  head: Buffer,
  config: ProxyConfig,
  trackSocket: (s: net.Socket | Duplex) => void,
): void {
  const hostCert = generateHostCert(hostname, config.ca);

  // Tell the client the tunnel is established
  (clientSocket as net.Socket).write(
    "HTTP/1.1 200 Connection Established\r\n\r\n",
  );

  // Wrap the client socket in TLS (we are the server to the client)
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    cert: hostCert.cert,
    key: hostCert.key,
  });
  trackSocket(tlsSocket);

  // Create an HTTP server to parse requests from the decrypted stream
  const mitmServer = http.createServer((req, res) => {
    const doUpstreamForward = (
      inReq: http.IncomingMessage,
      inRes: http.ServerResponse,
    ) => {
      forwardToUpstream(hostname, port, inReq, inRes, config.insecureUpstreamTls);
    };

    if (config.onMitmRequest) {
      config.onMitmRequest(req, res, hostname, doUpstreamForward);
    } else {
      // No policy handler wired yet — forward everything
      doUpstreamForward(req, res);
    }
  });

  // Feed the TLS socket into the HTTP server
  mitmServer.emit("connection", tlsSocket);
  if (head.length > 0) {
    tlsSocket.unshift(head);
  }

  // Clean up the per-connection MITM server when the socket closes
  const closeMitm = () => mitmServer.close();
  tlsSocket.on("close", closeMitm);

  tlsSocket.on("error", () => {
    clientSocket.destroy();
  });
  clientSocket.on("error", () => {
    tlsSocket.destroy();
  });
}

// ---------------------------------------------------------------------------
// HTTP forwarding helpers
// ---------------------------------------------------------------------------

function forwardHttpRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  url: URL,
): void {
  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: clientReq.method,
    headers: { ...clientReq.headers, host: url.host },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", () => {
    clientRes.writeHead(502);
    clientRes.end("Bad Gateway\n");
  });

  clientReq.pipe(proxyReq);
}

function forwardToUpstream(
  hostname: string,
  port: number,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  insecureUpstreamTls: boolean = false,
): void {
  const options: https.RequestOptions = {
    hostname,
    port,
    path: clientReq.url,
    method: clientReq.method,
    headers: { ...clientReq.headers, host: hostname },
    ...(insecureUpstreamTls ? { rejectUnauthorized: false } : {}),
  };

  const proxyReq = https.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", () => {
    clientRes.writeHead(502);
    clientRes.end("Bad Gateway\n");
  });

  clientReq.pipe(proxyReq);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDenyMessage(hostname: string): string {
  return `Bouncer: domain "${hostname}" is not in the allowed domain list.\n`;
}

function emitDenyEvent(
  config: ProxyConfig,
  hostname: string,
  operation: string,
): void {
  config.onPolicyEvent({
    timestamp: Date.now(),
    tool: "proxy",
    operation,
    decision: "deny",
    reason: `Domain "${hostname}" not in allowedDomains`,
  });
}
