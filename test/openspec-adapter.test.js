'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { defineContractTests } = require('../adapters/contract-suite.js');
const {
  createOpenSpecAdapter,
  cmdArgs,
  isArchiveOf,
  parseTasks,
  titleOf,
} = require('../adapters/openspec.js');
const { NoGoFormatError } = require('../lib/openspec-reads.js');

const PROPOSAL = [
  '# Proposal: Fix one',
  '',
  '## Autonomy',
  '',
  '```yaml',
  'merge: human',
  'pr: per-change',
  'no_go:',
  '  - docs/**',
  '```',
  '',
].join('\n');

const TASKS = [
  '# Tasks',
  '',
  '## 1. Group',
  '',
  '- [ ] 1.1 First thing',
  '- [ ] 1.2 (owner) Needs the owner (#812): details',
  '      Blocked by: 1.1.',
  '- [x] 1.3 Done thing',
  '',
].join('\n');

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A temp project with the canonical change; `extra` maps a relative path to its text. */
function project(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-'));
  write(root, 'openspec/changes/fix-one/proposal.md', PROPOSAL);
  write(root, 'openspec/changes/fix-one/tasks.md', TASKS);
  for (const [rel, text] of Object.entries(extra)) write(root, rel, text);
  return root;
}

/** Stands in for the openspec CLI: moves a change to the archive, or writes the config. */
function fakeCli(root, calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'archive') {
      const from = path.join(root, 'openspec', 'changes', args[2]);
      fs.mkdirSync(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
      fs.renameSync(
        from,
        path.join(root, 'openspec', 'changes', 'archive', `2026-01-01-${args[2]}`),
      );
    } else if (args[0] === 'init') {
      write(root, 'openspec/config.yaml', 'schema: spec-driven\n');
    }
  };
}

const adapterFor = (root, options = {}) =>
  createOpenSpecAdapter({ root, run: fakeCli(root), ...options });

defineContractTests('openspec', () => {
  const root = project();
  return { adapter: adapterFor(root), projectRoot: root };
});

test('parseTasks reads owner, ticket, title and blocking edges', () => {
  const tasks = parseTasks(TASKS);
  assert.deepEqual(tasks, [
    { id: '1.1', title: 'First thing', done: false, owner: false, blockedBy: [] },
    {
      id: '1.2',
      title: 'Needs the owner',
      done: false,
      owner: true,
      blockedBy: ['1.1'],
      issue: 812,
    },
    { id: '1.3', title: 'Done thing', done: true, owner: false, blockedBy: [] },
  ]);
});

test('parseTasks reads several blockers and ignores prose after them', () => {
  const tasks = parseTasks(
    [
      '- [ ] 2.2 Second',
      '- [ ] 2.3 Third',
      '- [ ] 2.4 Build it',
      '      Blocked by: 2.2, 2.3 and one clean run on the pinned ref.',
      '',
    ].join('\n'),
  );
  assert.deepEqual(tasks[2].blockedBy, ['2.2', '2.3']);
});

test('parseTasks skips unnumbered checkboxes, reads indented ones, and stops a task at the next', () => {
  const tasks = parseTasks(
    [
      '- [ ] note without a number',
      '- [ ] 2.9 Earlier task',
      '  - [ ] 3.1 Indented task',
      '      Blocked by: 2.9.',
      '- [ ] 3.2 Next task',
      '      Demo: nothing blocks this one.',
    ].join('\n'),
  );
  assert.deepEqual(
    tasks.map((t) => [t.id, t.blockedBy]),
    [
      ['2.9', []],
      ['3.1', ['2.9']],
      ['3.2', []],
    ],
  );
});

test('a ticket is only the first (#n): on the task line, never a bare reference', () => {
  const [task] = parseTasks('- [ ] 1.1 Fix what #734 broke (#900): see (#901): too');
  assert.equal(task.issue, 900);
  const [bare] = parseTasks('- [ ] 1.2 Fix what #734 broke');
  assert.equal('issue' in bare, false);
});

