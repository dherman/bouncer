/**
 * Container lifecycle management for Docker-based agent sandboxing.
 *
 * Phase 1: image availability check and build infrastructure.
 * Phase 2: container spawn, teardown, and orphan cleanup.
 */

import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const execFileAsync = promisify(execFile);

export const AGENT_IMAGE_PREFIX = 'bouncer-agent';
const CONTAINER_PREFIX = 'bouncer';

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
  networkMode: 'none' | 'bridge' | 'proxy';
  /** Docker network name (required when networkMode is "proxy") */
  networkName?: string;
}

export interface ContainerHandle {
  process: ChildProcess;
  containerName: string;
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
    await execFileAsync('docker', ['info'], { timeout: 10_000 });
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

async function resolveDockerfilePath(): Promise<string> {
  const { app } = await import('electron');
  if (app.isPackaged) {
    return join(process.resourcesPath, 'docker', 'agent.Dockerfile');
  }
  return join(app.getAppPath(), 'docker', 'agent.Dockerfile');
}

export async function ensureAgentImage(): Promise<string> {
  const dockerfilePath = await resolveDockerfilePath();
  const dockerDir = dirname(dockerfilePath);
  const hasher = createHash('sha256');
  // Version salt: bump this when the hash inputs change (e.g. adding new files)
  // to avoid collisions with images built under an older hashing scheme.
  hasher.update('v2:');
  hasher.update(await readFile(dockerfilePath, 'utf-8'));
  // Include entrypoint.sh in the hash — it's COPY'd into the image and changes
  // to it (e.g. proxy setup, iptables rules) must trigger a rebuild.
  try {
    hasher.update(await readFile(join(dockerDir, 'entrypoint.sh'), 'utf-8'));
  } catch {
    // entrypoint.sh not found — hash Dockerfile only
  }
  const hash = hasher.digest('hex').slice(0, 12);
  const imageTag = `${AGENT_IMAGE_PREFIX}:${hash}`;

  try {
    await execFileAsync('docker', ['image', 'inspect', imageTag], {
      timeout: 10_000,
    });
    console.log(`[container] Image ${imageTag} already exists, skipping build`);
    return imageTag;
  } catch {
    // Image doesn't exist — build it
  }

  console.log(`[container] Building image ${imageTag}...`);
  await execFileAsync('docker', ['build', '-t', imageTag, '-f', dockerfilePath, dockerDir], {
    timeout: 600_000,
  });
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
    'run',
    '-i',
    '--rm',
    '--name',
    name,
    '--label',
    'bouncer.managed=true',
    '--label',
    `bouncer.sessionId=${config.sessionId}`,
  ];

  for (const m of config.mounts) {
    const flag = m.readOnly
      ? `${m.hostPath}:${m.containerPath}:ro`
      : `${m.hostPath}:${m.containerPath}`;
    args.push('-v', flag);
  }

  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push('-w', config.workdir);
  if (config.networkMode === 'proxy') {
    // NET_ADMIN is needed for iptables rules that enforce proxy usage
    args.push('--cap-add=NET_ADMIN');
    if (!config.networkName) {
      throw new Error('ContainerConfig.networkName is required when networkMode is "proxy"');
    }
    args.push('--network', config.networkName);
    // Ensure host.docker.internal resolves on Linux Docker engines
    args.push('--add-host=host.docker.internal:host-gateway');
  } else {
    args.push('--network', config.networkMode);
  }
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

  const proc = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.on('error', (err) => {
    console.error(`[container] Failed to spawn docker process for ${name}:`, err);
  });

  return {
    process: proc,
    containerName: name,
    kill() {
      proc.kill();
      // Force-remove in case the process doesn't exit cleanly.
      // Fire-and-forget — removeContainer is idempotent.
      execFileAsync('docker', ['rm', '-f', name]).catch(() => {});
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
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 10_000 });
  } catch {
    // Container already gone — fine
  }
}

/**
 * Find and remove any bouncer containers that don't belong to active
 * sessions. Called at startup to clean up after crashes.
 */
export async function cleanupOrphanContainers(activeSessionIds: Set<string>): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'docker',
      [
        'ps',
        '-a',
        '--filter',
        'label=bouncer.managed=true',
        '--format',
        '{{.Label "bouncer.sessionId"}}\t{{.Names}}',
      ],
      { timeout: 10_000 },
    );
    stdout = result.stdout;
  } catch (err) {
    console.warn('[container] Failed to list containers for orphan cleanup:', err);
    return;
  }

  const lines = stdout.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [sessionId, name] = line.split('\t');
    if (sessionId && name && !activeSessionIds.has(sessionId)) {
      console.log(`[container] Removing orphan container: ${name}`);
      try {
        await execFileAsync('docker', ['rm', '-f', name], { timeout: 10_000 });
      } catch {
        console.warn(`[container] Failed to remove orphan container: ${name}`);
      }
    }
  }
}
