// src/main/proxy-network.ts
//
// Docker network management for the proxy-based network boundary.
// Creates per-session bridge networks. Containers on these networks are configured
// with HTTP_PROXY/HTTPS_PROXY env vars pointing to the host proxy, which enforces
// domain allowlists. Note: this is env-var-based routing, not network-level enforcement.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NETWORK_PREFIX = "bouncer-net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionNetwork {
  networkName: string;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createSessionNetwork()
// ---------------------------------------------------------------------------

/**
 * Create a Docker bridge network for a session.
 * Containers on this network reach the internet via the host proxy
 * (HTTP_PROXY/HTTPS_PROXY env vars). We use a standard bridge rather
 * than `--internal` because `--internal` blocks host access entirely,
 * making host.docker.internal unreachable. The proxy is the enforcement
 * layer — it blocks disallowed domains.
 */
export async function createSessionNetwork(
  sessionId: string,
): Promise<SessionNetwork> {
  const networkName = `${NETWORK_PREFIX}-${sessionId}`;

  // Check if the network already exists (e.g., left over from a crash)
  try {
    await execFileAsync("docker", ["network", "inspect", networkName], {
      timeout: 10_000,
    });
    // Network exists — reuse it
  } catch {
    // Network doesn't exist — create it
    await execFileAsync(
      "docker",
      [
        "network",
        "create",
        networkName,
        "--driver",
        "bridge",
        "--label",
        "glitterball.managed=true",
        "--label",
        `glitterball.sessionId=${sessionId}`,
      ],
      { timeout: 10_000 },
    );
  }

  return {
    networkName,
    async cleanup() {
      await execFileAsync("docker", ["network", "rm", networkName]).catch(
        () => {},
      ); // idempotent
    },
  };
}

// ---------------------------------------------------------------------------
// cleanupOrphanNetworks()
// ---------------------------------------------------------------------------

/**
 * Remove any bouncer networks that don't belong to active sessions.
 * Called at startup to clean up after crashes.
 */
export async function cleanupOrphanNetworks(
  activeSessionIds: Set<string>,
): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "docker",
      [
        "network",
        "ls",
        "--filter",
        "label=glitterball.managed=true",
        "--format",
        "{{.Name}}",
      ],
      { timeout: 10_000 },
    );
    stdout = result.stdout;
  } catch {
    return; // Docker not available or error — nothing to clean up
  }

  const names = stdout.trim().split("\n").filter(Boolean);
  for (const name of names) {
    // Extract session ID from network name: bouncer-net-{sessionId}
    const sessionId = name.startsWith(`${NETWORK_PREFIX}-`)
      ? name.slice(NETWORK_PREFIX.length + 1)
      : null;
    if (sessionId && !activeSessionIds.has(sessionId)) {
      console.log(`[proxy-network] Removing orphan network: ${name}`);
      try {
        await execFileAsync("docker", ["network", "rm", name], {
          timeout: 10_000,
        });
      } catch {
        console.warn(
          `[proxy-network] Failed to remove orphan network: ${name}`,
        );
      }
    }
  }
}
