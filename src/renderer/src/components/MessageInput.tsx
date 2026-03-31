import { useEffect, useMemo, useRef, useState } from 'react';
import type { PolicyEvent, SandboxViolationInfo, WorkspaceSummary } from '../../../main/types';
import lockIcon from '../assets/icon-lock.png';
import unlockIcon from '../assets/icon-unlock.png';

type LogEntry =
  | { kind: 'violation'; timestamp: number; data: SandboxViolationInfo }
  | { kind: 'policy'; timestamp: number; data: PolicyEvent };

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  sandboxed: boolean;
  sessionStatus: WorkspaceSummary['status'];
  placeholder?: string;
  violations: SandboxViolationInfo[];
  policyEvents: PolicyEvent[];
}

export function MessageInput({
  onSend,
  disabled,
  sandboxed,
  sessionStatus,
  placeholder,
  violations,
  policyEvents,
}: Props) {
  const [text, setText] = useState('');
  const [showLog, setShowLog] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const logBottomRef = useRef<HTMLDivElement>(null);

  const totalCount = violations.length + policyEvents.length;

  const entries = useMemo(() => {
    const merged: LogEntry[] = [
      ...violations.map((v): LogEntry => ({ kind: 'violation', timestamp: v.timestamp, data: v })),
      ...policyEvents.map((e): LogEntry => ({ kind: 'policy', timestamp: e.timestamp, data: e })),
    ];
    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged.slice(-200);
  }, [violations, policyEvents]);

  const { denyCount, violationCount } = useMemo(() => {
    let deny = 0;
    let viol = 0;
    for (const e of entries) {
      if (e.kind === 'violation') viol++;
      else if ((e.data as PolicyEvent).decision === 'deny') deny++;
    }
    return { denyCount: deny, violationCount: viol };
  }, [entries]);

  useEffect(() => {
    if (showLog) {
      logBottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [entries, showLog]);

  const canSend = !disabled && !!text.trim();
  const hasEvents = totalCount > 0;

  // Close popover when events disappear (e.g. session switch)
  useEffect(() => {
    if (!hasEvents) setShowLog(false);
  }, [hasEvents]);

  // Focus whenever the input becomes enabled (including initial mount)
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className="message-input-wrapper">
      {showLog && hasEvents && (
        <div
          className="sandbox-popover"
          id="sandbox-popover"
          role="dialog"
          aria-label="Policy and sandbox events"
        >
          <div className="sandbox-popover-header">
            Policy &amp; sandbox events ({entries.length})
            {denyCount > 0 && <span className="sandbox-popover-deny">{denyCount} denied</span>}
            {violationCount > 0 && (
              <span className="sandbox-popover-violations">{violationCount} violations</span>
            )}
          </div>
          <div className="sandbox-popover-entries">
            {entries.map((entry, i) => {
              if (entry.kind === 'violation') {
                const v = entry.data as SandboxViolationInfo;
                return (
                  <div
                    key={`v-${v.timestamp}-${v.operation}-${i}`}
                    className="sandbox-log-entry sandbox-log-violation"
                  >
                    <span className="sandbox-log-entry-icon" title="Sandbox violation">
                      &#x1F6E1;
                    </span>
                    <span className="sandbox-log-op-violation">{v.operation}</span>
                    <span className="sandbox-log-process">{v.processName}</span>
                    {v.path && <span className="sandbox-log-path">{v.path}</span>}
                  </div>
                );
              } else {
                const e = entry.data as PolicyEvent;
                const isAllow = e.decision === 'allow';
                return (
                  <div
                    key={`p-${e.timestamp}-${e.operation}-${i}`}
                    className={`sandbox-log-entry sandbox-log-policy-${e.decision}`}
                  >
                    <span className="sandbox-log-entry-icon" title={isAllow ? 'Allowed' : 'Denied'}>
                      {isAllow ? '\u2705' : '\u274C'}
                    </span>
                    <span className="sandbox-log-tool">{e.tool}</span>
                    <span className={isAllow ? 'sandbox-log-op-allow' : 'sandbox-log-op-deny'}>
                      {e.operation}
                    </span>
                    {e.reason && <span className="sandbox-log-reason">{e.reason}</span>}
                  </div>
                );
              }
            })}
            <div ref={logBottomRef} />
          </div>
        </div>
      )}
      <div className="message-input">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit();
          }}
          placeholder={placeholder ?? (disabled ? 'Agent is responding...' : 'Type a message...')}
          disabled={disabled}
        />
        <div className="message-input-toolbar">
          <div className="message-input-toolbar-right">
            <button
              type="button"
              className={`shield-btn${showLog ? ' active' : ''}${denyCount > 0 || violationCount > 0 ? ' has-issues' : ''}`}
              onClick={hasEvents ? () => setShowLog(!showLog) : undefined}
              aria-label="Policy and sandbox events"
              aria-expanded={hasEvents ? showLog : undefined}
              aria-controls={hasEvents ? 'sandbox-popover' : undefined}
              aria-haspopup={hasEvents ? 'dialog' : undefined}
              disabled={!hasEvents}
              title={
                sessionStatus === 'initializing'
                  ? 'Starting...'
                  : sandboxed
                    ? 'Sandboxed'
                    : 'Unsandboxed'
              }
              style={hasEvents ? undefined : { cursor: 'default' }}
            >
              <img
                src={sessionStatus === 'initializing' || sandboxed ? lockIcon : unlockIcon}
                alt={
                  sessionStatus === 'initializing'
                    ? 'Starting'
                    : sandboxed
                      ? 'Sandboxed'
                      : 'Unsandboxed'
                }
                className={`shield-lock-icon${sessionStatus === 'initializing' ? ' loading' : ''}`}
              />
              {(denyCount > 0 || violationCount > 0) && (
                <span className="shield-badge">{denyCount + violationCount}</span>
              )}
            </button>
            <button
              type="button"
              className="send-btn"
              onClick={handleSubmit}
              disabled={!canSend}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 3L8 13M8 3L4 7M8 3L12 7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
