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
  violationCounts: Map<string, number>
  policyDescriptions: Map<string, string>
  onSelect: (id: string) => void
  onCreate: () => void
  onClose: (id: string) => void
}

function projectLabel(session: SessionSummary): string {
  if (session.projectDir) {
    return session.projectDir.split('/').pop() ?? session.id.slice(0, 8)
  }
  return session.id.slice(0, 8)
}

export function SessionList({ sessions, activeSessionId, violationCounts, policyDescriptions, onSelect, onCreate, onClose }: Props) {
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
            {projectLabel(s)}
            {s.agentType === 'echo' && <span className="agent-type-badge"> echo</span>}
            {s.policyName && (
              <span
                className={`policy-badge policy-${s.policyId ?? 'default'}`}
                title={s.policyId ? (policyDescriptions.get(s.policyId) ?? s.policyId) : ''}
              >
                {s.policyName}
              </span>
            )}
            {s.githubRepo && (
              <span className="github-badge" title={`GitHub: ${s.githubRepo}`}>
                {s.githubRepo}{s.ownedPrNumber != null ? ` #${s.ownedPrNumber}` : ''}
              </span>
            )}
            {(violationCounts.get(s.id) ?? 0) > 0 && (
              <span className="violation-count">{violationCounts.get(s.id)}</span>
            )}
          </span>
          <span className="session-status">{s.status}</span>
          {s.status !== 'closed' && (
            <button
              type="button"
              className="close-btn"
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
              aria-label="Close session"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {sessions.length === 0 && (
        <div className="empty-state">No sessions yet</div>
      )}
    </div>
  )
}
