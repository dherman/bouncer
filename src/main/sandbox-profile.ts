import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxPolicy {
  /** Paths the sandboxed process can read and write */
  writablePaths: string[];
  /** Paths the sandboxed process can read (but not write) */
  readOnlyPaths: string[];
  /** Whether to allow outbound network access */
  allowNetwork: boolean;
}

export function defaultPolicy({
  worktreePath,
  homedir,
  tmpdir: tmpdirPath,
  sessionId,
}: {
  worktreePath: string;
  homedir: string;
  tmpdir: string;
  sessionId: string;
}): SandboxPolicy {
  return {
    writablePaths: [
      worktreePath,
      join(tmpdirPath, `glitterball-${sessionId}`),
    ],
    readOnlyPaths: [
      // System binaries and libraries
      "/usr/bin",
      "/usr/lib",
      "/usr/libexec",
      "/usr/share",
      "/bin",
      "/sbin",
      "/Library/Apple",
      "/System",
      "/private/var/db",
      "/dev",
      "/etc",
      "/private/etc",
      "/var",

      // Homebrew / user-installed tools
      "/usr/local",
      "/opt/homebrew",

      // User dotfiles
      `${homedir}/.gitconfig`,
      `${homedir}/.gitignore_global`,
      `${homedir}/.ssh`,
      `${homedir}/.claude`,
      `${homedir}/.claude.json`,
      `${homedir}/.config`,
      `${homedir}/.npm`,
      `${homedir}/.node_modules`,
      `${homedir}/.nvm`,
      `${homedir}/.cargo`,
      `${homedir}/.rustup`,
      `${homedir}/.zshrc`,
      `${homedir}/.zshenv`,
      `${homedir}/.zprofile`,
      `${homedir}/.bashrc`,
      `${homedir}/.bash_profile`,
      `${homedir}/.profile`,
    ],
    allowNetwork: false,
  };
}

/** Escape characters that are special in SBPL string literals. */
function escapeSbplPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Heuristic: if a path looks like a file (dotfile with extension, or known
 * file patterns), use `literal` match. Otherwise use `subpath` for directories.
 */
function isFilePath(path: string): boolean {
  const lastSegment = path.split("/").pop() ?? "";
  if (!lastSegment.startsWith(".")) return false;

  // Dotfiles with a second dot are files: .claude.json, .bash_profile
  // Single-segment dotnames without a second dot are directories: .ssh, .claude, .npm
  const rest = lastSegment.slice(1);
  if (rest.includes(".") || rest.includes("_")) return true;
  // Known file dotnames without extensions or underscores
  const knownFiles = ["gitconfig", "zshrc", "zshenv", "zprofile", "bashrc", "profile"];
  return knownFiles.includes(rest);
}

export function generateProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    "; ── Process and system operations ────────────────────",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow iokit-open)",
    "",
    "; ── Root directory and /dev writes ────────────────────",
    "; Processes need to read / (the root dir itself) for path resolution.",
    "; They also need to write to /dev/null, /dev/tty, /dev/fd/* for I/O.",
    '(allow file-read* (literal "/"))',
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/tty"))',
    '(allow file-write* (regex "^/dev/fd/"))',
    '(allow file-write* (regex "^/dev/dtracehelper"))',
    "",
  ];

  if (policy.writablePaths.length > 0) {
    lines.push("; ── Writable paths ────────────────────────────────");
    for (const p of policy.writablePaths) {
      const escaped = escapeSbplPath(p);
      lines.push(`(allow file-read* (subpath "${escaped}"))`);
      lines.push(`(allow file-write* (subpath "${escaped}"))`);
    }
    lines.push("");
  }

  if (policy.readOnlyPaths.length > 0) {
    lines.push("; ── Read-only paths ───────────────────────────────");
    for (const p of policy.readOnlyPaths) {
      const escaped = escapeSbplPath(p);
      const matcher = isFilePath(p) ? "literal" : "subpath";
      lines.push(`(allow file-read* (${matcher} "${escaped}"))`);
    }
    lines.push("");
  }

  if (policy.allowNetwork) {
    lines.push("; ── Network ───────────────────────────────────────");
    lines.push("(allow network*)");
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

const SANDBOX_PROFILE_DIR = join(tmpdir(), "glitterball-sandbox");

export async function writePolicyToDisk(
  sessionId: string,
  profile: string,
): Promise<string> {
  await mkdir(SANDBOX_PROFILE_DIR, { recursive: true });
  const profilePath = join(SANDBOX_PROFILE_DIR, `${sessionId}.sb`);
  await writeFile(profilePath, profile, "utf-8");
  return profilePath;
}
