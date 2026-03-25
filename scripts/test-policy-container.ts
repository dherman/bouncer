/**
 * Test policyToContainerConfig(), generateGitconfig(), and the credential helper.
 */

import { policyToContainerConfig, generateGitconfig } from "../src/main/policy-container.js";
import { standardPrTemplate, researchOnlyTemplate } from "../src/main/policy-templates.js";
import type { PolicyTemplate } from "../src/main/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

// --- Test policyToContainerConfig: standard PR template ---
{
  const config = policyToContainerConfig(
    standardPrTemplate,
    {
      sessionId: "test-123",
      worktreePath: "/tmp/wt",
      gitCommonDir: "/tmp/repo/.git",
      agentBinPath: "/app/agent",
      nodeModulesPath: "/app/node_modules",
      shimBundlePath: "/tmp/shim.js",
      shimScriptPath: "/tmp/gh-wrapper",
      hooksDir: "/tmp/hooks",
      allowedRefsPath: "/tmp/allowed-refs.txt",
      policyStatePath: "/tmp/policy.json",
      gitconfigPath: "/tmp/gitconfig",
      credentialHelperPath: "/tmp/cred-helper.js",
    },
    { ANTHROPIC_API_KEY: "test-key", GH_TOKEN: "ghp_test" },
    "glitterball-agent:abc123",
    ["node", "/usr/local/lib/agent/index.js"],
  );

  assert(config.sessionId === "test-123", "sessionId");
  assert(config.image === "glitterball-agent:abc123", "image tag");
  assert(config.workdir === "/workspace", "workdir");
  assert(config.networkMode === "bridge", "network mode");

  // Check mounts
  const mountPaths = config.mounts.map((m) => m.containerPath);
  assert(mountPaths.includes("/workspace"), "worktree mount");
  assert(mountPaths.includes("/tmp/repo/.git"), "git common dir mount (at host path)");
  assert(mountPaths.includes("/usr/local/lib/agent"), "agent bin mount");
  assert(mountPaths.includes("/usr/local/lib/agent/node_modules"), "node_modules mount");
  assert(mountPaths.includes("/etc/bouncer/hooks"), "hooks mount");
  assert(mountPaths.includes("/etc/bouncer/allowed-refs.txt"), "allowed refs mount");
  assert(mountPaths.includes("/usr/local/bin/gh"), "shim script mount");
  assert(mountPaths.includes("/usr/local/lib/bouncer/gh-shim.js"), "shim bundle mount");
  assert(mountPaths.includes("/etc/bouncer/github-policy.json"), "policy state mount");
  assert(mountPaths.includes("/etc/gitconfig"), "gitconfig mount");
  assert(mountPaths.includes("/usr/local/lib/bouncer/gh-credential-helper.js"), "credential helper mount");

  // Worktree should be rw for standard PR
  const wtMount = config.mounts.find((m) => m.containerPath === "/workspace");
  assert(wtMount?.readOnly === false, "worktree is rw for standard-pr");

  // Policy state should be rw
  const policyMount = config.mounts.find((m) => m.containerPath === "/etc/bouncer/github-policy.json");
  assert(policyMount?.readOnly === false, "policy state is rw");

  // Hooks should be ro
  const hooksMount = config.mounts.find((m) => m.containerPath === "/etc/bouncer/hooks");
  assert(hooksMount?.readOnly === true, "hooks is ro");

  // Env
  assert(config.env.BOUNCER_GITHUB_POLICY === "/etc/bouncer/github-policy.json", "BOUNCER_GITHUB_POLICY env");
  assert(config.env.NODE_PATH === "/usr/local/lib/agent/node_modules", "NODE_PATH env");
  assert(config.env.ANTHROPIC_API_KEY === "test-key", "ANTHROPIC_API_KEY passthrough");

  // SSH should NOT be mounted (not provided in ctx)
  assert(!mountPaths.includes("/home/agent/.ssh"), "no SSH mount when sshDir not provided");
}

// --- Test policyToContainerConfig: template without github ---
{
  const config = policyToContainerConfig(
    researchOnlyTemplate,
    {
      sessionId: "test-456",
      worktreePath: "/tmp/wt2",
      agentBinPath: "/app/agent",
      nodeModulesPath: "/app/node_modules",
    },
    {},
    "glitterball-agent:def456",
    ["node", "/usr/local/lib/agent/index.js"],
  );

  const mountPaths = config.mounts.map((m) => m.containerPath);
  assert(!mountPaths.includes("/etc/bouncer/hooks"), "no hooks mount without github");
  assert(!mountPaths.includes("/usr/local/bin/gh"), "no shim mount without github");
  assert(!mountPaths.includes("/etc/gitconfig"), "no gitconfig mount without github");
  assert(!mountPaths.includes("/usr/local/lib/bouncer/gh-credential-helper.js"), "no cred helper without github");
  assert(config.env.BOUNCER_GITHUB_POLICY === undefined, "no BOUNCER_GITHUB_POLICY without github");
}

