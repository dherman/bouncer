import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PolicyTemplate } from "./types.js";
import type { SandboxConfig } from "./sandbox.js";

const POLICY_DIR = join(tmpdir(), "glitterball-sandbox");

export interface SessionContext {
  sessionId: string;
  worktreePath: string;
  gitCommonDir?: string;
  readOnlyDirs?: string[];
}

const BASE_ENV = [
  "ANTHROPIC_API_KEY",
  "NODE_OPTIONS",
  "NODE_PATH",
  "EDITOR",
  "VISUAL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

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
    ...BASE_ENV.filter((v) => !template.env.exclude.includes(v)),
    ...template.env.additional,
  ];

  // Build append profile content from template + network policy
  let appendProfileContent: string | undefined;
  const profileParts: string[] = [];

  if (template.network.access === "none") {
    profileParts.push(
      ";; Block all outbound network access.",
      "(deny network-outbound)",
      "(deny network-bind)",
    );
  }

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
