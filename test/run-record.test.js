const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRecord,
  formatCost,
  formatDuration,
  messagesOf,
  parseExecution,
} = require('../lib/run-record.js');
const { main } = require('../scripts/factory-run-record.js');

const LOG = JSON.stringify([
  { type: 'system', subtype: 'init' },
  { type: 'assistant', message: {} },
  { type: 'result', total_cost_usd: 1.2345, duration_ms: 372000, num_turns: 31 },
]);

test('cost, duration and turns come from the last result message', () => {
  assert.deepEqual(parseExecution(LOG), { cost_usd: 1.2345, duration_ms: 372000, turns: 31 });
  const two = JSON.stringify([
    { type: 'result', total_cost_usd: 1, duration_ms: 1, num_turns: 1 },
    { type: 'result', total_cost_usd: 2, duration_ms: 2, num_turns: 2 },
  ]);
  assert.equal(parseExecution(two).cost_usd, 2);
});

test('a log of JSON lines is read too', () => {
  const lines = ['{"type":"system"}', 'not json', '{"type":"result","total_cost_usd":0.5}'].join(
    '\n',
  );
  assert.deepEqual(parseExecution(lines), { cost_usd: 0.5, duration_ms: null, turns: null });
  assert.equal(messagesOf('{"type":"result"}').length, 1, 'a single object');
});

test('a missing, empty, garbled or result-less log gives nulls, never a made-up number', () => {
  const unknown = { cost_usd: null, duration_ms: null, turns: null };
  for (const text of [undefined, '', '   ', 'garbage', '[]', '[{"type":"assistant"}]', 'null']) {
    assert.deepEqual(parseExecution(text), unknown, String(text));
  }
  const odd = JSON.stringify([{ type: 'result', total_cost_usd: '3', duration_ms: null }]);
  assert.deepEqual(parseExecution(odd), unknown, 'a string or null is not a number');
});

test('the record names what ran and on which change and PR', () => {
  assert.deepEqual(buildRecord({ executionText: LOG, mode: 'task', changeId: 'add-x', pr: '9' }), {
    version: 1,
    mode: 'task',
    change_id: 'add-x',
    pr: 9,
    cost_usd: 1.2345,
    duration_ms: 372000,
    turns: 31,
  });
  assert.equal(buildRecord({ executionText: '', mode: 'task', changeId: 'a', pr: '' }).pr, null);
});

test('cost and duration are formatted for a person', () => {
  assert.equal(formatCost(1.2345), '$1.23');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(null), 'cost unknown');
  assert.equal(formatDuration(372000), '6m12s');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(60000), '1m00s');
  assert.equal(formatDuration(null), 'duration unknown');
  assert.equal(formatDuration(-5), 'duration unknown');
});

function run(argv, files = {}) {
  const written = {};
  const errors = [];
  const status = main(argv, {
    read: (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    write: (file, text) => (written[file] = text),
    error: (m) => errors.push(m),
  });
  return { status, written, errors };
}

test('the script writes the record, with the log when there is one', () => {
  const r = run(['out.json', 'task', 'add-x', '9', '--execution', 'log.json'], { 'log.json': LOG });
  assert.equal(r.status, 0);
  const record = JSON.parse(r.written['out.json']);
  assert.equal(record.cost_usd, 1.2345);
  assert.equal(record.pr, 9);
  assert.ok(r.written['out.json'].endsWith('\n'));
});

test('a missing log still writes a record, with nulls', () => {
  for (const argv of [
    ['out.json', 'babysit', 'add-x', '9', '--execution', 'gone.json'],
    ['out.json', 'babysit', 'add-x', '9', '--execution', ''],
    ['out.json', 'babysit', 'add-x', '9', '--execution'],
    ['out.json', 'babysit', 'add-x', '9'],
  ]) {
    const r = run(argv);
    assert.equal(r.status, 0, argv.join(' '));
    assert.equal(JSON.parse(r.written['out.json']).cost_usd, null);
  }
  assert.equal(JSON.parse(run(['o', 'task', 'add-x']).written.o).pr, null);
});

test('a bad mode, change id, PR number or extra argument is a usage error that writes nothing', () => {
  for (const argv of [
    [],
    ['out.json'],
    ['out.json', 'bogus', 'add-x'],
    ['out.json', 'task', '../x'],
    ['out.json', 'task', 'Add-X'],
    ['out.json', 'task', 'add-x', '0'],
    ['out.json', 'task', 'add-x', '9; rm'],
    ['out.json', 'task', 'add-x', '9', 'extra'],
  ]) {
    const r = run(argv);
    assert.equal(r.status, 2, argv.join(' '));
    assert.deepEqual(r.written, {});
  }
});
