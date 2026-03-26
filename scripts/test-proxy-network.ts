// scripts/test-proxy-network.ts
//
// Tests for Phase 3: container networking with proxy.
// Unit tests for buildDockerRunArgs proxy mode.
// Integration tests (Docker required) for network isolation + proxy egress.
//
// Usage: npx tsx scripts/test-proxy-network.ts

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDockerRunArgs, type ContainerConfig } from "../src/main/container.js";
import { ensureCA, type BouncerCA } from "../src/main/proxy-tls.js";
import { startProxy, type ProxyConfig } from "../src/main/proxy.js";
import {
  createSessionNetwork,
  cleanupOrphanNetworks,
} from "../src/main/proxy-network.js";
import type { PolicyEvent } from "../src/main/types.js";

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

// --- Check Docker availability ---

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// =========================================================================
// Unit tests: buildDockerRunArgs with proxy networkMode
// =========================================================================

console.log("\nproxy-network tests\n");
console.log("  buildDockerRunArgs:");

function makeContainerConfig(
  overrides: Partial<ContainerConfig> = {},
): ContainerConfig {
  return {
    sessionId: "test-123",
    image: "test-image:latest",
    command: ["echo", "hello"],
    workdir: "/workspace",
    mounts: [],
    env: {},
    networkMode: "bridge",
    ...overrides,
  };
}

await test("networkMode 'proxy' with networkName uses the named network", () => {
  const args = buildDockerRunArgs(
    makeContainerConfig({
      networkMode: "proxy",
      networkName: "bouncer-net-test-123",
    }),
  );
  const netIdx = args.indexOf("--network");
  assert.ok(netIdx >= 0, "--network flag should be present");
  assert.equal(args[netIdx + 1], "bouncer-net-test-123");
});

await test("networkMode 'proxy' without networkName throws", () => {
  assert.throws(
    () => buildDockerRunArgs(makeContainerConfig({ networkMode: "proxy" })),
    /networkName is required/,
  );
});

await test("networkMode 'none' still works", () => {
  const args = buildDockerRunArgs(
    makeContainerConfig({ networkMode: "none" }),
  );
  const netIdx = args.indexOf("--network");
  assert.equal(args[netIdx + 1], "none");
});

await test("networkMode 'bridge' still works", () => {
  const args = buildDockerRunArgs(
    makeContainerConfig({ networkMode: "bridge" }),
  );
  const netIdx = args.indexOf("--network");
  assert.equal(args[netIdx + 1], "bridge");
});

// =========================================================================
// Integration tests (Docker required)
// =========================================================================

const dockerAvailable = await isDockerAvailable();

if (!dockerAvailable) {
  console.log("\n  ⚠ Docker not available — skipping integration tests\n");
} else {
  console.log("\n  Docker integration:");

  const tempDir = mkdtempSync(join(tmpdir(), "bouncer-net-test-"));
  let ca: BouncerCA;

  try {
    ca = await ensureCA(tempDir);

    await test("createSessionNetwork creates a Docker bridge network", async () => {
      const net = await createSessionNetwork("integ-test-1");
      try {
        // Verify the network exists
        const { stdout: driver } = await execFileAsync("docker", [
          "network",
          "inspect",
          net.networkName,
          "--format",
          "{{.Driver}}",
        ]);
        assert.equal(driver.trim(), "bridge", "network should use bridge driver");

        // Verify labels
        const { stdout: labels } = await execFileAsync("docker", [
          "network",
          "inspect",
          net.networkName,
          "--format",
          '{{index .Labels "glitterball.managed"}}',
        ]);
        assert.equal(labels.trim(), "true", "should have managed label");
      } finally {
        await net.cleanup();
      }
    });

    await test("createSessionNetwork cleanup is idempotent", async () => {
      const net = await createSessionNetwork("integ-test-2");
      await net.cleanup();
      // Second cleanup should not throw
      await net.cleanup();
    });

    await test("cleanupOrphanNetworks removes untracked networks", async () => {
      const net = await createSessionNetwork("orphan-test");
      // Don't include this session in active set
      await cleanupOrphanNetworks(new Set(["other-session"]));

      // Network should be gone
      try {
        await execFileAsync("docker", [
          "network",
          "inspect",
          net.networkName,
        ]);
        assert.fail("network should have been removed");
      } catch (err: any) {
        const msg = (err.message ?? "") + (err.stderr ?? "");
        assert.ok(
          msg.includes("No such network") || msg.includes("not found"),
          `expected network-not-found error, got: ${msg}`,
        );
      }
    });

    await test("cleanupOrphanNetworks preserves active session networks", async () => {
      const net = await createSessionNetwork("active-test");
      try {
        await cleanupOrphanNetworks(new Set(["active-test"]));

        // Network should still exist
        const { stdout } = await execFileAsync("docker", [
          "network",
          "inspect",
          net.networkName,
          "--format",
          "{{.Name}}",
        ]);
        assert.equal(stdout.trim(), net.networkName);
      } finally {
        await net.cleanup();
      }
    });

    await test("container on session network routes traffic through proxy", async () => {
      const sessionId = "isolation-test";
      const events: PolicyEvent[] = [];

      // 1. Start proxy
      const proxy = await startProxy({
        sessionId,
        port: 0,
        listenHost: "0.0.0.0", // Must be reachable from container
        allowedDomains: ["api.github.com", "*.github.com"],
        inspectedDomains: [],
        githubPolicy: null,
        ca,
        onPolicyEvent: (e) => events.push(e),
      });

      // 2. Create internal network
      const net = await createSessionNetwork(sessionId);

      try {
        // 3. Run a container on the session network and test connectivity
        const proxyUrl = `http://host.docker.internal:${proxy.port}`;

        // Common docker run args for proxy-configured containers.
        // --add-host ensures host.docker.internal resolves on Linux Docker engines.
        const dockerRunBase = [
          "run",
          "--rm",
          "--network",
          net.networkName,
          "--add-host=host.docker.internal:host-gateway",
          "-e",
          `HTTP_PROXY=${proxyUrl}`,
          "-e",
          `HTTPS_PROXY=${proxyUrl}`,
          "-e",
          `http_proxy=${proxyUrl}`,
          "-e",
          `https_proxy=${proxyUrl}`,
        ];

        // Test: proxy egress works for allowed domain
        const { stdout: allowedResult } = await execFileAsync(
          "docker",
          [
            ...dockerRunBase,
            "alpine/curl",
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--connect-timeout",
            "10",
            "--proxy-insecure",
            "https://api.github.com/",
          ],
          { timeout: 30_000 },
        );
        assert.equal(
          allowedResult.trim(),
          "200",
          `allowed domain should return 200, got ${allowedResult.trim()}`,
        );

        // Test: proxy blocks denied domain
        // curl exits non-zero when CONNECT returns 403, so we catch the error
        // and verify from the deny event instead
        try {
          await execFileAsync(
            "docker",
            [
              ...dockerRunBase,
              "alpine/curl",
              "curl",
              "-s",
              "-o",
              "/dev/null",
              "-w",
              "%{http_code}",
              "--connect-timeout",
              "10",
              "https://evil.example.com/",
            ],
            { timeout: 30_000 },
          );
          // If curl somehow succeeded, that's a failure
          assert.fail("curl to denied domain should have failed");
        } catch {
          // Expected — curl returns non-zero on proxy 403
        }

        // Verify deny event was logged
        assert.ok(
          events.some((e) => e.decision === "deny"),
          "should have logged a deny event for evil.example.com",
        );
      } finally {
        await proxy.stop();
        await net.cleanup();
      }
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
