const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { requeue } = require('../scripts/factory-requeue.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const OWNER = config.owner;
const RESUMED = '<!-- factory-requeue:resumed -->';
const LABELLED = '2026-11-26T10:00:00Z';

/** A fake gh: one parked issue per entry of `issues`, each with its own events and comments. */
function fakeGh({ issues, events = {}, comments = {}, failDispatch = false }) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
    if (args[0] === 'api') {
      const n = /issues\/(\d+)\/(events|comments)/.exec(args.at(-1));
      const source = n[2] === 'events' ? events : comments;
      return JSON.stringify([source[n[1]] || []]);
    }
    if (args[0] === 'workflow' && failDispatch) throw new Error('dispatch refused');
    return '';
  };
  return { gh, calls };
}

const parked = (number, id = 'add-x') => ({
  number,
  labels: [{ name: 'needs-human' }, ...(id ? [{ name: `factory:${id}` }] : [])],
});
const added = [{ event: 'labeled', label: { name: 'needs-human' }, created_at: LABELLED }];
const comment = (login, at) => ({ user: { login }, created_at: at });

test('an owner comment after the label removes it, says so and dispatches the change', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: added },
    comments: { 703: [comment(OWNER, '2026-11-26T11:00:00Z')] },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [703],
  );
  const edit = calls.findIndex((c) => c === 'issue edit 703 --remove-label needs-human');
  const dispatch = calls.findIndex((c) => c.startsWith('workflow run factory.yml'));
  assert.ok(edit !== -1 && dispatch > edit, 'label goes before the dispatch');
  assert.match(calls[dispatch], /-f change_id=add-x/);
  assert.ok(
    calls.some((c) => c.startsWith('issue comment 703 --body Resuming') && c.includes(RESUMED)),
  );
  assert.ok(
    dispatch < calls.findIndex((c) => c.startsWith('issue comment')),
    'said after the dispatch',
  );
});

test('no owner comment after the label leaves it, whoever else commented', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: added },
    comments: {
      703: [
        comment(OWNER, '2026-11-26T09:00:00Z'),
        comment('claude[bot]', '2026-11-26T11:00:00Z'),
        comment('someone-else', '2026-11-26T12:00:00Z'),
      ],
    },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [],
  );
  assert.ok(!calls.some((c) => c.startsWith('issue edit') || c.startsWith('workflow')));
});

test('the label counts from its last addition, so an old answer does not requeue a new ask', () => {
  const again = [
    ...added,
    { event: 'labeled', label: { name: 'needs-human' }, created_at: '2026-11-26T12:00:00Z' },
  ];
  const { gh } = fakeGh({
    issues: [parked(703)],
    events: { 703: again },
    comments: { 703: [comment(OWNER, '2026-11-26T11:00:00Z')] },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [],
  );
});

test('an issue that is not a tracking issue, or has no label event, is left alone', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(5, ''), parked(6)],
    events: { 6: [] },
    comments: {
      5: [comment(OWNER, '2026-11-26T11:00:00Z')],
      6: [comment(OWNER, '2026-11-26T11:00:00Z')],
    },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [],
  );
  assert.ok(!calls.some((c) => c.startsWith('issue edit') || c.startsWith('workflow')));
});

test('owner names compare without case, and only needs-human issues are listed', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: added },
    comments: { 703: [comment(OWNER.toUpperCase(), '2026-11-26T11:00:00Z')] },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [703],
  );
  assert.match(calls[0], /issue list --state open --label needs-human --limit 100/);
});

const FAILED = '<!-- factory-requeue:failed -->';
const note = (body, at) => ({ user: { login: 'github-actions[bot]' }, created_at: at, body });

