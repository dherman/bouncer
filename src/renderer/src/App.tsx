import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Message,
  PolicyEvent,
  PolicyTemplateSummary,
  Repository,
  SandboxViolationInfo,
  WorkspaceSummary,
  WorkspaceUpdate,
} from '../../main/types';
import { WorkspacesSidebar } from './components/WorkspacesSidebar';
import { ChatPanel } from './components/ChatPanel';
import { RepoSettings } from './components/RepoSettings';

function App() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [messagesByWorkspace, setMessagesByWorkspace] = useState<Map<string, Message[]>>(new Map());
  const [workspaceErrors, setWorkspaceErrors] = useState<Map<string, string>>(new Map());
  const [workspaceErrorKinds, setWorkspaceErrorKinds] = useState<Map<string, 'auth'>>(new Map());
  const [violationsByWorkspace, setViolationsByWorkspace] = useState<
    Map<string, SandboxViolationInfo[]>
  >(new Map());
  const [policies, setPolicies] = useState<PolicyTemplateSummary[]>([]);
  const [policyDescriptions, setPolicyDescriptions] = useState<Map<string, string>>(new Map());
  const [policyEventsByWorkspace, setPolicyEventsByWorkspace] = useState<
    Map<string, PolicyEvent[]>
  >(new Map());
  const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null);
  const [focusedRepoId, setFocusedRepoId] = useState<string | null>(null);

  // Buffer status-change events that arrive before the workspace is in state
  const pendingStatusUpdates = useRef(
    new Map<string, WorkspaceUpdate & { type: 'status-change' }>(),
  );

  // Use a ref for streaming text to avoid re-rendering the entire tree on every chunk.
  // A tick counter triggers periodic re-renders so the UI updates smoothly.
  const streamingTextRef = useRef(new Map<string, string[]>());
  const [streamTick, setStreamTick] = useState(0);
  const streamTickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStreamTick = useCallback(() => {
    if (!streamTickTimer.current) {
      streamTickTimer.current = setTimeout(() => {
        streamTickTimer.current = null;
        setStreamTick((t) => t + 1);
      }, 80);
    }
  }, []);

  const handleUpdate = useCallback(
    (update: WorkspaceUpdate) => {
      switch (update.type) {
        case 'status-change':
          setWorkspaces((prev) => {
            const exists = prev.some((s) => s.id === update.workspaceId);
            if (!exists) {
              // Workspace not yet in state — stash for when it arrives
              pendingStatusUpdates.current.set(update.workspaceId, update);
              return prev;
            }
            return prev.map((s) =>
              s.id === update.workspaceId
                ? update.summary
                  ? { ...s, ...update.summary }
                  : { ...s, status: update.status }
                : s,
            );
          });
          if (update.status === 'error' && update.error) {
            setWorkspaceErrors((prev) => {
              const next = new Map(prev);
              next.set(update.workspaceId, update.error!);
              return next;
            });
          }
          if (update.errorKind) {
            setWorkspaceErrorKinds((prev) => {
              const next = new Map(prev);
              next.set(update.workspaceId, update.errorKind!);
              return next;
            });
          } else {
            // Clear errorKind when transitioning to a non-auth error or away from error
            setWorkspaceErrorKinds((prev) => {
              if (!prev.has(update.workspaceId)) return prev;
              const next = new Map(prev);
              next.delete(update.workspaceId);
              return next;
            });
          }
          break;

        case 'message':
          setMessagesByWorkspace((prev) => {
            const next = new Map(prev);
            const msgs = next.get(update.workspaceId) ?? [];
            next.set(update.workspaceId, [...msgs, update.message]);
            return next;
          });
          if (update.message.streaming) {
            streamingTextRef.current.set(update.message.id, ['']);
          }
          break;

        case 'stream-chunk': {
          const segments = streamingTextRef.current.get(update.messageId) ?? [''];
          // Expand array if needed for new segment index
          while (segments.length <= update.segmentIndex) {
            segments.push('');
          }
          segments[update.segmentIndex] += update.text;
          streamingTextRef.current.set(update.messageId, segments);
          scheduleStreamTick();
          break;
        }

        case 'stream-end': {
          streamingTextRef.current.delete(update.messageId);
          setMessagesByWorkspace((prevMsgs) => {
            const next = new Map(prevMsgs);
            const msgs = next.get(update.workspaceId);
            if (msgs) {
              next.set(
                update.workspaceId,
                msgs.map((m) =>
                  m.id === update.messageId
                    ? {
                        ...m,
                        text: update.textSegments.join('\n\n'),
                        textSegments: update.textSegments,
                        parts: update.parts,
                        streaming: false,
                      }
                    : m,
                ),
              );
            }
            return next;
          });
          // Force a final render to clear streaming state
          setStreamTick((t) => t + 1);
          break;
        }

        case 'tool-call':
          setMessagesByWorkspace((prev) => {
            const next = new Map(prev);
            const msgs = next.get(update.workspaceId);
            if (msgs) {
              next.set(
                update.workspaceId,
                msgs.map((m) => {
                  if (m.id !== update.messageId) return m;
                  const toolCalls = m.toolCalls ? [...m.toolCalls] : [];
                  const existing = toolCalls.findIndex((tc) => tc.id === update.toolCall.id);
                  if (existing >= 0) {
                    toolCalls[existing] = { ...toolCalls[existing] };
                    for (const [k, v] of Object.entries(update.toolCall)) {
                      if (v !== undefined) {
                        (toolCalls[existing] as unknown as Record<string, unknown>)[k] = v;
                      }
                    }
                    return { ...m, toolCalls };
                  }
                  // New tool call: add to parts ordering
                  toolCalls.push(update.toolCall);
                  const parts = m.parts ? [...m.parts] : [{ type: 'text' as const, index: 0 }];
                  parts.push({ type: 'tool' as const, toolCallId: update.toolCall.id });
                  return { ...m, toolCalls, parts };
                }),
              );
            }
            return next;
          });
          break;

        case 'sandbox-violation':
          setViolationsByWorkspace((prev) => {
            const next = new Map(prev);
            const existing = next.get(update.workspaceId) ?? [];
            const updated = [...existing, update.violation].slice(-200);
            next.set(update.workspaceId, updated);
            return next;
          });
          break;

        case 'policy-event':
          setPolicyEventsByWorkspace((prev) => {
            const next = new Map(prev);
            const existing = next.get(update.workspaceId) ?? [];
            const updated = [...existing, update.event].slice(-200);
            next.set(update.workspaceId, updated);
            return next;
          });
          break;
      }
    },
    [scheduleStreamTick],
  );

  // Fetch messages for all open workspaces from the main process.
  // Called on initial mount and when the app returns to foreground
  // (the renderer may have been discarded by macOS while backgrounded).
  const hydrateMessages = useCallback(async (workspaceList: WorkspaceSummary[]) => {
    const open = workspaceList.filter((w) => w.status !== 'closed');
    if (open.length === 0) return;
    const entries = await Promise.all(
      open.map(async (w) => {
        try {
          const msgs: Message[] = await window.bouncer.workspaces.getMessages(w.id);
          return [w.id, msgs] as const;
        } catch {
          return [w.id, [] as Message[]] as const;
        }
      }),
    );
    setMessagesByWorkspace((prev) => {
      const next = new Map(prev);
      for (const [id, msgs] of entries) {
        // Only replace if the main process has more messages (avoids clobbering
        // in-flight streaming state with a stale snapshot).
        if (msgs.length > 0 && msgs.length >= (next.get(id)?.length ?? 0)) {
          next.set(id, msgs);
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    window.bouncer.repositories.list().then(setRepos);
    window.bouncer.workspaces.list().then((list) => {
      if (list.length > 0) {
        setWorkspaces(list);
        setActiveWorkspaceId(list[0].id);
        hydrateMessages(list);
      }
    });
    window.bouncer.policies.list().then((list) => {
      setPolicies(list);
      setPolicyDescriptions(new Map(list.map((p) => [p.id, p.description])));
    });
    window.bouncer.preferences.getFocusedRepoId().then((id) => {
      if (id) setFocusedRepoId(id);
    });
    const unsubscribe = window.bouncer.workspaces.onUpdate(handleUpdate);
    return unsubscribe;
  }, [handleUpdate, hydrateMessages]);

  // Re-hydrate messages when the app returns to the foreground.
  // macOS may discard the renderer's webContents while backgrounded,
  // causing React to remount with empty state.
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        window.bouncer.workspaces.list().then((list) => {
          if (list.length > 0) {
            setWorkspaces(list);
            hydrateMessages(list);
          }
        });
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [hydrateMessages]);

  // Compute the effective focused repo:
  // (a) single repo → always focused
  // (b) active workspace's repo
  // (c) persisted last-focused repo
  const effectiveFocusedRepoId = useMemo(() => {
    if (repos.length === 1) return repos[0].id;
    if (activeWorkspaceId) {
      const ws = workspaces.find((w) => w.id === activeWorkspaceId);
      if (ws?.repositoryId) return ws.repositoryId;
    }
    if (focusedRepoId && repos.some((r) => r.id === focusedRepoId)) return focusedRepoId;
    return null;
  }, [repos, activeWorkspaceId, workspaces, focusedRepoId]);

  // Persist focused repo when it changes due to workspace selection
  useEffect(() => {
    if (effectiveFocusedRepoId && effectiveFocusedRepoId !== focusedRepoId) {
      setFocusedRepoId(effectiveFocusedRepoId);
      void window.bouncer.preferences
        .setFocusedRepoId(effectiveFocusedRepoId)
        .catch((err) => console.error('Failed to persist focused repo ID:', err));
    }
  }, [effectiveFocusedRepoId]);

  async function handleAddRepo() {
    const dir = await window.bouncer.dialog.selectDirectory();
    if (!dir) return;
    try {
      const repo = await window.bouncer.repositories.add(dir);
      setRepos((prev) => [...prev, repo]);
    } catch (err) {
      console.error('Failed to add repository:', err);
    }
  }

  async function handleCreateWorkspace(repositoryId: string) {
    try {
      const ws = await window.bouncer.workspaces.create(repositoryId);
      // Apply any status-change events that arrived while create() was in flight
      const pending = pendingStatusUpdates.current.get(ws.id);
      pendingStatusUpdates.current.delete(ws.id);
      const resolved = pending?.summary
        ? { ...ws, ...pending.summary }
        : pending
          ? { ...ws, status: pending.status }
          : ws;
      setWorkspaces((prev) => [...prev, resolved]);
      setActiveWorkspaceId(ws.id);
    } catch (err) {
      console.error('Failed to create workspace:', err);
    }
  }

  async function handleSendMessage(text: string) {
    if (!activeWorkspaceId) return;
    try {
      await window.bouncer.workspaces.sendMessage(activeWorkspaceId, text);
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  }

  async function handleCloseWorkspace(id: string) {
    try {
      await window.bouncer.workspaces.close(id);
    } catch (err) {
      console.error('Failed to close workspace:', err);
    }
  }

  async function handleRefreshCredentials() {
    if (!activeWorkspaceId) return;
    try {
      await window.bouncer.workspaces.refreshCredentials(activeWorkspaceId);
    } catch (err) {
      console.error('Failed to refresh credentials:', err);
    }
  }

  async function handleRemoveRepo(id: string) {
    // Close active workspaces for this repo first
    const repoWorkspaces = workspaces.filter((w) => w.repositoryId === id && w.status !== 'closed');
    for (const w of repoWorkspaces) {
      await handleCloseWorkspace(w.id);
    }
    try {
      await window.bouncer.repositories.remove(id);
      setRepos((prev) => prev.filter((r) => r.id !== id));
      setWorkspaces((prev) => prev.filter((w) => w.repositoryId !== id));
      setActiveWorkspaceId((prev) => {
        if (!prev) return null;
        const ws = workspaces.find((w) => w.id === prev);
        return ws && ws.repositoryId === id ? null : prev;
      });
      if (settingsRepoId === id) setSettingsRepoId(null);
    } catch (err) {
      console.error('Failed to remove repository:', err);
    }
  }

  async function handleUpdateRepo(id: string, changes: Partial<Repository>) {
    try {
      await window.bouncer.repositories.update(id, changes);
      setRepos((prev) => prev.map((r) => (r.id === id ? { ...r, ...changes } : r)));
    } catch (err) {
      console.error('Failed to update repository:', err);
    }
  }

  const activeWorkspace = workspaces.find((s) => s.id === activeWorkspaceId);
  const activeMessages = activeWorkspaceId
    ? (messagesByWorkspace.get(activeWorkspaceId) ?? [])
    : [];
  const activeViolations = activeWorkspaceId
    ? (violationsByWorkspace.get(activeWorkspaceId) ?? [])
    : [];
  const activePolicyEvents = activeWorkspaceId
    ? (policyEventsByWorkspace.get(activeWorkspaceId) ?? [])
    : [];

  const [sidebarWidth, setSidebarWidth] = useState(280);
  const dragging = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  function stopDrag() {
    dragging.current = false;
    handleRef.current?.classList.remove('dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('blur', stopDrag);
  }

  function onMouseMove(ev: globalThis.MouseEvent) {
    const newWidth = Math.min(Math.max(ev.clientX, 180), window.innerWidth / 2);
    setSidebarWidth(newWidth);
  }

  function onMouseUp() {
    stopDrag();
  }

  function handleResizeStart(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.classList.add('dragging');

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', stopDrag);
  }

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', stopDrag);
    };
  }, []);

  const violationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [id, vs] of violationsByWorkspace) {
      counts.set(id, vs.length);
    }
    return counts;
  }, [violationsByWorkspace]);

  return (
    <div className="app">
      <WorkspacesSidebar
        repos={repos}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        focusedRepoId={effectiveFocusedRepoId}
        violationCounts={violationCounts}
        policyDescriptions={policyDescriptions}
        onSelectWorkspace={setActiveWorkspaceId}
        onCreateWorkspace={handleCreateWorkspace}
        onCloseWorkspace={handleCloseWorkspace}
        onAddRepo={handleAddRepo}
        onRemoveRepo={handleRemoveRepo}
        onUpdateRepo={handleUpdateRepo}
        onOpenRepoSettings={setSettingsRepoId}
        style={{ width: sidebarWidth }}
      />
      <div ref={handleRef} className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
      {activeWorkspace ? (
        <ChatPanel
          messages={activeMessages}
          streamingTextRef={streamingTextRef}
          streamTick={streamTick}
          sessionStatus={activeWorkspace.status}
          sessionError={workspaceErrors.get(activeWorkspace.id)}
          sandboxed={activeWorkspace.sandboxed}
          violations={activeViolations}
          policyEvents={activePolicyEvents}
          onSendMessage={handleSendMessage}
          onCloseSession={() => handleCloseWorkspace(activeWorkspace.id)}
          sessionErrorKind={workspaceErrorKinds.get(activeWorkspace.id)}
          onRefreshCredentials={handleRefreshCredentials}
        />
      ) : (
        <div className="chat-panel">
          <div className="empty-state">
            {repos.length === 0
              ? 'Add a repository to get started'
              : 'Select a workspace or create one with the + button'}
          </div>
        </div>
      )}
      {settingsRepoId &&
        (() => {
          const repo = repos.find((r) => r.id === settingsRepoId);
          if (!repo) return null;
          return (
            <RepoSettings
              repo={repo}
              policies={policies}
              onSave={handleUpdateRepo}
              onClose={() => setSettingsRepoId(null)}
            />
          );
        })()}
    </div>
  );
}

export default App;