test('readAutonomy reads the issue key, and omits issue when there is none', () => {
  const withIssue = project({
    'openspec/changes/answers/proposal.md': PROPOSAL.replace(
      'pr: per-change',
      'issue: 671\npr: per-change',
    ),
  });
  assert.deepEqual(adapterFor(withIssue).readAutonomy('answers'), {
    merge: 'human',
    pr: 'per-change',
    noGo: ['docs/**'],
    issue: 671,
  });
  assert.equal('issue' in adapterFor(withIssue).readAutonomy('fix-one'), false);
});

test('readAutonomy defaults to one PR per task and no extra paths', () => {
  const root = project({ 'openspec/changes/plain/proposal.md': '# Proposal\n\nno block\n' });
  assert.deepEqual(adapterFor(root).readAutonomy('plain'), {
    merge: 'human',
    pr: 'per-task',
    noGo: [],
  });
});

test('readAutonomy fails closed on a no_go shape it cannot read', () => {
  const root = project({
    'openspec/changes/odd/proposal.md': PROPOSAL.replace('no_go:\n  - docs/**', 'no_go: docs/**'),
  });
  assert.throws(() => adapterFor(root).readAutonomy('odd'), NoGoFormatError);
});

test('tickTask changes only the named task, matching the id exactly', () => {
  const root = project({
    'openspec/changes/many/proposal.md': PROPOSAL,
    'openspec/changes/many/tasks.md': '- [ ] 1.1 One\n- [ ] 1.10 Ten\n- [ ] 1.1a Letter\n',
  });
  adapterFor(root).tickTask('many', '1.1');
  assert.equal(
    fs.readFileSync(path.join(root, 'openspec/changes/many/tasks.md'), 'utf8'),
    '- [x] 1.1 One\n- [ ] 1.10 Ten\n- [ ] 1.1a Letter\n',
  );
});

test('tickTask keeps CRLF line endings and leaves a done task alone', () => {
  const crlf = TASKS.replace(/\n/g, '\r\n');
  const root = project({ 'openspec/changes/fix-one/tasks.md': crlf });
  const file = path.join(root, 'openspec/changes/fix-one/tasks.md');
  adapterFor(root).tickTask('fix-one', '1.1');
  assert.equal(fs.readFileSync(file, 'utf8'), crlf.replace('- [ ] 1.1 ', '- [x] 1.1 '));
  const before = fs.readFileSync(file, 'utf8');
  adapterFor(root).tickTask('fix-one', '1.3');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a change id is a folder name, never a path', () => {
  const root = project();
  const adapter = adapterFor(root);
  // '../changes/fix-one' and 'fix-one/../fix-one' resolve to the real change, so
  // only the guard (not a missing folder) keeps them out.
  const paths = ['../changes/fix-one', 'fix-one/../fix-one', '..', '.', 'a\\b', 'archive'];
  for (const id of paths) {
    assert.throws(() => adapter.listTasks(id), undefined, id);
    assert.throws(() => adapter.readAutonomy(id), undefined, id);
  }
  assert.throws(() => adapter.tickTask('../changes/fix-one', '1.1'));
  assert.throws(() => adapter.archive('../changes/fix-one'));
  assert.equal(adapter.listTasks('fix-one').length, 3, 'the real id still works');
});

test('a folder without a proposal.md is not a change; a badly named one with a proposal is listed', () => {
  const root = project({
    'openspec/changes/stray/notes.md': 'x',
    'openspec/changes/Bad-Name/proposal.md': PROPOSAL,
    // The archive holds finished changes, never an active one, even with a stray proposal.
    'openspec/changes/archive/proposal.md': PROPOSAL,
  });
  const ids = adapterFor(root)
    .listChanges()
    .map((c) => c.id)
    .sort();
  assert.deepEqual(ids, ['Bad-Name', 'fix-one']);
});

