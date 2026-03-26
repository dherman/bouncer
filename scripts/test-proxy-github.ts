// scripts/test-proxy-github.ts
//
// Tests for Phase 5: GitHub REST API enforcement in the proxy MITM handler.
// Uses a mock HTTPS upstream to test policy decisions
// and PR capture without hitting the real GitHub API.
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
const TEST_API_HOST = "localhost";
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

await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (mockUpstream.address() as net.AddressInfo).port;

// --- Helpers ---

function makePolicy(overrides: Partial<GitHubPolicy> = {}): GitHubPolicy {
  return {
    repo: "owner/repo",
    allowedPushRefs: ["feature-branch"],
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

// --- Cleanup ---
mockUpstream.close();
rmSync(tempDir, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
