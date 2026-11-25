const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const {
  CONTEXT,
  MAX_DESCRIPTION,
  missingBots,
  normalise,
  settledStatus,
} = require('../lib/reviews-settled.js');
const { main } = require('../scripts/factory-reviews-settled.js');
const { tempRoot } = require('./helpers.js');

const PUSHED = '2026-10-21T10:00:00Z';
const at = (minutes) => Date.parse(PUSHED) + minutes * 60000;
const report = (overrides = {}) => ({
  state: 'OPEN',
  head: 'sha1',
  lastPushAt: PUSHED,
  waitingOn: [],
  posters: [],
  ...overrides,
});
const BOTS = ['copilot-pull-request-reviewer', 'sentry'];
const options = (now, bots = BOTS) => ({ bots, timeoutMinutes: 30, now });

test('the status is pending while a configured bot has not posted, naming it', () => {
  const s = settledStatus(report({ posters: ['sentry'] }), options(at(5)));
  assert.deepEqual(s, {
    state: 'pending',
    description: 'Waiting on: copilot-pull-request-reviewer',
  });
});

test('the status is pending through the quiet window and unfinished checks', () => {
  const s = settledStatus(
    report({ waitingOn: ['checks', 'quiet window'], posters: [...BOTS] }),
    options(at(5)),
  );
  assert.deepEqual(s, { state: 'pending', description: 'Waiting on: checks, quiet window' });
});

test('the status is success once the quiet window is over and every bot has posted', () => {
  const s = settledStatus(
    report({ posters: ['copilot-pull-request-reviewer', 'sentry', 'jatwell93'] }),
    options(at(5)),
  );
  assert.deepEqual(s, {
    state: 'success',
    description: 'Quiet window over; all 2 review bot(s) have reported',
  });
});

test('a bot whose mapped check has finished counts as reported without posting', () => {
  const botChecks = { sentry: 'Seer Code Review' };
  const rep = report({
    posters: ['copilot-pull-request-reviewer'],
    finishedChecks: ['Seer Code Review'],
  });
  const s = settledStatus(rep, { ...options(at(5)), botChecks });
  assert.equal(s.state, 'success');
  assert.match(s.description, /all 2 review bot\(s\) have reported/);
});

test('a mapped check that is still running, or absent, does not count', () => {
  const botChecks = { sentry: 'Seer Code Review' };
  const base = { posters: ['copilot-pull-request-reviewer'] };
  for (const finishedChecks of [[], ['Test']]) {
    const s = settledStatus(report({ ...base, finishedChecks }), { ...options(at(5)), botChecks });
    assert.deepEqual(s, { state: 'pending', description: 'Waiting on: sentry' });
  }
});

test('a finished check counts only for the bot it is mapped to', () => {
  const rep = report({ posters: [], finishedChecks: ['Seer Code Review'] });
  assert.deepEqual(missingBots(rep, BOTS, { sentry: 'Seer Code Review' }), [
    'copilot-pull-request-reviewer',
  ]);
  assert.deepEqual(missingBots(rep, BOTS, {}), BOTS);
  assert.deepEqual(missingBots(rep, ['constructor'], {}), ['constructor']);
});

test('the script reads review_bot_checks from the config', () => {
  const cfg = configWith('review_bots: [sentry]', 'review_bot_checks: {sentry: Seer Code Review}');
  assert.deepEqual(cfg.review_bot_checks, { sentry: 'Seer Code Review' });
  assert.deepEqual(configWith('review_bots: [sentry]').review_bot_checks, {});
});

test('with no review bots configured, the quiet window alone settles it', () => {
  const s = settledStatus(report(), options(at(5), []));
  assert.equal(s.state, 'success');
  assert.match(s.description, /no review bots set/);
});

test('the timeout turns it to success and names the bot that never posted', () => {
  const before = settledStatus(report({ posters: ['sentry'] }), options(at(29)));
  assert.equal(before.state, 'pending');
  const s = settledStatus(report({ posters: ['sentry'] }), options(at(30)));
  assert.deepEqual(s, {
    state: 'success',
    description: 'Timed out after 30m: no review from copilot-pull-request-reviewer',
  });
});

test('the timeout counts from the last push, and also ends a wait with no bot missing', () => {
  const s = settledStatus(report({ waitingOn: ['checks'], posters: [...BOTS] }), options(at(31)));
  assert.deepEqual(s, { state: 'success', description: 'Timed out after 30m: still checks' });
  const later = settledStatus(
    report({ lastPushAt: '2026-10-21T10:25:00Z', posters: ['sentry'] }),
    options(at(31)),
  );
  assert.equal(later.state, 'pending', 'a newer push restarts the clock');
});

