/**
 * Container lifecycle management for Docker-based agent sandboxing.
 *
 * Phase 1: image availability check and build infrastructure.
 * Later phases add container spawn, teardown, and orphan cleanup.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";

const execFileAsync = promisify(execFile);

export const AGENT_IMAGE_PREFIX = "glitterball-agent";

/**
 * Check whether Docker is available on this machine.
 * Result is cached after first probe.
 */
let _dockerAvailable: boolean | null = null;
export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/**
 * Resolve the path to the agent Dockerfile.
 * In dev mode this is `<project>/docker/agent.Dockerfile`.
 * In a packaged app it lives under `extraResources`.
 */
function resolveDockerfilePath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "docker", "agent.Dockerfile");
  }
  return join(app.getAppPath(), "docker", "agent.Dockerfile");
}

/**
 * Build (or reuse) the agent container image.
 *
 * The image is tagged `glitterball-agent:<hash>` where `<hash>` is derived
 * from the Dockerfile contents. If an image with that tag already exists
 * the build is skipped.
 *
 * Returns the full image tag, e.g. `glitterball-agent:a1b2c3d4`.
 */
export async function ensureAgentImage(): Promise<string> {
  const dockerfilePath = resolveDockerfilePath();
  const content = await readFile(dockerfilePath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const imageTag = `${AGENT_IMAGE_PREFIX}:${hash}`;

  // Check if the image already exists
  try {
    await execFileAsync("docker", ["image", "inspect", imageTag], {
      timeout: 10_000,
    });
    console.log(`[container] Image ${imageTag} already exists, skipping build`);
    return imageTag;
  } catch {
    // Image doesn't exist — build it
  }

  const dockerDir = join(dockerfilePath, "..");
  console.log(`[container] Building image ${imageTag}...`);
  await execFileAsync(
    "docker",
    ["build", "-t", imageTag, "-f", dockerfilePath, dockerDir],
    { timeout: 600_000 }, // 10 minute timeout for builds
  );
  console.log(`[container] Image ${imageTag} built successfully`);
  return imageTag;
}
