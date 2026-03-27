import { type RefObject, useEffect, useRef } from 'react'
import type { Message, PolicyEvent, SandboxViolationInfo, SessionSummary, ToolCallInfo } from '../../../main/types'
import { MessageInput } from './MessageInput'

interface Props {
  messages: Message[]
  streamingTextRef: RefObject<Map<string, string>>
  streamTick: number
  sessionStatus: SessionSummary['status']
  sessionError?: string
  violations: SandboxViolationInfo[]
  policyEvents: PolicyEvent[]
  onSendMessage: (text: string) => void
  onCloseSession: () => void
}

function ToolCallBlock({ toolCall }: { toolCall: ToolCallInfo }) {
  const statusIcon =
    toolCall.status === 'completed' ? '\u2713' :
    toolCall.status === 'failed' ? '\u2717' :
    toolCall.status === 'in_progress' ? '\u22EF' : '\u25CB'

  return (
    <div className={`tool-call-block tool-status-${toolCall.status}`}>
      <span className="tool-status-icon">{statusIcon}</span>
      <span className="tool-name">{toolCall.name}</span>
      {toolCall.title && (
        <span className="tool-title">{toolCall.title}</span>
      )}
      {toolCall.output && (
        <details className="tool-output">
          <summary>Output</summary>
          <pre>{typeof toolCall.output === 'string' ? toolCall.output : JSON.stringify(toolCall.output, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

export function ChatPanel({
  messages,
  streamingTextRef,
  streamTick,
  sessionStatus,
  sessionError,
  violations,
  policyEvents,
  onSendMessage,
  onCloseSession,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastScrollTime = useRef(0)

  const isStreaming = messages.some((m) => m.streaming)
  const inputDisabled = isStreaming || sessionStatus !== 'ready'

  // Throttle scrolling to at most once per 100ms
  useEffect(() => {
    const now = Date.now()
    if (now - lastScrollTime.current < 100) return
    lastScrollTime.current = now
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' })
  }, [messages, streamTick, isStreaming])

  return (
    <div className="chat-panel">
      <div className="messages">
        {messages.length === 0 && sessionStatus === 'ready' && (
          <div className="empty-state">Send a message to begin</div>
        )}
        {messages.length === 0 && sessionStatus === 'initializing' && (
          <div className="empty-state">Starting session...</div>
        )}
        {messages.map((msg) => {
          const msgStreaming = msg.streaming && streamingTextRef.current.has(msg.id)
          const rawText = msgStreaming ? (streamingTextRef.current.get(msg.id) ?? '') : msg.text
          const displayText = rawText.replace(/^\n+/, '')

          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="bubble">{msgStreaming && !displayText
                  ? <span className="thinking-indicator"><span className="dot" /><span className="dot" /><span className="dot" /></span>
                  : <>{displayText}{msgStreaming && <span className="cursor">|</span>}</>}{msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="tool-calls">
                    {msg.toolCalls.map((tc) => (
                      <ToolCallBlock key={tc.id} toolCall={tc} />
                    ))}
                  </div>)}</div>
            </div>
          )
        })}
        {sessionStatus === 'error' && (
          <div className="session-state-banner error">
            {sessionError ?? 'Session disconnected'}
            <button onClick={onCloseSession}>Close session</button>
          </div>
        )}
        {sessionStatus === 'closed' && (
          <div className="session-state-banner closed">
            Session closed
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <MessageInput
        onSend={onSendMessage}
        disabled={inputDisabled}
        violations={violations}
        policyEvents={policyEvents}
        placeholder={
          sessionStatus === 'error' ? 'Session disconnected' :
          sessionStatus === 'closed' ? 'Session closed' :
          sessionStatus === 'initializing' ? 'Starting session...' :
          undefined
        }
      />
    </div>
  )
}
