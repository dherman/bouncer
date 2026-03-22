import { useEffect, useRef } from 'react'
import type { Message } from '../../../main/types'
import { MessageInput } from './MessageInput'

interface Props {
  messages: Message[]
  streamingText: Map<string, string>
  onSendMessage: (text: string) => void
  disabled: boolean
}

export function ChatPanel({ messages, streamingText, onSendMessage, disabled }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  return (
    <div className="chat-panel">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">Send a message to begin</div>
        )}
        {messages.map((msg) => {
          const isStreaming = msg.streaming && streamingText.has(msg.id)
          const displayText = isStreaming ? streamingText.get(msg.id)! : msg.text

          return (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="bubble">
                {displayText}
                {isStreaming && <span className="cursor">|</span>}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <MessageInput onSend={onSendMessage} disabled={disabled} />
    </div>
  )
}
