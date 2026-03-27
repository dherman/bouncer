import { useEffect, useState, type CSSProperties } from 'react'
import type { Repository, WorkspaceSummary } from '../../../main/types'

const STATUS_INDICATOR: Record<WorkspaceSummary['status'], string> = {
  initializing: '#f0ad4e',
  ready: '#5cb85c',
  error: '#d9534f',
  closed: '#999',
}

interface Props {
  repos: Repository[]
  workspaces: WorkspaceSummary[]
  activeWorkspaceId: string | null
  violationCounts: Map<string, number>
  policyDescriptions: Map<string, string>
  onSelectWorkspace: (id: string) => void
  onCreateWorkspace: (repositoryId: string) => void
  onCloseWorkspace: (id: string) => void
  onAddRepo: () => void
  onRemoveRepo: (id: string) => void
  onUpdateRepo: (id: string, changes: Partial<Repository>) => void
  onOpenRepoSettings: (repoId: string) => void
  style?: CSSProperties
}

function workspaceLabel(ws: WorkspaceSummary): string {
  if (ws.projectDir) {
    return ws.projectDir.split('/').pop() ?? ws.id.slice(0, 8)
  }
  return ws.id.slice(0, 8)
}

function RepoGroup({
  repo,
  workspaces,
  activeWorkspaceId,
  violationCounts,
  policyDescriptions,
  onSelectWorkspace,
  onCreateWorkspace,
  onCloseWorkspace,
  onRemoveRepo,
  onOpenSettings,
}: {
  repo: Repository
  workspaces: WorkspaceSummary[]
  activeWorkspaceId: string | null
  violationCounts: Map<string, number>
  policyDescriptions: Map<string, string>
  onSelectWorkspace: (id: string) => void
  onCreateWorkspace: (repositoryId: string) => void
  onCloseWorkspace: (id: string) => void
  onRemoveRepo: (id: string) => void
  onOpenSettings: (repoId: string) => void
}) {
  const hasActive = workspaces.some((w) => w.status !== 'closed')
  const [expanded, setExpanded] = useState(true)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })

  // Auto-expand when active workspaces appear
  useEffect(() => {
    if (hasActive) setExpanded(true)
  }, [hasActive])

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setShowContextMenu(true)
    setContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  return (
    <div className="repo-group">
      <div className="repo-row" onContextMenu={handleContextMenu}>
        <button
          type="button"
          className="repo-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '\u25BC' : '\u25B6'}
        </button>
        <span className="repo-name" title={repo.localPath}>
          {repo.name}
        </span>
        {repo.githubRepo && (
          <span className="repo-github" title={repo.githubRepo}>
            {repo.githubRepo}
          </span>
        )}
        <button
          type="button"
          className="repo-create-btn"
          onClick={() => onCreateWorkspace(repo.id)}
          title="New workspace"
        >
          +
        </button>
      </div>
      {expanded && workspaces.map((ws) => (
        <div
          key={ws.id}
          className={`workspace-item ${ws.id === activeWorkspaceId ? 'active' : ''}`}
          onClick={() => onSelectWorkspace(ws.id)}
        >
          <span
            className="status-dot"
            style={{ backgroundColor: STATUS_INDICATOR[ws.status] }}
          />
          <span className="workspace-label">
            {workspaceLabel(ws)}
            {ws.agentType === 'echo' && <span className="agent-type-badge"> echo</span>}
            {ws.sandboxBackend === 'container' && (
              <span className="sandbox-badge sandbox-container" title={ws.containerName ?? 'Container'}>Container</span>
            )}
            {ws.sandboxBackend === 'safehouse' && (
              <span className="sandbox-badge sandbox-seatbelt" title="macOS Seatbelt sandbox">Seatbelt</span>
            )}
            {ws.sandboxBackend === 'none' && ws.status !== 'closed' && (
              <span className="sandbox-badge sandbox-none" title="No sandbox — agent runs with full host access">Unsandboxed</span>
            )}
            {ws.networkAccess === 'filtered' && (
              <span className="sandbox-badge sandbox-seatbelt" title="Network filtered via proxy">Filtered</span>
            )}
            {ws.policyName && (
              <span
                className={`policy-badge policy-${ws.policyId ?? 'default'}`}
                title={ws.policyId ? (policyDescriptions.get(ws.policyId) ?? ws.policyId) : ''}
              >
                {ws.policyName}
              </span>
            )}
            {ws.githubRepo && (
              <span className="github-badge" title={`GitHub: ${ws.githubRepo}`}>
                {ws.ownedPrNumber != null ? `#${ws.ownedPrNumber}` : ''}
              </span>
            )}
            {(violationCounts.get(ws.id) ?? 0) > 0 && (
              <span className="violation-count">{violationCounts.get(ws.id)}</span>
            )}
          </span>
          <span className="workspace-status">{ws.status}</span>
          {ws.status !== 'closed' && (
            <button
              type="button"
              className="close-btn"
              onClick={(e) => {
                e.stopPropagation()
                onCloseWorkspace(ws.id)
              }}
              aria-label="Close workspace"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {expanded && workspaces.length === 0 && (
        <div className="repo-empty">No workspaces</div>
      )}
      {showContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setShowContextMenu(false)} />
          <div
            className="context-menu"
            style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          >
            <button
              type="button"
              onClick={() => {
                setShowContextMenu(false)
                onOpenSettings(repo.id)
              }}
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => {
                setShowContextMenu(false)
                onRemoveRepo(repo.id)
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function WorkspacesSidebar({
  repos,
  workspaces,
  activeWorkspaceId,
  violationCounts,
  policyDescriptions,
  onSelectWorkspace,
  onCreateWorkspace,
  onCloseWorkspace,
  onAddRepo,
  onRemoveRepo,
  onUpdateRepo,
  onOpenRepoSettings,
  style,
}: Props) {
  return (
    <div className="workspaces-sidebar" style={style}>
      <div className="sidebar-header">
        <span className="sidebar-title">Workspaces</span>
        <button
          type="button"
          className="add-repo-btn"
          onClick={onAddRepo}
          title="Add repository"
        >
          + Repo
        </button>
      </div>
      {repos.map((repo) => (
        <RepoGroup
          key={repo.id}
          repo={repo}
          workspaces={workspaces.filter((w) => w.repositoryId === repo.id)}
          activeWorkspaceId={activeWorkspaceId}
          violationCounts={violationCounts}
          policyDescriptions={policyDescriptions}
          onSelectWorkspace={onSelectWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onCloseWorkspace={onCloseWorkspace}
          onRemoveRepo={onRemoveRepo}
          onOpenSettings={onOpenRepoSettings}
        />
      ))}
      {repos.length === 0 && (
        <div className="empty-state">
          Add a repository to get started
        </div>
      )}
    </div>
  )
}
