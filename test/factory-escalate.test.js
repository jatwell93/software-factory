const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');
const { main } = require('../scripts/factory-escalate.js');
const { tempRoot } = require('./helpers.js');

const TASKS =
  '## 2\n\n- [x] 2.1 Add the API\n- [ ] 2.2 (owner) Rotate the vendor key\n- [ ] 2.3 Use it\n';

/** A project whose change `add-x` has the given task list. */
function project(tasks = TASKS, extraConfig = []) {
  const root = tempRoot({ 'add-x': '# Add x\n' }, { extraConfig });
  fs.writeFileSync(path.join(root, 'openspec/changes/add-x/tasks.md'), tasks);
  const config = loadConfig(root);
  return { config, adapter: loadAdapter(config, { root }) };
}

/** A fake `gh` with one open issue labelled for the change; records every call. */
function fakeGh() {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 707 }]);
    return '';
  };
  return { gh, calls };
}

const io = (gh, tasks, extra = {}) => ({ ...project(tasks), gh, log: () => {}, ...extra });

test('labels the tracking issue needs-human, then comments the task for the owner', () => {
  const { gh, calls } = fakeGh();
  assert.equal(main(['add-x', '2.2'], io(gh)), 0);
  const writes = calls.filter((c) => c[1] !== 'list');
  assert.deepEqual(writes[0].slice(0, 3), ['label', 'create', 'needs-human']);
  assert.deepEqual(writes[1], ['issue', 'edit', '707', '--add-label', 'needs-human']);
  assert.deepEqual(writes[2].slice(0, 4), ['issue', 'comment', '707', '--body']);
  const body = writes[2][4];
  assert.match(body, /^@octo Task 2\.2 of `add-x` is an owner task/);
  assert.match(body, /> Rotate the vendor key/);
  assert.match(body, /tick it in the change's task list on `main`, then remove `needs-human`/);
});

test("on a per-change PR, reads the branch's task list and asks for the tick there", () => {
  const { gh, calls } = fakeGh();
  const refs = [];
  const { adapter } = project();
  const d = io(gh, TASKS, {
    branchAdapter: (ref) => {
      refs.push(ref);
      return adapter;
    },
  });
  assert.equal(main(['add-x', '2.2', 'feature/factory-add-x'], d), 0);
  assert.deepEqual(refs, ['feature/factory-add-x']);
  const body = calls.find((c) => c[1] === 'comment')[4];
  assert.match(body, /on `feature\/factory-add-x`, then remove/);
  assert.equal(main(['add-x', '2.2', 'x;rm -rf'], d), 2, 'unsafe branch rejected');
});

test('does nothing when the task is no longer the next owner task', () => {
  for (const tasks of [
    TASKS.replace('- [ ] 2.2', '- [x] 2.2'), // ticked meanwhile
    TASKS.replace('(owner) ', ''), // no longer an owner task
  ]) {
    const { gh, calls } = fakeGh();
    assert.equal(main(['add-x', '2.2'], io(gh, tasks)), 0);
    assert.equal(calls.length, 0, 'no label, issue or comment');
  }
});

test('asks only for the task the router named, not another owner task', () => {
  const tasks = '- [ ] 2.2 (owner) First\n- [ ] 2.3 (owner) Second\n';
  const { gh, calls } = fakeGh();
  assert.equal(main(['add-x', '2.3'], io(gh, tasks)), 0);
  assert.equal(calls.length, 0, 'the next owner task is 2.2, so 2.3 is not asked about yet');
});

test('a change archived meanwhile asks for nothing', () => {
  const { gh, calls } = fakeGh();
  const lines = [];
  const d = { ...io(gh), log: (l) => lines.push(l) };
  assert.equal(main(['no-such-change', '2.2'], d), 0);
  assert.match(lines[0], /no longer the next owner task/);
  assert.equal(calls.length, 0);
});

test('rejects an unsafe change id or task number before calling gh', () => {
  for (const argv of [
    ['../x', '2.2'],
    ['add-x', '2.2; rm'],
    ['add-x', ''],
    ['a'.repeat(43), '1.1'],
  ]) {
    const { gh, calls } = fakeGh();
    assert.equal(main(argv, { ...io(gh), error: () => {} }), 2, argv.join(' '));
    assert.equal(calls.length, 0);
  }
});

test('the configured owner, label and default branch are used', () => {
  const root = tempRoot(
    { 'add-x': '# Add x\n' },
    {
      config: [
        'spec_source: openspec',
        'owner: boss',
        'default_branch: trunk',
        'gates:',
        '  - run: npm test',
        'labels:',
        '  change_prefix: "bot-"',
        '  needs_human: stuck',
      ].join('\n'),
    },
  );
  fs.writeFileSync(path.join(root, 'openspec/changes/add-x/tasks.md'), TASKS);
  const config = loadConfig(root);
  const { gh, calls } = fakeGh();
  const d = { config, adapter: loadAdapter(config, { root }), gh, log: () => {} };
  assert.equal(main(['add-x', '2.2'], d), 0);
  assert.deepEqual(
    calls.find((c) => c[1] === 'edit'),
    ['issue', 'edit', '707', '--add-label', 'stuck'],
  );
  assert.ok(calls.some((c) => c[0] === 'label' && c[2] === 'stuck'));
  assert.ok(calls.find((c) => c[1] === 'list').includes('bot-add-x'));
  const body = calls.find((c) => c[1] === 'comment')[4];
  assert.match(body, /^@boss /);
  assert.match(body, /on `trunk`, then remove `stuck`/);
});
