// scripts/test-proxy-github.ts
//
// Tests for Phase 5-6: GitHub REST API and git push enforcement in the proxy.
// Uses mock HTTPS upstreams to test policy decisions, PR capture, and
// git-receive-pack ref enforcement without hitting the real GitHub API.
//
// Usage: npx tsx scripts/test-proxy-github.ts

import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCA, generateHostCert, type BouncerCA } from "../src/main/proxy-tls.js";
import { startProxy, type ProxyConfig } from "../src/main/proxy.js";
import { createGitHubMitmHandler } from "../src/main/proxy-github.js";
import type { GitHubPolicy, PolicyEvent } from "../src/main/types.js";

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

// --- Setup ---

const tempDir = mkdtempSync(join(tmpdir(), "bouncer-proxy-gh-test-"));
const ca = await ensureCA(tempDir);

// Mock HTTPS upstream server. Tests use "localhost" as the hostname
// (instead of api.github.com) so DNS resolves to 127.0.0.1 where the
// mock is listening. createGitHubMitmHandler accepts a custom hostname.
const TEST_API_HOST = "api.localhost";
const upstreamCert = generateHostCert(TEST_API_HOST, ca);
const mockUpstream = https.createServer(
  { cert: upstreamCert.cert, key: upstreamCert.key },
  (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // POST /repos/owner/repo/pulls → return a PR creation response
    if (method === "POST" && url === "/repos/owner/repo/pulls") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ number: 42, html_url: "https://github.com/owner/repo/pull/42" }));
      });
      return;
    }

    // GET /repos/owner/repo/pulls → return a list
    if (method === "GET" && url === "/repos/owner/repo/pulls") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ number: 1, title: "Test PR" }]));
      return;
    }

    // GET /repos/owner/repo → repo metadata
    if (method === "GET" && url === "/repos/owner/repo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ full_name: "owner/repo" }));
      return;
    }

    // Fallback
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: url, method }));
  },
);

await new Promise<void>((resolve) => mockUpstream.listen(0, resolve));
const upstreamPort = (mockUpstream.address() as net.AddressInfo).port;

// --- Helpers ---

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

interface TestContext {
  proxy: { port: number; stop: () => Promise<void>; };
  events: PolicyEvent[];
  policy: GitHubPolicy;
}

async function setupProxy(policyOverrides: Partial<GitHubPolicy> = {}): Promise<TestContext> {
  const events: PolicyEvent[] = [];
  const policy = makePolicy(policyOverrides);
  const config: ProxyConfig = {
    sessionId: "test",
    port: 0,
    listenHost: "127.0.0.1",
    allowedDomains: [TEST_API_HOST],
    inspectedDomains: [TEST_API_HOST],
    githubPolicy: policy,
    ca,
    onPolicyEvent: (e) => events.push(e),
    insecureUpstreamTls: true,
  };
  config.onMitmRequest = createGitHubMitmHandler(config, TEST_API_HOST);

  const proxy = await startProxy(config);
  return { proxy, events, policy };
}

