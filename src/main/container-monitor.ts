/**
 * Container lifecycle monitor.
 *
 * Watches Docker events for a container and emits violations for
 * unexpected lifecycle events (OOM kill, unexpected exit, etc.).
 * Policy events (gh shim, git hooks) are already captured via stderr
 * parsing and don't need a separate monitor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { SandboxMonitorEvents } from "./sandbox-monitor.js";

export class ContainerMonitor extends EventEmitter<SandboxMonitorEvents> {
  private dockerProcess: ChildProcess | null = null;

  /**
   * Start monitoring Docker events for a container.
   * Watches for OOM kills, unexpected exits, and other lifecycle events.
   */
  start(containerName: string): void {
    if (this.dockerProcess) {
      this.dockerProcess.kill();
      this.dockerProcess = null;
    }

    this.dockerProcess = spawn(
      "docker",
      [
        "events",
        "--filter", `container=${containerName}`,
        "--format", "{{json .}}",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const rl = createInterface({ input: this.dockerProcess.stdout! });
    rl.on("line", (line) => {
      this.parseEvent(line, containerName);
    });

    this.dockerProcess.on("error", (err) => {
      console.warn(`[container-monitor] docker events error: ${err.message}`);
    });

    this.dockerProcess.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.warn(`[container-monitor] docker events exited with code ${code}`);
      }
    });
  }

  stop(): void {
    if (this.dockerProcess) {
      this.dockerProcess.kill();
      this.dockerProcess = null;
    }
  }

  private parseEvent(line: string, containerName: string): void {
    try {
      const event = JSON.parse(line) as {
        status?: string;
        Action?: string;
        Actor?: { Attributes?: Record<string, string> };
      };

      const action = event.Action ?? event.status ?? "";

      // OOM kill
      if (action === "oom") {
        this.emit("violation", {
          timestamp: new Date(),
          pid: 0,
          processName: containerName,
          operation: "oom-kill",
          path: undefined,
          raw: line,
        });
      }

      // Unexpected die (non-zero exit)
      if (action === "die") {
        const exitCode = event.Actor?.Attributes?.exitCode;
        if (exitCode && exitCode !== "0") {
          this.emit("violation", {
            timestamp: new Date(),
            pid: 0,
            processName: containerName,
            operation: `container-exit(${exitCode})`,
            path: undefined,
            raw: line,
          });
        }
      }
    } catch {
      // Not valid JSON — skip
    }
  }
}
