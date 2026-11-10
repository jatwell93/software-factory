const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');
const { createDeps, readyComment } = require('../lib/router-deps.js');
const { createRouter } = require('../lib/router.js');
const { main } = require('../scripts/factory-route.js');
const { createStubAdapter } = require('./stub-adapter.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const CHANGE = 'fix-one';

/** A gh double: records every call and answers from `replies`, keyed by the first args. */
function fakeGh(replies = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const key = Object.keys(replies).find((k) => args.join(' ').startsWith(k));
    return key ? replies[key] : '[]';
  };
  return { gh, calls };
}

const deps = (io = {}, cfg = config) =>
  createDeps(cfg, { adapter: createStubAdapter(), gh: fakeGh().gh, ...io });

test('the tracking-issue lookups use the configured change prefix and state labels', () => {
  const { gh, calls } = fakeGh({ 'issue list': '[{"number":703}]' });
  const d = deps({ gh });
  assert.equal(d.parkedIssue(CHANGE), 703);
  assert.deepEqual(calls[0], [
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    'factory:fix-one',
    '--label',
    'needs-human',
    '--json',
    'number',
  ]);
  assert.equal(d.retryIssue(CHANGE), 703);
  assert.ok(calls[1].includes('factory-retry'));

  const custom = loadConfig(
    tempRoot({}, { extraConfig: ['labels:', '  change_prefix: "bot-"', '  needs_human: stuck'] }),
  );
  const other = fakeGh({ 'issue list': '[]' });
  assert.equal(deps({ gh: other.gh }, custom).parkedIssue(CHANGE), 0);
  assert.deepEqual(other.calls[0].slice(5, 8), ['bot-fix-one', '--label', 'stuck']);
});

test('retry candidates carry when the retry label was last added', () => {
  const events = [
    [
      { event: 'labeled', label: { name: 'factory-retry' }, created_at: '2026-10-26T09:00:00Z' },
      { event: 'labeled', label: { name: 'bug' }, created_at: '2026-10-26T09:30:00Z' },
      { event: 'labeled', label: { name: 'factory-retry' }, created_at: '2026-10-26T10:00:00Z' },
    ],
  ];
  const { gh, calls } = fakeGh({
    'issue list': '[{"number":714,"labels":[]}]',
    api: JSON.stringify(events),
  });
  const [candidate] = deps({ gh }).retryCandidates();
  assert.equal(candidate.number, 714);
  assert.equal(candidate.labelledAt, '2026-10-26T10:00:00Z');
  assert.ok(calls[1].some((a) => a.endsWith('/issues/714/events')));
});

test('the retry time follows a renamed retry label', () => {
  const renamed = loadConfig(tempRoot({}, { extraConfig: ['labels:', '  retry: again'] }));
  const events = [
    [
      { event: 'labeled', label: { name: 'factory-retry' }, created_at: '2026-10-26T09:00:00Z' },
      { event: 'labeled', label: { name: 'again' }, created_at: '2026-10-26T10:00:00Z' },
    ],
  ];
  const { gh } = fakeGh({
    'issue list': '[{"number":714,"labels":[]}]',
    api: JSON.stringify(events),
  });
  const [candidate] = deps({ gh }, renamed).retryCandidates();
  assert.equal(candidate.labelledAt, '2026-10-26T10:00:00Z');
});

test('retry labels are swapped and dropped by their configured names', () => {
  const { gh, calls } = fakeGh();
  const d = deps({ gh });
  d.startRetry(714);
  d.dropRetry(714);
  assert.deepEqual(calls[0], [
    'issue',
    'edit',
    '714',
    '--remove-label',
    'factory-retry',
    '--add-label',
    'factory-retrying',
  ]);
  assert.deepEqual(calls[1], ['issue', 'edit', '714', '--remove-label', 'factory-retry']);
});

test('openFactoryPr finds an open PR of the change that the app wrote', () => {
  const prs = [
    { number: 3, author: { login: 'jatwell93' } },
    { number: 4, author: { login: 'app/claude' } },
  ];
  const found = deps({ gh: fakeGh({ 'pr list': JSON.stringify(prs) }).gh });
  assert.equal(found.openFactoryPr(CHANGE), 4);
  const { gh, calls } = fakeGh({ 'pr list': JSON.stringify(prs.slice(0, 1)) });
  assert.equal(deps({ gh }).openFactoryPr(CHANGE), 0, 'an owner PR with the label does not count');
  assert.ok(calls[0].includes('factory:fix-one'));
});

test('the change is active only while it is listed and has a task', () => {
  const d = deps();
  assert.equal(d.changeExists(CHANGE), true);
  assert.equal(d.changeExists('gone'), false);
  const empty = createStubAdapter();
  empty.scaffold('plan-only');
  assert.equal(deps({ adapter: empty }).changeExists('plan-only'), false, 'no task yet');
  assert.deepEqual(d.nextTask(CHANGE), { number: '1.1', text: 'Task 1.1', owner: false });
});

test('perChange reads the autonomy, and is false for a change that is not on the branch', () => {
  const d = deps();
  assert.equal(d.perChange(CHANGE), true);
  assert.equal(d.perChange('gone'), false, 'a missing change is per-task, not an error');
  const scaffolded = createStubAdapter();
  scaffolded.scaffold('other');
  assert.equal(deps({ adapter: scaffolded }).perChange('other'), false);
});