test('a PR that is not open needs no status, and an unknown push time never times out', () => {
  assert.equal(settledStatus(report({ state: 'MERGED' }), options(at(5))), null);
  const s = settledStatus(report({ lastPushAt: null, posters: [] }), options(at(9999)));
  assert.equal(s.state, 'pending');
});

test('a bot is matched without case or the [bot] suffix', () => {
  assert.equal(normalise('Sentry[bot]'), 'sentry');
  assert.deepEqual(missingBots(report({ posters: ['SENTRY[bot]'] }), BOTS), [
    'copilot-pull-request-reviewer',
  ]);
});

test('a description is never longer than GitHub shows', () => {
  const bots = Array.from({ length: 30 }, (_, i) => `a-very-long-bot-name-${i}`);
  const s = settledStatus(report(), options(at(5), bots));
  assert.ok(s.description.length <= MAX_DESCRIPTION);
  assert.match(s.description, /…$/);
});

// The script

const configWith = (...extra) => loadConfig(tempRoot({}, { extraConfig: extra }));
const APP = { login: 'app/claude' };
const LABELS = [{ name: 'factory:add-x' }];

function fakeGh({ prs = [], statuses = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify(prs.find((p) => String(p.number) === args[2]));
    }
    if (args[0] === 'api' && args[1].includes('/commits/')) return JSON.stringify(statuses);
    return '';
  };
  return { gh, calls };
}
const posts = (calls) => calls.filter((c) => c[0] === 'api' && c.includes('-f'));
const run = (argv, { cfg = configWith(), gh, rep = report(), now = at(5) }) => {
  const lines = [];
  const status = main(argv, {
    config: cfg,
    gh,
    feedback: () => rep,
    now,
    log: (l) => lines.push(l),
    error: () => {},
  });
  return { status, lines };
};
const factoryPr = (number = 9) => ({ number, state: 'OPEN', labels: LABELS, author: APP });

test('the status context is the fixed name a project requires in its ruleset', () => {
  assert.equal(CONTEXT, 'factory/reviews-settled');
});

test('the script reposts when only the state changed, even with the same description', () => {
  const cfg = configWith();
  // No bots, quiet window over: success "Quiet window over; no review bots set".
  const sameText = [
    { context: CONTEXT, state: 'pending', description: 'Quiet window over; no review bots set' },
  ];
  const { gh, calls } = fakeGh({ prs: [factoryPr()], statuses: sameText });
  run([], { cfg, gh });
  assert.equal(posts(calls).length, 1);
});

test('the script posts the status on the head of each open factory PR only', () => {
  const owner = { number: 3, state: 'OPEN', labels: LABELS, author: { login: 'jatwell93' } };
  const unlabelled = { number: 4, state: 'OPEN', labels: [], author: APP };
  const { gh, calls } = fakeGh({ prs: [factoryPr(), owner, unlabelled] });
  const cfg = configWith('review_bots:', '  - sentry');
  const { lines } = run([], { cfg, gh, rep: report({ posters: ['sentry'] }) });
  const [post] = posts(calls);
  assert.equal(post[1], 'repos/{owner}/{repo}/statuses/sha1');
  assert.ok(post.includes(`context=${CONTEXT}`) && post.includes('state=success'));
  assert.equal(posts(calls).length, 1);
  assert.deepEqual(lines, [
    '#9: success (Quiet window over; all 1 review bot(s) have reported)',
    '#9: asked the factory for a pass',
  ]);
});

// The dispatch: the CI relay does not fire for a run the owner approved, so a PR whose
// reviews just settled asks the factory itself.

const dispatches = (calls) => calls.filter((c) => c[0] === 'workflow');

// Recovery: GitHub sometimes starts no pull_request_target run for a push, and the PR
// then waits on a required status nothing will post.

const GUARD = { context: 'factory/no-go-guard', state: 'success', description: 'ok' };
const IDS = { context: 'factory/change-ids', state: 'success', description: 'ok' };
const recovered = (calls) => dispatches(calls).filter((c) => c[2] !== 'factory.yml');

