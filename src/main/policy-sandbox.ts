import { join } from "node:path";
import type { PolicyTemplate } from "./types.js";
import { POLICY_DIR, BASE_ENV_PASSTHROUGH } from "./sandbox.js";
import type { SandboxConfig } from "./sandbox.js";

export interface SessionContext {
  sessionId: string;
  worktreePath: string;
  gitCommonDir?: string;
  readOnlyDirs?: string[];
}


export function policyToSandboxConfig(
  template: PolicyTemplate,
  ctx: SessionContext,
): SandboxConfig {
  const writableDirs: string[] = [];
  const readOnlyDirs: string[] = [...(ctx.readOnlyDirs ?? [])];

  // Worktree access mode
  if (template.filesystem.worktreeAccess === "read-write") {
    writableDirs.push(ctx.worktreePath);
  } else {
    readOnlyDirs.push(ctx.worktreePath);
  }

  // Git common dir follows worktree access mode
  if (ctx.gitCommonDir) {
    if (template.filesystem.worktreeAccess === "read-write") {
      writableDirs.push(ctx.gitCommonDir);
    } else {
      readOnlyDirs.push(ctx.gitCommonDir);
    }
  }

  // Additional dirs from template
  writableDirs.push(...template.filesystem.additionalWritableDirs);
  readOnlyDirs.push(...template.filesystem.additionalReadOnlyDirs);

  // Environment variables: base set minus excludes, plus additions
  const envPassthrough = [
    ...BASE_ENV_PASSTHROUGH.filter((v) => !template.env.exclude.includes(v)),
    ...template.env.additional,
  ];

  // Build append profile content from template + network policy
  let appendProfileContent: string | undefined;
  const profileParts: string[] = [];

  // Network filtering is handled by the M7 proxy layer in container mode.
  // On the Seatbelt fallback path, "filtered" is treated as "full" since
  // Seatbelt can't enforce proxy-based domain filtering. SBPL network deny
  // is all-or-nothing and would block the agent's own API traffic.

  if (template.appendProfile) {
    profileParts.push(template.appendProfile.trim());
  }

  if (profileParts.length > 0) {
    appendProfileContent = "(version 1)\n" + profileParts.join("\n") + "\n";
  }

  return {
    workdir: ctx.worktreePath,
    writableDirs,
    readOnlyDirs,
    envPassthrough,
    policyOutputPath: join(POLICY_DIR, `${ctx.sessionId}.sb`),
    appendProfileContent,
  };
}
