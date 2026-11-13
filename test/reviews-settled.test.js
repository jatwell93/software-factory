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
    description: 'Quiet window over; all 2 review bot(s) have posted',
  });
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
const run = (argv, { cfg = configWith(), gh, rep = report() }) => {
  const lines = [];
  const status = main(argv, {
    config: cfg,
    gh,
    feedback: () => rep,
    now: at(5),
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
  assert.deepEqual(lines, ['#9: success (Quiet window over; all 1 review bot(s) have posted)']);
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