test('branch reads go through the adapter built for that ref', () => {
  const refs = [];
  const branch = createStubAdapter();
  branch.archive(CHANGE);
  const d = deps({
    branchAdapter: (ref) => {
      refs.push(ref);
      return branch;
    },
  });
  assert.equal(d.branchArchived(CHANGE, 'feature/factory-fix-one'), true);
  assert.deepEqual(refs, ['feature/factory-fix-one']);
  assert.throws(() => d.branchTask(CHANGE, 'feature/x'), /no active change/);
});

test('branchTask is the first open task of the branch', () => {
  const d = deps({ branchAdapter: () => createStubAdapter() });
  assert.equal(d.branchTask(CHANGE, 'feature/x').number, '1.1');
});

test('markReady readies a draft, retitles the PR after the change and tells the owner', () => {
  const branch = createStubAdapter();
  branch.archive(CHANGE);
  const { gh, calls } = fakeGh();
  const d = deps({ gh, branchAdapter: () => branch });
  d.markReady({ isDraft: true, title: 'WIP: feat(x): do a', headRefName: 'feature/f' }, 9, CHANGE);
  assert.deepEqual(calls[0], ['pr', 'ready', '9']);
  assert.deepEqual(calls[1], ['pr', 'edit', '9', '--title', 'feat(x): fix one (fix-one)']);
  assert.deepEqual(calls[2].slice(0, 4), ['pr', 'comment', '9', '--body']);
  assert.match(calls[2][4], /^@octo Every task of this change is done/);
});

test('markReady leaves a title that is already right and a PR that is not a draft', () => {
  const branch = createStubAdapter();
  branch.archive(CHANGE);
  const { gh, calls } = fakeGh();
  const d = deps({ gh, branchAdapter: () => branch });
  d.markReady(
    { isDraft: false, title: 'feat(x): fix one (fix-one)', headRefName: 'feature/f' },
    9,
    CHANGE,
  );
  assert.deepEqual(
    calls.map((c) => c[1]),
    ['comment'],
  );
});

test('readyComment mentions the configured owner', () => {
  assert.match(readyComment('someone'), /^@someone /);
});

test('loadAdapter names the adapters that exist when spec_source has none', () => {
  assert.equal(loadAdapter(config, { root: tempRoot() }).name, 'openspec');
  const unknown = { ...config, spec_source: 'paul' };
  assert.throws(() => loadAdapter(unknown), /"paul" has no adapter installed \(have: openspec\)/);
});

test('loadAdapter gives the adapter the config id limit', () => {
  const limited = { ...config, change_id_max_length: 5 };
  const adapter = loadAdapter(limited, { root: tempRoot() });
  assert.throws(() => adapter.scaffold('abcdef'), /limit is 5/);
});

test('the route job prints the output lines for the event it was given', () => {
  const root = tempRoot();
  const eventFile = path.join(root, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ inputs: { change_id: CHANGE } }));
  const lines = [];
  const status = main(
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventFile },
    { root, log: (s) => lines.push(s), deps: deps() },
  );
  assert.equal(status, 0);
  assert.match(lines[0], /^mode=task\nchange_id=fix-one\n/);
  const direct = createRouter(config).route(
    'workflow_dispatch',
    { inputs: { change_id: CHANGE } },
    deps(),
  );
  assert.equal(direct.per_change, true, 'the fixture is per-change');
});

test('the route job fails on a project without a valid config', () => {
  const root = tempRoot({}, { config: null });
  assert.throws(
    () => main({ GITHUB_EVENT_NAME: 'x', GITHUB_EVENT_PATH: 'y' }, { root }),
    /cannot read/,
  );
});

test('a proposal with a malformed no_go holds its change with a reason, not a crash', () => {
  const root = tempRoot({
    odd: '# Odd\n\n## Autonomy\n\n```yaml\nmerge: human\npr: per-change\nno_go: nonsense\n```\n',
  });
  fs.mkdirSync(path.join(root, 'openspec/changes/odd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'openspec/changes/odd/tasks.md'), '- [ ] 1.1 Do it\n');
  const eventFile = path.join(root, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ inputs: { change_id: 'odd' } }));
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventFile };
  const lines = [];
  const real = createDeps(config, { adapter: loadAdapter(config, { root }), gh: fakeGh().gh });
  assert.equal(main(env, { root, log: (s) => lines.push(s), deps: real }), 0);
  assert.match(lines[0], /^mode=none\n/);
  assert.match(lines[0], /unrecognised no_go value: no_go: nonsense; fix the change's proposal/);
});

test('any other routing failure stays an error', () => {
  const root = tempRoot();
  const eventFile = path.join(root, 'event.json');
  fs.writeFileSync(eventFile, JSON.stringify({ inputs: { change_id: CHANGE } }));
  const broken = {
    ...deps(),
    changeExists: () => {
      throw new Error('HTTP 502');
    },
  };
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventFile };
  assert.throws(() => main(env, { root, deps: broken }), /HTTP 502/);
});
