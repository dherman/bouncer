import type { PolicyTemplate } from "./types.js";

/**
 * Standard PR implementation: read-write worktree, network deny intended.
 * The tightest practical boundary for coding tasks.
 * Network deny is declared but not yet enforced — requires app-layer proxy (M6).
 */
export const standardPrTemplate: PolicyTemplate = {
  id: "standard-pr",
  name: "Standard PR",
  description: "Read-write worktree, standard toolchains (network deny planned)",
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
  github: {
    repo: "",              // Populated per-session
    allowedPushRefs: [],   // Populated per-session
    ownedPrNumber: null,
    canCreatePr: true,
  },
};

/**
 * Research only: read-write worktree, full network.
 * For code review, analysis, and web research tasks.
 * Sandbox blocks writes to user home and system paths; temp dirs are writable
 * due to safehouse agent profiles. See findings.md for details.
 */
export const researchOnlyTemplate: PolicyTemplate = {
  id: "research-only",
  name: "Research Only",
  description: "Read-write worktree, full network, no access outside sandbox",
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
