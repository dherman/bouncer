import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Message, PolicyEvent, PolicyTemplateSummary, SandboxViolationInfo, SessionSummary, SessionUpdate } from '../../main/types'
import { SessionList } from './components/SessionList'
import { ChatPanel } from './components/ChatPanel'
import { NewSessionDialog } from './components/NewSessionDialog'

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Map<string, Message[]>>(new Map())
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false)
  const [sessionErrors, setSessionErrors] = useState<Map<string, string>>(new Map())
  const [violationsBySession, setViolationsBySession] = useState<Map<string, SandboxViolationInfo[]>>(new Map())
  const [policyDescriptions, setPolicyDescriptions] = useState<Map<string, string>>(new Map())
  const [policyEventsBySession, setPolicyEventsBySession] = useState<Map<string, PolicyEvent[]>>(new Map())

  // Use a ref for streaming text to avoid re-rendering the entire tree on every chunk.
  // A tick counter triggers periodic re-renders so the UI updates smoothly.
  const streamingTextRef = useRef(new Map<string, string>())
  const [streamTick, setStreamTick] = useState(0)
  const streamTickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleStreamTick = useCallback(() => {
    if (!streamTickTimer.current) {
      streamTickTimer.current = setTimeout(() => {
        streamTickTimer.current = null
        setStreamTick((t) => t + 1)
      }, 80)
    }
  }, [])

  const handleUpdate = useCallback((update: SessionUpdate) => {
    switch (update.type) {
      case 'status-change':
        setSessions((prev) =>
          prev.map((s) =>
            s.id === update.sessionId ? { ...s, status: update.status } : s
          )
        )
        if (update.status === 'error' && update.error) {
          setSessionErrors((prev) => {
            const next = new Map(prev)
            next.set(update.sessionId, update.error!)
            return next
          })
        }
        break

      case 'message':
        setMessagesBySession((prev) => {
          const next = new Map(prev)
          const msgs = next.get(update.sessionId) ?? []
          next.set(update.sessionId, [...msgs, update.message])
          return next
        })
        if (update.message.streaming) {
          streamingTextRef.current.set(update.message.id, '')
        }
        break

      case 'stream-chunk':
        streamingTextRef.current.set(
          update.messageId,
          (streamingTextRef.current.get(update.messageId) ?? '') + update.text
        )
        scheduleStreamTick()
        break

      case 'stream-end': {
        const finalText = streamingTextRef.current.get(update.messageId) ?? ''
        streamingTextRef.current.delete(update.messageId)
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
        // Force a final render to clear streaming state
        setStreamTick((t) => t + 1)
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

      case 'sandbox-violation':
        setViolationsBySession((prev) => {
          const next = new Map(prev)
          const existing = next.get(update.sessionId) ?? []
          const updated = [...existing, update.violation].slice(-200)
          next.set(update.sessionId, updated)
          return next
        })
        break

      case 'policy-event':
        setPolicyEventsBySession((prev) => {
          const next = new Map(prev)
          const existing = next.get(update.sessionId) ?? []
          const updated = [...existing, update.event].slice(-200)
          next.set(update.sessionId, updated)
          return next
        })
        break
    }
  }, [scheduleStreamTick])

  useEffect(() => {
    window.glitterball.sessions.list().then((list) => {
      if (list.length > 0) {
        setSessions(list)
        setActiveSessionId(list[0].id)
      }
    })
    window.glitterball.policies.list().then((list) => {
      setPolicyDescriptions(new Map(list.map((p) => [p.id, p.description])))
    })
    const unsubscribe = window.glitterball.sessions.onUpdate(handleUpdate)
    return unsubscribe
  }, [handleUpdate])

  function handleSessionCreated(session: SessionSummary) {
    setSessions((prev) => [...prev, session])
    setActiveSessionId(session.id)
    setShowNewSessionDialog(false)
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
  const activeViolations = activeSessionId
    ? violationsBySession.get(activeSessionId) ?? []
    : []
  const activePolicyEvents = activeSessionId
    ? policyEventsBySession.get(activeSessionId) ?? []
    : []

  const violationCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const [id, vs] of violationsBySession) {
      counts.set(id, vs.length)
    }
    return counts
  }, [violationsBySession])

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        violationCounts={violationCounts}
        policyDescriptions={policyDescriptions}
        onSelect={setActiveSessionId}
        onCreate={() => setShowNewSessionDialog(true)}
        onClose={handleCloseSession}
      />
      {activeSession ? (
        <ChatPanel
          messages={activeMessages}
          streamingTextRef={streamingTextRef}
          streamTick={streamTick}
          sessionStatus={activeSession.status}
          sessionError={sessionErrors.get(activeSession.id)}
          violations={activeViolations}
          policyEvents={activePolicyEvents}
          onSendMessage={handleSendMessage}
          onCloseSession={() => handleCloseSession(activeSession.id)}
        />
      ) : (
        <div className="chat-panel">
          <div className="empty-state">
            Create a new session to get started
          </div>
        </div>
      )}
      {showNewSessionDialog && (
        <NewSessionDialog
          onClose={() => setShowNewSessionDialog(false)}
          onCreated={handleSessionCreated}
        />
      )}
    </div>
  )
}

export default App
