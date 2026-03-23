import { useCallback, useEffect, useState } from 'react'
import type { Message, SessionSummary, SessionUpdate, ToolCallInfo } from '../../main/types'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Map<string, Message[]>>(new Map())
  const [streamingText, setStreamingText] = useState<Map<string, string>>(new Map())
  const [createError, setCreateError] = useState<string | null>(null)

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

      case 'stream-end': {
        setStreamingText((prev) => {
          const finalText = prev.get(update.messageId) ?? ''
          setMessagesBySession((prevMsgs) => {
            const next = new Map(prevMsgs)
            const msgs = next.get(update.sessionId)
            if (msgs) {
              next.set(
                update.sessionId,
                msgs.map((m) =>
                  m.id === update.messageId
                    ? { ...m, text: finalText, streaming: false }
                    : m
                )
              )
            }
            return next
          })
          const next = new Map(prev)
          next.delete(update.messageId)
          return next
        })
        break
      }

      case 'tool-call':
        setMessagesBySession((prev) => {
          const next = new Map(prev)
          const msgs = next.get(update.sessionId)
          if (msgs) {
            next.set(
              update.sessionId,
              msgs.map((m) => {
                if (m.id !== update.messageId) return m
                const toolCalls = m.toolCalls ? [...m.toolCalls] : []
                const existing = toolCalls.findIndex((tc) => tc.id === update.toolCall.id)
                if (existing >= 0) {
                  toolCalls[existing] = update.toolCall
                } else {
                  toolCalls.push(update.toolCall)
                }
                return { ...m, toolCalls }
              })
            )
          }
          return next
        })
        break
    }
  }, [])

  useEffect(() => {
    window.glitterball.sessions.list().then((list) => {
      if (list.length > 0) {
        setSessions(list)
        setActiveSessionId(list[0].id)
      }
    })
    const unsubscribe = window.glitterball.sessions.onUpdate(handleUpdate)
    return unsubscribe
  }, [handleUpdate])

  async function handleCreateSession() {
    try {
      const projectDir = await window.glitterball.dialog.selectDirectory()
      if (!projectDir) return // User cancelled

      setCreateError(null)
      const session = await window.glitterball.sessions.create(projectDir)
      setSessions((prev) => [...prev, session])
      setActiveSessionId(session.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCreateError(message)
      console.error('Failed to create session:', err)
    }
  }

  async function handleSendMessage(text: string) {
    if (!activeSessionId) return
    try {
      await window.glitterball.sessions.sendMessage(activeSessionId, text)
    } catch (err) {
      console.error('Failed to send message:', err)
    }
  }

  async function handleCloseSession(id: string) {
    try {
      await window.glitterball.sessions.closeSession(id)
    } catch (err) {
      console.error('Failed to close session:', err)
    }
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeMessages = activeSessionId
    ? messagesBySession.get(activeSessionId) ?? []
    : []

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onCreate={handleCreateSession}
        onClose={handleCloseSession}
      />
      {activeSession ? (
        <ChatPanel
          messages={activeMessages}
          streamingText={streamingText}
          sessionStatus={activeSession.status}
          onSendMessage={handleSendMessage}
          onCloseSession={() => handleCloseSession(activeSession.id)}
        />
      ) : (
        <div className="chat-panel">
          <div className="empty-state">
            {createError ? (
              <div className="create-error">
                <p>{createError}</p>
                <button onClick={() => setCreateError(null)}>Dismiss</button>
              </div>
            ) : (
              'Create a new session to get started'
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
