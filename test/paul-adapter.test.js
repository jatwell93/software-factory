'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defineContractTests } = require('../adapters/contract-suite.js');
const {
  createPaulAdapter,
  parsePlan,
  parseRoadmap,
  parseSidecar,
  taskIdOf,
} = require('../adapters/paul.js');

const ROADMAP = [
  '# Roadmap: Demo',
  '',
  '## Phase Details',
  '',
  '### Phase 1: Fix one',
  '',
  '**Goal:** fix it',
  '',
  '**Plans:**',
  '- [ ] 01-01: First thing',
  '- [ ] 01-02: Needs the owner',
  '- [x] 01-03: Done thing',
  '',
].join('\n');

const SIDECAR = ['merge: human', 'pr: per-change', 'no_go:', '  - docs/**', ''].join('\n');

const PLAN_2 = [
  '---',
  'phase: 01-fix-one',
  'plan: 02',
  'depends_on: ["01-01"]',
  'autonomous: false',
  '---',
  '',
  '<objective/>',
  '',
].join('\n');

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** A temp project with the canonical phase; `extra` maps a relative path to its text. */
function project(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paul-'));
  write(root, '.paul/ROADMAP.md', ROADMAP);
  write(root, '.paul/phases/01-fix-one/factory.yml', SIDECAR);
  write(root, '.paul/phases/01-fix-one/01-02-PLAN.md', PLAN_2);
  for (const [rel, text] of Object.entries(extra)) write(root, rel, text);
  return root;
}

defineContractTests('paul', async () => {
  const root = project();
  return {
    adapter: createPaulAdapter({ root, now: () => new Date('2026-11-23T09:00:00Z') }),
    projectRoot: root,
  };
});

test('a plan id becomes a dotted task id', () => {
  assert.equal(taskIdOf('01-02'), '1.2');
  assert.equal(taskIdOf('10-11'), '10.11');
  assert.equal(taskIdOf('02.1-01'), '2.1.1');
  assert.throws(() => taskIdOf('fix-one'), /not a plan id/);
});

test('the roadmap gives each phase its plans, and a decimal phase keeps its [INSERTED] out of the name', () => {
  const phases = parseRoadmap(
    [
      '### Phase 2: Core',
      '- [ ] 02-01: a',
      '### Phase 2.1: Hotfix [INSERTED]',
      '- [x] 02.1-01: b',
      '## Other',
      '- [ ] 02-09: not under a phase',
    ].join('\n'),
  );
  assert.deepEqual(
    phases.map((p) => [p.num, p.name, p.plans.map((plan) => plan.planId)]),
    [
      ['2', 'Core', ['02-01']],
      ['2.1', 'Hotfix', ['02.1-01']],
    ],
  );
});

test('a decimal phase directory is a change with dotted task ids', () => {
  const root = project({
    '.paul/ROADMAP.md': `${ROADMAP}\n### Phase 1.1: Hotfix [INSERTED]\n\n**Plans:**\n- [ ] 01.1-01: Patch\n`,
    '.paul/phases/01.1-hotfix/factory.yml': 'merge: human\n',
  });
  const adapter = createPaulAdapter({ root });
  assert.deepEqual(
    adapter.listChanges().map((c) => c.id),
    ['fix-one', 'hotfix'],
  );
  assert.deepEqual(
    adapter.listTasks('hotfix').map((t) => t.id),
    ['1.1.1'],
  );
});

test('a slug two phases share is listed for neither, and a name that is not NN-slug is skipped', () => {
  const root = project({
    '.paul/phases/02-fix-one/factory.yml': 'merge: human\n',
    '.paul/phases/Notes/readme.md': 'x',
    '.paul/phases/03-Bad_Name/x': 'x',
  });
  const adapter = createPaulAdapter({ root });
  assert.deepEqual(adapter.listChanges(), []);
  assert.throws(() => adapter.listTasks('fix-one'), /no active change/);
  assert.equal(adapter.isArchived('fix-one'), false);
});

