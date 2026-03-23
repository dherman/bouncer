import { useEffect, useRef, useState } from 'react'
import type { SandboxViolationInfo } from '../../../main/types'

interface Props {
  violations: SandboxViolationInfo[]
}

export function SandboxLog({ violations }: Props) {
  const [expanded, setExpanded] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [violations, expanded])

  if (violations.length === 0) return null

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
        {' '}Sandbox violations ({violations.length})
        <span className="sandbox-log-chevron">{expanded ? '\u25B2' : '\u25BC'}</span>
      </button>
      {expanded && (
        <div className="sandbox-log-entries" id="sandbox-log-entries">
          {violations.slice(-200).map((v, i) => {
            const key = `${v.timestamp}:${v.operation}:${v.processName}:${v.path ?? ''}:${i}`
            return (
              <div key={key} className="sandbox-log-entry">
                <span className="sandbox-log-op">{v.operation}</span>
                <span className="sandbox-log-process">{v.processName}</span>
                {v.path && <span className="sandbox-log-path">{v.path}</span>}
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
