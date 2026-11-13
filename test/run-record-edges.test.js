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
  assert.deepEqual(parseExecution(log), {
    cost_usd: 1,
    duration_ms: 1000,
    turns: 1,
    denied: null,
  });
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

const { denialLines } = require('../lib/run-record.js');
const { main: recordMain } = require('../scripts/factory-run-record.js');

const DENIED = [
  {
    tool_name: 'Bash',
    tool_input: { command: 'n=$(node "$FACTORY_DIR/scripts/factory-issue.js" x)' },
  },
  { tool_name: 'Read', tool_input: { file_path: '/tmp/software-factory/lib/a.js' } },
  { tool_name: 'Odd' },
];
const logWith = (result) => JSON.stringify([{ type: 'result', ...result }]);

test('denied tool calls are counted from the list, else from the count field', () => {
  assert.equal(parseExecution(logWith({ permission_denials: DENIED })).denied, 3);
  assert.equal(parseExecution(logWith({ permission_denials: [] })).denied, 0);
  assert.equal(parseExecution(logWith({ permission_denials_count: 4 })).denied, 4);
  assert.equal(parseExecution(logWith({ permission_denials_count: '4' })).denied, null);
  assert.equal(parseExecution(logWith({})).denied, null);
});

test('each denied call is one short line naming the tool and what it tried', () => {
  assert.deepEqual(denialLines(logWith({ permission_denials: DENIED })), [
    'denied: Bash n=$(node "$FACTORY_DIR/scripts/factory-issue.js" x)',
    'denied: Read /tmp/software-factory/lib/a.js',
    'denied: Odd',
  ]);
});

test('denial lines are capped, shortened and single-line; no list gives none', () => {
  const many = Array.from({ length: 30 }, () => ({
    tool_name: 'Bash',
    tool_input: { command: 'echo ' + 'x'.repeat(500) + '\nsecond line' },
  }));
  const lines = denialLines(logWith({ permission_denials: many }));
  assert.equal(lines.length, 10);
  assert.ok(lines.every((l) => l.length <= 100 && !/[\r\n]/.test(l)));
  assert.equal(denialLines(logWith({ permission_denials: many }), 2).length, 2);
  assert.deepEqual(denialLines(logWith({})), []);
  assert.deepEqual(denialLines(''), []);
});

test('the record script prints the denials and stores their count', () => {
  const printed = [];
  let written;
  const code = recordMain(['out.json', 'task', 'add-x', '--execution', 'log.json'], {
    read: () => logWith({ total_cost_usd: 1, permission_denials: DENIED }),
    write: (file, text) => (written = JSON.parse(text)),
    log: (line) => printed.push(line),
  });
  assert.equal(code, 0);
  assert.equal(printed.length, 3);
  assert.equal(written.denied, 3);
});

test('the digest says how many tool calls a run was denied, and nothing when none', () => {
  const run = (denied) => ({
    displayTitle: 'Factory',
    conclusion: 'success',
    url: 'u',
    record: { cost_usd: 0.1, duration_ms: 1000, turns: 2, denied },
  });
  assert.match(
    require('../scripts/factory-digest.js').runLine(run(4)),
    /2 turns, 4 tool call\(s\) denied: u$/,
  );
  assert.doesNotMatch(require('../scripts/factory-digest.js').runLine(run(0)), /denied/);
  assert.doesNotMatch(require('../scripts/factory-digest.js').runLine(run(null)), /denied/);
});

test('a newline or tab inside a denied command never breaks the log line', () => {
  const list = [{ tool_name: 'Bash', tool_input: { command: 'echo a\nb\tc\r\nd' } }];
  assert.deepEqual(denialLines(logWith({ permission_denials: list })), [
    'denied: Bash echo a b c d',
  ]);
});

test('a denial with no tool name still gets a line', () => {
  assert.deepEqual(denialLines(logWith({ permission_denials: [{}] })), ['denied: unknown tool']);
});
