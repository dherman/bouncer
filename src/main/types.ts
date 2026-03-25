export type AgentType = "echo" | "claude-code" | "replay";

export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  streaming?: boolean;
  toolCalls?: ToolCallInfo[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
}

export type SandboxBackend = "safehouse" | "container" | "none";

export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
  agentType: AgentType;
  projectDir: string;
  sandboxed: boolean;
  sandboxBackend: SandboxBackend;
  policyId: string | null;
  policyName: string | null;
  githubRepo: string | null;
  ownedPrNumber: number | null;
}

// --- GitHub Application-Layer Policy Types (M5) ---

/** GitHub-specific application-layer policy for a session. */
export interface GitHubPolicy {
  repo: string;
  allowedPushRefs: string[];
  ownedPrNumber: number | null;
  canCreatePr: boolean;
}

/** Logged when the gh shim or git hook allows/denies an operation. */
export interface PolicyEvent {
  timestamp: number;
  tool: "gh" | "git";
  operation: string;
  decision: "allow" | "deny";
  reason?: string;
}

// --- Policy Template Types ---

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
}

export interface FilesystemPolicy {
  worktreeAccess: "read-write" | "read-only";
  additionalWritableDirs: string[];
  additionalReadOnlyDirs: string[];
}

export type NetworkPolicy =
  | { access: "full" }
  | { access: "none" }
  | { access: "filtered"; allowedDomains: string[] };

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
  replay_outcome: "allowed" | "blocked" | "skipped" | "error";
  error_message?: string;
  original_outcome: string;
}

export type SessionUpdate =
  | { sessionId: string; type: "status-change"; status: SessionSummary["status"]; error?: string }
  | { sessionId: string; type: "message"; message: Message }
  | { sessionId: string; type: "stream-chunk"; messageId: string; text: string }
  | { sessionId: string; type: "stream-end"; messageId: string }
  | { sessionId: string; type: "tool-call"; messageId: string; toolCall: ToolCallInfo }
  | { sessionId: string; type: "sandbox-violation"; violation: SandboxViolationInfo }
  | { sessionId: string; type: "policy-event"; event: PolicyEvent };
