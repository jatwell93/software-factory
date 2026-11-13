const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { main, runLine, totalLine } = require('../scripts/factory-digest.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const NOW = Date.parse('2026-10-24T21:00:00Z');

const run = (over = {}) => ({
  databaseId: 1,
  displayTitle: 'Factory',
  conclusion: 'success',
  url: 'https://github.com/o/r/actions/runs/1',
  startedAt: '2026-10-24T10:00:00Z',
  updatedAt: '2026-10-24T10:07:01Z',
  record: null,
  ...over,
});
const record = (over = {}) => ({ cost_usd: 0.4, duration_ms: 372000, turns: 31, ...over });

test('a run with a record shows its cost, the agent time and the turns', () => {
  assert.equal(
    runLine(run({ record: record() })),
    '- Factory (success): $0.40, 6m12s, 31 turns: https://github.com/o/r/actions/runs/1',
  );
});

test('a record without a duration falls back to the wall-clock time, marked as such', () => {
  const line = runLine(run({ record: record({ duration_ms: null, turns: null }) }));
  assert.equal(
    line,
    '- Factory (success): $0.40, 7m01s wall: https://github.com/o/r/actions/runs/1',
  );
});

test('a failed run with no record says its cost is unknown, never a number', () => {
  assert.equal(
    runLine(run({ conclusion: 'failure' })),
    '- Factory (failure): cost unknown, 7m01s wall: https://github.com/o/r/actions/runs/1',
  );
  const bare = runLine(run({ conclusion: 'failure', startedAt: undefined, updatedAt: undefined }));
  assert.match(bare, /cost unknown, duration unknown/);
});

test('a record that has a cost of zero shows $0.00, not unknown', () => {
  assert.match(runLine(run({ record: record({ cost_usd: 0 }) })), /\$0\.00/);
});

test('the total adds the known costs and counts the runs with none', () => {
  const runs = [
    run({ record: record({ cost_usd: 0.4 }) }),
    run({ record: record({ cost_usd: 1.1 }) }),
    run({ conclusion: 'failure' }),
  ];
  assert.equal(totalLine(runs), 'Total: $1.50 over 2 run(s) (1 run(s) with unknown cost)');
  assert.equal(totalLine([run({ record: record({ cost_usd: 2 }) })]), 'Total: $2.00 over 1 run(s)');
  assert.equal(
    totalLine([run({ conclusion: 'failure' })]),
    'Total: $0.00 over 0 run(s) (1 run(s) with unknown cost)',
  );
});

function digest({ runs, records = {} }) {
  const asked = [];
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'run') return JSON.stringify(runs);
    if (args[1] === 'create') return 'https://github.com/o/r/issues/800\n';
    if (args[1] === 'list') return '[]';
    return '';
  };
  const lines = [];
  main(['--dry-run'], {
    config,
    gh,
    summary: () => '',
    record: (id) => {
      asked.push(id);
      return records[id] ?? null;
    },
    log: (l) => lines.push(l),
    now: NOW,
  });
  return { body: lines.join('\n'), asked, calls };
}

test('the digest lists the runs that ran an agent and the failed ones, with a total', () => {
  const runs = [
    run({ databaseId: 1, displayTitle: 'Task run', record: null }),
    run({ databaseId: 2, displayTitle: 'Agent run' }),
    run({ databaseId: 3, displayTitle: 'Failed early', conclusion: 'failure' }),
  ];
  const { body, asked } = digest({ runs, records: { 2: record({ cost_usd: 0.25 }) } });
  assert.deepEqual(asked, [1, 2, 3]);
  assert.match(body, /Factory runs, last 24 hours/);
  assert.match(body, /- Agent run \(success\): \$0\.25/);
  assert.match(body, /- Failed early \(failure\): cost unknown/);
  assert.doesNotMatch(
    body,
    /Task run/,
    'a run with no record and no failure has nothing to report',
  );
  assert.match(body, /Total: \$0\.25 over 1 run\(s\) \(1 run\(s\) with unknown cost\)/);
});

test('runs still in progress or skipped are not looked at', () => {
  const runs = [
    run({ databaseId: 1, conclusion: '' }),
    run({ databaseId: 2, conclusion: 'skipped' }),
    run({ databaseId: 3, conclusion: 'cancelled' }),
  ];
  const { asked } = digest({ runs });
  assert.deepEqual(asked, [3]);
});

test('with no runs, no records and nothing else open, nothing is posted', () => {
  const { body } = digest({ runs: [run({ databaseId: 1 })] });
  assert.match(body, /no digest posted/);
});

test('the runs are those of the factory workflow in the last 24 hours', () => {
  const { calls } = digest({ runs: [] });
  const list = calls.find((a) => a[0] === 'run');
  assert.equal(list[list.indexOf('--workflow') + 1], 'factory.yml');
  assert.ok(list.includes('>=2026-10-23T21:00:00.000Z'));
  assert.equal(list[list.indexOf('--limit') + 1], '200');
  assert.ok(!list.includes('--status'), 'successful runs are listed too');
});
