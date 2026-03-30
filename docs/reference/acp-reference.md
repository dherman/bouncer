# Agent Client Protocol (ACP) Reference

Reference for using ACP in Bouncer. ACP is the protocol connecting the Glitter Ball harness (Electron app) to coding agents.

## Overview

ACP standardizes communication between **code editors/IDEs** (clients) and **AI coding agents** (agents). It is analogous to LSP (Language Server Protocol) but for AI coding agents. Created by Zed Industries, Apache 2.0 / MIT licensed.

- **Spec**: https://agentclientprotocol.com
- **GitHub**: https://github.com/agentclientprotocol/agent-client-protocol
- **API docs**: https://agentclientprotocol.github.io/typescript-sdk

## Key Packages

| Package                            | Purpose                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `@agentclientprotocol/sdk`         | Core SDK — `ClientSideConnection` (for harness) and `AgentSideConnection` (for agents) |
| `@zed-industries/claude-agent-acp` | Official ACP adapter for Claude Code                                                   |

SDKs also exist for Python, Rust, Kotlin, and Java.

## Transport

ACP uses **JSON-RPC 2.0** over bidirectional channels.

**stdio (primary, recommended):** The client launches the agent as a subprocess. Agent reads JSON-RPC from stdin, writes to stdout. Messages are newline-delimited. Agents may log to stderr.

**Streamable HTTP:** Under development, not yet finalized.

## Protocol Messages

### Client → Agent Requests

| Request                            | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `InitializeRequest`                | Negotiate protocol version, exchange capabilities |
| `AuthenticateRequest`              | Authentication                                    |
| `NewSessionRequest`                | Create a new conversation session                 |
| `LoadSessionRequest`               | Resume a previous session                         |
| `ListSessionsRequest`              | List existing sessions                            |
| `SetSessionModeRequest`            | Switch agent operating mode                       |
| `SetSessionConfigOptionRequest`    | Update session configuration                      |
| `PromptRequest` (`session/prompt`) | Send user message with context                    |

### Agent → Client Requests

| Request                      | Purpose                            |
| ---------------------------- | ---------------------------------- |
| `ReadTextFileRequest`        | Agent reads a file via the editor  |
| `WriteTextFileRequest`       | Agent writes a file via the editor |
| `RequestPermissionRequest`   | Agent asks user for permission     |
| `CreateTerminalRequest`      | Agent creates a terminal           |
| `TerminalOutputRequest`      | Get terminal output                |
| `KillTerminalRequest`        | Kill a running command             |
| `WaitForTerminalExitRequest` | Wait for command completion        |
| `ReleaseTerminalRequest`     | Close a terminal                   |

### Notifications

| Notification                             | Direction      | Purpose                                        |
| ---------------------------------------- | -------------- | ---------------------------------------------- |
| `SessionNotification` (`session/update`) | Agent → Client | Stream content, tool calls, plans in real-time |
| `CancelNotification` (`session/cancel`)  | Client → Agent | Cancel an ongoing turn                         |
| `ExtRequest` / `ExtNotification`         | Either         | Custom extension methods                       |

### MCP-over-ACP

ACP supports tunneling MCP connections through the ACP channel:

| Message          | Purpose                          |
| ---------------- | -------------------------------- |
| `mcp/connect`    | Initiate MCP connection over ACP |
| `mcp/message`    | Exchange MCP protocol messages   |
| `mcp/disconnect` | Close MCP connection             |

## Streaming Model

When a client sends `PromptRequest`, the agent streams back `SessionNotification` messages containing:

- Text content chunks as generated
- Tool call updates (pending → in_progress → completed/failed)
- Plan updates (multi-step execution plans with status per entry)

The turn concludes when the agent sends `PromptResponse` with a `StopReason` (e.g., `end_turn` or `cancelled`). Clients can cancel at any time with `session/cancel`.

## Content Types

- `TextContent` — markdown text
- `ImageContent` — images
- `AudioContent` — audio
- `ResourceLink` — link to a resource
- `EmbeddedResource` — inline resource
- `ToolCallContent` — tool call with status and results

## Relevance to Bouncer

### Session management

Each Bouncer session maps to an ACP session. `NewSessionRequest` creates a session; `PromptRequest` sends user messages; `SessionNotification` streams responses to the chat UI.

### Sandbox policy interception

`RequestPermissionRequest` is the natural interception point for policy enforcement. When the agent asks for permission, the session manager can evaluate the request against the sandbox policy before prompting the user (or auto-approving).

### Terminal sandboxing

`CreateTerminalRequest` is how the agent runs shell commands. The session manager handles this by spawning the shell inside the Seatbelt sandbox. `TerminalOutputRequest` captures output; `KillTerminalRequest` and `WaitForTerminalExitRequest` manage lifecycle.

### File operations

`ReadTextFileRequest` and `WriteTextFileRequest` can be mediated by the session manager to enforce filesystem boundaries at the ACP level, in addition to OS-level enforcement.

### Agent swappability

The `AgentSideConnection` interface allows swapping between a real Claude Code agent (`@zed-industries/claude-agent-acp`) and a deterministic replay agent for testing, without changing the harness code.

## Relationship to Other Protocols

| Protocol                           | Scope                             | Relationship                                                                                   |
| ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| **MCP** (Model Context Protocol)   | Agent ↔ tools/data (behind agent) | Complementary. ACP reuses MCP JSON types. ACP sits "in front of" the agent; MCP sits "behind." |
| **LSP** (Language Server Protocol) | Editor ↔ language server          | Analogous design. ACP is "LSP for AI coding agents."                                           |
| **A2A** (Agent-to-Agent)           | Agent ↔ agent                     | Different scope. ACP is agent-to-editor, not agent-to-agent.                                   |
