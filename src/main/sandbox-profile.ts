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

/**
 * Build the default sandbox policy for a Claude Code agent session.
 *
 * Informed by agent-safehouse profiles (https://agent-safehouse.dev):
 *   00-base.sb, 10-system-runtime.sb, 30-toolchains/node.sb,
 *   50-integrations-core/git.sb, 60-agents/claude-code.sb
 */
export function defaultPolicy({
  worktreePath,
  homedir,
  tmpdir: tmpdirPath,
  sessionId,
  gitCommonDir,
}: {
  worktreePath: string;
  homedir: string;
  tmpdir: string;
  sessionId: string;
  /** The git common dir for linked worktrees (the parent repo's .git). */
  gitCommonDir?: string;
}): SandboxPolicy {
  const writablePaths = [
    worktreePath,
    join(tmpdirPath, `glitterball-${sessionId}`),

    // Temp directories — processes and toolchains write here extensively.
    // (agent-safehouse 10-system-runtime.sb)
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",

    // Claude Code state — needs write access to persist session data,
    // file history, debug logs, todos, etc.
    // (agent-safehouse 60-agents/claude-code.sb)
    `${homedir}/.claude`,
    `${homedir}/.cache/claude`,
    `${homedir}/.config/claude`,
    `${homedir}/.local/state/claude`,
    `${homedir}/.local/share/claude`,

    // Node.js toolchain caches — package managers write here.
    // (agent-safehouse 30-toolchains/node.sb)
    `${homedir}/.npm`,
    `${homedir}/.cache/npm`,
    `${homedir}/.cache/node`,
    `${homedir}/.config/npm`,
    `${homedir}/.pnpm-store`,
    `${homedir}/.pnpm-state`,
    `${homedir}/.config/pnpm`,
    `${homedir}/.local/share/pnpm`,
    `${homedir}/.local/state/pnpm`,
    `${homedir}/.cache/yarn`,
    `${homedir}/.yarn`,
  ];

  // Git worktree common dir: linked worktrees store refs and metadata in
  // the parent repo's .git directory. Without write access, git operations
  // (commit, branch, etc.) fail from within the worktree.
  // (agent-safehouse 50-integrations-core/worktree-common-dir.sb)
  if (gitCommonDir) {
    writablePaths.push(gitCommonDir);
  }

  return {
    writablePaths,
    readOnlyPaths: [
      // System binaries and libraries
      // (agent-safehouse 10-system-runtime.sb)
      "/usr",
      "/bin",
      "/sbin",
      "/opt",
      "/System/Library",
      "/System/Volumes/Preboot",
      "/Library/Apple",
      "/Library/Frameworks",
      "/Library/Fonts",
      "/Library/Filesystems/NetFSPlugins",
      "/Library/Preferences/Logging",

      // /dev directory listing (writes handled separately in generateProfile)
      "/dev",

      // /etc and /var — symlinks into /private/* on macOS
      // (agent-safehouse 10-system-runtime.sb — scoped to specific files)
      "/private/var/db/timezone",
      "/private/var/select/sh",
      "/private/var/select/developer_dir",
      "/var/select/developer_dir",
      "/private/var/db/xcode_select_link",
      "/var/db/xcode_select_link",
      "/private/etc/hosts",
      "/private/etc/resolv.conf",
      "/private/etc/services",
      "/private/etc/protocols",
      "/private/etc/shells",
      "/private/etc/ssl",
      "/private/etc/localtime",
      "/private/etc/profile",
      "/private/etc/paths",
      "/private/etc/paths.d",
      "/private/etc/bashrc",
      "/private/etc/zprofile",
      "/private/etc/zshrc",

      // Git config
      // (agent-safehouse 50-integrations-core/git.sb)
      `${homedir}/.gitconfig`,
      `${homedir}/.gitignore_global`,
      `${homedir}/.gitattributes`,
      `${homedir}/.config/git`,
      `${homedir}/.ssh`,

      // Claude Code config (read-only portions)
      // (agent-safehouse 60-agents/claude-code.sb)
      `${homedir}/.claude.json`,
      `${homedir}/.claude.lock`,
      `${homedir}/.mcp.json`,
      `${homedir}/.local/bin/claude`,
      `${homedir}/Library/Application Support/Claude/claude_desktop_config.json`,

      // User preferences read by macOS frameworks
      // (agent-safehouse 10-system-runtime.sb)
      `${homedir}/Library/Preferences`,
      `${homedir}/.CFUserTextEncoding`,

      // Shell init files
      // (agent-safehouse 55-integrations-optional/shell-init.sb)
      `${homedir}/.zshrc`,
      `${homedir}/.zshenv`,
      `${homedir}/.zprofile`,
      `${homedir}/.zcompdump`,
      `${homedir}/.bashrc`,
      `${homedir}/.bash_profile`,
      `${homedir}/.profile`,

      // XDG config/cache roots (directory listings for tool discovery)
      `${homedir}/.config`,
      `${homedir}/.cache`,
      `${homedir}/.local/bin`,

      // Node.js version managers and read-only paths
      // (agent-safehouse 30-toolchains/node.sb)
      `${homedir}/.nvm`,
      `${homedir}/.fnm`,
      `${homedir}/.npmrc`,
      `${homedir}/.node-gyp`,

      // Rust toolchain (read-only)
      `${homedir}/.cargo`,
      `${homedir}/.rustup`,

      // Agent guidance files
      // (agent-safehouse 40-shared/agent-common.sb)
      `${homedir}/CLAUDE.md`,
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
  const knownFiles = [
    "gitconfig", "gitattributes", "zshrc", "zshenv", "zprofile", "zcompdump",
    "bashrc", "profile", "npmrc", "CFUserTextEncoding",
  ];
  return knownFiles.includes(rest);
}

/**
 * Also detect non-dotfile files by known names.
 */
function isLiteralPath(path: string): boolean {
  if (isFilePath(path)) return true;
  const lastSegment = path.split("/").pop() ?? "";
  // Known file names that aren't dotfiles
  const knownFiles = [
    "CLAUDE.md", "claude_desktop_config.json", "managed-settings.json",
    "managed-mcp.json", "sh", "developer_dir", "xcode_select_link",
    "hosts", "resolv.conf", "services", "protocols", "shells",
    "localtime", "profile", "paths", "bashrc", "zprofile", "zshrc",
  ];
  return knownFiles.includes(lastSegment);
}

/**
 * Generate a macOS Seatbelt (SBPL) profile from a SandboxPolicy.
 *
 * The generated profile follows the patterns established by agent-safehouse
 * (https://agent-safehouse.dev) for robust agent sandboxing on macOS.
 */
export function generateProfile(policy: SandboxPolicy): string {
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    "; ── Process operations ────────────────────────────────",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow pseudo-tty)",
    "",
    "; ── Mach IPC ──────────────────────────────────────────",
    "; Broad mach-lookup: many macOS system services require IPC.",
    "; Tightening to specific service names is a future hardening step.",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow iokit-open)",
    "(allow system-socket)",
    "(allow ipc-posix-shm-read-data",
    '    (ipc-posix-name "apple.shm.notification_center"))',
    "",
    "; ── Root directory and /dev devices ───────────────────",
    '(allow file-read* (literal "/"))',
    '(allow file-read-metadata (literal "/private"))',
    '(allow file-read-metadata (literal "/private/var"))',
    '(allow file-read-metadata (literal "/private/var/run"))',
    '(allow file-read-metadata (literal "/private/etc"))',
    '(allow file-read-metadata (literal "/home"))',
    '(allow file-read* (literal "/etc"))',
    '(allow file-read* (literal "/var"))',
    '(allow file-read* (literal "/private"))',
    "",
    "; Device nodes for I/O, PTYs, and entropy",
    '(allow file-read* file-write* (subpath "/dev/fd"))',
    '(allow file-read* file-write* (literal "/dev/stdout"))',
    '(allow file-read* file-write* (literal "/dev/stderr"))',
    '(allow file-read* file-write* (literal "/dev/null"))',
    '(allow file-read* file-write* (literal "/dev/tty"))',
    '(allow file-read* file-write* (literal "/dev/ptmx"))',
    '(allow file-read* file-write* (literal "/dev/dtracehelper"))',
    '(allow file-read* file-write* (regex "^/dev/tty"))',
    '(allow file-read* file-write* (regex "^/dev/ttys"))',
    '(allow file-read* file-write* (regex "^/dev/pty"))',
    '(allow file-read* (literal "/dev/zero"))',
    '(allow file-read* (literal "/dev/autofs_nowait"))',
    '(allow file-read* (literal "/dev/urandom"))',
    '(allow file-read* (literal "/dev/random"))',
    "",
    "; TTY/PTY ioctl operations",
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/tty"))',
    '(allow file-ioctl (literal "/dev/ptmx"))',
    '(allow file-ioctl (regex "^/dev/tty"))',
    '(allow file-ioctl (regex "^/dev/ttys"))',
    '(allow file-ioctl (regex "^/dev/pty"))',
    "",
  ];

  if (policy.writablePaths.length > 0) {
    lines.push("; ── Writable paths ────────────────────────────────");
    for (const p of policy.writablePaths) {
      const escaped = escapeSbplPath(p);
      lines.push(`(allow file-read* file-write* (subpath "${escaped}"))`);
    }
    lines.push("");
  }

  if (policy.readOnlyPaths.length > 0) {
    lines.push("; ── Read-only paths ───────────────────────────────");
    for (const p of policy.readOnlyPaths) {
      const escaped = escapeSbplPath(p);
      const matcher = isLiteralPath(p) ? "literal" : "subpath";
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