// --- Test policyToContainerConfig: read-only worktree ---
{
  const roTemplate: PolicyTemplate = {
    ...researchOnlyTemplate,
    id: "ro-test",
    filesystem: { ...researchOnlyTemplate.filesystem, worktreeAccess: "read-only" },
  };

  const config = policyToContainerConfig(
    roTemplate,
    {
      sessionId: "test-789",
      worktreePath: "/tmp/wt3",
      gitCommonDir: "/tmp/repo3/.git",
      agentBinPath: "/app/agent",
      nodeModulesPath: "/app/node_modules",
    },
    {},
    "glitterball-agent:ghi789",
    ["node", "/usr/local/lib/agent/index.js"],
  );

  const wtMount = config.mounts.find((m) => m.containerPath === "/workspace");
  assert(wtMount?.readOnly === true, "worktree is ro for read-only template");
  const gitMount = config.mounts.find((m) => m.containerPath === "/tmp/repo3/.git");
  assert(gitMount?.readOnly === true, "git common dir follows worktree access mode");
}

// --- Test generateGitconfig ---
{
  const content = generateGitconfig({
    hooksPath: "/etc/bouncer/hooks",
    credentialHelperPath: "/usr/local/lib/bouncer/gh-credential-helper.js",
    userName: "Test User",
    userEmail: "test@example.com",
  });

  assert(content.includes("hooksPath = /etc/bouncer/hooks"), "gitconfig has hooksPath");
  assert(content.includes('helper = !node /usr/local/lib/bouncer/gh-credential-helper.js'), "gitconfig has credential helper");
  assert(content.includes("name = Test User"), "gitconfig has user name");
  assert(content.includes("email = test@example.com"), "gitconfig has user email");
}

// --- Test generateGitconfig without user ---
{
  const content = generateGitconfig({
    hooksPath: "/etc/bouncer/hooks",
    credentialHelperPath: "/usr/local/lib/bouncer/gh-credential-helper.js",
  });

  assert(!content.includes("[user]"), "gitconfig omits [user] when not provided");
}

// --- Test policyToContainerConfig: Claude config and credentials mounts ---
{
  const config = policyToContainerConfig(
    researchOnlyTemplate,
    {
      sessionId: "test-claude",
      worktreePath: "/tmp/wt-claude",
      agentBinPath: "/app/agent",
      nodeModulesPath: "/app/node_modules",
      claudeConfigDir: "/home/testuser/.claude",
      claudeCredentialsPath: "/tmp/creds.json",
    },
    {},
    "glitterball-agent:claude",
    ["node", "/usr/local/lib/agent/dist/index.js"],
  );

  const mountPaths = config.mounts.map((m) => m.containerPath);
  assert(mountPaths.includes("/home/agent/.claude"), "claude config dir mounted");
  assert(mountPaths.includes("/home/agent/.claude/.credentials.json"), "claude credentials file mounted");

  const configMount = config.mounts.find((m) => m.containerPath === "/home/agent/.claude");
  assert(configMount?.readOnly === false, "claude config dir is rw");
  const credsMount = config.mounts.find((m) => m.containerPath === "/home/agent/.claude/.credentials.json");
  assert(credsMount?.readOnly === true, "claude credentials file is ro");
}

// --- Test policyToContainerConfig: no Claude mounts when not provided ---
{
  const config = policyToContainerConfig(
    researchOnlyTemplate,
    {
      sessionId: "test-no-claude",
      worktreePath: "/tmp/wt-no-claude",
      agentBinPath: "/app/agent",
      nodeModulesPath: "/app/node_modules",
    },
    {},
    "glitterball-agent:no-claude",
    ["node", "/usr/local/lib/agent/dist/index.js"],
  );

  const mountPaths = config.mounts.map((m) => m.containerPath);
  assert(!mountPaths.includes("/home/agent/.claude"), "no claude config mount when not provided");
  assert(!mountPaths.includes("/home/agent/.claude/.credentials.json"), "no claude creds mount when not provided");
}

// --- Results ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
