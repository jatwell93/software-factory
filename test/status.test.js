const test = require('node:test');
const assert = require('node:assert/strict');

const { verdict, status } = require('../lib/status.js');
const { listOpenPrs, OPEN_LIMIT } = require('../scripts/factory-status.js');

const NOW = Date.parse('2026-11-25T10:00:00Z');
const report = (over = {}) => ({
  pr: 7,
  state: 'OPEN',
  checks: { pass: 3, fail: [], pending: [], pendingActions: [], skipped: 0 },
  actionable: 0,
  threadsTruncated: false,
  quietUntil: null,
  posters: ['cursor', 'sentry'],
  ...over,
});

test('a settled PR is ready', () => {
  assert.equal(verdict(report(), { now: NOW }).level, 'ready');
});

test('a failing check blocks, and names it', () => {
  const v = verdict(report({ checks: { ...report().checks, fail: ['Test'] }, actionable: 1 }));
  assert.equal(v.level, 'blocked');
  assert.match(v.text, /checks failing: Test/);
});

test('unresolved review items block and say who handles them', () => {
  const v = verdict(report({ actionable: 2 }));
  assert.equal(v.level, 'blocked');
  assert.match(v.text, /2 unresolved review item\(s\)/);
});

test('checks still running is a wait, not a block', () => {
  const v = verdict(report({ checks: { ...report().checks, pending: ['Build'] } }));
  assert.equal(v.level, 'wait');
  assert.match(v.text, /checks running: Build/);
});

test('only the quiet window left is safe to merge, and says what a late comment does', () => {
  const v = verdict(report({ quietUntil: '2026-11-25T10:30:00Z' }), { now: NOW });
  assert.equal(v.level, 'safe');
  assert.match(v.text, /waiting only on quiet window until/);
  assert.match(v.text, /follow-up issue/);
});

test('a configured bot that has not posted is safe, named, and not a block', () => {
  const v = verdict(report({ posters: ['sentry'] }), { bots: ['sentry', 'cursor'], now: NOW });
  assert.equal(v.level, 'safe');
  assert.match(v.text, /no review from cursor yet/);
  assert.doesNotMatch(v.text, /sentry yet/);
});

test('an elapsed quiet window is not outstanding', () => {
  assert.equal(
    verdict(report({ quietUntil: '2026-11-25T09:00:00Z' }), { now: NOW }).level,
    'ready',
  );
});

test('truncated threads cannot be called safe', () => {
  assert.equal(verdict(report({ threadsTruncated: true }), { now: NOW }).level, 'wait');
});

test('a merged or closed PR is done', () => {
  assert.equal(verdict(report({ state: 'MERGED' })).level, 'done');
  assert.equal(verdict(report({ state: 'CLOSED' })).level, 'done');
});

function io(reports, lines) {
  return {
    listOpen: () => Object.keys(reports).map((n) => ({ number: Number(n), title: `t${n}` })),
    view: (n) => ({ number: n, title: `t${n}` }),
    report: (n) => reports[n],
    bots: [],
    now: NOW,
    log: (m) => lines.push(m),
  };
}

test('with no number it lists every open PR and exits 0', () => {
  const lines = [];
  const code = status(
    {},
    io({ 7: report(), 8: report({ checks: { ...report().checks, fail: ['Test'] } }) }, lines),
  );
  assert.equal(code, 0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^#7 ready\s+t7: settled/);
  assert.match(lines[1], /^#8 blocked\s+t8: checks failing/);
});

test('with a number it exits 0 for ready or safe and 1 otherwise', () => {
  const lines = [];
  assert.equal(status({ pr: 7 }, io({ 7: report() }, lines)), 0);
  assert.equal(
    status({ pr: 7 }, io({ 7: report({ quietUntil: '2026-11-25T11:00:00Z' }) }, lines)),
    0,
  );
  assert.equal(status({ pr: 7 }, io({ 7: report({ actionable: 1 }) }, lines)), 1);
  assert.equal(
    status({ pr: 7 }, io({ 7: report({ checks: { ...report().checks, pending: ['B'] } }) }, lines)),
    1,
  );
});

test('the open PR list asks for 100, sorts oldest first, and says when it hit the cap', () => {
  const calls = [];
  const lines = [];
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ number: n - i, title: `t${i}` }));
  const gh = (n) => (args) => {
    calls.push(args);
    return JSON.stringify(rows(n));
  };
  const few = listOpenPrs(gh(3), (m) => lines.push(m));
  assert.deepEqual(
    few.map((p) => p.number),
    [1, 2, 3],
  );
  assert.ok(calls[0].includes('--limit') && calls[0][calls[0].indexOf('--limit') + 1] === '100');
  assert.equal(lines.length, 0);
  listOpenPrs(gh(OPEN_LIMIT), (m) => lines.push(m));
  assert.match(lines[0], /first 100 open pull requests only/);
});

test('no open PRs says so', () => {
  const lines = [];
  assert.equal(status({}, io({}, lines)), 0);
  assert.deepEqual(lines, ['no open pull requests']);
});
