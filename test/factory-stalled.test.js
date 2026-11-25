const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { stallReason, stallComment, IDLE_HOURS } = require('../lib/stalled.js');
const { flagStalled } = require('../scripts/factory-stalled.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const NOW = Date.parse('2026-11-27T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const report = (over = {}) => ({
  settled: true,
  waitingOn: [],
  actionable: 0,
  checks: { fail: [], pending: [] },
  ...over,
});
const never = () => {
  throw new Error('report read');
};

test('a conflicting PR is stuck, with no report read', () => {
  const reason = stallReason({ mergeable: 'CONFLICTING', updatedAt: hoursAgo(0) }, never, NOW);
  assert.match(reason, /conflicts with the default branch/);
});

test('a recent PR is not stuck and costs no report', () => {
  const pr = { mergeable: 'MERGEABLE', updatedAt: hoursAgo(IDLE_HOURS - 1) };
  assert.equal(stallReason(pr, never, NOW), '');
  assert.equal(stallReason({ mergeable: 'UNKNOWN', updatedAt: hoursAgo(1) }, never, NOW), '');
});

test('an idle PR is stuck on failing or unfinished checks, or unresolved review items', () => {
  const pr = { mergeable: 'MERGEABLE', updatedAt: hoursAgo(30) };
  const why = (over) => stallReason(pr, () => report(over), NOW);
  // The real report counts a failing check in `actionable`, so it must not read as a review item.
  const failing = why({ checks: { fail: ['Test'], pending: [] }, actionable: 1 });
  assert.match(failing, /30 hours.*checks failing: Test/);
  assert.doesNotMatch(failing, /review item/);
  assert.match(
    why({ checks: { fail: ['Test'], pending: [] }, actionable: 3 }),
    /checks failing: Test; 2 unresolved review item/,
  );
  assert.match(why({ checks: { fail: [], pending: ['Build'] } }), /checks never finished: Build/);
  assert.match(why({ actionable: 2 }), /2 unresolved review item/);
  assert.match(why({ settled: false, waitingOn: ['quiet window'] }), /waiting on quiet window/);
});

test('an idle PR that is settled, waiting only for the owner to merge, is not stuck', () => {
  const pr = { mergeable: 'MERGEABLE', updatedAt: hoursAgo(100) };
  assert.equal(
    stallReason(pr, () => report(), NOW),
    '',
  );
});

test('the comment mentions the owner, names the way out, and says how to resume', () => {
  const conflict = stallComment({
    owner: 'octo',
    needsHuman: 'needs-human',
    reason: 'it conflicts with the default branch',
  });
  assert.match(conflict, /^@octo This pull request is stuck: it conflicts/);
  assert.match(conflict, /\*\*Update branch\*\*/);
  assert.match(conflict, /Remove the label when it can carry on/);
  const idle = stallComment({ owner: 'octo', needsHuman: 'needs-human', reason: 'no activity' });
  assert.doesNotMatch(idle, /Update branch/);
});

const row = (number, over = {}) => ({
  number,
  labels: [{ name: 'factory:add-x' }],
  mergeable: 'MERGEABLE',
  updatedAt: hoursAgo(1),
  ...over,
});
function fakeGh(rows) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    return args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(rows) : '';
  };
  return { gh, calls };
}

test('a stuck factory PR gets the label first, then one comment', () => {
  const { gh, calls } = fakeGh([row(9, { mergeable: 'CONFLICTING' })]);
  assert.deepEqual(flagStalled(config, { gh, now: NOW, report: never }), [9]);
  assert.match(calls[0], /pr list --state open --author app\/claude --limit 100/);
  assert.equal(calls[1], 'pr edit 9 --add-label needs-human');
  assert.match(calls[2], /^pr comment 9 --body @\S+ This pull request is stuck/);
});

test('a PR that is parked, not a factory PR, or healthy is left alone', () => {
  const { gh, calls } = fakeGh([
    row(1, {
      mergeable: 'CONFLICTING',
      labels: [{ name: 'factory:add-x' }, { name: 'needs-human' }],
    }),
    row(2, { mergeable: 'CONFLICTING', labels: [{ name: 'bug' }] }),
    row(3),
  ]);
  assert.deepEqual(flagStalled(config, { gh, now: NOW, report: never }), []);
  assert.equal(calls.length, 1);
});

test('the report is read only for an idle PR', () => {
  const read = [];
  const { gh } = fakeGh([row(4), row(5, { updatedAt: hoursAgo(48) })]);
  const flagged = flagStalled(config, {
    gh,
    now: NOW,
    report: (n) => {
      read.push(n);
      return report({ checks: { fail: ['Test'], pending: [] } });
    },
  });
  assert.deepEqual(read, [5]);
  assert.deepEqual(flagged, [5]);
});

test('one PR that fails to flag does not stop the others, and the run still fails', () => {
  const calls = [];
  const rows = [row(6, { mergeable: 'CONFLICTING' }), row(7, { mergeable: 'CONFLICTING' })];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'list') return JSON.stringify(rows);
    if (args.join(' ').startsWith('pr edit 6')) throw new Error('label refused');
    return '';
  };
  assert.throws(() => flagStalled(config, { gh, now: NOW, report: never }), /label refused/);
  assert.ok(calls.includes('pr edit 7 --add-label needs-human'));
});
