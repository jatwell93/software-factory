const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { deniedComment, deniedWithoutResult } = require('../lib/denied-run.js');
const { main } = require('../scripts/factory-denied.js');
const { createStubAdapter } = require('./stub-adapter.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const RUN = 'https://github.com/octo/app/actions/runs/111';
const HEAD = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

const run = (over = {}) => ({
  mode: 'task',
  denied: 2,
  pr: '',
  prs: [],
  headBefore: '',
  headAfter: '',
  ...over,
});

test('a first task that was denied and opened no PR made nothing', () => {
  assert.equal(deniedWithoutResult(run()), true);
  assert.equal(deniedWithoutResult(run({ prs: [7] })), false);
});

test('a later task on a PR made nothing when its head did not move', () => {
  const on = (over) => run({ pr: '7', headBefore: HEAD, headAfter: HEAD, ...over });
  assert.equal(deniedWithoutResult(on()), true);
  assert.equal(deniedWithoutResult(on({ headAfter: MOVED })), false);
  // No head noted before the run: it cannot be told, so it is never failed.
  assert.equal(deniedWithoutResult(on({ headBefore: '', headAfter: '' })), false);
});

test('no denials, an unknown count, or a babysit pass is never failed', () => {
  assert.equal(deniedWithoutResult(run({ denied: 0 })), false);
  assert.equal(deniedWithoutResult(run({ denied: null })), false);
  assert.equal(deniedWithoutResult(run({ mode: 'babysit' })), false);
  assert.equal(deniedWithoutResult(run({ mode: 'archive' })), true);
});

test('the comment lists what was refused, says how many more, and names the usual fix', () => {
  const body = deniedComment({
    id: 'add-x',
    mode: 'task',
    denied: 12,
    lines: ['denied: Bash pytest -q', 'denied: Read /tmp/x'],
    runUrl: RUN,
  });
  assert.match(body, /A task run of `add-x` was refused 12 tool call\(s\) and made nothing/);
  assert.match(body, /- `Bash pytest -q`/);
  assert.match(body, /- and 10 more/);
  assert.match(body, /Run: https:\/\/github\.com\/octo\/app\/actions\/runs\/111/);
  assert.match(body, /add it to `gates`/);
});

const log = (denials) =>
  JSON.stringify([{ type: 'result', permission_denials: denials, total_cost_usd: 1 }]);
const DENIALS = [{ tool_name: 'Bash', tool_input: { command: 'pytest -q' } }];

/** A fake gh: the change's open PRs, the head of PR 7, and one tracking issue (#714). */
function fakeGh({ prs = [], head = HEAD } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list')
      return JSON.stringify(prs.map((number) => ({ number })));
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head });
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 714 }]);
    return '';
  };
  return { gh, calls };
}

function exec(argv, { text = log(DENIALS), ...ghOptions } = {}) {
  const { gh, calls } = fakeGh(ghOptions);
  const out = [];
  const code = main(argv, {
    config,
    adapter: createStubAdapter(),
    gh,
    read: () => text,
    log: (l) => out.push(l),
    error: (l) => out.push(l),
  });
  return { code, calls, out };
}
const ARGS = (extra = []) => ['task', 'add-x', ...extra, '--execution', 'x.json', '--run-url', RUN];
const comments = (calls) => calls.filter((c) => c[0] === 'issue' && c[1] === 'comment');

test('a denied first task with no PR fails the run and comments the refused command', () => {
  const { code, calls, out } = exec(ARGS());
  assert.equal(code, 1);
  const [comment] = comments(calls);
  assert.equal(comment[2], '714');
  assert.match(comment[4], /`Bash pytest -q`/);
  assert.ok(out.some((l) => /^::error::run was refused 1 tool call\(s\)/.test(l)));
  const list = calls.find((c) => c[1] === 'list' && c[0] === 'pr');
  assert.ok(list.includes('factory:add-x'));
});

test('a first task that did open its PR passes, whatever it was denied', () => {
  const { code, calls } = exec(ARGS(), { prs: [9] });
  assert.equal(code, 0);
  assert.deepEqual(comments(calls), []);
});

test('a later task on PR 7 fails when its head did not move, and passes when it did', () => {
  const stuck = exec(ARGS(['7', '--head-before', HEAD]), { head: HEAD });
  assert.equal(stuck.code, 1);
  assert.equal(comments(stuck.calls).length, 1);
  const moved = exec(ARGS(['7', '--head-before', HEAD]), { head: MOVED });
  assert.equal(moved.code, 0);
  assert.deepEqual(comments(moved.calls), []);
});

test('no denied call, no log, or no count leaves the run alone and asks GitHub nothing', () => {
  for (const text of [log([]), '', JSON.stringify([{ type: 'result' }])]) {
    const { code, calls } = exec(ARGS(), { text });
    assert.equal(code, 0);
    assert.deepEqual(calls, []);
  }
  const code = main(ARGS(), {
    config,
    adapter: createStubAdapter(),
    gh: () => '',
    read: () => {
      throw new Error('ENOENT');
    },
    log: () => {},
  });
  assert.equal(code, 0);
});

test('a babysit pass is never failed, however much it was denied', () => {
  const { code, calls } = exec(['babysit', 'add-x', '7', '--execution', 'x', '--run-url', RUN]);
  assert.equal(code, 0);
  assert.deepEqual(comments(calls), []);
});

test('bad arguments are a usage error and call nothing', () => {
  for (const argv of [
    ['task', 'Bad Id', '--execution', 'x', '--run-url', RUN],
    ['task', 'add-x', '0', '--execution', 'x', '--run-url', RUN],
    ['task', 'add-x', '--execution', 'x', '--run-url', 'http://evil'],
    ['task', 'add-x', '7', '--execution', 'x', '--run-url', RUN, '--head-before', 'nope'],
  ]) {
    const { code, calls } = exec(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.deepEqual(calls, []);
  }
});
