import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Repository, WorkspaceSummary } from '../../../main/types'
import branchIcon from '../assets/icon-branch.png'
import newFolderIcon from '../assets/icon-new-folder.png'
import newFolderHoverIcon from '../assets/icon-new-folder-hover.png'

function AddRepoButton({ onAddRepo }: { onAddRepo: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      className="add-repo-btn"
      onClick={onAddRepo}
      title="Add repository (⌘⌥A)"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img src={hovered ? newFolderHoverIcon : newFolderIcon} alt="Add repository" className="add-repo-icon" />
    </button>
  )
}

interface Props {
  repos: Repository[]
  workspaces: WorkspaceSummary[]
  activeWorkspaceId: string | null
  focusedRepoId: string | null
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
  isFocused,
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
  isFocused: boolean
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
          title={isFocused ? 'New workspace (⌘N)' : 'New workspace'}
        >
          +
        </button>
      </div>
      {expanded &&
        workspaces.map((ws) => (
          <div
            key={ws.id}
            className={`workspace-item ${ws.id === activeWorkspaceId ? 'active' : ''}`}
            onClick={() => onSelectWorkspace(ws.id)}
          >
            <img className="workspace-branch-icon" src={branchIcon} alt="Branch" />
            <span className="workspace-label">
              {workspaceLabel(ws)}
              {ws.agentType === 'echo' && <span className="agent-type-badge"> echo</span>}
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
      {expanded && workspaces.length === 0 && <div className="repo-empty">No workspaces</div>}
      {showContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setShowContextMenu(false)} />
          <div className="context-menu" style={{ left: contextMenuPos.x, top: contextMenuPos.y }}>
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
  focusedRepoId,
  style,
}: Props) {
  const onAddRepoRef = useRef(onAddRepo)
  const onCreateWorkspaceRef = useRef(onCreateWorkspace)
  const focusedRepoIdRef = useRef(focusedRepoId)
  onAddRepoRef.current = onAddRepo
  onCreateWorkspaceRef.current = onCreateWorkspace
  focusedRepoIdRef.current = focusedRepoId

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (e.metaKey && e.altKey && e.code === 'KeyA') {
        e.preventDefault()
        onAddRepoRef.current()
      }
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyN' && focusedRepoIdRef.current) {
        e.preventDefault()
        onCreateWorkspaceRef.current(focusedRepoIdRef.current)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="workspaces-sidebar" style={style}>
      <div className="sidebar-header">
        <span className="sidebar-title">Workspaces</span>
        <AddRepoButton onAddRepo={onAddRepo} />
      </div>
      {repos.map((repo) => (
        <RepoGroup
          key={repo.id}
          repo={repo}
          workspaces={workspaces.filter((w) => w.repositoryId === repo.id)}
          activeWorkspaceId={activeWorkspaceId}
          isFocused={repo.id === focusedRepoId}
          violationCounts={violationCounts}
          policyDescriptions={policyDescriptions}
          onSelectWorkspace={onSelectWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          onCloseWorkspace={onCloseWorkspace}
          onRemoveRepo={onRemoveRepo}
          onOpenSettings={onOpenRepoSettings}
        />
      ))}
      {repos.length === 0 && <div className="empty-state">Add a repository to get started</div>}
    </div>
  )
}
