const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize, summarizeChecks, fetchReport, main } = require('../scripts/pr-feedback.js');
const { tempRoot } = require('./helpers.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');

function thread(
  id,
  { resolved = false, author = 'sentry', at = '2026-10-21T11:00:00Z', replies = [] } = {},
) {
  return {
    id,
    isResolved: resolved,
    isOutdated: false,
    path: 'frontend/src/a.tsx',
    line: 10,
    comments: {
      nodes: [
        { author: { login: author }, createdAt: at, url: `u/${id}`, body: `**Bug:** ${id}` },
        ...replies.map((r) => ({ author: { login: r }, createdAt: at, url: 'r', body: 'reply' })),
      ],
    },
  };
}

function pr(overrides = {}) {
  return {
    number: 667,
    state: 'OPEN',
    url: 'https://github.com/o/r/pull/667',
    headRefName: 'feature/x',
    commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-10-21T11:00:00Z' } }] },
    reviewThreads: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

test('only unresolved threads are reported, with their replies', () => {
  const report = summarize(
    pr({
      reviewThreads: {
        nodes: [thread('T1', { resolved: true }), thread('T2', { replies: ['jatwell93'] })],
      },
    }),
    [],
    { now: NOW },
  );
  assert.deepEqual(
    report.unresolvedThreads.map((t) => t.id),
    ['T2'],
  );
  assert.equal(report.unresolvedThreads[0].author, 'sentry');
  assert.deepEqual(report.unresolvedThreads[0].replies, [{ author: 'jatwell93', body: 'reply' }]);
  assert.equal(report.actionable, 1);
});

test('only the latest review per author counts, and only CHANGES_REQUESTED is actionable', () => {
  const report = summarize(
    pr({
      reviews: {
        nodes: [
          {
            author: { login: 'codescene-delta-analysis' },
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-21T10:00:00Z',
            body: 'gates failed',
          },
          {
            author: { login: 'codescene-delta-analysis' },
            state: 'APPROVED',
            submittedAt: '2026-10-21T11:00:00Z',
            body: 'Gates Passed',
          },
          {
            author: { login: 'copilot-pull-request-reviewer' },
            state: 'COMMENTED',
            submittedAt: '2026-10-21T10:30:00Z',
            body: 'quota',
          },
        ],
      },
    }),
    [],
    { now: NOW },
  );
  assert.equal(report.reviews.length, 2);
  const codescene = report.reviews.find((r) => r.author === 'codescene-delta-analysis');
  assert.equal(codescene.state, 'APPROVED');
  assert.equal(report.actionable, 0);
});

test('a failing CodeScene review is actionable', () => {
  const report = summarize(
    pr({
      reviews: {
        nodes: [
          {
            author: { login: 'codescene-delta-analysis' },
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-21T11:00:00Z',
            body: 'x',
          },
        ],
      },
    }),
    [],
    { now: NOW },
  );
  assert.equal(report.actionable, 1);
});

test('a later COMMENTED review does not clear an earlier CHANGES_REQUESTED', () => {
  const report = summarize(
    pr({
      reviews: {
        nodes: [
          {
            author: { login: 'reviewer' },
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-10-21T10:00:00Z',
            body: 'fix this',
          },
          {
            author: { login: 'reviewer' },
            state: 'COMMENTED',
            submittedAt: '2026-10-21T11:00:00Z',
            body: 'one more thing',
          },
        ],
      },
    }),
    [],
    { now: NOW },
  );
  assert.equal(report.reviews[0].state, 'COMMENTED');
  assert.equal(report.reviews[0].decision, 'CHANGES_REQUESTED');
  assert.equal(report.actionable, 1);
});

test('the quiet window restarts at the latest check start or completion, not the commit date', () => {
  // Committed long ago, but a check (e.g. Seer) completed 2 minutes ago.
  const report = summarize(
    pr(),
    [
      {
        name: 'Seer Code Review',
        bucket: 'pass',
        startedAt: '2026-10-21T11:55:00Z',
        completedAt: '2026-10-21T11:58:00Z',
      },
    ],
    { now: NOW, quietMinutes: 10 },
  );
  assert.equal(report.settled, false);
  assert.equal(report.lastActivityAt, '2026-10-21T11:58:00.000Z');
});

test('a CodeScene COMMENTED review with failed gates is actionable', () => {
  const report = summarize(
    pr({
      reviews: {
        nodes: [
          {
            author: { login: 'codescene-delta-analysis' },
            state: 'COMMENTED',
            submittedAt: '2026-10-21T11:00:00Z',
            body: '[//]: # (cs-code-health)\n**Gates Failed**',
          },
        ],
      },
    }),
    [],
    { now: NOW },
  );
  assert.equal(report.reviews[0].actionable, true);
  assert.equal(report.actionable, 1);
});

test('checks are bucketed, and failures count as actionable', () => {
  const checks = summarizeChecks([
    { name: 'Frontend CI Gate', bucket: 'pass' },
    { name: 'Workers CI Gate', bucket: 'fail' },
    { name: 'CodeQL', bucket: 'pending' },
    { name: 'Deploy', bucket: 'skipping' },
    { name: 'Old', bucket: 'cancel' },
  ]);
  assert.deepEqual(checks, {
    pass: 1,
    fail: ['Workers CI Gate', 'Old'],
    pending: ['CodeQL'],
    pendingActions: [],
    skipped: 1,
  });
});

const CI = ['Workers Test', 'Frontend Test & Coverage'];

const ROWS = [
  { name: 'Workers Tests', bucket: 'pending', workflow: 'Workers Test' },
  { name: 'CodeScene Code Health Review (main)', bucket: 'pending', workflow: '' },
  { name: 'Seer Code Review', bucket: 'pending' },
  { name: 'Lint (changed files)', bucket: 'pass', workflow: 'Frontend Test & Coverage' },
  { name: 'Route the event', bucket: 'pending', workflow: 'Factory' },
  { name: 'No-go guard', bucket: 'pending', workflow: 'No-go guard' },
];

test('pendingActions lists only pending checks of the configured CI workflows', () => {
  const checks = summarizeChecks(ROWS, CI);
  assert.deepEqual(checks.pendingActions, ['Workers Tests'], "the factory's own runs never count");
  assert.equal(checks.pending.length, 5);
});

test('with no ci_workflows configured a pass waits for no CI check', () => {
  assert.deepEqual(summarizeChecks(ROWS).pendingActions, []);
  assert.deepEqual(summarizeChecks(ROWS, []).pendingActions, []);
});

test('a check of a workflow that is not configured is not waited for', () => {
  const checks = summarizeChecks(ROWS, ['Frontend Test & Coverage']);
  assert.deepEqual(checks.pendingActions, []);
});

test('the no-checks-yet placeholder is always waited for', () => {
  const checks = summarizeChecks([
    { name: '(no checks reported yet)', bucket: 'pending', workflow: '(no checks reported yet)' },
  ]);
  assert.deepEqual(checks.pendingActions, ['(no checks reported yet)']);
  assert.equal(checks.pending.length, 1);
});

test('settled needs finished checks AND a quiet window since the last commit or feedback', () => {
  const quiet = summarize(pr(), [{ name: 'a', bucket: 'pass' }], { now: NOW, quietMinutes: 10 });
  assert.equal(quiet.settled, true);

  const pending = summarize(pr(), [{ name: 'a', bucket: 'pending' }], {
    now: NOW,
    quietMinutes: 10,
  });
  assert.equal(pending.settled, false);

  // A Seer comment 3 minutes ago restarts the window even though checks are done.
  const fresh = summarize(
    pr({ reviewThreads: { nodes: [thread('T1', { at: '2026-10-21T11:57:00Z' })] } }),
    [{ name: 'a', bucket: 'pass' }],
    { now: NOW, quietMinutes: 10 },
  );
  assert.equal(fresh.settled, false);
  assert.equal(fresh.lastActivityAt, '2026-10-21T11:57:00.000Z');
});

test('waitingOn names every blocker and quietUntil says when the window ends', () => {
  const quiet = summarize(pr(), [{ name: 'a', bucket: 'pass' }], { now: NOW, quietMinutes: 10 });
  assert.deepEqual(quiet.waitingOn, []);

  const busy = summarize(
    pr({
      reviewThreads: {
        totalCount: 101,
        nodes: [thread('T1', { resolved: true, at: '2026-10-21T11:57:00Z' })],
      },
    }),
    [{ name: 'a', bucket: 'pending' }],
    { now: NOW, quietMinutes: 10 },
  );
  assert.deepEqual(busy.waitingOn, ['checks', 'quiet window', 'truncated threads']);
  assert.equal(busy.quietUntil, '2026-10-21T12:07:00.000Z');
  assert.equal(busy.settled, false);
});

test('long bodies are clipped', () => {
  const big = thread('T1');
  big.comments.nodes[0].body = 'x'.repeat(5000);
  const report = summarize(pr({ reviewThreads: { nodes: [big] } }), [], { now: NOW });
  assert.ok(report.unresolvedThreads[0].body.length < 4100);
  assert.match(report.unresolvedThreads[0].body, /\[truncated\]$/);
});

test('fetchReport reads checks JSON from a non-zero gh exit (pending or failed checks)', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'repo') return 'o/r\n';
    if (args[0] === 'api') return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
    const err = new Error('exit 8');
    err.stdout = JSON.stringify([{ name: 'CodeQL', bucket: 'pending' }]);
    throw err;
  };
  const report = fetchReport(667, { gh, now: NOW });
  assert.deepEqual(report.checks.pending, ['CodeQL']);
  assert.ok(
    calls[1].includes('owner=o') && calls[1].includes('repo=r') && calls[1].includes('number=667'),
  );
});