test('a phase a shipped milestone lists is archived, whatever the archive file is called', () => {
  const root = project({
    '.paul/milestones/v1.0-mvp.md':
      '# Milestone v1.0\n\n### Phase 1: First name\n\nPlans:\n- [x] 01-01: a\n',
  });
  const adapter = createPaulAdapter({ root });
  assert.deepEqual(adapter.listChanges(), []);
  assert.equal(adapter.isArchived('fix-one'), true);
  assert.equal(adapter.archivedTitle('fix-one'), 'Fix one', 'the roadmap still names it');
  assert.throws(() => adapter.listTasks('fix-one'), /no active change/);
  // The roadmap has collapsed the phase: the archive still names it.
  const collapsed = project({
    '.paul/ROADMAP.md': '# Roadmap\n',
    '.paul/milestones/1.0-ROADMAP.md': '### Phase 1: Only in archive\n',
  });
  assert.equal(createPaulAdapter({ root: collapsed }).archivedTitle('fix-one'), 'Only in archive');
});

test('archive writes the marker and nothing else, and refuses a second time', () => {
  const root = project();
  const adapter = createPaulAdapter({ root, now: () => new Date('2026-11-23T09:00:00Z') });
  const before = read(root, '.paul/ROADMAP.md');
  adapter.archive('fix-one');
  assert.equal(read(root, '.paul/phases/01-fix-one/ARCHIVED'), 'archived: 2026-11-23\n');
  assert.equal(read(root, '.paul/ROADMAP.md'), before);
  assert.throws(() => adapter.archive('fix-one'), /no active change/);
});

test('tick edits that one roadmap line, keeps CRLF, and writes nothing else', () => {
  const root = project({ '.paul/ROADMAP.md': ROADMAP.replace(/\n/g, '\r\n') });
  const adapter = createPaulAdapter({ root });
  adapter.tickTask('fix-one', '1.2');
  assert.equal(
    read(root, '.paul/ROADMAP.md'),
    ROADMAP.replace('- [ ] 01-02:', '- [x] 01-02:').replace(/\n/g, '\r\n'),
  );
  assert.equal(fs.existsSync(path.join(root, '.paul/STATE.md')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.paul/phases/01-fix-one')).sort(), [
    '01-02-PLAN.md',
    'factory.yml',
  ]);
});

test('a task id that is not in the change is refused, even when another phase has it', () => {
  const root = project({
    '.paul/ROADMAP.md': `${ROADMAP}\n### Phase 2: Other\n- [ ] 02-01: other\n`,
    '.paul/phases/02-other/factory.yml': 'merge: human\n',
  });
  const adapter = createPaulAdapter({ root });
  assert.throws(() => adapter.tickTask('fix-one', '2.1'), /no task 2.1/);
  assert.match(read(root, '.paul/ROADMAP.md'), /- \[ \] 02-01:/);
});

test('the sidecar and a plan can each make a task an owner task', () => {
  const root = project({
    '.paul/phases/01-fix-one/factory.yml': `${SIDECAR}owner:\n  - "01-01"\n`,
  });
  const tasks = createPaulAdapter({ root }).listTasks('fix-one');
  assert.deepEqual(
    tasks.map((t) => [t.id, t.owner]),
    [
      ['1.1', true],
      ['1.2', true],
      ['1.3', false],
    ],
  );
});

test('with no sidecar the defaults apply', () => {
  const root = project();
  fs.rmSync(path.join(root, '.paul/phases/01-fix-one/factory.yml'));
  assert.deepEqual(createPaulAdapter({ root }).readAutonomy('fix-one'), {
    merge: 'human',
    pr: 'per-task',
    noGo: [],
  });
});

test('a sidecar with an unknown key, a bad value or broken YAML is an error, never read in part', () => {
  for (const [text, message] of [
    ['merge: robot\n', /merge must be human/],
    ['pr: sometimes\n', /pr must be/],
    ['nogo: [a]\n', /unknown key nogo/],
    ['no_go: docs\n', /no_go must be a list/],
    ['issue: 0\n', /issue must be/],
    ['owner: ["fix-one"]\n', /not a plan id/],
    ['- a\n- b\n', /must be a mapping/],
    ['merge: [\n', /not valid YAML/],
  ]) {
    assert.throws(() => parseSidecar(text), message, text);
  }
  assert.deepEqual(parseSidecar('issue: 12\n').autonomy.issue, 12);
});

