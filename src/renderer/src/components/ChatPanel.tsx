import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, MessagePart, PolicyEvent, SandboxViolationInfo, WorkspaceSummary, ToolCallInfo } from '../../../main/types'
import { MessageInput } from './MessageInput'
import thinkingVideo from '../assets/thinking.webm'

const markdownComponents: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

interface Props {
  messages: Message[]
  streamingTextRef: RefObject<Map<string, string[]>>
  streamTick: number
  sessionStatus: WorkspaceSummary['status']
  sessionError?: string
  sessionErrorKind?: 'auth'
  sandboxed: boolean
  violations: SandboxViolationInfo[]
  policyEvents: PolicyEvent[]
  onSendMessage: (text: string) => void
  onCloseSession: () => void
  onRefreshCredentials: () => void
}


function ToolCallStep({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false)

  const isBash = toolCall.name === 'Bash'
  const command = isBash && toolCall.input?.command ? String(toolCall.input.command) : null
  const hasOutput = !!toolCall.output
  const hasDetail = (isBash && command) || hasOutput
  const dotClass =
    toolCall.status === 'completed' ? 'step-dot tool-dot-success' :
    toolCall.status === 'failed' ? 'step-dot tool-dot-fail' :
    'step-dot tool-dot-progress'

  return (
    <div className="message agent tool-step">
      <div className={dotClass} />
      <div className="step-content tool-step-content">
        <div
          className={`tool-step-summary${hasDetail ? ' clickable' : ''}`}
          onClick={hasDetail ? () => setExpanded((v) => !v) : undefined}
        >
          <span className="tool-step-name">{toolCall.name}</span>
          <span className="tool-step-title">{toolCall.description || toolCall.title}</span>
          {hasDetail && <span className="tool-step-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>}
        </div>
        {expanded && hasDetail && (
          <div className="bash-detail expanded">
            {command && (
              <div className="bash-command">
                <pre>{command}</pre>
              </div>
            )}
            {hasOutput && (
              <>
                {command && <div className="bash-divider" />}
                <div className="bash-output">
                  <pre>{toolCall.output}</pre>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Groups consecutive tool parts from the parts array, preserving text parts as-is. */
type PartGroup =
  | { type: 'text'; part: MessagePart & { type: 'text' } }
  | { type: 'tools'; toolCallIds: string[] }

function groupParts(parts: MessagePart[]): PartGroup[] {
  const groups: PartGroup[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      groups.push({ type: 'text', part })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.type === 'tools') {
        last.toolCallIds.push(part.toolCallId)
      } else {
        groups.push({ type: 'tools', toolCallIds: [part.toolCallId] })
      }
    }
  }
  return groups
}

function ToolRunGroup({ toolCallIds, toolCalls, isStreaming }: {
  toolCallIds: string[]
  toolCalls: ToolCallInfo[]
  isStreaming: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  // Track turn completion: once streaming transitions false, the turn is done.
  const [turnComplete, setTurnComplete] = useState(!isStreaming)
  const prevStreaming = useRef(isStreaming)
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      setTurnComplete(true)
    }
    prevStreaming.current = isStreaming
  }, [isStreaming])

  const resolved = toolCallIds.map((id) => toolCalls.find((t) => t.id === id)).filter(Boolean) as ToolCallInfo[]
  const failCount = resolved.filter((tc) => tc.status === 'failed').length

  // Before the turn is complete, or if user expanded: show all tool calls individually
  if (!turnComplete || expanded) {
    return (
      <>
        {turnComplete && (
          <button type="button" className="tool-group-summary" onClick={() => setExpanded(false)}>
            <span className="tool-step-chevron">{'\u25BE'}</span>
            <span className="tool-group-summary-text">
              {resolved.length} tool call{resolved.length !== 1 ? 's' : ''}
              {failCount > 0 && <span className="tool-group-fail-count"> ({failCount} failed)</span>}
            </span>
          </button>
        )}
        {resolved.map((tc) => <ToolCallStep key={tc.id} toolCall={tc} />)}
      </>
    )
  }

  // Turn complete and collapsed: single summary line
  return (
    <button type="button" className="tool-group-summary" onClick={() => setExpanded(true)}>
      <span className="tool-step-chevron">{'\u25B8'}</span>
      <span className="tool-group-summary-text">
        {resolved.length} tool call{resolved.length !== 1 ? 's' : ''}
        {failCount > 0 && <span className="tool-group-fail-count"> ({failCount} failed)</span>}
      </span>
    </button>
  )
}

export function ChatPanel({
  messages,
  streamingTextRef,
  streamTick,
  sessionStatus,
  sessionError,
  sessionErrorKind,
  sandboxed,
  violations,
  policyEvents,
  onSendMessage,
  onCloseSession,
  onRefreshCredentials,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastScrollTime = useRef(0)

  const isStreaming = messages.some((m) => m.streaming)
  const hasPendingMessage = sessionStatus === 'initializing' && messages.some((m) => m.role === 'user')
  const inputDisabled = isStreaming || hasPendingMessage || (sessionStatus !== 'ready' && sessionStatus !== 'initializing')

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
        {messages.length === 0 && (sessionStatus === 'ready' || sessionStatus === 'initializing') && (
          <div className="empty-state">Send a message to begin</div>
        )}
        {messages.map((msg) => {
          if (msg.role === 'user') {
            const displayText = msg.text.replace(/^\n+/, '')
            return (
              <div key={msg.id} className="message user">
                <div className="user-bubble">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} disallowedElements={['img']}>{displayText}</Markdown>
                </div>
              </div>
            )
          }

          const isStreaming = msg.streaming && streamingTextRef.current.has(msg.id)
          const streamingSegments = isStreaming ? streamingTextRef.current.get(msg.id) : undefined
          const segments = streamingSegments ?? msg.textSegments ?? [msg.text]
          const parts: MessagePart[] = msg.parts ?? [{ type: 'text', index: 0 }]
          const lastTextIndex = [...parts].reverse().find((p) => p.type === 'text')
          const activeSegmentIndex = lastTextIndex?.type === 'text' ? lastTextIndex.index : -1

          const grouped = groupParts(parts)

          // Show the thinking indicator at the bottom of the turn whenever
          // the agent is streaming and the last group is not an active text segment.
          const lastGroup = grouped[grouped.length - 1]
          const activeSegmentIsLast = lastGroup?.type === 'text' && lastGroup.part.index === activeSegmentIndex
          const showTrailingThinking = isStreaming && !activeSegmentIsLast

          return (
            <div key={msg.id} className="agent-turn">
              {grouped.map((group, i) => {
                if (group.type === 'text') {
                  const rawText = segments[group.part.index] ?? ''
                  const displayText = rawText.replace(/^\n+/, '')
                  const isActiveSegment = isStreaming && group.part.index === activeSegmentIndex

                  // Skip empty active segments when we'll show the indicator at the bottom instead
                  if (!displayText && isActiveSegment && showTrailingThinking) return null
                  if (!displayText && !isActiveSegment) return null

                  if (isActiveSegment && !displayText) {
                    return (
                      <div key={`text-${group.part.index}`} className="thinking-indicator">
                        <video src={thinkingVideo} autoPlay loop muted playsInline />
                      </div>
                    )
                  }

                  return (
                    <div key={`text-${group.part.index}`} className="message agent agent-text">
                      <div className={`step-content${isActiveSegment ? ' streaming' : ''}`}>
                        <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} disallowedElements={['img']}>{displayText}</Markdown>
                      </div>
                    </div>
                  )
                }

                return (
                  <ToolRunGroup
                    key={`tools-${i}`}
                    toolCallIds={group.toolCallIds}
                    toolCalls={msg.toolCalls ?? []}
                    isStreaming={!!isStreaming}
                  />
                )
              })}
              {showTrailingThinking && (
                <div className="thinking-indicator">
                  <video src={thinkingVideo} autoPlay loop muted playsInline />
                </div>
              )}
            </div>
          )
        })}
        {sessionStatus === 'error' && sessionErrorKind === 'auth' && (
          <div className="workspace-state-banner auth-error">
            Authentication expired. Run <code>claude auth login</code> in your terminal, then:
            <button type="button" onClick={onRefreshCredentials}>Retry</button>
          </div>
        )}
        {sessionStatus === 'error' && sessionErrorKind !== 'auth' && (
          <div className="workspace-state-banner error">
            {sessionError ?? 'Workspace disconnected'}
            <button onClick={onCloseSession}>Close workspace</button>
          </div>
        )}
        {sessionStatus === 'closed' && (
          <div className="workspace-state-banner closed">
            Workspace closed
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <MessageInput
        onSend={onSendMessage}
        disabled={inputDisabled}
        sandboxed={sandboxed}
        sessionStatus={sessionStatus}
        violations={violations}
        policyEvents={policyEvents}
        placeholder={
          sessionStatus === 'error' ? 'Workspace disconnected' :
          sessionStatus === 'closed' ? 'Workspace closed' :
          sessionStatus === 'initializing' && hasPendingMessage ? 'Starting workspace...' :
          undefined
        }
      />
    </div>
  )
}
