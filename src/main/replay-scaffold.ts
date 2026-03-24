import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, isAbsolute } from "node:path";
import type { ReplayToolCall } from "./types.js";

export interface ScaffoldPlan {
  /** Relative path → file content */
  files: Map<string, string>;
  /** Relative directory paths to create */
  directories: Set<string>;
}

/**
 * Returns true if a path looks like a file (has a real extension, not a dotfile/dotdir).
 * e.g. "foo.ts" → true, ".github" → false, "src/utils" → false
 */
function looksLikeFile(path: string): boolean {
  const base = basename(path);
  const ext = extname(base);
  // extname(".github") returns ".github" — the whole name is the "extension"
  // A real file extension means the name has content before the dot
  return ext !== "" && base !== ext;
}

/**
 * Returns true if the raw (pre-deanonymized) path should be skipped for scaffolding.
 */
function shouldSkipPath(raw: string): boolean {
  if (raw.includes("{project-name}")) return true;
  if (raw.includes(".claude/")) return true;
  if (raw.includes("{home}")) return true;
  return false;
}

/**
 * Returns the relative path within the worktree, or null if the path
 * is outside the worktree or is a system path.
 */
function toRelativePath(absPath: string, worktreePath: string): string | null {
  if (!isAbsolute(absPath)) return null;
  const rel = relative(worktreePath, absPath);
  // Reject paths outside the worktree (../ or absolute)
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Best-effort extraction of {project}/... paths from a Bash command string.
 */
function extractProjectPaths(command: string): string[] {
  const matches = command.match(/\{project\}\/[^\s;|&"'`$()]+/g);
  return matches ?? [];
}

/**
 * Scan a session's tool calls and build a plan for stub files.
 * All paths in the plan are relative to the worktree root.
 */
export function buildScaffoldPlan(
  toolCalls: ReplayToolCall[],
  deanonymize: (path: string) => string,
  worktreePath: string,
): ScaffoldPlan {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  function addFile(raw: string, content: string) {
    if (shouldSkipPath(raw)) return;
    const abs = deanonymize(raw);
    const rel = toRelativePath(abs, worktreePath);
    if (!rel) return;

    if (content != null && content !== "// stub\n") {
      // Meaningful content (e.g. old_string from Edit) — append if file already has content
      const existing = files.get(rel);
      if (existing && existing !== "// stub\n") {
        files.set(rel, existing + "\n" + content);
      } else {
        files.set(rel, content);
      }
    } else if (!files.has(rel)) {
      files.set(rel, "// stub\n");
    }
  }

  function addDirectory(raw: string) {
    if (shouldSkipPath(raw)) return;
    const abs = deanonymize(raw);
    const rel = toRelativePath(abs, worktreePath);
    if (!rel) return;
    directories.add(rel);
  }

  for (const call of toolCalls) {
    const input = call.input;
    switch (call.tool) {
      case "Read": {
        const filePath = input.file_path as string | undefined;
        if (filePath) addFile(filePath, "// stub\n");
        break;
      }
      case "Write": {
        const filePath = input.file_path as string | undefined;
        if (filePath) {
          // Only create parent directory — Write creates the file itself
          if (!shouldSkipPath(filePath)) {
            const abs = deanonymize(filePath);
            const rel = toRelativePath(abs, worktreePath);
            if (rel) {
              const dir = dirname(rel);
              if (dir !== ".") directories.add(dir);
            }
          }
        }
        break;
      }
      case "Edit": {
        const filePath = input.file_path as string | undefined;
        if (filePath) {
          const oldString = input.old_string as string | undefined;
          addFile(filePath, oldString ?? "// stub\n");
        }
        break;
      }
      case "Grep": {
        const path = input.path as string | undefined;
        if (path) {
          if (looksLikeFile(path)) {
            addFile(path, "// stub\n");
          } else {
            addDirectory(path);
          }
        }
        break;
      }
      case "Glob": {
        const path = input.path as string | undefined;
        if (path) addDirectory(path);
        break;
      }
      case "Bash": {
        const command = input.command as string | undefined;
        if (command) {
          for (const raw of extractProjectPaths(command)) {
            if (looksLikeFile(raw)) {
              addFile(raw, "// stub\n");
            } else {
              addDirectory(raw);
            }
          }
        }
        break;
      }
    }
  }

  return { files, directories };
}

/**
 * Apply a scaffold plan to a worktree directory.
 * Returns the number of files created.
 */
export async function applyScaffold(
  worktreePath: string,
  plan: ScaffoldPlan,
): Promise<number> {
  // Create directories first
  for (const dir of plan.directories) {
    await mkdir(join(worktreePath, dir), { recursive: true });
  }
  // Create files (skip if already exists to avoid clobbering worktree content)
  let created = 0;
  for (const [relPath, content] of plan.files) {
    const absPath = join(worktreePath, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    try {
      await writeFile(absPath, content, { encoding: "utf-8", flag: "wx" });
      created++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  return created;
}
