// scripts/test-proxy-e2e.ts
//
// End-to-end integration test for M7 Phase 7.7: simulates the full session
// manager proxy lifecycle without Electron. Exercises:
//   - CA generation → proxy startup → network creation → container spawn
//   - Allowed domain tunneling (registry.npmjs.org, non-inspected)
//   - Denied domain blocking (evil.example.com)
//   - GitHub REST API enforcement (MITM'd api.github.com)
//   - CA trust inside the container (entrypoint installs cert)
//   - Clean teardown (proxy stop, network remove)
//
// Requires Docker. Uses the bouncer agent image (builds if needed).
//
// Usage: npx tsx scripts/test-proxy-e2e.ts

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureCA, type BouncerCA } from "../src/main/proxy-tls.js";
import { startProxy, type ProxyConfig, type ProxyHandle } from "../src/main/proxy.js";
import { createGitHubMitmHandler } from "../src/main/proxy-github.js";
import { createSessionNetwork, type SessionNetwork } from "../src/main/proxy-network.js";
import type { GitHubPolicy, PolicyEvent } from "../src/main/types.js";

const execFileAsync = promisify(execFile);

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

// --- Docker check ---

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// --- Resolve agent image (same logic as container.ts but without Electron) ---

async function resolveAgentImage(): Promise<string> {
  const dockerDir = join(process.cwd(), "docker");
  const dockerfilePath = join(dockerDir, "agent.Dockerfile");
  // Hash all build-context files so image is rebuilt when any input changes
  const hasher = createHash("sha256");
  hasher.update(readFileSync(dockerfilePath, "utf-8"));
  hasher.update(readFileSync(join(dockerDir, "entrypoint.sh"), "utf-8"));
  const hash = hasher.digest("hex").slice(0, 12);
  const imageTag = `bouncer-agent:${hash}`;

  try {
    await execFileAsync("docker", ["image", "inspect", imageTag], { timeout: 10_000 });
    return imageTag;
  } catch {
    // Build the image
    console.log(`  [setup] Building agent image ${imageTag}...`);
    await execFileAsync(
      "docker",
      ["build", "-t", imageTag, "-f", dockerfilePath, join(process.cwd(), "docker")],
      { timeout: 600_000 },
    );
    return imageTag;
  }
}

// =========================================================================

console.log("\nM7 proxy end-to-end test\n");

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.log("  ⚠ Docker not available — skipping end-to-end test\n");
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), "bouncer-e2e-"));
let ca: BouncerCA;
let proxy: ProxyHandle | undefined;
let network: SessionNetwork | undefined;
let imageTag: string;
const events: PolicyEvent[] = [];
const sessionId = `e2e-${Date.now().toString(36)}`;

