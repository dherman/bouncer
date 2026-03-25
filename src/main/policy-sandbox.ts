import { join } from 'node:path';
import type { PolicyTemplate } from './types.js';
import { POLICY_DIR, BASE_ENV_PASSTHROUGH } from './sandbox.js';
import type { SandboxConfig } from './sandbox.js';

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
  if (template.filesystem.worktreeAccess === 'read-write') {
    writableDirs.push(ctx.worktreePath);
  } else {
    readOnlyDirs.push(ctx.worktreePath);
  }

  // Git common dir follows worktree access mode
  if (ctx.gitCommonDir) {
    if (template.filesystem.worktreeAccess === 'read-write') {
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

  // Network deny rules are intentionally skipped for now. SBPL deny is
  // all-or-nothing — it blocks the agent's own API traffic (Anthropic API),
  // making the session non-functional. Meaningful network restriction requires
  // an application-layer proxy (Milestone 6) that allows API traffic while
  // blocking everything else. The template's network.access field still
  // declares intent for when the proxy layer exists.
  //
  // See: docs/milestones/policy-templates/findings.md
  if (template.network.access === 'filtered') {
    throw new Error("Network access mode 'filtered' is not yet supported by policyToSandboxConfig");
  }

  if (template.appendProfile) {
    profileParts.push(template.appendProfile.trim());
  }

  if (profileParts.length > 0) {
    appendProfileContent = '(version 1)\n' + profileParts.join('\n') + '\n';
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
