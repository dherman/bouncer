/**
 * Container lifecycle management for Docker-based agent sandboxing.
 *
 * Phase 1: image availability check and build infrastructure.
 * Phase 2: container spawn, teardown, and orphan cleanup.
 */

import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { app } from "electron";

const execFileAsync = promisify(execFile);

export const AGENT_IMAGE_PREFIX = "glitterball-agent";
const CONTAINER_PREFIX = "glitterball";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface ContainerConfig {
  sessionId: string;
  image: string;
  command: string[];
  workdir: string;
  mounts: ContainerMount[];
  env: Record<string, string>;
  networkMode: "none" | "bridge";
}

export interface ContainerHandle {
  process: ChildProcess;
  containerId: string;
  kill(): void;
}

// ---------------------------------------------------------------------------
// Docker availability (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Check whether Docker is available on this machine.
 * A positive result is cached permanently. A negative result is re-probed
 * after a cooldown, since Docker Desktop may start after the app.
 */
let _dockerAvailable: boolean | null = null;
let _dockerCheckedAt = 0;
const DOCKER_RETRY_MS = 60_000;

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable === true) return true;
  if (_dockerAvailable === false && Date.now() - _dockerCheckedAt < DOCKER_RETRY_MS) {
    return false;
  }
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  _dockerCheckedAt = Date.now();
  return _dockerAvailable;
}

// ---------------------------------------------------------------------------
// Image build (Phase 1)
// ---------------------------------------------------------------------------

function resolveDockerfilePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "docker", "agent.Dockerfile");
  }
  return join(app.getAppPath(), "docker", "agent.Dockerfile");
}

export async function ensureAgentImage(): Promise<string> {
  const dockerfilePath = resolveDockerfilePath();
  const content = await readFile(dockerfilePath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const imageTag = `${AGENT_IMAGE_PREFIX}:${hash}`;

  try {
    await execFileAsync("docker", ["image", "inspect", imageTag], {
      timeout: 10_000,
    });
    console.log(`[container] Image ${imageTag} already exists, skipping build`);
    return imageTag;
  } catch {
    // Image doesn't exist — build it
  }

  const dockerDir = dirname(dockerfilePath);
  console.log(`[container] Building image ${imageTag}...`);
  await execFileAsync(
    "docker",
    ["build", "-t", imageTag, "-f", dockerfilePath, dockerDir],
    { timeout: 600_000 },
  );
  console.log(`[container] Image ${imageTag} built successfully`);
  return imageTag;
}

// ---------------------------------------------------------------------------
// Container spawn + teardown (Phase 2)
// ---------------------------------------------------------------------------

function containerName(sessionId: string): string {
  return `${CONTAINER_PREFIX}-${sessionId}`;
}

/**
 * Build the `docker run` argument list from a ContainerConfig.
 * Does not include the leading `"docker"` — caller passes these to
 * `spawn("docker", args)`.
 */
export function buildDockerRunArgs(config: ContainerConfig): string[] {
  const name = containerName(config.sessionId);
  const args: string[] = [
    "run", "-i", "--rm",
    "--name", name,
  ];

  for (const m of config.mounts) {
    const flag = m.readOnly
      ? `${m.hostPath}:${m.containerPath}:ro`
      : `${m.hostPath}:${m.containerPath}`;
    args.push("-v", flag);
  }

  for (const [key, value] of Object.entries(config.env)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push("-w", config.workdir);
  args.push("--network", config.networkMode);
  args.push(config.image);
  args.push(...config.command);

  return args;
}

/**
 * Spawn a Docker container and return a handle for stdio communication.
 */
export function spawnContainer(config: ContainerConfig): ContainerHandle {
  const args = buildDockerRunArgs(config);
  const name = containerName(config.sessionId);

  const proc = spawn("docker", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    process: proc,
    containerId: name,
    kill() {
      proc.kill();
      // Force-remove in case the process doesn't exit cleanly.
      // Fire-and-forget — removeContainer is idempotent.
      execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
    },
  };
}

/**
 * Force-remove a container by session ID. Idempotent — safe to call on
 * already-stopped or nonexistent containers.
 */
export async function removeContainer(sessionId: string): Promise<void> {
  const name = containerName(sessionId);
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 10_000 });
  } catch {
    // Container already gone — fine
  }
}

/**
 * Find and remove any glitterball containers that don't belong to active
 * sessions. Called at startup to clean up after crashes.
 */
export async function cleanupOrphanContainers(
  activeSessionIds: Set<string>,
): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "docker",
      ["ps", "-a", "--filter", `name=${CONTAINER_PREFIX}-`, "--format", "{{.Names}}"],
      { timeout: 10_000 },
    );
    stdout = result.stdout;
  } catch {
    return; // Docker not available or error — nothing to clean up
  }

  const names = stdout.trim().split("\n").filter(Boolean);
  for (const name of names) {
    const sessionId = name.slice(CONTAINER_PREFIX.length + 1);
    if (!activeSessionIds.has(sessionId)) {
      console.log(`[container] Removing orphan container: ${name}`);
      try {
        await execFileAsync("docker", ["rm", "-f", name], { timeout: 10_000 });
      } catch {
        console.warn(`[container] Failed to remove orphan container: ${name}`);
      }
    }
  }
}
