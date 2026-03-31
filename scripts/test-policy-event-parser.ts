// scripts/test-policy-event-parser.ts
//
// Tests for the policy event stderr line parser.
//
// Usage: npx tsx scripts/test-policy-event-parser.ts

import assert from 'node:assert/strict';
import { parsePolicyEvent } from '../src/main/policy-event-parser.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err}`);
    failed++;
  }
}

console.log('=== Policy Event Parser Tests ===\n');

// --- gh shim events ---

console.log('gh shim events:');

test('ALLOW pr create', () => {
  const event = parsePolicyEvent('[bouncer:gh] ALLOW pr create --title "foo"');
  assert.ok(event);
  assert.equal(event.tool, 'gh');
  assert.equal(event.decision, 'allow');
  assert.equal(event.operation, 'pr create --title "foo"');
  assert.equal(event.reason, undefined);
});

test('ALLOW pr view 42', () => {
  const event = parsePolicyEvent('[bouncer:gh] ALLOW pr view 42');
  assert.ok(event);
  assert.equal(event.tool, 'gh');
  assert.equal(event.decision, 'allow');
  assert.equal(event.operation, 'pr view 42');
});

test('ALLOW api graphql [unaudited]', () => {
  const event = parsePolicyEvent('[bouncer:gh] ALLOW api graphql [unaudited]');
  assert.ok(event);
  assert.equal(event.tool, 'gh');
  assert.equal(event.decision, 'allow');
  assert.equal(event.operation, 'api graphql');
  assert.equal(event.reason, undefined);
});

test('DENY pr merge 15', () => {
  const event = parsePolicyEvent(
    '[bouncer:gh] DENY pr merge 15 — merging pull requests is not allowed',
  );
  assert.ok(event);
  assert.equal(event.tool, 'gh');
  assert.equal(event.decision, 'deny');
  assert.equal(event.operation, 'pr merge 15');
  assert.equal(event.reason, 'merging pull requests is not allowed');
});

test('DENY auth login', () => {
  const event = parsePolicyEvent('[bouncer:gh] DENY auth login — auth commands are not allowed');
  assert.ok(event);
  assert.equal(event.decision, 'deny');
  assert.equal(event.operation, 'auth login');
  assert.equal(event.reason, 'auth commands are not allowed');
});

test('DENY cross-repo', () => {
  const event = parsePolicyEvent(
    "[bouncer:gh] DENY pr list — cross-repo access denied: 'other/repo' (session repo: 'owner/repo')",
  );
  assert.ok(event);
  assert.equal(event.decision, 'deny');
  assert.equal(event.operation, 'pr list');
  assert.ok(event.reason?.includes('cross-repo'));
});

test('ALLOW with no subcommand args', () => {
  const event = parsePolicyEvent('[bouncer:gh] ALLOW pr list');
  assert.ok(event);
  assert.equal(event.operation, 'pr list');
  assert.equal(event.decision, 'allow');
});

// --- git hook events ---

console.log('\ngit hook events:');

test('ALLOW push to branch', () => {
  const event = parsePolicyEvent('[bouncer:git] ALLOW push to bouncer/abc123');
  assert.ok(event);
  assert.equal(event.tool, 'git');
  assert.equal(event.decision, 'allow');
  assert.equal(event.operation, 'push to bouncer/abc123');
});

test('DENY push to unauthorized branch', () => {
  const event = parsePolicyEvent(
    '[bouncer:git] DENY push to main — ref not in allowed list (bouncer/abc123)',
  );
  assert.ok(event);
  assert.equal(event.tool, 'git');
  assert.equal(event.decision, 'deny');
  assert.equal(event.operation, 'push to main');
  assert.equal(event.reason, 'ref not in allowed list (bouncer/abc123)');
});

// --- Non-matching lines ---

console.log('\nNon-matching lines:');

test('random stderr line returns null', () => {
  assert.equal(parsePolicyEvent('some random stderr output'), null);
});

test('empty line returns null', () => {
  assert.equal(parsePolicyEvent(''), null);
});

test('[bouncer:gh] error line returns null (not ALLOW/DENY)', () => {
  assert.equal(parsePolicyEvent('[bouncer:gh] error: BOUNCER_GITHUB_POLICY not set'), null);
});

test('[bouncer:gh] captured PR returns null', () => {
  assert.equal(parsePolicyEvent('[bouncer:gh] captured PR #42'), null);
});

test('timestamp field is set', () => {
  const before = Date.now();
  const event = parsePolicyEvent('[bouncer:gh] ALLOW pr list');
  const after = Date.now();
  assert.ok(event);
  assert.ok(event.timestamp >= before && event.timestamp <= after);
});

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
