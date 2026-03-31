import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

const execFileAsync = promisify(execFile)

export interface SandboxViolation {
  timestamp: Date
  pid: number
  processName: string
  operation: string
  path?: string
  raw: string
}

export interface SandboxMonitorEvents {
  violation: [SandboxViolation]
}

export class SandboxMonitor extends EventEmitter<SandboxMonitorEvents> {
  private logProcess: ChildProcess | null = null
  private rootPid: number = 0
  private knownPids = new Set<number>()
  private pidRefreshTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Start monitoring for sandbox violations from a given PID.
   * Watches for violations from this PID and all its descendants.
   *
   * PID filtering is best-effort: short-lived child processes may
   * appear in the log before we discover them via pgrep. To avoid
   * missing violations, we accept all sandbox violations during the
   * first few seconds, then filter once the PID tree is populated.
   */
  start(pid: number): void {
    // Clean up any previous monitoring session
    if (this.logProcess) {
      this.logProcess.kill()
      this.logProcess = null
    }
    if (this.pidRefreshTimer) {
      clearInterval(this.pidRefreshTimer)
      this.pidRefreshTimer = null
    }

    this.rootPid = pid
    this.knownPids.clear()
    this.knownPids.add(pid)

    // Accept all violations for the first 5 seconds while we build
    // the PID tree. After that, only match known PIDs.
    const startTime = Date.now()
    const WARMUP_MS = 5000

    this.logProcess = spawn('log', ['stream', '--style', 'ndjson', '--predicate', 'sender=="Sandbox"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const rl = createInterface({ input: this.logProcess.stdout! })
    rl.on('line', (line) => {
      const violation = this.parseLine(line)
      if (!violation) return

      const inWarmup = Date.now() - startTime < WARMUP_MS
      if (inWarmup || this.knownPids.has(violation.pid)) {
        // During warmup, add discovered PIDs to the known set
        if (inWarmup) this.knownPids.add(violation.pid)
        this.emit('violation', violation)
      }
    })

    this.logProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.warn(`Sandbox monitor log stream exited with code ${code}`)
      }
    })

    this.logProcess.on('error', (err) => {
      console.warn('Sandbox monitor log stream error:', err.message)
    })

    // Refresh PID tree periodically
    this.pidRefreshTimer = setInterval(() => this.refreshPidTree(), 2000)
    this.refreshPidTree()
  }

  /** Stop monitoring. */
  stop(): void {
    if (this.pidRefreshTimer) {
      clearInterval(this.pidRefreshTimer)
      this.pidRefreshTimer = null
    }
    if (this.logProcess) {
      this.logProcess.kill()
      this.logProcess = null
    }
  }

  /**
   * Parse a log stream NDJSON line into a SandboxViolation.
   *
   * The eventMessage format is:
   *   "Sandbox: <process>(<pid>) deny(<count>) <operation> <path>"
   * or with duplicate suppression:
   *   "<N> duplicate report for Sandbox: <process>(<pid>) deny(<count>) <operation> <path>"
   */
  private parseLine(line: string): SandboxViolation | null {
    try {
      const entry = JSON.parse(line)
      const msg: string = entry.eventMessage ?? ''

      const match = msg.match(/Sandbox:\s+(\S+)\((\d+)\)\s+deny\(\d+\)\s+([\w*-]+)\s*(.*)/)
      if (!match) return null

      const [, processName, pidStr, operation, path] = match
      return {
        timestamp: new Date(entry.timestamp ?? Date.now()),
        pid: parseInt(pidStr, 10),
        processName,
        operation,
        path: path?.trim() || undefined,
        raw: msg,
      }
    } catch {
      // Not valid JSON or no match — skip
      return null
    }
  }

  /** Refresh the set of known child PIDs via pgrep. */
  private refreshPidTree(): void {
    this.discoverDescendants(this.rootPid)
  }

  private discoverDescendants(parentPid: number): void {
    execFileAsync('pgrep', ['-P', String(parentPid)])
      .then(({ stdout }) => {
        const pids = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number)
          .filter((n) => !isNaN(n))
        for (const pid of pids) {
          if (!this.knownPids.has(pid)) {
            this.knownPids.add(pid)
            this.discoverDescendants(pid)
          }
        }
      })
      .catch((error: unknown) => {
        // pgrep returns exit code 1 when no children found — expected
        const err = error as { code?: number | string | null; message?: string }
        if (err?.code === 1 || err?.code === '1') return
        console.warn(`SandboxMonitor: pgrep failed for PID ${parentPid}:`, err?.message ?? error)
      })
  }
}