test('a head with neither required status gets both callers dispatched with the PR number', () => {
  const { gh, calls } = fakeGh({ prs: [factoryPr(9)] });
  const { lines } = run([], { gh, now: at(10) });
  assert.deepEqual(recovered(calls), [
    ['workflow', 'run', 'no-go-guard.yml', '--ref', 'main', '-f', 'pr=9'],
    ['workflow', 'run', 'check-change-ids.yml', '--ref', 'main', '-f', 'pr=9'],
  ]);
  assert.ok(
    lines.includes('#9: no factory/no-go-guard status on the head; dispatched no-go-guard.yml'),
  );
});

test('only the missing status is dispatched', () => {
  const only = fakeGh({ prs: [factoryPr(9)], statuses: [GUARD] });
  run([], { gh: only.gh, now: at(10) });
  assert.deepEqual(
    recovered(only.calls).map((c) => c[2]),
    ['check-change-ids.yml'],
  );
  const both = fakeGh({ prs: [factoryPr(9)], statuses: [GUARD, IDS] });
  run([], { gh: both.gh, now: at(10) });
  assert.deepEqual(recovered(both.calls), []);
});

test('a head pushed less than ten minutes ago is left to the events that normally post', () => {
  const young = fakeGh({ prs: [factoryPr(9)] });
  run([], { gh: young.gh, now: at(9.99) });
  assert.deepEqual(recovered(young.calls), []);
  const old = fakeGh({ prs: [factoryPr(9)] });
  run([], { gh: old.gh, now: at(10) });
  assert.equal(recovered(old.calls).length, 2);
});

test('recovery runs even when the reviews-settled status is unchanged, and uses the default branch', () => {
  const same = [
    { context: CONTEXT, state: 'success', description: 'Quiet window over; no review bots set' },
  ];
  const { gh, calls } = fakeGh({ prs: [factoryPr(9)], statuses: same });
  run([], { cfg: configWith('default_branch: trunk'), gh, now: at(30) });
  assert.equal(posts(calls).length, 0);
  assert.equal(recovered(calls).length, 2);
  assert.ok(recovered(calls).every((c) => c.includes('trunk')));
});

test('a closed PR and a non-factory PR are not recovered', () => {
  const closed = fakeGh({ prs: [factoryPr(9)] });
  run([], { gh: closed.gh, rep: report({ state: 'CLOSED' }), now: at(30) });
  assert.deepEqual(recovered(closed.calls), []);
  const owner = { number: 3, state: 'OPEN', labels: LABELS, author: { login: 'jatwell93' } };
  const other = fakeGh({ prs: [owner] });
  run([], { gh: other.gh, now: at(30) });
  assert.deepEqual(dispatches(other.calls), []);
});

test('a failed recovery dispatch warns and the other one and the status still go ahead', () => {
  const inner = fakeGh({ prs: [factoryPr(9)] });
  const gh = (args) => {
    if (args[0] === 'workflow' && args[2] === 'no-go-guard.yml') {
      throw Object.assign(new Error('x'), { stderr: 'HTTP 422: no workflow_dispatch\nmore' });
    }
    return inner.gh(args);
  };
  const { status, lines } = run([], { gh, now: at(10) });
  assert.equal(status, 0);
  assert.ok(
    lines.includes(
      '::warning::#9: could not dispatch no-go-guard.yml: HTTP 422: no workflow_dispatch',
    ),
  );
  assert.deepEqual(
    recovered(inner.calls).map((c) => c[2]),
    ['check-change-ids.yml'],
  );
  assert.equal(posts(inner.calls).length, 1, 'the settled status is posted');
});

test('a PR that just settled asks the factory for a pass on the default branch', () => {
  const { gh, calls } = fakeGh({ prs: [factoryPr(9)] });
  run([], { cfg: configWith('default_branch: trunk'), gh });
  assert.deepEqual(dispatches(calls), [
    ['workflow', 'run', 'factory.yml', '--ref', 'trunk', '-f', 'pr=9'],
  ]);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf('workflow') > order.lastIndexOf('api'), 'after the status is posted');
});

test('a pending status or an unchanged success asks nobody', () => {
  const cfg = configWith('review_bots:', '  - sentry');
  const pending = fakeGh({ prs: [factoryPr()] });
  run([], { cfg, gh: pending.gh, rep: report({ posters: [] }) });
  assert.equal(dispatches(pending.calls).length, 0);
  const done = [
    { context: CONTEXT, state: 'success', description: 'Quiet window over; no review bots set' },
  ];
  const same = fakeGh({ prs: [factoryPr()], statuses: done });
  run([], { gh: same.gh });
  assert.equal(posts(same.calls).length, 0);
  assert.equal(dispatches(same.calls).length, 0, 'the 15-minute run does not ask again');
});

