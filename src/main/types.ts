export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  streaming?: boolean;
}

export interface SessionSummary {
  id: string;
  status: "initializing" | "ready" | "error" | "closed";
  messageCount: number;
}

export type SessionUpdate =
  | { sessionId: string; type: "status-change"; status: SessionSummary["status"] }
  | { sessionId: string; type: "message"; message: Message }
  | { sessionId: string; type: "stream-chunk"; messageId: string; text: string }
  | { sessionId: string; type: "stream-end"; messageId: string };
