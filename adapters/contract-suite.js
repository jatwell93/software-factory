'use strict';

/**
 * The shared contract suite. Every spec-source adapter runs it from its own test
 * file, so OpenSpec, a PAUL or GSD adapter and a bespoke one are held to the
 * same behaviour:
 *
 *   defineContractTests('openspec', async () => ({ adapter, projectRoot }));
 *
 * `create` must return a fresh project that holds the canonical fixture below,
 * so one test cannot see another's changes.
 *
 * Canonical fixture: one active change, `fix-one`, with three tasks and the
 * autonomy settings in FIXTURE.autonomy. An adapter that cannot express one of
 * these (for example blocking edges) does not meet the contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertAdapter, OPERATIONS } = require('./contract.js');

const FIXTURE = {
  changeId: 'fix-one',
  title: 'Fix one',
  tasks: [
    { id: '1.1', done: false, owner: false, blockedBy: [] },
    { id: '1.2', done: false, owner: true, blockedBy: ['1.1'] },
    { id: '1.3', done: true, owner: false, blockedBy: [] },
  ],
  autonomy: { merge: 'human', pr: 'per-change', noGo: ['docs/**'] },
};

// An adapter may throw at once or return a rejected promise; both count as a refusal.
const fails = (operation) => assert.rejects(async () => operation());

const shape = (tasks) =>
  tasks.map(({ id, done, owner, blockedBy }) => ({
    id,
    done,
    owner,
    blockedBy,
  }));

function defineContractTests(name, create) {
  const t = (title, fn) =>
    test(`${name} adapter: ${title}`, async () => {
      const { adapter, projectRoot } = await create();
      await fn(adapter, projectRoot);
    });

  t('has a name and every operation', (adapter) => {
    assertAdapter(adapter);
    assert.equal(adapter.name, name);
    assert.equal(OPERATIONS.length, 9);
  });

  t('lists the active change', async (adapter) => {
    const ids = (await adapter.listChanges()).map((c) => c.id);
    assert.deepEqual(ids, [FIXTURE.changeId]);
  });

  t('lists tasks with done, owner and blockedBy', async (adapter) => {
    const tasks = await adapter.listTasks(FIXTURE.changeId);
    assert.deepEqual(shape(tasks), FIXTURE.tasks);
    assert.ok(tasks.every((task) => typeof task.title === 'string'));
  });

  t('rejects an unknown change', async (adapter) => {
    await fails(() => adapter.listTasks('no-such-change'));
    await fails(() => adapter.readAutonomy('no-such-change'));
    await fails(() => adapter.tickTask('no-such-change', '1.1'));
    await fails(() => adapter.archive('no-such-change'));
  });

  t('reads autonomy with defaults applied', async (adapter) => {
    assert.deepEqual(await adapter.readAutonomy(FIXTURE.changeId), FIXTURE.autonomy);
  });

  t('ticks one task and leaves the others', async (adapter) => {
    await adapter.tickTask(FIXTURE.changeId, '1.1');
    const tasks = shape(await adapter.listTasks(FIXTURE.changeId));
    assert.deepEqual(tasks, [
      { ...FIXTURE.tasks[0], done: true },
      FIXTURE.tasks[1],
      FIXTURE.tasks[2],
    ]);
  });

  t('ticking twice changes nothing more', async (adapter) => {
    await adapter.tickTask(FIXTURE.changeId, '1.1');
    const once = shape(await adapter.listTasks(FIXTURE.changeId));
    await adapter.tickTask(FIXTURE.changeId, '1.1');
    assert.deepEqual(shape(await adapter.listTasks(FIXTURE.changeId)), once);
  });

  t('rejects ticking an unknown task', async (adapter) => {
    await fails(() => adapter.tickTask(FIXTURE.changeId, '9.9'));
  });

  t('archives a change out of the active list', async (adapter) => {
    await adapter.archive(FIXTURE.changeId);
    assert.deepEqual(await adapter.listChanges(), []);
  });

  t('reports a change as archived only after it is archived', async (adapter) => {
    assert.equal(await adapter.isArchived(FIXTURE.changeId), false);
    assert.equal(await adapter.isArchived('no-such-change'), false, 'an unknown id never rejects');
    await adapter.archive(FIXTURE.changeId);
    assert.equal(await adapter.isArchived(FIXTURE.changeId), true);
    assert.equal(await adapter.isArchived('no-such-change'), false);
  });

  t('names an archived change by its title, and nothing else', async (adapter) => {
    assert.equal(await adapter.archivedTitle(FIXTURE.changeId), '', 'active: no archived title');
    assert.equal(await adapter.archivedTitle('no-such-change'), '');
    await adapter.archive(FIXTURE.changeId);
    assert.equal(await adapter.archivedTitle(FIXTURE.changeId), FIXTURE.title);
  });

  t('scaffolds a new change and refuses a taken id', async (adapter) => {
    const { path } = await adapter.scaffold('new-thing', {
      title: 'New thing',
    });
    assert.equal(typeof path, 'string');
    const ids = (await adapter.listChanges()).map((c) => c.id).sort();
    assert.deepEqual(ids, [FIXTURE.changeId, 'new-thing']);
    await fails(() => adapter.scaffold('new-thing'));
    await fails(() => adapter.scaffold(FIXTURE.changeId));
  });

  t('setup is safe to run twice', async (adapter, projectRoot) => {
    const first = await adapter.setup(projectRoot);
    assert.equal(typeof first.changed, 'boolean');
    assert.deepEqual(await adapter.setup(projectRoot), { changed: false });
  });
}

module.exports = { defineContractTests, FIXTURE };
