// scripts/test-electron-download.ts
//
// Targeted experiment: can Electron's postinstall binary download succeed
// through the Bouncer proxy + iptables sandbox?
//
// Tests three layers:
//   1. Does global-agent load and patch https.globalAgent?
//   2. Can the proxy tunnel to GitHub releases + redirect targets?
//   3. Does `npm install electron` succeed end-to-end?
//
// Requires Docker.
// Usage: npx tsx scripts/test-electron-download.ts

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureCA, type BouncerCA } from "../src/main/proxy-tls.js";
import { startProxy, type ProxyConfig, type ProxyHandle } from "../src/main/proxy.js";
import { createSessionNetwork, type SessionNetwork } from "../src/main/proxy-network.js";
import type { PolicyEvent } from "../src/main/types.js";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err}`);
    failed++;
    return false;
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function resolveAgentImage(): Promise<string> {
  const dockerDir = join(process.cwd(), "docker");
  const dockerfilePath = join(dockerDir, "agent.Dockerfile");
  const hasher = createHash("sha256");
  hasher.update(readFileSync(dockerfilePath, "utf-8"));
  hasher.update(readFileSync(join(dockerDir, "entrypoint.sh"), "utf-8"));
  const hash = hasher.digest("hex").slice(0, 12);
  const imageTag = `bouncer-agent:${hash}`;

  try {
    await execFileAsync("docker", ["image", "inspect", imageTag], { timeout: 10_000 });
    return imageTag;
  } catch {
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

console.log("\nElectron download experiment\n");

const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.log("  ⚠ Docker not available — skipping\n");
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), "bouncer-electron-"));
let ca: BouncerCA;
let proxy: ProxyHandle | undefined;
let network: SessionNetwork | undefined;
let imageTag: string;
const events: PolicyEvent[] = [];
const sessionId = `electron-${Date.now().toString(36)}`;

try {
  ca = await ensureCA(tempDir);
  imageTag = await resolveAgentImage();

  // Use the SAME allowedDomains as the real policy template
  const proxyConfig: ProxyConfig = {
    sessionId,
    port: 0,
    listenHost: "0.0.0.0",
    allowedDomains: [
      "api.anthropic.com",
      "platform.claude.com",
      "github.com",
      "api.github.com",
      "uploads.github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
      "registry.npmjs.org",
      "crates.io",
      "static.crates.io",
      "index.crates.io",
      "pypi.org",
      "files.pythonhosted.org",
    ],
    inspectedDomains: ["api.github.com", "github.com"],
    githubPolicy: null, // No GitHub policy needed for this test
    ca,
    onPolicyEvent: (e) => {
      events.push(e);
      // Log deny events immediately so we can see what's blocked
      if (e.decision === "deny") {
        console.log(`    [proxy] DENY: ${e.operation} — ${e.reason}`);
      }
    },
    insecureUpstreamTls: false,
  };

  proxy = await startProxy(proxyConfig);
  network = await createSessionNetwork(sessionId);

  const proxyUrl = `http://host.docker.internal:${proxy.port}`;

  const dockerRunBase = [
    "run", "--rm",
    "--network", network.networkName,
    "--add-host=host.docker.internal:host-gateway",
    "--cap-add=NET_ADMIN",  // For iptables
    "-e", `HTTP_PROXY=${proxyUrl}`,
    "-e", `HTTPS_PROXY=${proxyUrl}`,
    "-e", `http_proxy=${proxyUrl}`,
    "-e", `https_proxy=${proxyUrl}`,
    "-e", "NO_PROXY=localhost,127.0.0.1,::1",
    "-e", "no_proxy=localhost,127.0.0.1,::1",
    "-e", `BOUNCER_PROXY_HOST=host.docker.internal`,
    "-e", `BOUNCER_PROXY_PORT=${proxy.port}`,
    "-v", `${ca.certPath}:/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt:ro`,
  ];

  console.log(`  [setup] Proxy on port ${proxy.port}, network ${network.networkName}\n`);

  // -----------------------------------------------------------------------
  // Test 1: Does global-agent bootstrap load?
  // -----------------------------------------------------------------------
  await test("global-agent bootstrap loads and patches https.globalAgent", async () => {
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "node", "-e", `
          const https = require('https');
          const agentClass = https.globalAgent.constructor.name;
          // global-agent replaces the default Agent with a proxy-aware one
          console.log('agent-class:' + agentClass);
          // Also check that the env vars are set
          console.log('NODE_OPTIONS:' + (process.env.NODE_OPTIONS || 'NOT SET'));
          console.log('GLOBAL_AGENT_HTTPS_PROXY:' + (process.env.GLOBAL_AGENT_HTTPS_PROXY || 'NOT SET'));
        `,
      ],
      { timeout: 30_000 },
    );
    console.log(`    stdout: ${stdout.trim().replace(/\n/g, "\n    stdout: ")}`);
    // global-agent replaces the Agent with its own class
    assert.ok(
      !stdout.includes("agent-class:Agent"),
      `Expected global-agent to replace https.globalAgent, but got default Agent. NODE_OPTIONS may not be set.`,
    );
  });

  // -----------------------------------------------------------------------
  // Test 2: Can we reach github.com through the proxy?
  // -----------------------------------------------------------------------
  await test("curl to github.com works through proxy", async () => {
    const { stdout } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "10",
        "https://github.com/electron/electron/releases",
      ],
      { timeout: 30_000 },
    );
    assert.equal(stdout.trim(), "200", `Expected 200, got ${stdout.trim()}`);
  });

  // -----------------------------------------------------------------------
  // Test 3: Can we follow a GitHub release redirect?
  // The Electron download URL redirects to objects.githubusercontent.com
  // -----------------------------------------------------------------------
  await test("curl follows GitHub release redirect (objects.githubusercontent.com)", async () => {
    // Use -L to follow redirects, -I for headers only to avoid downloading the full binary
    const { stdout, stderr } = await execFileAsync(
      "docker",
      [
        ...dockerRunBase,
        imageTag,
        "curl", "-sI", "-L",
        "--connect-timeout", "10",
        "-o", "/dev/null", "-w", "%{http_code} %{url_effective}",
        "https://github.com/electron/electron/releases/latest",
      ],
      { timeout: 30_000 },
    );
    console.log(`    result: ${stdout.trim()}`);
    // If the redirect target (*.githubusercontent.com) is blocked,
    // the final status won't be 200
    assert.ok(
      stdout.includes("200"),
      `Expected 200 after following redirects, got: ${stdout.trim()}`,
    );
  });

  // -----------------------------------------------------------------------
  // Test 4: Does Node.js https.request work through the proxy?
  // (This is what `got` uses internally)
  // -----------------------------------------------------------------------
  await test("node https.request to github.com goes through proxy", async () => {
    let stdout = "", stderr = "";
    try {
      const result = await execFileAsync(
        "docker",
        [
          ...dockerRunBase,
          imageTag,
          "node", "-e", `
            const https = require('https');
            const req = https.get('https://github.com/electron/electron/releases', (res) => {
              console.log('status:' + res.statusCode);
              res.resume();
              res.on('end', () => process.exit(0));
            });
            req.on('error', (err) => {
              console.log('error:' + err.message);
              process.exit(1);
            });
            req.setTimeout(15000, () => {
              console.log('error:timeout');
              process.exit(1);
            });
          `,
        ],
        { timeout: 30_000 },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    console.log(`    stdout: ${stdout.trim()}`);
    if (stderr) console.log(`    stderr (last 5 lines): ${stderr.trim().split("\n").slice(-5).join("\n      ")}`);
    assert.ok(
      stdout.includes("status:200") || stdout.includes("status:301") || stdout.includes("status:302"),
      `Expected 200/301/302, got: ${stdout.trim()}`,
    );
  });

  // -----------------------------------------------------------------------
  // Test 5: Full npm install electron in a temp directory
  // -----------------------------------------------------------------------
  console.log("\n  --- Full npm install electron test (may take a while) ---\n");

  await test("npm install electron succeeds in sandbox", async () => {
    let stdout = "", stderr = "";
    try {
      const result = await execFileAsync(
        "docker",
        [
          ...dockerRunBase,
          imageTag,
          "bash", "-c", `
            TMPDIR=$(mktemp -d)
            cd "$TMPDIR"
            echo '{"name":"electron-test","private":true,"dependencies":{"electron":"^41.0.0"}}' > package.json
            echo "=== Starting npm install ==="
            npm install 2>&1
            EXIT=$?
            echo "=== npm install exit code: $EXIT ==="
            ls -la node_modules/electron/dist/ 2>/dev/null | head -5 || echo "No electron dist directory"
            node -e "console.log('electron-path:' + require('electron'))" 2>/dev/null || echo "require('electron') failed"
            exit $EXIT
          `,
        ],
        { timeout: 300_000 }, // 5 minutes — electron download can be slow
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    console.log(`    stdout (last 30 lines):\n${stdout.split("\n").slice(-30).map(l => "      " + l).join("\n")}`);
    if (stderr) {
      console.log(`    stderr (last 10 lines):\n${stderr.split("\n").slice(-10).map(l => "      " + l).join("\n")}`);
    }
    assert.ok(
      !stdout.includes("ETIMEDOUT") && !stdout.includes("ECONNREFUSED") && stdout.includes("npm install exit code: 0"),
      `npm install failed`,
    );
  });

  // -----------------------------------------------------------------------
  // Summary: show all deny events
  // -----------------------------------------------------------------------
  const denyEvents = events.filter((e) => e.decision === "deny");
  if (denyEvents.length > 0) {
    console.log(`\n  --- Proxy deny events (${denyEvents.length}) ---`);
    for (const e of denyEvents) {
      console.log(`    DENY: ${e.operation} — ${e.reason}`);
    }
  }

} finally {
  await proxy?.stop();
  await network?.cleanup();
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
