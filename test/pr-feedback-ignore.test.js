const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize, main } = require('../scripts/pr-feedback.js');
const { tempRoot } = require('./helpers.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');

const pr = () => ({
  number: 667,
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/667',
  headRefName: 'feature/x',
  commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-10-21T11:00:00Z' } }] },
  reviewThreads: { nodes: [] },
  reviews: { nodes: [] },
  comments: { nodes: [] },
});

const OWN = ['Reviews settled', 'factory/reviews-settled'];
const rows = () => [
  {
    name: 'Workers Test',
    bucket: 'pass',
    workflow: 'Workers Test',
    startedAt: '2026-10-21T10:00:00Z',
    completedAt: '2026-10-21T10:05:00Z',
  },
  // The reviews-settled run itself: running now, found by its workflow name.
  {
    name: 'settle / Publish factory/reviews-settled',
    bucket: 'pending',
    workflow: 'Reviews settled',
    startedAt: '2026-10-21T11:59:00Z',
  },
  // Its own status: pending until this very run posts, found by its name.
  {
    name: 'factory/reviews-settled',
    bucket: 'pending',
    workflow: '',
    startedAt: '2026-10-21T11:59:30Z',
  },
];

test('ignored checks are not pending and do not restart the quiet window', () => {
  const without = summarize(pr(), rows(), { now: NOW, ignoreChecks: OWN });
  assert.deepEqual(without.checks.pending, []);
  assert.equal(without.settled, true);
  assert.equal(
    without.lastActivityAt,
    '2026-10-21T11:00:00.000Z',
    'only the commit and the passing check count',
  );
});

test('an ignored check does not move the push time, even when it started first', () => {
  const early = [
    {
      name: 'factory/reviews-settled',
      bucket: 'pending',
      workflow: '',
      startedAt: '2026-10-21T11:10:00Z',
    },
    {
      name: 'Workers Test',
      bucket: 'pass',
      workflow: 'Workers Test',
      startedAt: '2026-10-21T11:20:00Z',
    },
  ];
  assert.equal(
    summarize(pr(), early, { now: NOW, ignoreChecks: OWN }).lastPushAt,
    '2026-10-21T11:20:00.000Z',
  );
  assert.equal(summarize(pr(), early, { now: NOW }).lastPushAt, '2026-10-21T11:10:00.000Z');
});

test('without the ignore list the report waits on its own run, and on its quiet window', () => {
  const report = summarize(pr(), rows(), { now: NOW });
  assert.equal(report.settled, false);
  assert.deepEqual(report.waitingOn, ['checks', 'quiet window']);
});

test('a failing ignored check does not count as a failure either', () => {
  const failing = rows().map((r) =>
    r.workflow === 'Reviews settled' ? { ...r, bucket: 'fail' } : r,
  );
  const report = summarize(pr(), failing, { now: NOW, ignoreChecks: OWN });
  assert.deepEqual(report.checks.fail, []);
});

test('an ignored name matches a check or a workflow, never part of a name', () => {
  const some = [
    { name: 'Reviews settled extra', bucket: 'pending', workflow: 'Other' },
    { name: 'build', bucket: 'pending', workflow: 'Reviews settled' },
  ];
  const report = summarize(pr(), some, { now: NOW, ignoreChecks: ['Reviews settled'] });
  assert.deepEqual(report.checks.pending, ['Reviews settled extra']);
});

function run(argv, checkRows) {
  let out = '';
  const gh = (args) => {
    if (args[0] === 'repo') return 'o/r';
    if (args[0] === 'api') return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
    return JSON.stringify(checkRows);
  };
  const status = main(argv, { gh, out: { write: (s) => (out += s) }, root: tempRoot() });
  return { status, out };
}

test('--ignore-check reaches the report from the command line', () => {
  const self = [
    { name: 'self', bucket: 'pending', workflow: 'Own', startedAt: '2026-10-21T11:59:00Z' },
  ];
  const ignored = run(['667', '--ignore-check', 'Own', '--summary'], self);
  assert.equal(ignored.status, 0);
  assert.match(ignored.out, /checks=0 pass\/0 fail\/0 pending/);
  assert.match(run(['667', '--summary'], self).out, /1 pending/);
  const two = run(['667', '--ignore-check', 'Own', '--ignore-check', 'self', '--summary'], self);
  assert.match(two.out, /0 pending/);
});

test('--ignore-check without a name is a usage error', () => {
  const saved = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(run(['667', '--ignore-check'], []).status, 2);
    assert.equal(run(['667', '--ignore-check', '--summary'], []).status, 2);
  } finally {
    process.stderr.write = saved;
  }
});
