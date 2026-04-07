import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Repository, WorkspaceSummary } from '../../../main/types';
import branchIcon from '../assets/icon-branch.png';
import newFolderIcon from '../assets/icon-new-folder.png';
import newFolderHoverIcon from '../assets/icon-new-folder-hover.png';
import archiveIcon from '../assets/icon-archive.png';
import cancelledIcon from '../assets/icon-cancelled.png';

function AddRepoButton({ onAddRepo }: { onAddRepo: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      className="add-repo-btn"
      onClick={onAddRepo}
      title="Add repository (⌘⌥A)"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={hovered ? newFolderHoverIcon : newFolderIcon}
        alt="Add repository"
        className="add-repo-icon"
      />
    </button>
  );
}

interface Props {
  repos: Repository[];
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  focusedRepoId: string | null;
  violationCounts: Map<string, number>;
  policyDescriptions: Map<string, string>;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: (repositoryId: string) => void;
  onCloseWorkspace: (id: string) => void;
  onArchiveWorkspace: (id: string) => void;
  onResumeWorkspace: (id: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (id: string) => void;
  onUpdateRepo: (id: string, changes: Partial<Repository>) => void;
  onOpenRepoSettings: (repoId: string) => void;
  style?: CSSProperties;
}

function workspaceLabel(ws: WorkspaceSummary): string {
  if (ws.projectDir) {
    return ws.projectDir.split('/').pop() ?? ws.id.slice(0, 8);
  }
  return ws.id.slice(0, 8);
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
  onArchiveWorkspace,
  onResumeWorkspace,
  onRemoveRepo,
  onOpenSettings,
}: {
  repo: Repository;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  isFocused: boolean;
  violationCounts: Map<string, number>;
  policyDescriptions: Map<string, string>;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: (repositoryId: string) => void;
  onCloseWorkspace: (id: string) => void;
  onArchiveWorkspace: (id: string) => void;
  onResumeWorkspace: (id: string) => void;
  onRemoveRepo: (id: string) => void;
  onOpenSettings: (repoId: string) => void;
}) {
  const hasActive = workspaces.some((w) => w.status !== 'closed' && w.status !== 'archived');
  const [expanded, setExpanded] = useState(true);
  const [showRepoContextMenu, setShowRepoContextMenu] = useState(false);
  const [repoContextMenuPos, setRepoContextMenuPos] = useState({ x: 0, y: 0 });
  const [wsContextMenu, setWsContextMenu] = useState<{
    workspaceId: string;
    x: number;
    y: number;
  } | null>(null);

  // Auto-expand when active workspaces appear
  useEffect(() => {
    if (hasActive) setExpanded(true);
  }, [hasActive]);

  function handleRepoContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    setShowRepoContextMenu(true);
    setRepoContextMenuPos({ x: e.clientX, y: e.clientY });
  }

  function handleWsContextMenu(e: React.MouseEvent, workspaceId: string) {
    e.preventDefault();
    e.stopPropagation();
    setWsContextMenu({ workspaceId, x: e.clientX, y: e.clientY });
  }

  function handleCloseWithConfirm(workspaceId: string) {
    setWsContextMenu(null);
    if (window.confirm('Close this workspace? All data will be permanently deleted.')) {
      onCloseWorkspace(workspaceId);
    }
  }

  // Filter out closed/archived workspaces from display
  const visibleWorkspaces = workspaces.filter(
    (w) => w.status !== 'closed' && w.status !== 'archived',
  );

  return (
    <div className="repo-group">
      <div className="repo-row" onContextMenu={handleRepoContextMenu}>
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
        visibleWorkspaces.map((ws) => {
          const topicText = ws.topic ?? workspaceLabel(ws);
          const isPlaceholder = !ws.topic;
          return (
            <div
              key={ws.id}
              className={`workspace-item${ws.id === activeWorkspaceId ? ' active' : ''}${ws.status === 'suspended' ? ' suspended' : ''}`}
              onClick={() => onSelectWorkspace(ws.id)}
              onContextMenu={(e) => handleWsContextMenu(e, ws.id)}
            >
              <div className="workspace-row-top">
                <img className="workspace-branch-icon" src={branchIcon} alt="Branch" />
                <span
                  className={`workspace-topic${isPlaceholder ? ' placeholder' : ''}`}
                  title={topicText}
                >
                  {topicText}
                </span>
                {ws.status === 'suspended' && ws.canResume ? (
                  <button
                    type="button"
                    className="resume-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onResumeWorkspace(ws.id);
                    }}
                    aria-label="Resume workspace"
                    title="Resume"
                  >
                    ▶
                  </button>
                ) : ws.status === 'suspended' ? (
                  <img
                    src={cancelledIcon}
                    alt="Suspended"
                    className="cancelled-icon"
                    title="Suspended (cannot resume)"
                  />
                ) : (
                  <span className={`workspace-status${ws.status === 'error' ? ' error' : ''}`}>
                    {ws.status === 'resuming' ? '⟳ resuming' : ws.status}
                  </span>
                )}
                {ws.status !== 'closed' && ws.status !== 'archived' && (
                  <button
                    type="button"
                    className="archive-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchiveWorkspace(ws.id);
                    }}
                    aria-label="Archive workspace"
                    title="Archive"
                  >
                    <img src={archiveIcon} alt="Archive" className="archive-icon" />
                  </button>
                )}
              </div>
              <div className="workspace-row-bottom">
                {ws.agentType === 'echo' && <span className="agent-type-badge">echo</span>}
                {ws.policyName && (
                  <span
                    className={`policy-badge policy-${ws.policyId ?? 'default'}`}
                    title={ws.policyId ? (policyDescriptions.get(ws.policyId) ?? ws.policyId) : ''}
                  >
                    {ws.policyName}
                  </span>
                )}
                {ws.phase && (
                  <span className={`phase-badge phase-${ws.phase}`}>
                    {ws.phase === 'implementing' ? 'Impl' : ws.phase === 'pr-open' ? 'PR' : 'Ready'}
                  </span>
                )}
                {ws.prUrl ? (
                  <a
                    className="github-badge pr-link"
                    href={ws.prUrl}
                    title={ws.prUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      window.open(ws.prUrl!, '_blank');
                    }}
                  >
                    #{ws.ownedPrNumber}
                  </a>
                ) : ws.githubRepo && ws.ownedPrNumber != null ? (
                  <span className="github-badge" title={`GitHub: ${ws.githubRepo}`}>
                    #{ws.ownedPrNumber}
                  </span>
                ) : null}
                {(violationCounts.get(ws.id) ?? 0) > 0 && (
                  <span className="violation-count">{violationCounts.get(ws.id)}</span>
                )}
              </div>
            </div>
          );
        })}
      {expanded && visibleWorkspaces.length === 0 && (
        <div className="repo-empty">No workspaces</div>
      )}
      {showRepoContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setShowRepoContextMenu(false)} />
          <div
            className="context-menu"
            style={{ left: repoContextMenuPos.x, top: repoContextMenuPos.y }}
          >
            <button
              type="button"
              onClick={() => {
                setShowRepoContextMenu(false);
                onOpenSettings(repo.id);
              }}
            >
              Settings
            </button>
            <button
              type="button"
              onClick={() => {
                setShowRepoContextMenu(false);
                onRemoveRepo(repo.id);
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
      {wsContextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setWsContextMenu(null)} />
          <div className="context-menu" style={{ left: wsContextMenu.x, top: wsContextMenu.y }}>
            <button type="button" onClick={() => handleCloseWithConfirm(wsContextMenu.workspaceId)}>
              Close (delete permanently)
            </button>
          </div>
        </>
      )}
    </div>
  );
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
  onArchiveWorkspace,
  onResumeWorkspace,
  onAddRepo,
  onRemoveRepo,
  onUpdateRepo,
  onOpenRepoSettings,
  focusedRepoId,
  style,
}: Props) {
  const onAddRepoRef = useRef(onAddRepo);
  const onCreateWorkspaceRef = useRef(onCreateWorkspace);
  const focusedRepoIdRef = useRef(focusedRepoId);
  onAddRepoRef.current = onAddRepo;
  onCreateWorkspaceRef.current = onCreateWorkspace;
  focusedRepoIdRef.current = focusedRepoId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;
      if (e.metaKey && e.altKey && e.code === 'KeyA') {
        e.preventDefault();
        onAddRepoRef.current();
      }
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyN' && focusedRepoIdRef.current) {
        e.preventDefault();
        onCreateWorkspaceRef.current(focusedRepoIdRef.current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
          onArchiveWorkspace={onArchiveWorkspace}
          onResumeWorkspace={onResumeWorkspace}
          onRemoveRepo={onRemoveRepo}
          onOpenSettings={onOpenRepoSettings}
        />
      ))}
      {repos.length === 0 && <div className="empty-state">Add a repository to get started</div>}
    </div>
  );
}
