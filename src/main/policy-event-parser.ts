/**
 * Parser for Bouncer policy event log lines from stderr.
 *
 * Parses [bouncer:gh], [bouncer:git], and [bouncer:proxy] structured log
 * lines emitted by the gh shim, pre-push hook, and network proxy into
 * PolicyEvent objects.
 *
 * Expected formats:
 *   [bouncer:gh] ALLOW pr create --title "foo"
 *   [bouncer:gh] ALLOW api graphql [unaudited]
 *   [bouncer:gh] DENY pr merge 15 — reason text
 *   [bouncer:git] ALLOW push to bouncer/abc123
 *   [bouncer:git] DENY push to main — reason text
 *   [bouncer:proxy] DENY POST /graphql — GraphQL endpoint is not allowed
 */

import type { PolicyEvent } from './types.js';

// Matches: [bouncer:<tool>] <ALLOW|DENY> <operation>[ — <reason>]
const POLICY_LINE_RE = /^\[bouncer:(gh|git|proxy)\] (ALLOW|DENY) (.+)$/;

// Splits "operation — reason" on the em-dash separator
const REASON_SEPARATOR = ' — ';

/**
 * Attempt to parse a stderr line as a Bouncer policy event.
 * Returns null if the line is not a policy event.
 */
export function parsePolicyEvent(line: string): PolicyEvent | null {
  const match = line.trimEnd().match(POLICY_LINE_RE);
  if (!match) return null;

  const tool = match[1] as 'gh' | 'git' | 'proxy';
  const decision = match[2] === 'ALLOW' ? 'allow' : 'deny';
  const rest = match[3];

  let operation: string;
  let reason: string | undefined;

  const separatorIndex = rest.lastIndexOf(REASON_SEPARATOR);
  if (decision === 'deny' && separatorIndex !== -1) {
    operation = rest.substring(0, separatorIndex);
    reason = rest.substring(separatorIndex + REASON_SEPARATOR.length);
  } else {
    operation = rest;
    // Strip [unaudited] tag if present
    operation = operation.replace(/ \[unaudited\]$/, '');
  }

  return {
    timestamp: Date.now(),
    tool,
    operation: operation.trim(),
    decision,
    reason,
  };
}