test('fetchReport treats "no checks reported" right after a push as pending, and rethrows other errors', () => {
  const ghWith = (stderr) => (args) => {
    if (args[0] === 'repo') return 'o/r\n';
    if (args[0] === 'api') return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
    const err = new Error('exit 1');
    err.stdout = '';
    err.stderr = stderr;
    throw err;
  };
  const report = fetchReport(667, {
    gh: ghWith("no checks reported on the 'feature/x' branch"),
    now: NOW,
  });
  assert.equal(report.settled, false);
  assert.deepEqual(report.checks.pending, ['(no checks reported yet)']);

  assert.throws(
    () => fetchReport(667, { gh: ghWith('HTTP 401: Bad credentials'), now: NOW }),
    /exit 1/,
  );
});

test('more threads than the query reads blocks settled', () => {
  const report = summarize(
    pr({ reviewThreads: { totalCount: 150, nodes: [thread('T1', { resolved: true })] } }),
    [{ name: 'a', bucket: 'pass' }],
    { now: NOW },
  );
  assert.equal(report.threadsTruncated, true);
  assert.equal(report.settled, false);
});

test('main routes reply and resolve to GraphQL mutations, and rejects bad usage', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    return '{}';
  };
  assert.equal(main(['reply', 'PRRT_1', 'Not', 'a', 'bug'], { gh }), 0);
  assert.match(calls[0], /addPullRequestReviewThreadReply/);
  assert.match(calls[0], /id=PRRT_1/);
  assert.match(calls[0], /body=Not a bug/);
  assert.equal(main(['resolve', 'PRRT_1'], { gh }), 0);
  assert.match(calls[1], /resolveReviewThread/);

  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(main(['bogus'], { gh }), 2);
    // An invalid or missing --quiet-minutes value is a usage error, not a NaN crash.
    assert.equal(main(['675', '--quiet-minutes', 'ten'], { gh }), 2);
    assert.equal(main(['675', '--quiet-minutes'], { gh }), 2);
    assert.equal(main(['675', '--quiet-minutes', '-1'], { gh }), 2);
    assert.equal(main(['675', '--quiet-minutes', ''], { gh }), 2);
    assert.equal(main(['675', '--quiet-minutes', ' '], { gh }), 2);
  } finally {
    process.stderr.write = origWrite;
  }
});