test('a change whose proposal.md is empty is still a change', () => {
  const root = project({ 'openspec/changes/blank/proposal.md': '' });
  const adapter = adapterFor(root);
  assert.ok(adapter.listChanges().some((c) => c.id === 'blank'));
  assert.deepEqual(adapter.listTasks('blank'), []);
  assert.deepEqual(adapter.readAutonomy('blank'), { merge: 'human', pr: 'per-task', noGo: [] });
});

test('archive runs the openspec CLI with -y on the change', () => {
  const root = project();
  const calls = [];
  const adapter = createOpenSpecAdapter({ root, run: fakeCli(root, calls) });
  adapter.archive('fix-one');
  assert.deepEqual(calls, [['archive', '-y', 'fix-one']]);
  assert.deepEqual(adapter.listChanges(), []);
});

test('scaffold writes a valid empty change and refuses a bad or taken id', () => {
  const root = project();
  const adapter = createOpenSpecAdapter({
    root,
    run: fakeCli(root),
    now: () => new Date('2026-11-10T09:00:00Z'),
  });
  const { path: made } = adapter.scaffold('new-thing', { title: 'New thing' });
  assert.equal(made, 'openspec/changes/new-thing');
  const dir = path.join(root, made);
  assert.equal(
    fs.readFileSync(path.join(dir, '.openspec.yaml'), 'utf8'),
    'schema: spec-driven\ncreated: 2026-11-10\n',
  );
  assert.match(fs.readFileSync(path.join(dir, 'proposal.md'), 'utf8'), /^# Proposal: New thing/);
  assert.deepEqual(adapter.listTasks('new-thing'), []);
  assert.deepEqual(adapter.readAutonomy('new-thing'), { merge: 'human', pr: 'per-task', noGo: [] });
  assert.throws(() => adapter.scaffold('Fix-Thing'), /lowercase/);
  assert.throws(() => adapter.scaffold('x'.repeat(43)), /limit is 42/);
  assert.throws(() => adapter.scaffold('new-thing'), /exists/);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes/Fix-Thing')), false);
});

test('scaffold honours a configured id length', () => {
  const root = project();
  const adapter = createOpenSpecAdapter({ root, run: fakeCli(root), maxIdLength: 10 });
  assert.throws(() => adapter.scaffold('twelve-char'), /limit is 10/);
});

test('setup runs openspec init once, with the configured tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-'));
  const calls = [];
  const adapter = createOpenSpecAdapter({ root, run: fakeCli(root, calls), tools: 'none' });
  assert.deepEqual(adapter.setup(root), { changed: true });
  assert.deepEqual(adapter.setup(root), { changed: false });
  assert.deepEqual(calls, [['init', '--tools', 'none', '--no-animation', root]]);
});

test('scaffold refuses the reserved archive folder, even when no archive exists yet', () => {
  const root = project();
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes/archive')), false);
  assert.throws(() => adapterFor(root).scaffold('archive'), /reserved/);
  assert.equal(fs.existsSync(path.join(root, 'openspec/changes/archive')), false);
});

test('archive refuses a folder whose name is not a plain id, so it never reaches a command line', () => {
  const root = project({
    'openspec/changes/a&calc/proposal.md': PROPOSAL,
    'openspec/changes/Bad Name/proposal.md': PROPOSAL,
  });
  const calls = [];
  const adapter = createOpenSpecAdapter({ root, run: fakeCli(root, calls) });
  assert.throws(() => adapter.archive('a&calc'), /valid change id/);
  assert.throws(() => adapter.archive('Bad Name'), /valid change id/);
  assert.deepEqual(calls, []);
});