test('a plan with broken frontmatter fails the listing instead of reading no blockers', () => {
  const root = project({
    '.paul/phases/01-fix-one/01-01-PLAN.md': '---\ndepends_on: [\n---\n',
  });
  assert.throws(() => createPaulAdapter({ root }).listTasks('fix-one'), /not valid YAML/);
  assert.throws(() => parsePlan('---\ndepends_on: "01-01"\n---\n'), /must be a list/);
  assert.deepEqual(parsePlan('no frontmatter'), { owner: false, blockedBy: [] });
  assert.deepEqual(parsePlan(null), { owner: false, blockedBy: [] });
});

test('scaffold numbers the phase above every one seen, writes the sidecar and a roadmap section', () => {
  const root = project({ '.paul/milestones/v1.0.md': '### Phase 7: Shipped\n' });
  const adapter = createPaulAdapter({ root });
  const { path: made } = adapter.scaffold('new-thing', { title: 'New thing' });
  assert.equal(made, '.paul/phases/08-new-thing');
  assert.equal(read(root, `${made}/factory.yml`), 'merge: human\n');
  assert.match(read(root, '.paul/ROADMAP.md'), /\n### Phase 8: New thing\n\n\*\*Plans:\*\*\n$/);
  assert.deepEqual(adapter.listTasks('new-thing'), []);
  assert.throws(() => adapter.scaffold('new-thing'), /exists/);
  assert.throws(() => adapter.scaffold('Fix-Thing'), /lowercase/);
  assert.throws(() => adapter.scaffold('ok', { title: 'a\nb' }), /line break/);
});

test('scaffold refuses a project with no roadmap, and writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paul-empty-'));
  assert.throws(() => createPaulAdapter({ root }).scaffold('new-thing'), /run PAUL's own init/);
  assert.equal(fs.existsSync(path.join(root, '.paul')), false);
});

test('setup runs nothing: it passes with a roadmap and asks for PAUL init without one', () => {
  const root = project();
  assert.deepEqual(createPaulAdapter({ root }).setup(root), { changed: false });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'paul-empty-'));
  assert.throws(() => createPaulAdapter({ root: empty }).setup(empty), /run PAUL's own init/);
});

test('changesIn names the slug of each phase directory a path is under, once, and no other path', () => {
  const adapter = createPaulAdapter({ root: project() });
  assert.deepEqual(
    adapter.changesIn([
      '.paul/phases/01-fix-one/01-01-PLAN.md',
      '.paul/phases/01-fix-one/factory.yml',
      '.paul/phases/02.1-hotfix/x.md',
      '.paul/ROADMAP.md',
      '.paul/phases/Notes/x.md',
      'src/.paul/phases/03-nested/x.md',
    ]),
    ['fix-one', 'hotfix'],
  );
});

test('an adapter reading a branch is read-only and still reads', () => {
  const root = project();
  const source = {
    read: (rel) => (fs.existsSync(path.join(root, rel)) ? read(root, rel) : null),
    list: (rel) =>
      fs.existsSync(path.join(root, rel))
        ? fs
            .readdirSync(path.join(root, rel), { withFileTypes: true })
            .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        : [],
  };
  const adapter = createPaulAdapter({ root: '/nowhere', source });
  assert.deepEqual(adapter.listChanges(), [{ id: 'fix-one' }]);
  assert.equal(adapter.listTasks('fix-one').length, 3);
  assert.throws(() => adapter.tickTask('fix-one', '1.1'), /read-only/);
  assert.throws(() => adapter.archive('fix-one'), /read-only/);
  assert.throws(() => adapter.scaffold('x'), /read-only/);
});

test('an id that is not a plain slug is never found and never rejects isArchived', () => {
  const adapter = createPaulAdapter({ root: project() });
  for (const id of ['../x', 'a/b', '', '..', undefined]) {
    assert.equal(adapter.isArchived(id), false);
    assert.throws(() => adapter.listTasks(id), /no active change/);
  }
});
