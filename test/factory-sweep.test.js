const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { firstOpenTask } = require('../lib/router.js');
const { parseTasks } = require('../adapters/openspec.js');
const { sweep, sweepDeps, main } = require('../scripts/factory-sweep.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const nextTask = (md) => firstOpenTask(parseTasks(md));
const LABEL = { name: 'factory:add-x' };
const SETTLED = { settled: true, waitingOn: [], unresolvedThreads: [], reviews: [] };

/** Fake deps for one open per-change PR #9; records dispatches and ready marks. */
function deps({
  pr = {},
  report = {},
  parked = 0,
  retry = 0,
  retrying = 0,
  perChange = true,
  tasks = '- [x] 1.1 Do it\n- [ ] 1.2 Next\n',
  archived = false,
} = {}) {
  const calls = { dispatch: [], markReady: [] };
  const view = {
    state: 'OPEN',
    labels: [LABEL],
    author: { login: 'app/claude' },
    headRefName: 'feature/factory-add-x',
    title: 'WIP: feat(x): add x',
    ...pr,
  };
  return {
    calls,
    openAppPrs: () => [{ number: 9, labels: view.labels }],
    perChange: () => perChange,
    parkedIssue: () => parked,
    retryIssue: () => retry,
    retryingIssue: () => retrying,
    prView: () => view,
    feedback: () => ({
      ...SETTLED,
      headCommittedAt: '2026-10-27T01:00:00Z',
      ...report,
      checks: { pendingActions: [], fail: [], ...report.checks },
    }),
    branchTask: () => nextTask(tasks),
    branchArchived: () => archived,
    markReady: (p, n) => calls.markReady.push(n),
    dispatch: (n) => calls.dispatch.push(n),
  };
}

const quiet = () => {};
const run = (d) => sweep(config, d, quiet);

test('a settled per-change PR with a task left is dispatched', () => {
  const d = deps();
  assert.equal(run(d), 1);
  assert.deepEqual(d.calls.dispatch, [9]);
});

test('an actionable per-change PR is dispatched for a babysit pass', () => {
  const thread = { author: 'sentry', replies: [] };
  const d = deps({ report: { unresolvedThreads: [thread] } });
  run(d);
  assert.deepEqual(d.calls.dispatch, [9]);
});

test('a waiting PR is not dispatched', () => {
  for (const report of [
    { settled: false, waitingOn: ['quiet window'] },
    { checks: { pendingActions: ['Workers Test'] } },
  ]) {
    const d = deps({ report });
    assert.equal(run(d), 0);
    assert.deepEqual(d.calls.dispatch, []);
  }
});

test('a parked PR, or one whose change waits on a retry, is not dispatched', () => {
  for (const opts of [
    { parked: 703 },
    { pr: { labels: [LABEL, { name: 'needs-human' }] } },
    { retry: 714 },
    { retrying: 714 },
  ]) {
    assert.equal(run(deps(opts)), 0, JSON.stringify(opts));
  }
});

test('a PR with no task left is dispatched for its archive run', () => {
  const d = deps({ tasks: '- [x] 1.1 Do it\n' });
  assert.equal(run(d), 1);
  assert.deepEqual(d.calls.dispatch, [9]);
  assert.deepEqual(d.calls.markReady, []);
});

test('an archived PR is marked ready by the sweep itself, not dispatched', () => {
  const d = deps({ archived: true });
  d.branchTask = () => {
    throw new Error('HTTP 404: Not Found');
  };
  assert.equal(run(d), 0);
  assert.deepEqual(d.calls.markReady, [9]);
});

test('a per-task factory PR is left to its events, even with work on it', () => {
  const thread = { author: 'sentry', replies: [] };
  const d = deps({ perChange: false, report: { unresolvedThreads: [thread] } });
  assert.equal(run(d), 0);
  assert.deepEqual(d.calls.dispatch, []);
});

test('an owner task on a per-change PR is dispatched, so the escalate job runs', () => {
  const d = deps({ tasks: '- [x] 1.1 Do it\n- [ ] 1.2 (owner) Rotate the key\n' });
  assert.equal(run(d), 1);
  assert.deepEqual(d.calls.dispatch, [9]);
});

test('a PR with no change label is left alone', () => {
  const d = deps({ pr: { labels: [] } });
  assert.equal(run(d), 0);
});

test('the real deps list the app PRs, find a retrying issue and dispatch the factory workflow', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'list' && args[0] === 'pr') return '[{"number":4,"labels":[]}]';
    return '[{"number":714}]';
  };
  const real = sweepDeps(config, gh);
  assert.deepEqual(real.openAppPrs(), [{ number: 4, labels: [] }]);
  assert.ok(calls[0].includes('app/claude'));
  assert.equal(real.retryingIssue('add-x'), 714);
  assert.ok(calls[1].includes('factory:add-x') && calls[1].includes('factory-retrying'));
  real.dispatch(4);
  assert.deepEqual(calls[2], ['workflow', 'run', 'factory.yml', '-f', 'pr=4']);
});

test('main sweeps and reports the count', () => {
  const lines = [];
  assert.equal(main({ config, deps: deps(), log: (l) => lines.push(l) }), 0);
  assert.equal(lines.at(-1), 'dispatched 1 run(s)');
});
