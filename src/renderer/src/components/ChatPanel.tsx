import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message, MessagePart, PolicyEvent, SandboxViolationInfo, WorkspaceSummary, ToolCallInfo } from '../../../main/types'
import { MessageInput } from './MessageInput'

const markdownComponents: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

interface Props {
  messages: Message[]
  streamingTextRef: RefObject<Map<string, string[]>>
  streamTick: number
  sessionStatus: WorkspaceSummary['status']
  sessionError?: string
  sandboxed: boolean
  violations: SandboxViolationInfo[]
  policyEvents: PolicyEvent[]
  onSendMessage: (text: string) => void
  onCloseSession: () => void
}


function ToolCallStep({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false)

  const isBash = toolCall.name === 'Bash'
  const command = isBash && toolCall.input?.command ? String(toolCall.input.command) : null
  const hasDetail = isBash && (command || toolCall.output)
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
            {toolCall.output && (
              <>
                <div className="bash-divider" />
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
  const resolved = toolCallIds.map((id) => toolCalls.find((t) => t.id === id)).filter(Boolean) as ToolCallInfo[]
  const allDone = !isStreaming && resolved.length > 0 && resolved.every(
    (tc) => tc.status === 'completed' || tc.status === 'failed'
  )
  // While still in progress or only one tool call, show individually
  if (!allDone || resolved.length <= 1) {
    return <>{resolved.map((tc) => <ToolCallStep key={tc.id} toolCall={tc} />)}</>
  }

  // Collapsed summary for completed runs
  if (!expanded) {
    return (
      <div className="message agent tool-step">
        <div className="step-dot" />
        <div className="step-content tool-step-content">
          <div className="tool-step-summary clickable" onClick={() => setExpanded(true)}>
            <span className="tool-run-summary">
              {resolved.length} tool call{resolved.length > 1 ? 's' : ''}
            </span>
            <span className="tool-step-chevron">{'\u25B8'}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="tool-run-expanded">
      <div className="message agent tool-step">
        <div className="step-dot" />
        <div className="step-content tool-step-content">
          <div className="tool-step-summary clickable" onClick={() => setExpanded(false)}>
            <span className="tool-run-summary">
              {resolved.length} tool call{resolved.length > 1 ? 's' : ''}
            </span>
            <span className="tool-step-chevron">{'\u25BE'}</span>
          </div>
        </div>
      </div>
      {resolved.map((tc) => <ToolCallStep key={tc.id} toolCall={tc} />)}
    </div>
  )
}

export function ChatPanel({
  messages,
  streamingTextRef,
  streamTick,
  sessionStatus,
  sessionError,
  sandboxed,
  violations,
  policyEvents,
  onSendMessage,
  onCloseSession,
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

          return (
            <div key={msg.id} className="agent-turn">
              {grouped.map((group, i) => {
                if (group.type === 'text') {
                  const rawText = segments[group.part.index] ?? ''
                  const displayText = rawText.replace(/^\n+/, '')
                  const isActiveSegment = isStreaming && group.part.index === activeSegmentIndex

                  if (!displayText && !isActiveSegment) return null

                  return (
                    <div key={`text-${group.part.index}`} className="message agent">
                      <div className="step-dot" />
                      <div className={`step-content${isActiveSegment ? ' streaming' : ''}`}>
                        {isActiveSegment && !displayText
                          ? <span className="thinking-indicator"><span className="dot" /><span className="dot" /><span className="dot" /></span>
                          : <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} disallowedElements={['img']}>{displayText}</Markdown>}
                      </div>
                    </div>
                  )
                }

                return (
                  <ToolRunGroup
                    key={`tools-${i}`}
                    toolCallIds={group.toolCallIds}
                    toolCalls={msg.toolCalls ?? []}
                    isStreaming={isStreaming}
                  />
                )
              })}
            </div>
          )
        })}
        {sessionStatus === 'error' && (
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