test('cmdArgs wraps each argument in double quotes', () => {
  assert.deepEqual(cmdArgs(['archive', '-y', 'fix-one']), ['"archive"', '"-y"', '"fix-one"']);
  assert.deepEqual(cmdArgs(['init', 'C:\\Program Files (x86)\\app']), [
    '"init"',
    '"C:\\Program Files (x86)\\app"',
  ]);
});

test('cmdArgs doubles a trailing backslash so it cannot escape the closing quote', () => {
  assert.deepEqual(cmdArgs(['C:\\temp\\']), ['"C:\\temp\\\\"']);
  assert.deepEqual(cmdArgs(['C:\\temp\\\\']), ['"C:\\temp\\\\\\\\"']);
});

for (const bad of ['a&calc', 'a|b', 'a>b', 'a<b', 'a^b', 'say "hi"', '100%', 'a!b', 'a\nb']) {
  test(`cmdArgs refuses an argument cmd.exe would act on: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => cmdArgs(['archive', '-y', bad]), /cannot be passed to cmd\.exe safely/);
  });
}

test('parseTasks keeps only blockers that are tasks of the same file', () => {
  const tasks = parseTasks(
    [
      '- [ ] 1.1 First',
      '- [ ] 1.2 Second',
      '- [ ] 1.3 Third',
      '      Blocked by: 1.2, 9.9 and one clean run on 2 hosts, then 1.1.',
    ].join('\n'),
  );
  assert.deepEqual(tasks[2].blockedBy, ['1.2', '1.1'], 'order kept; 9.9 and 2 dropped');
});

test('isArchiveOf matches only <date>-<exact id>', () => {
  assert.equal(isArchiveOf('2026-01-01-fix-one', 'fix-one'), true);
  assert.equal(isArchiveOf('2026-01-01-other-fix-one', 'fix-one'), false);
  assert.equal(isArchiveOf('2026-01-01-fix-one-more', 'fix-one'), false);
  assert.equal(isArchiveOf('2026-1-1-fix-one', 'fix-one'), false);
  assert.equal(isArchiveOf('fix-one', 'fix-one'), false);
});

test('titleOf drops a Proposal: prefix in any case and keeps an acronym as written', () => {
  assert.equal(titleOf('# Proposal: Fix one\n\nbody'), 'Fix one');
  assert.equal(titleOf('# proposal: Fix one'), 'Fix one');
  assert.equal(titleOf('# API change for sales\n'), 'API change for sales');
  assert.equal(titleOf('no heading here'), '');
  assert.equal(titleOf(null), '');
  assert.equal(titleOf('## Not the top heading\n# Real one'), 'Real one');
});

test('isArchived and archivedTitle read the archive folder, matching the exact id', () => {
  const root = project({
    'openspec/changes/archive/2026-01-01-done-one/proposal.md': '# Proposal: Done one\n',
    'openspec/changes/archive/2026-01-02-other-done-one/proposal.md': '# Proposal: Other\n',
    'openspec/changes/archive/2026-01-03-no-heading/proposal.md': 'text only\n',
    'openspec/changes/archive/2026-01-04-no-proposal/notes.md': 'x\n',
    'openspec/changes/archive/2026-01-05-a-file': 'not a folder',
  });
  const adapter = adapterFor(root);
  assert.equal(adapter.isArchived('done-one'), true);
  assert.equal(adapter.archivedTitle('done-one'), 'Done one');
  assert.equal(adapter.isArchived('one'), false, 'a suffix of another id is not a match');
  assert.equal(adapter.archivedTitle('other-done-one'), 'Other');
  assert.equal(adapter.archivedTitle('no-heading'), '');
  assert.equal(adapter.isArchived('no-proposal'), true);
  assert.equal(adapter.archivedTitle('no-proposal'), '');
  assert.equal(adapter.isArchived('a-file'), false, 'a file is not an archived change');
});

test('isArchived and archivedTitle never reject, even for an id that is not a folder name', () => {
  const adapter = adapterFor(project());
  for (const id of ['../changes/fix-one', 'a/b', 'a\\b', '..', '.', '']) {
    assert.equal(adapter.isArchived(id), false, JSON.stringify(id));
    assert.equal(adapter.archivedTitle(id), '', JSON.stringify(id));
  }
});

/** An in-memory source: a map of relative paths to text. */
function mapSource(files) {
  const paths = Object.keys(files);
  return {
    read: (rel) => (rel in files ? files[rel] : null),
    list(rel) {
      const prefix = `${rel}/`;
      const seen = new Map();
      for (const p of paths.filter((x) => x.startsWith(prefix))) {
        const rest = p.slice(prefix.length);
        const [name, ...more] = rest.split('/');
        seen.set(name, more.length > 0);
      }
      return [...seen].map(([name, dir]) => ({ name, dir }));
    },
  };
}

test('an adapter over another source reads from it, not from the disk', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-empty-'));
  const adapter = createOpenSpecAdapter({
    root: emptyRoot,
    source: mapSource({
      'openspec/changes/on-branch/proposal.md': PROPOSAL,
      'openspec/changes/on-branch/tasks.md': TASKS,
      'openspec/changes/archive/2026-01-01-gone/proposal.md': '# Proposal: Gone\n',
    }),
  });
  assert.deepEqual(adapter.listChanges(), [{ id: 'on-branch' }]);
  assert.equal(adapter.listTasks('on-branch').length, 3);
  assert.deepEqual(adapter.readAutonomy('on-branch').noGo, ['docs/**']);
  assert.equal(adapter.isArchived('gone'), true);
  assert.equal(adapter.archivedTitle('gone'), 'Gone');
  assert.throws(() => adapter.listTasks('fix-one'), /no active change/);
});

test('an adapter over another source refuses every write and touches no file', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-empty-'));
  const source = mapSource({
    'openspec/changes/on-branch/proposal.md': PROPOSAL,
    'openspec/changes/on-branch/tasks.md': TASKS,
  });
  const calls = [];
  const adapter = createOpenSpecAdapter({
    root: emptyRoot,
    source,
    run: fakeCli(emptyRoot, calls),
  });
  assert.throws(() => adapter.tickTask('on-branch', '1.1'), /read-only/);
  assert.throws(() => adapter.archive('on-branch'), /read-only/);
  assert.throws(() => adapter.scaffold('new-thing'), /read-only/);
  assert.throws(() => adapter.setup(emptyRoot), /read-only/);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(emptyRoot), []);
});

const hasCli =
  spawnSync('openspec', ['--version'], { shell: process.platform === 'win32' }).status === 0;

test(
  'setup works against the real openspec CLI',
  { skip: !hasCli && 'openspec CLI not installed' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-real-'));
    const adapter = createOpenSpecAdapter({ root, tools: 'none' });
    assert.deepEqual(adapter.setup(root), { changed: true });
    assert.ok(fs.existsSync(path.join(root, 'openspec')));
    assert.deepEqual(adapter.setup(root), { changed: false });
  },
);

test('a numbered sub-item repeating a task number never stands for the task', () => {
  const md = '- [ ] 1.1 Real (#800):\n  - [ ] 1.2 sub (#900):\n- [ ] 1.2 Own (#801):\n';
  const tasks = parseTasks(md);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.issue]),
    [
      ['1.1', 800],
      ['1.2', 801],
    ],
  );
});

test('tickTask ticks the task line, not a sub-item with the same number', () => {
  const root = project({
    'openspec/changes/fix-one/tasks.md': '  - [ ] 1.2 sub\n- [ ] 1.2 Own\n',
  });
  const file = path.join(root, 'openspec/changes/fix-one/tasks.md');
  adapterFor(root).tickTask('fix-one', '1.2');
  assert.equal(fs.readFileSync(file, 'utf8'), '  - [ ] 1.2 sub\n- [x] 1.2 Own\n');
});
