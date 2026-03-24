import { useEffect, useRef, useState } from 'react'
import type { PolicyEvent, SandboxViolationInfo } from '../../../main/types'

interface Props {
  violations: SandboxViolationInfo[]
  policyEvents: PolicyEvent[]
}

type LogEntry =
  | { kind: 'violation'; timestamp: number; data: SandboxViolationInfo }
  | { kind: 'policy'; timestamp: number; data: PolicyEvent }

export function SandboxLog({ violations, policyEvents }: Props) {
  const [expanded, setExpanded] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const totalCount = violations.length + policyEvents.length

  useEffect(() => {
    if (expanded) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [violations, policyEvents, expanded])

  if (totalCount === 0) return null

  // Merge and sort by timestamp
  const entries: LogEntry[] = [
    ...violations.map((v): LogEntry => ({ kind: 'violation', timestamp: v.timestamp, data: v })),
    ...policyEvents.map((e): LogEntry => ({ kind: 'policy', timestamp: e.timestamp, data: e })),
  ].sort((a, b) => a.timestamp - b.timestamp).slice(-200)

  const denyCount = policyEvents.filter((e) => e.decision === 'deny').length
  const violationCount = violations.length

  return (
    <div className="sandbox-log">
      <button
        type="button"
        className="sandbox-log-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="sandbox-log-entries"
      >
        <span className="sandbox-log-icon">&#x1F6E1;</span>
        {' '}Policy &amp; sandbox events ({totalCount})
        {denyCount > 0 && <span className="sandbox-log-deny-count">{denyCount} denied</span>}
        {violationCount > 0 && <span className="sandbox-log-violation-count">{violationCount} violations</span>}
        <span className="sandbox-log-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>
      {expanded && (
        <div className="sandbox-log-entries" id="sandbox-log-entries">
          {entries.map((entry, i) => {
            if (entry.kind === 'violation') {
              const v = entry.data as SandboxViolationInfo
              const key = `v-${v.timestamp}-${v.operation}-${i}`
              return (
                <div key={key} className="sandbox-log-entry sandbox-log-violation">
                  <span className="sandbox-log-entry-icon" title="Sandbox violation">&#x1F6E1;</span>
                  <span className="sandbox-log-op">{v.operation}</span>
                  <span className="sandbox-log-process">{v.processName}</span>
                  {v.path && <span className="sandbox-log-path">{v.path}</span>}
                </div>
              )
            } else {
              const e = entry.data as PolicyEvent
              const key = `p-${e.timestamp}-${e.operation}-${i}`
              const isAllow = e.decision === 'allow'
              return (
                <div key={key} className={`sandbox-log-entry sandbox-log-policy-${e.decision}`}>
                  <span className="sandbox-log-entry-icon" title={isAllow ? 'Allowed' : 'Denied'}>
                    {isAllow ? '\u2705' : '\u274C'}
                  </span>
                  <span className="sandbox-log-tool">{e.tool}</span>
                  <span className={`sandbox-log-op ${isAllow ? '' : 'sandbox-log-op-deny'}`}>{e.operation}</span>
                  {e.reason && <span className="sandbox-log-reason">{e.reason}</span>}
                </div>
              )
            }
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