test('a failed dispatch puts the label back, says so once, and still fails the run', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: added },
    comments: { 703: [comment(OWNER, '2026-11-26T11:00:00Z')] },
    failDispatch: true,
  });
  assert.throws(() => requeue(config, gh, () => {}), /dispatch refused/);
  assert.ok(calls.includes('issue edit 703 --add-label needs-human'));
  assert.ok(calls.some((c) => c.startsWith('issue comment 703') && c.includes(FAILED)));
  assert.ok(!calls.some((c) => c.includes(RESUMED)), 'no claim of resuming');
});

test('after a failed resume the next run retries although the label is newer than the reply', () => {
  const relabelled = [
    ...added,
    { event: 'labeled', label: { name: 'needs-human' }, created_at: '2026-11-26T12:00:05Z' },
  ];
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: relabelled },
    comments: {
      703: [comment(OWNER, '2026-11-26T11:00:00Z'), note(FAILED, '2026-11-26T12:00:06Z')],
    },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [703],
  );
  assert.ok(calls.some((c) => c.startsWith('workflow run factory.yml')));
  assert.ok(calls.some((c) => c.startsWith('issue comment 703') && c.includes(RESUMED)));
});

test('a retry that fails again puts the label back without a second failure note', () => {
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    comments: {
      703: [comment(OWNER, '2026-11-26T11:00:00Z'), note(FAILED, '2026-11-26T12:00:06Z')],
    },
    failDispatch: true,
  });
  assert.throws(() => requeue(config, gh, () => {}), /dispatch refused/);
  assert.ok(calls.includes('issue edit 703 --add-label needs-human'));
  assert.ok(!calls.some((c) => c.startsWith('issue comment')));
});

test('a later successful resume cancels an old failure: a new ask waits for a new reply', () => {
  const again = [
    ...added,
    { event: 'labeled', label: { name: 'needs-human' }, created_at: '2026-11-26T14:00:00Z' },
  ];
  const { gh, calls } = fakeGh({
    issues: [parked(703)],
    events: { 703: again },
    comments: {
      703: [
        comment(OWNER, '2026-11-26T11:00:00Z'),
        note(FAILED, '2026-11-26T12:00:06Z'),
        note(RESUMED, '2026-11-26T13:00:00Z'),
      ],
    },
  });
  assert.deepEqual(
    requeue(config, gh, () => {}),
    [],
  );
  assert.ok(!calls.some((c) => c.startsWith('workflow')));
});

test('the owner cannot fake a marker, and one bad issue does not stop the others', () => {
  const faked = fakeGh({
    issues: [parked(703)],
    events: { 703: added },
    comments: { 703: [{ ...comment(OWNER, '2026-11-26T09:00:00Z'), body: FAILED }] },
  });
  assert.deepEqual(
    requeue(config, faked.gh, () => {}),
    [],
  );

  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([parked(1), parked(2)]);
    if (args[0] === 'api') {
      return JSON.stringify([
        /events/.test(args.at(-1)) ? added : [comment(OWNER, '2026-11-26T11:00:00Z')],
      ]);
    }
    if (args[0] === 'workflow' && calls.filter((c) => c.startsWith('workflow')).length === 1) {
      throw new Error('first dispatch refused');
    }
    return '';
  };
  assert.throws(() => requeue(config, gh, () => {}), /first dispatch refused/);
  assert.equal(calls.filter((c) => c.startsWith('workflow run')).length, 2);
});

test('a label that cannot be put back is logged and does not hide the dispatch error', () => {
  const logs = [];
  const gh = (args) => {
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([parked(703)]);
    if (args[0] === 'api') {
      return JSON.stringify([
        /events/.test(args.at(-1)) ? added : [comment(OWNER, '2026-11-26T11:00:00Z')],
      ]);
    }
    if (args[0] === 'workflow') throw new Error('dispatch refused');
    if (args.includes('--add-label')) throw new Error('no network');
    return '';
  };
  assert.throws(() => requeue(config, gh, (m) => logs.push(m)), /dispatch refused/);
  assert.ok(logs.some((m) => /could not put needs-human back: no network/.test(m)));
});