const ciRoot = () =>
  tempRoot(
    {},
    { extraConfig: ['ci_workflows:', '  - Workers Test', '  - Frontend Test & Coverage'] },
  );

function summaryOutput(checkRows, args = [], root = ciRoot()) {
  const gh = (a) => {
    if (a[0] === 'repo') return 'o/r\n';
    if (a[0] === 'api') return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
    return JSON.stringify(checkRows);
  };
  let written = '';
  const out = { write: (s) => (written += s) };
  assert.equal(main(['667', '--summary', ...args], { gh, out, root }), 0);
  return written;
}

test('the report reads ci_workflows from factory.config.yml', () => {
  const gh = (a) => {
    if (a[0] === 'repo') return 'o/r\n';
    if (a[0] === 'api') return JSON.stringify({ data: { repository: { pullRequest: pr() } } });
    return JSON.stringify([{ name: 'Workers Tests', bucket: 'pending', workflow: 'Workers Test' }]);
  };
  let written = '';
  const out = { write: (s) => (written += s) };
  assert.equal(main(['667'], { gh, out, root: ciRoot() }), 0);
  assert.deepEqual(JSON.parse(written).checks.pendingActions, ['Workers Tests']);
  written = '';
  assert.equal(main(['667'], { gh, out, root: tempRoot() }), 0);
  assert.deepEqual(JSON.parse(written).checks.pendingActions, []);
});