/** Make an HTTPS request through the proxy via CONNECT tunnel. */
async function requestViaProxy(
  proxyPort: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string; }> {
  // 1. CONNECT to the proxy
  const { socket } = await new Promise<{ socket: net.Socket }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      // Use the upstream port instead of 443 so the MITM forwardToUpstream
      // hits our mock server
      path: `${TEST_API_HOST}:${upstreamPort}`,
    });
    req.on("connect", (_res, socket) => resolve({ socket }));
    req.on("error", reject);
    req.end();
  });

  // 2. Upgrade to TLS
  const tlsSocket = tls.connect({
    socket,
    ca: ca.cert,
    servername: TEST_API_HOST,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.on("secureConnect", resolve);
    tlsSocket.on("error", reject);
  });

  // 3. Make HTTP request over the MITM'd connection
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => tlsSocket as unknown as net.Socket,
        hostname: TEST_API_HOST,
        path,
        method,
        headers: {
          host: TEST_API_HOST,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// =========================================================================
// Tests
// =========================================================================

console.log("\nproxy-github tests\n");

await test("GET /repos/owner/repo/pulls → 200 (allowed, forwarded)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "GET", "/repos/owner/repo/pulls");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data), "should return array from mock upstream");
    // Check allow event was logged
    assert.ok(ctx.events.some((e) => e.decision === "allow" && e.operation.includes("GET")));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("PUT /repos/owner/repo/pulls/1/merge → 403 (denied)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "PUT", "/repos/owner/repo/pulls/1/merge");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("[bouncer:proxy]"), "deny message should have bouncer prefix");
    assert.ok(res.body.includes("merging"), "should mention merge denial");
    assert.ok(ctx.events.some((e) => e.decision === "deny"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("POST /graphql → 403 (not in allowlist)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "POST", "/graphql");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("GraphQL"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("GET /repos/other/repo/pulls → 403 (cross-repo)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "GET", "/repos/other/repo/pulls");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("cross-repo"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("DELETE /repos/owner/repo/anything → 403 (DELETE denied)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "DELETE", "/repos/owner/repo/pulls/1");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("DELETE"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("GET /unknown/endpoint → 403 (default-deny)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "GET", "/unknown/endpoint");
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("not in allowlist"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("POST /repos/owner/repo/pulls → 201 + PR capture", async () => {
  const ctx = await setupProxy({ canCreatePr: true });
  try {
    const res = await requestViaProxy(
      ctx.proxy.port,
      "POST",
      "/repos/owner/repo/pulls",
      JSON.stringify({ title: "Test PR", head: "feature", base: "main" }),
    );
    assert.equal(res.status, 201);
    const data = JSON.parse(res.body);
    assert.equal(data.number, 42);

    // Verify PR was captured in the policy
    assert.equal(ctx.policy.ownedPrNumber, 42);
    assert.equal(ctx.policy.canCreatePr, false);

    // Verify capture event was logged
    assert.ok(ctx.events.some((e) => e.operation.includes("captured PR #42")));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("POST /repos/owner/repo/pulls after capture → 403 (can't create second PR)", async () => {
  const ctx = await setupProxy({ canCreatePr: false, ownedPrNumber: 42 });
  try {
    const res = await requestViaProxy(
      ctx.proxy.port,
      "POST",
      "/repos/owner/repo/pulls",
      JSON.stringify({ title: "Second PR" }),
    );
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("already created"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("GET /repos/owner/repo → 200 (repo metadata allowed)", async () => {
  const ctx = await setupProxy();
  try {
    const res = await requestViaProxy(ctx.proxy.port, "GET", "/repos/owner/repo");
    assert.equal(res.status, 200);
  } finally {
    await ctx.proxy.stop();
  }
});

// =========================================================================
// Phase 6: Git smart HTTP enforcement tests
// =========================================================================

console.log("\n  git push enforcement:");

// Mock HTTPS upstream for git transport (github.com)
const TEST_GIT_HOST = "localhost";
const gitUpstreamCert = generateHostCert(TEST_GIT_HOST, ca);
let lastGitPushBody: Buffer | null = null;

const mockGitUpstream = https.createServer(
  { cert: gitUpstreamCert.cert, key: gitUpstreamCert.key },
  (req, res) => {
    // Capture the body for verification
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      lastGitPushBody = Buffer.concat(chunks);
      res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result" });
      res.end("0000"); // minimal valid response
    });
  },
);
await new Promise<void>((resolve) => mockGitUpstream.listen(0, resolve));
const gitUpstreamPort = (mockGitUpstream.address() as net.AddressInfo).port;

// Helper to build pkt-line data for git push simulation
function makePktLine(line: string): Buffer {
  const payload = line + "\n";
  const len = (payload.length + 4).toString(16).padStart(4, "0");
  return Buffer.from(len + payload, "ascii");
}
const FLUSH = Buffer.from("0000", "ascii");

async function setupGitProxy(policyOverrides: Partial<GitHubPolicy> = {}): Promise<TestContext> {
  const events: PolicyEvent[] = [];
  const policy = makePolicy(policyOverrides);
  const config: ProxyConfig = {
    sessionId: "test",
    port: 0,
    listenHost: "127.0.0.1",
    allowedDomains: [TEST_API_HOST, TEST_GIT_HOST],
    inspectedDomains: [TEST_API_HOST, TEST_GIT_HOST],
    githubPolicy: policy,
    ca,
    onPolicyEvent: (e) => events.push(e),
    insecureUpstreamTls: true,
  };
  config.onMitmRequest = createGitHubMitmHandler(config, TEST_API_HOST, TEST_GIT_HOST);

  const proxy = await startProxy(config);
  return { proxy, events, policy };
}

/** Make a git push request through the proxy via CONNECT tunnel. */
async function gitPushViaProxy(
  proxyPort: number,
  repoPath: string,
  pktLineBody: Buffer,
): Promise<{ status: number; body: string }> {
  const { socket } = await new Promise<{ socket: net.Socket }>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: `${TEST_GIT_HOST}:${gitUpstreamPort}`,
    });
    req.on("connect", (_res, socket) => resolve({ socket }));
    req.on("error", reject);
    req.end();
  });

  const tlsSocket = tls.connect({
    socket,
    ca: ca.cert,
    servername: TEST_GIT_HOST,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.on("secureConnect", resolve);
    tlsSocket.on("error", reject);
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => tlsSocket as unknown as net.Socket,
        hostname: TEST_GIT_HOST,
        path: `/${repoPath}.git/git-receive-pack`,
        method: "POST",
        headers: {
          host: TEST_GIT_HOST,
          "content-type": "application/x-git-receive-pack-request",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(pktLineBody);
    req.end();
  });
}

await test("git push to allowed branch → 200 (forwarded)", async () => {
  const ctx = await setupGitProxy({ allowedPushRefs: ["feature-branch"] });
  try {
    const body = Buffer.concat([
      makePktLine("0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/feature-branch"),
      FLUSH,
    ]);
    lastGitPushBody = null;
    const res = await gitPushViaProxy(ctx.proxy.port, "owner/repo", body);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
    assert.ok(lastGitPushBody !== null, "push body should have been forwarded");
    assert.ok(ctx.events.some((e) => e.decision === "allow" && e.operation.includes("git push")));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("git push to main → 403 (denied)", async () => {
  const ctx = await setupGitProxy({ allowedPushRefs: ["feature-branch"] });
  try {
    const body = Buffer.concat([
      makePktLine("0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/main"),
      FLUSH,
    ]);
    const res = await gitPushViaProxy(ctx.proxy.port, "owner/repo", body);
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("refs/heads/main"));
    assert.ok(ctx.events.some((e) => e.decision === "deny" && e.operation.includes("main")));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("git push --no-verify to main → still 403 (proxy doesn't care about hooks)", async () => {
  // --no-verify only skips local hooks; the proxy enforces at the network level
  const ctx = await setupGitProxy({ allowedPushRefs: ["feature-branch"] });
  try {
    const body = Buffer.concat([
      makePktLine("0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/main\0 report-status"),
      FLUSH,
    ]);
    const res = await gitPushViaProxy(ctx.proxy.port, "owner/repo", body);
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("refs/heads/main"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("git push to different repo → 403 (cross-repo)", async () => {
  const ctx = await setupGitProxy();
  try {
    const body = Buffer.concat([
      makePktLine("0000000000000000000000000000000000000000 abc123abc123abc123abc123abc123abc123abc1 refs/heads/feature-branch"),
      FLUSH,
    ]);
    const res = await gitPushViaProxy(ctx.proxy.port, "other/repo", body);
    assert.equal(res.status, 403);
    assert.ok(res.body.includes("cross-repo"));
  } finally {
    await ctx.proxy.stop();
  }
});

await test("git fetch (non-push) → forwarded without policy check", async () => {
  // GET requests to github.com should pass through (ref advertisement, clone)
  const ctx = await setupGitProxy();
  try {
    // Use the normal requestViaProxy but target the git host
    const { socket } = await new Promise<{ socket: net.Socket }>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: ctx.proxy.port,
        method: "CONNECT",
        path: `${TEST_GIT_HOST}:${gitUpstreamPort}`,
      });
      req.on("connect", (_res, socket) => resolve({ socket }));
      req.on("error", reject);
      req.end();
    });

    const tlsSocket = tls.connect({
      socket,
      ca: ca.cert,
      servername: TEST_GIT_HOST,
    });

    await new Promise<void>((resolve, reject) => {
      tlsSocket.on("secureConnect", resolve);
      tlsSocket.on("error", reject);
    });

    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          createConnection: () => tlsSocket as unknown as net.Socket,
          hostname: TEST_GIT_HOST,
          path: "/owner/repo.git/info/refs?service=git-upload-pack",
          method: "GET",
          headers: { host: TEST_GIT_HOST },
        },
        (res) => {
          res.resume(); // drain
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.status, 200, "GET should be forwarded");
  } finally {
    await ctx.proxy.stop();
  }
});

// --- Cleanup ---
mockUpstream.close();
mockGitUpstream.close();
rmSync(tempDir, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
