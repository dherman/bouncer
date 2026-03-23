import type { PolicyTemplate } from "./types.js";

/**
 * Standard PR implementation: read-write worktree, no network.
 * The tightest practical boundary for offline coding tasks.
 */
export const standardPrTemplate: PolicyTemplate = {
  id: "standard-pr",
  name: "Standard PR",
  description: "Read-write worktree, standard toolchains, no network",
  filesystem: {
    worktreeAccess: "read-write",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "none",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
};

/**
 * Research only: read-only filesystem, full network.
 * For code review, analysis, and web research tasks.
 */
export const researchOnlyTemplate: PolicyTemplate = {
  id: "research-only",
  name: "Research Only",
  description: "Read-only filesystem, full network access",
  filesystem: {
    worktreeAccess: "read-only",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "full",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
};

/**
 * Permissive: read-write worktree, full network.
 * For trusted tasks that need both mutation and network access.
 * Equivalent to the M2 default safehouse configuration.
 */
export const permissiveTemplate: PolicyTemplate = {
  id: "permissive",
  name: "Permissive",
  description: "Read-write worktree, toolchains, full network access",
  filesystem: {
    worktreeAccess: "read-write",
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: "full",
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ["all-agents"],
};