test('each PR that settles is asked once, and only a factory PR', () => {
  const owner = { number: 3, state: 'OPEN', labels: LABELS, author: { login: 'jatwell93' } };
  const { gh, calls } = fakeGh({ prs: [factoryPr(9), factoryPr(10), owner] });
  run([], { gh });
  assert.deepEqual(
    dispatches(calls).map((c) => c.at(-1)),
    ['pr=9', 'pr=10'],
  );
});

test('a failed dispatch warns and keeps going: the status is posted and the sweep covers it', () => {
  const inner = fakeGh({ prs: [factoryPr(9), factoryPr(10)] });
  const gh = (args) => {
    if (args[0] === 'workflow' && args.at(-1) === 'pr=9') {
      throw Object.assign(new Error('x'), { stderr: 'HTTP 403: Resource not accessible\nmore' });
    }
    return inner.gh(args);
  };
  const { status, lines } = run([], { gh });
  assert.equal(status, 0);
  assert.equal(posts(inner.calls).length, 2, 'both statuses posted');
  assert.ok(
    lines.includes(
      '::warning::#9: could not ask the factory for a pass: HTTP 403: Resource not accessible',
    ),
  );
  assert.ok(lines.includes('#10: asked the factory for a pass'));
});

test('the script reads the bots and the timeout from the config', () => {
  const { gh, calls } = fakeGh({ prs: [factoryPr()] });
  const cfg = configWith('reviews_timeout_minutes: 3', 'review_bots:', '  - copilot');
  run([], { cfg, gh });
  const post = posts(calls)[0];
  assert.ok(post.includes('state=success'));
  assert.ok(
    post.some((a) => a.startsWith('description=Timed out after 3m: no review from copilot')),
  );
});

test('the script posts nothing when the status is already what it would be', () => {
  const cfg = configWith('review_bots:', '  - sentry');
  const rep = report({ posters: [] });
  const same = [{ context: CONTEXT, state: 'pending', description: 'Waiting on: sentry' }];
  const { gh, calls } = fakeGh({ prs: [factoryPr()], statuses: same });
  const { lines } = run([], { cfg, gh, rep });
  assert.equal(posts(calls).length, 0);
  assert.deepEqual(lines, ['#9: pending (unchanged)']);
  const changed = [{ context: CONTEXT, state: 'pending', description: 'Waiting on: other' }];
  const again = fakeGh({ prs: [factoryPr()], statuses: changed });
  run([], { cfg, gh: again.gh, rep });
  assert.equal(posts(again.calls).length, 1);
});

test('a status of another context does not count as the current one', () => {
  const cfg = configWith('review_bots:', '  - sentry');
  const other = [{ context: 'other', state: 'pending', description: 'Waiting on: sentry' }];
  const { gh, calls } = fakeGh({ prs: [factoryPr()], statuses: other });
  run([], { cfg, gh });
  assert.equal(posts(calls).length, 1);
});

test('with a PR number only that PR is looked at; a bad argument is a usage error', () => {
  const { gh, calls } = fakeGh({ prs: [factoryPr(9), factoryPr(10)] });
  run(['10'], { gh, rep: report({ head: 'sha10' }) });
  assert.ok(calls.some((c) => c[0] === 'pr' && c[1] === 'view' && c[2] === '10'));
  assert.ok(!calls.some((c) => c[0] === 'pr' && c[1] === 'list'));
  assert.equal(posts(calls).length, 1);
  assert.ok(posts(calls)[0][1].endsWith('sha10'));
  for (const bad of ['0', 'x', '9; rm', '-1']) {
    const g = fakeGh();
    assert.equal(run([bad], { gh: g.gh }).status, 2, bad);
    assert.equal(g.calls.length, 0);
  }
});

test('a closed PR gets no status', () => {
  const { gh, calls } = fakeGh({ prs: [factoryPr()] });
  run([], { gh, rep: report({ state: 'CLOSED' }) });
  assert.equal(posts(calls).length, 0);
});

test('the change label comes from the config', () => {
  const cfg = configWith('labels:', '  change_prefix: "bot-"');
  const pr = { ...factoryPr(), labels: [{ name: 'factory:add-x' }] };
  const none = fakeGh({ prs: [pr] });
  run([], { cfg, gh: none.gh });
  assert.equal(posts(none.calls).length, 0);
  const some = fakeGh({ prs: [{ ...pr, labels: [{ name: 'bot-add-x' }] }] });
  run([], { cfg, gh: some.gh });
  assert.equal(posts(some.calls).length, 1);
});
