import type { PolicyTemplate } from './types.js';

/**
 * Standard PR implementation: read-write worktree, filtered network via proxy.
 * The tightest practical boundary for coding tasks.
 * Network traffic routes through the M7 proxy with domain allowlisting and
 * GitHub API/git push enforcement.
 */
export const standardPrTemplate: PolicyTemplate = {
  id: 'standard-pr',
  name: 'Standard PR',
  description: 'Read-write worktree, filtered network via proxy, GitHub policy enforcement',
  filesystem: {
    worktreeAccess: 'read-write',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'filtered',
    allowedDomains: [
      // Claude Code API backend — required for the agent to function
      'api.anthropic.com',
      // Claude Code OAuth — required for token refresh / re-authentication
      'platform.claude.com',
      // GitHub (code hosting, API, uploads)
      'github.com',
      'api.github.com',
      'uploads.github.com',
      // Package registries
      'registry.npmjs.org',
      'crates.io',
      'static.crates.io',
      'index.crates.io',
      'pypi.org',
      'files.pythonhosted.org',
    ],
    inspectedDomains: ['api.github.com', 'github.com'],
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
  github: {
    repo: '', // Populated per-session
    allowedPushRefs: [], // Populated per-session
    ownedPrNumber: null,
    canCreatePr: true,
  },
  container: {},
};

/**
 * Research only: read-write worktree, full network.
 * For code review, analysis, and web research tasks.
 * Sandbox blocks writes to user home and system paths; temp dirs are writable
 * due to safehouse agent profiles. See findings.md for details.
 */
export const researchOnlyTemplate: PolicyTemplate = {
  id: 'research-only',
  name: 'Research Only',
  description: 'Read-write worktree, full network, no access outside sandbox',
  filesystem: {
    worktreeAccess: 'read-write',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'full',
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
};

/**
 * Permissive: read-write worktree, full network.
 * For trusted tasks that need both mutation and network access.
 * Equivalent to the M2 default safehouse configuration.
 */
export const permissiveTemplate: PolicyTemplate = {
  id: 'permissive',
  name: 'Permissive',
  description: 'Read-write worktree, toolchains, full network access',
  filesystem: {
    worktreeAccess: 'read-write',
    additionalWritableDirs: [],
    additionalReadOnlyDirs: [],
  },
  network: {
    access: 'full',
  },
  env: {
    additional: [],
    exclude: [],
  },
  safehouseIntegrations: ['all-agents'],
};
