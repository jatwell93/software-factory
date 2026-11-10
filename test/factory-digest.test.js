const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { main } = require('../scripts/factory-digest.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const NOW = Date.parse('2026-10-24T21:00:00Z');
const FACTORY_PR = {
  number: 701,
  title: 'feat(workers): name users',
  url: 'u701',
  labels: [{ name: 'factory:add-x' }],
};
const OWNER_PR = { number: 9, title: 'chore: owner branch', url: 'u9', labels: [] };

/** A fake `gh` answering each list command, recording every call. */
function fakeDeps({
  issues = [],
  prsParked = [],
  prs = [],
  failed = [],
  digest = [],
  digestLabel = 'factory-digest',
  parkedLabel = 'needs-human',
} = {}) {
  const calls = [];
  const has = (args, flag, value) => args[args.indexOf(flag) + 1] === value;
  const gh = (args) => {
    calls.push(args);
    const [noun, verb] = args;
    if (verb === 'create') return 'https://github.com/o/r/issues/800\n';
    if (verb !== 'list') return '';
    if (noun === 'run') return JSON.stringify(failed);
    if (has(args, '--label', digestLabel)) return JSON.stringify(digest);
    if (has(args, '--label', parkedLabel))
      return JSON.stringify(noun === 'pr' ? prsParked : issues);
    return JSON.stringify(prs);
  };
  return { calls, gh, summary: (n) => `#${n} settled=true actionable=0` };
}

const run = (deps, argv = [], cfg = config) => {
  const out = [];
  main(argv, {
    config: cfg,
    gh: deps.gh,
    summary: deps.summary,
    log: (l) => out.push(l),
    now: NOW,
  });
  return out.join('\n');
};

const comments = (deps) => deps.calls.filter((a) => a[0] === 'issue' && a[1] === 'comment');

test('nothing open posts nothing', () => {
  const deps = fakeDeps();
  assert.match(run(deps), /no digest posted/);
  assert.equal(comments(deps).length, 0);
});

test('the digest lists parked items, factory PRs only, and failed runs, mentioning the owner', () => {
  const deps = fakeDeps({
    issues: [{ number: 703, title: 'factory: add-x', url: 'u703' }],
    prs: [FACTORY_PR, OWNER_PR],
    failed: [{ displayTitle: 'Factory', url: 'run-url' }],
  });
  const body = run(deps, ['--dry-run']);
  assert.match(body, /^Factory digest, 2026-10-24\. @octo/);
  assert.match(body, /Waiting on you \(needs-human\)/);
  assert.match(body, /- #703 factory: add-x/);
  assert.match(body, /- #701 feat\(workers\): name users: `#701 settled=true actionable=0`/);
  assert.doesNotMatch(body, /#9 /);
  assert.match(body, /- Factory: run-url/);
  assert.equal(comments(deps).length, 0, '--dry-run posts nothing');
});

test('only PRs the Claude app wrote are listed', () => {
  const deps = fakeDeps();
  run(deps);
  const prList = deps.calls.find((a) => a[0] === 'pr' && !a.includes('--label'));
  assert.equal(prList[prList.indexOf('--author') + 1], 'app/claude');
});

test('failed runs are read from the last 24 hours only, from the factory workflow', () => {
  const deps = fakeDeps();
  run(deps);
  const runList = deps.calls.find((a) => a[0] === 'run');
  assert.ok(runList.includes('>=2026-10-23T21:00:00.000Z'));
  assert.equal(runList[runList.indexOf('--workflow') + 1], 'factory.yml');
});

test('posts one comment on the open digest issue, creating it only when missing', () => {
  const existing = fakeDeps({ prs: [FACTORY_PR], digest: [{ number: 750 }] });
  run(existing);
  assert.deepEqual(
    comments(existing).map((a) => a[2]),
    ['750'],
  );
  assert.ok(!existing.calls.some((a) => a[1] === 'create'));

  const fresh = fakeDeps({ prs: [FACTORY_PR] });
  run(fresh);
  assert.deepEqual(
    comments(fresh).map((a) => a[2]),
    ['800'],
  );
  const label = fresh.calls.find((a) => a[0] === 'label');
  assert.deepEqual(label.slice(0, 3), ['label', 'create', 'factory-digest']);
});

test('renamed labels and owner and a custom prefix are used', () => {
  const renamed = loadConfig(
    tempRoot(
      {},
      {
        config: [
          'spec_source: openspec',
          'owner: boss',
          'gates:',
          '  - run: npm test',
          'labels:',
          '  change_prefix: "bot-"',
          '  needs_human: stuck',
          '  digest: daily',
        ].join('\n'),
      },
    ),
  );
  const deps = fakeDeps({
    prs: [
      { ...FACTORY_PR, labels: [{ name: 'bot-add-x' }] },
      { ...FACTORY_PR, number: 702 },
    ],
    issues: [{ number: 703, title: 'parked', url: 'u703' }],
    digestLabel: 'daily',
    parkedLabel: 'stuck',
  });
  const body = run(deps, ['--dry-run'], renamed);
  assert.match(body, /@boss/);
  assert.match(body, /Waiting on you \(stuck\)/);
  assert.match(body, /- #703 parked/);
  assert.match(body, /- #701 /);
  assert.doesNotMatch(body, /- #702 /, 'only the bot- PR counts');
  run(deps, [], renamed);
  assert.ok(deps.calls.some((a) => a[0] === 'label' && a[2] === 'daily'));
  const created = deps.calls.find((a) => a[0] === 'issue' && a[1] === 'create');
  assert.equal(created[created.indexOf('--label') + 1], 'daily');
});
