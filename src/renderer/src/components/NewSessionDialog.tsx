import { useEffect, useState, type CSSProperties } from 'react'
import type { AgentType, PolicyTemplateSummary, SessionSummary } from '../../../main/types'

interface Props {
  onClose: () => void
  onCreated: (session: SessionSummary) => void
}

export function NewSessionDialog({ onClose, onCreated }: Props) {
  const [agentType, setAgentType] = useState<AgentType>('claude-code')
  const [replaySessionId, setReplaySessionId] = useState('')
  const [policies, setPolicies] = useState<PolicyTemplateSummary[]>([])
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.glitterball.policies.list()
      .then((list) => {
        if (cancelled) return
        setPolicies(list)
        if (list.length > 0) {
          setSelectedPolicyId((prev) => prev ?? list[0].id)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [])

  async function handleBrowse() {
    const dir = await window.glitterball.dialog.selectDirectory()
    if (dir) {
      setProjectDir(dir)
      setError(null)
    }
  }

  async function handleCreate() {
    if (!projectDir || !selectedPolicyId) return
    if (agentType === 'replay' && !replaySessionId.trim()) return
    setCreating(true)
    setError(null)
    try {
      const session = await window.glitterball.sessions.create(
        projectDir,
        agentType,
        selectedPolicyId,
      )
      onCreated(session)

      // For replay sessions, load dataset and auto-send tool calls
      if (agentType === 'replay' && replaySessionId.trim()) {
        const toolCalls = await window.glitterball.sessions.loadReplayData(replaySessionId.trim())
        await window.glitterball.sessions.sendMessage(session.id, JSON.stringify(toolCalls))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={titleStyle}>New Session</h2>

        <div style={sectionStyle}>
          <label style={labelStyle}>Project</label>
          <div style={browseRowStyle}>
            <span style={dirDisplayStyle}>
              {projectDir ?? '(none selected)'}
            </span>
            <button style={browseButtonStyle} onClick={handleBrowse}>
              Browse...
            </button>
          </div>
        </div>

        <div style={sectionStyle}>
          <label style={labelStyle}>Agent</label>
          <div style={agentTypeListStyle}>
            {([
              ['claude-code', 'Claude Code'] as const,
              ['replay', 'Replay'] as const,
              ['echo', 'Echo (dev)'] as const,
            ]).map(([value, label]) => (
              <label key={value} style={agentTypeItemStyle}>
                <input
                  type="radio"
                  name="agentType"
                  checked={agentType === value}
                  onChange={() => setAgentType(value)}
                  style={{ marginRight: 6 }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {agentType === 'replay' && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Dataset Session ID</label>
            <input
              type="text"
              placeholder="e.g., session-042"
              value={replaySessionId}
              onChange={(e) => setReplaySessionId(e.target.value)}
              style={textInputStyle}
            />
          </div>
        )}

        <div style={sectionStyle}>
          <label style={labelStyle}>Policy</label>
          <div style={policyListStyle}>
            {policies.map((p) => (
              <label
                key={p.id}
                style={{
                  ...policyItemStyle,
                  ...(p.id === selectedPolicyId ? policyItemSelectedStyle : {}),
                }}
              >
                <input
                  type="radio"
                  name="policy"
                  checked={p.id === selectedPolicyId}
                  onChange={() => setSelectedPolicyId(p.id)}
                  style={{ marginRight: 8 }}
                />
                <div>
                  <div style={policyNameStyle}>{p.name}</div>
                  <div style={policyDescStyle}>{p.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={buttonRowStyle}>
          <button style={cancelButtonStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...createButtonStyle,
              ...((!projectDir || !selectedPolicyId || creating || (agentType === 'replay' && !replaySessionId.trim())) ? disabledButtonStyle : {}),
            }}
            onClick={handleCreate}
            disabled={!projectDir || !selectedPolicyId || creating || (agentType === 'replay' && !replaySessionId.trim())}
          >
            {creating ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
}

const panelStyle: CSSProperties = {
  backgroundColor: '#2d2d2d',
  borderRadius: 8,
  padding: 24,
  width: 420,
  maxHeight: '80vh',
  overflowY: 'auto',
  color: '#fff',
}

const titleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 20,
}

const sectionStyle: CSSProperties = {
  marginBottom: 16,
}

const labelStyle: CSSProperties = {
  fontSize: 13,
  color: '#aaa',
  marginBottom: 6,
  display: 'block',
}

const browseRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const dirDisplayStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontFamily: 'monospace',
  color: '#ccc',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const browseButtonStyle: CSSProperties = {
  padding: '4px 12px',
  backgroundColor: '#444',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  flexShrink: 0,
}

const policyListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid #444',
}

const policyItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  padding: '10px 12px',
  cursor: 'pointer',
  backgroundColor: '#333',
  borderBottom: '1px solid #444',
}

const policyItemSelectedStyle: CSSProperties = {
  backgroundColor: '#3a3d41',
}

const policyNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
}

const policyDescStyle: CSSProperties = {
  fontSize: 12,
  color: '#999',
  marginTop: 2,
}

const errorStyle: CSSProperties = {
  fontSize: 13,
  color: '#d9534f',
  marginBottom: 12,
}

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 8,
}

const cancelButtonStyle: CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#444',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
}

const createButtonStyle: CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#0078d4',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
}

const disabledButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}

const agentTypeListStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
}

const agentTypeItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  fontSize: 14,
  cursor: 'pointer',
}

const textInputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontSize: 14,
  fontFamily: 'monospace',
  backgroundColor: '#333',
  color: '#fff',
  border: '1px solid #555',
  borderRadius: 4,
  outline: 'none',
  boxSizing: 'border-box',
}
