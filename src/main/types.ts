export type AgentType = 'echo' | 'claude-code' | 'replay';

// --- Repository Types (M8) ---

export interface Repository {
  id: string;
  name: string;
  localPath: string;
  githubRepo: string | null;
  defaultPolicyId: string;
  defaultAgentType: AgentType;
  createdAt: number;
}

export type MessagePart = { type: 'text'; index: number } | { type: 'tool'; toolCallId: string };

export interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];
  textSegments?: string[];
  parts?: MessagePart[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  output?: string;
}

export type SandboxBackend = 'safehouse' | 'container' | 'none';

export type WorkspacePhase =
  | 'implementing' // Pre-push, agent is writing code
  | 'pr-open' // PR created, CI/review loop
  | 'ready'; // CI green, reviews clean

export type TopicSource = 'placeholder' | 'branch' | 'inferred' | 'pr-title' | 'user';

export interface WorkspaceSummary {
  id: string;
  repositoryId: string | null;
  status: 'initializing' | 'ready' | 'error' | 'suspended' | 'resuming' | 'closed' | 'archived';
  canResume: boolean;
  messageCount: number;
  agentType: AgentType;
  projectDir: string;
  sandboxed: boolean;
  sandboxBackend: SandboxBackend;
  containerName: string | null;
  policyId: string | null;
  policyName: string | null;
  githubRepo: string | null;
  ownedPrNumber: number | null;
  prUrl: string | null;
  phase: WorkspacePhase | null;
  networkAccess: 'full' | 'none' | 'filtered' | null;
  topic: string | null;
}

// --- GitHub Application-Layer Policy Types (M5) ---

/** GitHub-specific application-layer policy for a workspace. */
export interface GitHubPolicy {
  repo: string;
  allowedPushRefs: string[];
  ownedPrNumber: number | null;
  canCreatePr: boolean;
  /** Branches that can never be pushed to, regardless of allowedPushRefs wildcards. */
  protectedBranches: string[];
}

/** Logged when the gh shim, git hook, or proxy allows/denies an operation. */
export interface PolicyEvent {
  timestamp: number;
  tool: 'gh' | 'git' | 'proxy';
  operation: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

// --- Policy Template Types ---

export interface ContainerPolicy {
  image?: string;
  additionalMounts?: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
  networkMode?: 'none' | 'bridge' | 'proxy';
}

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  filesystem: FilesystemPolicy;
  network: NetworkPolicy;
  env: EnvPolicy;
  safehouseIntegrations: string[];
  appendProfile?: string;
  github?: GitHubPolicy;
  container?: ContainerPolicy;
}

export interface FilesystemPolicy {
  worktreeAccess: 'read-write' | 'read-only';
  additionalWritableDirs: string[];
  additionalReadOnlyDirs: string[];
}

export type NetworkPolicy =
  | { access: 'full' }
  | { access: 'none' }
  | { access: 'filtered'; allowedDomains: string[]; inspectedDomains: string[] };

export interface EnvPolicy {
  additional: string[];
  exclude: string[];
}

export interface PolicyTemplateSummary {
  id: string;
  name: string;
  description: string;
}

export interface SandboxViolationInfo {
  timestamp: number;
  operation: string;
  path?: string;
  processName: string;
}

// --- Replay Types ---

export interface ReplayToolCall {
  id: number;
  tool: string;
  input: Record<string, unknown>;
  original_outcome: string;
}

export interface ReplayResult {
  id: number;
  tool: string;
  replay_outcome: 'allowed' | 'blocked' | 'skipped' | 'error';
  error_message?: string;
  original_outcome: string;
}

export type WorkspaceUpdate =
  | {
      workspaceId: string;
      type: 'status-change';
      status: WorkspaceSummary['status'];
      error?: string;
      errorKind?: 'auth';
      summary?: WorkspaceSummary;
    }
  | { workspaceId: string; type: 'message'; message: Message }
  | {
      workspaceId: string;
      type: 'stream-chunk';
      messageId: string;
      text: string;
      segmentIndex: number;
    }
  | {
      workspaceId: string;
      type: 'stream-end';
      messageId: string;
      textSegments: string[];
      parts: MessagePart[];
    }
  | { workspaceId: string; type: 'tool-call'; messageId: string; toolCall: ToolCallInfo }
  | { workspaceId: string; type: 'sandbox-violation'; violation: SandboxViolationInfo }
  | { workspaceId: string; type: 'policy-event'; event: PolicyEvent };
