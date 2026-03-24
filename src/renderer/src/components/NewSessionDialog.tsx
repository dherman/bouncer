import { useEffect, useState } from 'react'
import type { PolicyTemplateSummary, SessionSummary } from '../../../main/types'

interface Props {
  onClose: () => void
  onCreated: (session: SessionSummary) => void
}

export function NewSessionDialog({ onClose, onCreated }: Props) {
  const [policies, setPolicies] = useState<PolicyTemplateSummary[]>([])
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.glitterball.policies.list().then((list) => {
      setPolicies(list)
      if (list.length > 0) {
        setSelectedPolicyId(list[0].id)
      }
    })
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
    setCreating(true)
    setError(null)
    try {
      const session = await window.glitterball.sessions.create(
        projectDir,
        'claude-code',
        selectedPolicyId,
      )
      onCreated(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
          <label style={labelStyle}>Policy</label>
          <div style={policyListStyle}>
            {policies.map((p) => (
              <label
                key={p.id}
                style={{
                  ...policyItemStyle,
                  ...(p.id === selectedPolicyId ? policyItemSelectedStyle : {}),
                }}
                onClick={() => setSelectedPolicyId(p.id)}
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
              ...((!projectDir || creating) ? disabledButtonStyle : {}),
            }}
            onClick={handleCreate}
            disabled={!projectDir || creating}
          >
            {creating ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
}

const panelStyle: React.CSSProperties = {
  backgroundColor: '#2d2d2d',
  borderRadius: 8,
  padding: 24,
  width: 420,
  maxHeight: '80vh',
  overflowY: 'auto',
  color: '#fff',
}

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 20,
}

const sectionStyle: React.CSSProperties = {
  marginBottom: 16,
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#aaa',
  marginBottom: 6,
  display: 'block',
}

const browseRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const dirDisplayStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontFamily: 'monospace',
  color: '#ccc',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const browseButtonStyle: React.CSSProperties = {
  padding: '4px 12px',
  backgroundColor: '#444',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  flexShrink: 0,
}

const policyListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid #444',
}

const policyItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  padding: '10px 12px',
  cursor: 'pointer',
  backgroundColor: '#333',
  borderBottom: '1px solid #444',
}

const policyItemSelectedStyle: React.CSSProperties = {
  backgroundColor: '#3a3d41',
}

const policyNameStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
}

const policyDescStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#999',
  marginTop: 2,
}

const errorStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#d9534f',
  marginBottom: 12,
}

const buttonRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 8,
}

const cancelButtonStyle: React.CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#444',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
}

const createButtonStyle: React.CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#0078d4',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
}

const disabledButtonStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
}
