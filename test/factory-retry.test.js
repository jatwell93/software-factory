const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { main } = require('../scripts/factory-retry.js');
const { createStubAdapter } = require('./stub-adapter.js');
const { tempRoot } = require('./helpers.js');

const RUN = 'https://github.com/octo/app/actions/runs/111';
const RETRY_RUN = 'https://github.com/octo/app/actions/runs/222';
const config = loadConfig(tempRoot());

/** A config that renames the owner, the change prefix and every state label. */
const renamedConfig = () =>
  [
    'spec_source: openspec',
    'owner: boss',
    'gates:',
    '  - run: npm test',
    'labels:',
    '  change_prefix: "bot-"',
    '  needs_human: stuck',
    '  retry: again',
    '  retrying: again-now',
  ].join('\n');

/** A fake `gh` with one open tracking issue (#714); records every call. */
function fakeGh({ labels = [], comments = [], retrying = [] } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      const asksRetrying = args.includes('factory-retrying') || args.includes('again-now');
      return JSON.stringify(asksRetrying ? retrying : [{ number: 714 }]);
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ labels: labels.map((name) => ({ name })), comments });
    }
    return '';
  };
  return { gh, calls };
}

const io = (gh, cfg = config) => ({
  config: cfg,
  adapter: createStubAdapter(),
  gh,
  log: () => {},
  error: () => {},
});
const edits = (calls) => calls.filter((c) => c[0] === 'issue' && c[1] === 'edit');
const bodies = (calls) => calls.filter((c) => c[1] === 'comment').map((c) => c[4]);

test('a first failure labels the tracking issue factory-retry and comments the run with a marker', () => {
  const { gh, calls } = fakeGh();
  assert.equal(main(['fail', 'add-x', RUN], io(gh)), 0);
  assert.deepEqual(edits(calls), [['issue', 'edit', '714', '--add-label', 'factory-retry']]);
  const [body] = bodies(calls);
  assert.match(body, /failed: https:\/\/github\.com\/.*\/runs\/111/);
  assert.match(body, /<!-- factory-retry run: https:\/\/github\.com\/\S+\/runs\/111 -->/);
  assert.ok(
    calls.some((c) => c[0] === 'label' && c.includes('factory-retry')),
    'label exists first',
  );
});

test('a failed retry escalates with both run links and drops factory-retrying', () => {
  const { gh, calls } = fakeGh({
    labels: ['factory:add-x', 'factory-retrying'],
    comments: [{ body: `failed\n\n<!-- factory-retry run: ${RUN} -->` }],
  });
  assert.equal(main(['fail', 'add-x', RETRY_RUN], io(gh)), 0);
  assert.deepEqual(edits(calls), [
    ['issue', 'edit', '714', '--remove-label', 'factory-retrying', '--add-label', 'needs-human'],
  ]);
  const [body] = bodies(calls);
  assert.match(body, /^@octo /);
  assert.ok(body.includes(`first: ${RUN}`) && body.includes(`retry: ${RETRY_RUN}`));
  assert.match(body, /remove `needs-human` to resume/);
  assert.doesNotMatch(body, /<!-- factory-retry run/, 'no marker: this is not a retry');
});

test('the needs-human label is created before the escalation adds it', () => {
  // A fresh repository has no needs-human label, and `gh issue edit` fails on one it lacks.
  const known = new Set(['factory-retrying']);
  const inner = fakeGh({
    labels: ['factory-retrying'],
    comments: [{ body: `<!-- factory-retry run: ${RUN} -->` }],
  });
  const gh = (args) => {
    if (args[0] === 'label') known.add(args[2]);
    const added = args[args.indexOf('--add-label') + 1];
    if (args.includes('--add-label') && !known.has(added)) throw new Error(`'${added}' not found`);
    return inner.gh(args);
  };
  assert.equal(main(['fail', 'add-x', RETRY_RUN], io(gh)), 0);
  const created = inner.calls.find((c) => c[0] === 'label' && c[2] === 'needs-human');
  assert.ok(created, 'created with --force');
  assert.ok(created.includes('--force'));
  const renamed = loadConfig(tempRoot({}, { config: renamedConfig() }));
  known.clear();
  known.add('again-now');
  const second = fakeGh({
    labels: ['again-now'],
    comments: [{ body: `<!-- factory-retry run: ${RUN} -->` }],
  });
  const gh2 = (args) => {
    if (args[0] === 'label') known.add(args[2]);
    const added = args[args.indexOf('--add-label') + 1];
    if (args.includes('--add-label') && !known.has(added)) throw new Error(`'${added}' not found`);
    return second.gh(args);
  };
  assert.equal(main(['fail', 'add-x', RETRY_RUN], io(gh2, renamed)), 0);
  assert.ok(second.calls.some((c) => c[0] === 'label' && c[2] === 'stuck'));
});

test('a success removes factory-retrying, and does nothing when it is absent', () => {
  const withLabel = fakeGh({ retrying: [{ number: 714 }] });
  assert.equal(main(['ok', 'add-x'], io(withLabel.gh)), 0);
  assert.deepEqual(edits(withLabel.calls), [
    ['issue', 'edit', '714', '--remove-label', 'factory-retrying'],
  ]);
  const without = fakeGh();
  main(['ok', 'add-x'], io(without.gh));
  assert.deepEqual(edits(without.calls), []);
  assert.ok(!without.calls.some((c) => c[1] === 'create'), 'a success never creates an issue');
});

test('rejects a bad command, change id or run url before calling gh', () => {
  for (const argv of [
    ['retry', 'add-x', RUN],
    ['fail', '../x', RUN],
    ['fail', 'add-x', 'https://example.com/runs/1'],
    ['fail', 'add-x', `${RUN}; rm`],
  ]) {
    const { gh, calls } = fakeGh();
    assert.equal(main(argv, io(gh)), 2, argv.join(' '));
    assert.equal(calls.length, 0);
  }
});

test('renamed labels and a renamed owner are used throughout', () => {
  const renamed = loadConfig(tempRoot({}, { config: renamedConfig() }));
  const first = fakeGh();
  main(['fail', 'add-x', RUN], io(first.gh, renamed));
  assert.deepEqual(edits(first.calls), [['issue', 'edit', '714', '--add-label', 'again']]);
  assert.ok(first.calls.some((c) => c[0] === 'label' && c[2] === 'again-now'));
  assert.ok(first.calls.some((c) => c[0] === 'label' && c[2] === 'again'));

  const second = fakeGh({
    labels: ['again-now'],
    comments: [{ body: `<!-- factory-retry run: ${RUN} -->` }],
  });
  main(['fail', 'add-x', RETRY_RUN], io(second.gh, renamed));
  assert.deepEqual(edits(second.calls), [
    ['issue', 'edit', '714', '--remove-label', 'again-now', '--add-label', 'stuck'],
  ]);
  const [body] = bodies(second.calls);
  assert.match(body, /^@boss /);
  assert.match(body, /remove `stuck` to resume/);

  const ok = fakeGh({ retrying: [{ number: 5 }] });
  main(['ok', 'add-x'], io(ok.gh, renamed));
  assert.ok(ok.calls[0].includes('bot-add-x') && ok.calls[0].includes('again-now'));
  assert.deepEqual(edits(ok.calls), [['issue', 'edit', '5', '--remove-label', 'again-now']]);
});
