const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { formatCost, formatDuration, parseExecution } = require('../lib/run-record.js');
const { defaultRecord, totalLine } = require('../scripts/factory-digest.js');
const { RECORD_ARTIFACT, RECORD_FILE } = require('../lib/run-record.js');

test('only a result message counts, even when a later message has the same fields', () => {
  const log = JSON.stringify([
    { type: 'result', total_cost_usd: 1, duration_ms: 1000, num_turns: 1 },
    { type: 'assistant', total_cost_usd: 99, duration_ms: 99000, num_turns: 99 },
  ]);
  assert.deepEqual(parseExecution(log), { cost_usd: 1, duration_ms: 1000, turns: 1 });
});

test('an undefined cost is unknown, not an error', () => {
  assert.equal(formatCost(undefined), 'cost unknown');
});

test('durations are rounded to the nearest second', () => {
  assert.equal(formatDuration(45600), '46s');
  assert.equal(formatDuration(45400), '45s');
  assert.equal(formatDuration(372500), '6m13s');
});

test('a run whose record has a null cost counts as unknown in the total', () => {
  const run = (cost) => ({ record: { cost_usd: cost } });
  assert.equal(
    totalLine([run(0.5), run(null)]),
    'Total: $0.50 over 1 run(s) (1 run(s) with unknown cost)',
  );
});

test('the record is downloaded by artifact name into a fresh directory, read, and cleaned up', () => {
  let seen;
  const exec = (cmd, args, options) => {
    seen = { cmd, args, options };
    const dir = args[args.indexOf('-D') + 1];
    fs.writeFileSync(path.join(dir, RECORD_FILE), '{"cost_usd":0.4}');
  };
  assert.deepEqual(defaultRecord(77, exec), { cost_usd: 0.4 });
  assert.equal(seen.cmd, 'gh');
  assert.deepEqual(seen.args.slice(0, 5), ['run', 'download', '77', '-n', RECORD_ARTIFACT]);
  assert.equal(seen.options.stdio, 'pipe', 'a failed download prints nothing to the digest log');
  assert.equal(fs.existsSync(seen.args.at(-1)), false, 'the directory is removed');
});

test('a run with no record, or an unreadable one, gives null and leaves nothing behind', () => {
  let dir;
  const failing = (cmd, args) => {
    dir = args[args.indexOf('-D') + 1];
    throw new Error('no artifact');
  };
  assert.equal(defaultRecord(1, failing), null);
  assert.equal(fs.existsSync(dir), false);
  const garbled = (cmd, args) => {
    dir = args[args.indexOf('-D') + 1];
    fs.writeFileSync(path.join(dir, RECORD_FILE), 'not json');
  };
  assert.equal(defaultRecord(1, garbled), null);
  assert.equal(fs.existsSync(dir), false);
});