try {
  // --- Setup: replicate what session-manager.ts does ---

  ca = await ensureCA(tempDir);
  imageTag = await resolveAgentImage();

  const policy: GitHubPolicy = {
    repo: "owner/repo",
    allowedPushRefs: ["feature-branch"],
    protectedBranches: ["main"],
    ownedPrNumber: null,
    canCreatePr: true,
  };

  const proxyConfig: ProxyConfig = {
    sessionId,
    port: 0,
    listenHost: "0.0.0.0",
    allowedDomains: [
      "api.github.com",
      "*.github.com",
      "github.com",
      "registry.npmjs.org",
    ],
    inspectedDomains: ["api.github.com", "github.com"],
    githubPolicy: policy,
    ca,
    onPolicyEvent: (e) => events.push(e),
    insecureUpstreamTls: false,
  };
  proxyConfig.onMitmRequest = createGitHubMitmHandler(proxyConfig);

  proxy = await startProxy(proxyConfig);
  network = await createSessionNetwork(sessionId);

  const proxyUrl = `http://host.docker.internal:${proxy.port}`;

  // Common docker run args: session network, proxy env vars, CA cert mount, host-gateway
  const dockerRunBase = [
    "run", "--rm",
    "--network", network.networkName,
    "--add-host=host.docker.internal:host-gateway",
    "-e", `HTTP_PROXY=${proxyUrl}`,
    "-e", `HTTPS_PROXY=${proxyUrl}`,
    "-e", `http_proxy=${proxyUrl}`,
    "-e", `https_proxy=${proxyUrl}`,
    "-e", "NO_PROXY=localhost,127.0.0.1,::1",
    "-e", "no_proxy=localhost,127.0.0.1,::1",
    "-v", `${ca.certPath}:/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt:ro`,
  ];

  console.log(`  [setup] Proxy on port ${proxy.port}, network ${network.networkName}`);

  // --- Tests ---

  await test("allowed non-inspected domain: curl registry.npmjs.org tunnels through", async () => {
    // registry.npmjs.org is in allowedDomains but not inspectedDomains,
    // so it tunnels directly through the proxy (no MITM).
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "10",
        "https://registry.npmjs.org/",
      ],
      { timeout: 30_000 },
    );
    assert.equal(stdout.trim(), "200", `expected 200, got ${stdout.trim()}`);
  });

  await test("denied domain: curl evil.example.com → blocked by proxy", async () => {
    try {
      await execFileAsync(
        "docker",
        [
          ...dockerRunBase,
          imageTag,
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "--connect-timeout", "10",
          "https://evil.example.com/",
        ],
        { timeout: 30_000 },
      );
      assert.fail("curl to denied domain should have failed");
    } catch {
      // Expected: curl returns non-zero on proxy 403
    }
    assert.ok(
      events.some((e) => e.decision === "deny" && e.operation.includes("evil.example.com")),
      "should have logged a deny event for evil.example.com",
    );
  });

  await test("GitHub REST enforcement: allowed endpoint is forwarded and logged", async () => {
    const prevLen = events.length;
    // GET /repos/owner/repo/pulls is allowed by policy. GitHub returns 404
    // for the non-existent repo, but the proxy forwards the request (allow).
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "10",
        "--proxy-insecure",
        "https://api.github.com/repos/owner/repo/pulls",
      ],
      { timeout: 30_000 },
    );
    // Proxy forwarded (allow) → GitHub responds (status varies: 200, 404, 403 rate limit)
    assert.ok(
      /^[0-9]{3}$/.test(stdout.trim()),
      `expected HTTP status code, got: ${stdout.trim()}`,
    );
    // The definitive check: proxy logged an allow event (not a deny)
    assert.ok(
      events.slice(prevLen).some((e) => e.decision === "allow" && e.operation.includes("GET")),
      "should have logged an allow event",
    );
  });

  await test("GitHub REST enforcement: POST /graphql → 403 (denied by policy)", async () => {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          ...dockerRunBase,
          imageTag,
          "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
          "--connect-timeout", "10",
          "--proxy-insecure",
          "-X", "POST",
          "https://api.github.com/graphql",
        ],
        { timeout: 30_000 },
      );
      // curl may still succeed with a 403 status
      assert.equal(stdout.trim(), "403");
    } catch {
      // curl may exit non-zero — that's also fine
    }
    assert.ok(
      events.some((e) => e.decision === "deny" && e.operation.includes("graphql")),
      "should have logged a deny for graphql",
    );
  });

  await test("CA trust: container's curl trusts Bouncer CA (entrypoint installs it)", async () => {
    // This test verifies that the entrypoint installed the CA cert properly.
    // Without the CA, curl would reject the MITM'd TLS cert.
    // We use the agent image (which has the entrypoint) without --proxy-insecure.
    // GET /repos/owner/repo/pulls is allowed by policy → forwarded to GitHub.
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "10",
        // No --proxy-insecure: relies on CA trust from entrypoint
        "https://api.github.com/repos/owner/repo/pulls",
      ],
      { timeout: 30_000 },
    );
    // If CA trust works: curl accepts the MITM cert, proxy forwards, GitHub responds.
    // If CA trust fails: curl exits with a TLS error (wouldn't reach this point).
    assert.ok(
      /^[0-9]{3}$/.test(stdout.trim()),
      `curl should trust the Bouncer CA (got: ${stdout.trim()})`,
    );
  });

  await test("policy events accumulated during session", () => {
    assert.ok(events.length > 0, "should have accumulated policy events");
    const allows = events.filter((e) => e.decision === "allow");
    const denies = events.filter((e) => e.decision === "deny");
    assert.ok(allows.length > 0, "should have allow events");
    assert.ok(denies.length > 0, "should have deny events");
    assert.ok(events.every((e) => e.tool === "proxy"), "all events should be from proxy tool");
  });

  await test("teardown: proxy stops and network is removed cleanly", async () => {
    assert.ok(proxy, "proxy should have been started");
    assert.ok(network, "network should have been created");
    const networkName = network.networkName;
    await proxy.stop();
    await network.cleanup();
    proxy = undefined;
    network = undefined;

    // Verify network is gone
    try {
      await execFileAsync("docker", ["network", "inspect", networkName]);
      assert.fail("network should have been removed");
    } catch (err: any) {
      const msg = (err.message ?? "") + (err.stderr ?? "");
      assert.ok(
        msg.includes("not found") || msg.includes("No such network"),
        `expected network-not-found, got: ${msg}`,
      );
    }
  });
} finally {
  // Best-effort cleanup in case tests failed before teardown test
  try { await proxy?.stop(); } catch {}
  try { await network?.cleanup(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
