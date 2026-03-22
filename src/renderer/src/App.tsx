import { useCallback, useEffect, useState } from 'react'
import type { Message, SessionSummary, SessionUpdate } from '../../main/types'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Map<string, Message[]>>(new Map())
  const [streamingText, setStreamingText] = useState<Map<string, string>>(new Map())

  const handleUpdate = useCallback((update: SessionUpdate) => {
    switch (update.type) {
      case 'status-change':
        setSessions((prev) =>
          prev.map((s) =>
            s.id === update.sessionId ? { ...s, status: update.status } : s
          )
        )
        break

      case 'message':
        setMessagesBySession((prev) => {
          const next = new Map(prev)
          const msgs = next.get(update.sessionId) ?? []
          next.set(update.sessionId, [...msgs, update.message])
          return next
        })
        // Initialize streaming text for agent messages that are streaming
        if (update.message.streaming) {
          setStreamingText((prev) => {
            const next = new Map(prev)
            next.set(update.message.id, '')
            return next
          })
        }
        break

      case 'stream-chunk':
        setStreamingText((prev) => {
          const next = new Map(prev)
          next.set(update.messageId, (next.get(update.messageId) ?? '') + update.text)
          return next
        })
        break

      case 'stream-end':
        // Finalize: copy streaming text into the message, remove from streaming map
        setStreamingText((prev) => {
          const finalText = prev.get(update.messageId) ?? ''
          // Update the message with the final text
          setMessagesBySession((prevMsgs) => {
            const next = new Map(prevMsgs)
            for (const [sessionId, msgs] of next) {
              const updated = msgs.map((m) =>
                m.id === update.messageId
                  ? { ...m, text: finalText, streaming: false }
                  : m
              )
              if (updated !== msgs) {
                next.set(sessionId, updated)
              }
            }
            return next
          })
          const next = new Map(prev)
          next.delete(update.messageId)
          return next
        })
        break
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.glitterball.sessions.onUpdate(handleUpdate)
    return unsubscribe
  }, [handleUpdate])

  async function handleCreateSession() {
    const session = await window.glitterball.sessions.create()
    setSessions((prev) => [...prev, session])
    setActiveSessionId(session.id)
  }

  async function handleSendMessage(text: string) {
    if (!activeSessionId) return
    await window.glitterball.sessions.sendMessage(activeSessionId, text)
  }

  const activeMessages = activeSessionId
    ? messagesBySession.get(activeSessionId) ?? []
    : []

  const isStreaming = activeMessages.some((m) => m.streaming)

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onCreate={handleCreateSession}
      />
      {activeSessionId ? (
        <ChatPanel
          messages={activeMessages}
          streamingText={streamingText}
          onSendMessage={handleSendMessage}
          disabled={isStreaming}
        />
      ) : (
        <div className="chat-panel">
          <div className="empty-state">Create a new session to get started</div>
        </div>
      )}
    </div>
  )
}

export default App
