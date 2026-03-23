export type AgentType = "echo" | "claude-code";

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

export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
  agentType: AgentType;
  projectDir: string;
  sandboxed: boolean;
  policyId: string | null;
  policyName: string | null;
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
}

export interface FilesystemPolicy {
  worktreeAccess: "read-write" | "read-only";
  additionalWritableDirs: string[];
  additionalReadOnlyDirs: string[];
}

export interface NetworkPolicy {
  access: "full" | "none" | "filtered";
  allowedDomains?: string[];
}

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

export type SessionUpdate =
  | { sessionId: string; type: "status-change"; status: SessionSummary["status"]; error?: string }
  | { sessionId: string; type: "message"; message: Message }
  | { sessionId: string; type: "stream-chunk"; messageId: string; text: string }
  | { sessionId: string; type: "stream-end"; messageId: string }
  | { sessionId: string; type: "tool-call"; messageId: string; toolCall: ToolCallInfo }
  | { sessionId: string; type: "sandbox-violation"; violation: SandboxViolationInfo };