test('a missing or invalid config exits 2 for a report, but reply and resolve need none', () => {
  const origWrite = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => ((err += s), true);
  try {
    const gh = () => 'unused';
    assert.equal(main(['667'], { gh, root: tempRoot({}, { config: null }) }), 2);
    assert.match(err, /^pr-feedback: cannot read factory\.config\.yml/);
    assert.equal(
      main(['667'], { gh, root: tempRoot({}, { extraConfig: ['spend_cap_usd: 0'] }) }),
      2,
    );
    assert.equal(main(['reply', 'T1', 'ok'], { gh, root: tempRoot({}, { config: null }) }), 0);
    assert.equal(main(['resolve', 'T1'], { gh, root: tempRoot({}, { config: null }) }), 0);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('--summary prints one line for a settled PR', () => {
  const line = summaryOutput([{ name: 'a', bucket: 'pass' }]);
  assert.equal(line, '#667 settled=true waitingOn=- actionable=0 checks=1 pass/0 fail/0 pending\n');
});

test('--summary names the checks a PR is waiting on and counts failures as actionable', () => {
  const line = summaryOutput([
    { name: 'a', bucket: 'pass' },
    { name: 'b', bucket: 'fail' },
    { name: 'c', bucket: 'pending' },
  ]);
  assert.equal(
    line,
    '#667 settled=false waitingOn=checks actionable=1 checks=1 pass/1 fail/1 pending\n',
  );
});

test('--summary combined with --quiet-minutes reports the quiet window', () => {
  const rows = [{ name: 'a', bucket: 'pass' }];
  assert.equal(
    summaryOutput(rows, ['--quiet-minutes', '1000000']),
    '#667 settled=false waitingOn=quiet window actionable=0 checks=1 pass/0 fail/0 pending\n',
  );
  assert.match(
    summaryOutput([{ name: 'c', bucket: 'pending' }], ['--quiet-minutes', '1000000']),
    /waitingOn=checks,quiet window /,
  );
});
