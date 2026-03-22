import type { SessionSummary } from '../../../main/types'

const STATUS_INDICATOR: Record<SessionSummary['status'], string> = {
  initializing: '#f0ad4e',
  ready: '#5cb85c',
  error: '#d9534f',
  closed: '#999',
}

interface Props {
  sessions: SessionSummary[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}

export function SessionList({ sessions, activeSessionId, onSelect, onCreate }: Props) {
  return (
    <div className="session-list">
      <button className="new-session-btn" onClick={onCreate}>
        + New Session
      </button>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <span
            className="status-dot"
            style={{ backgroundColor: STATUS_INDICATOR[s.status] }}
          />
          <span className="session-label">
            {s.id.slice(0, 8)}
          </span>
          <span className="session-status">{s.status}</span>
        </div>
      ))}
      {sessions.length === 0 && (
        <div className="empty-state">No sessions yet</div>
      )}
    </div>
  )
}
