const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');
const { main } = require('../scripts/factory-issue.js');
const { createStubAdapter } = require('./stub-adapter.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());

function setup(extra = {}) {
  const calls = [];
  const lines = [];
  const io = {
    config,
    adapter: createStubAdapter(),
    gh: (args) => {
      calls.push(args);
      return args[1] === 'list' ? '[{"number":703}]' : '';
    },
    out: (line) => lines.push(line),
    error: () => {},
    ...extra,
  };
  return { io, calls, lines };
}

test('main prints the tracking issue number', () => {
  const { io, lines } = setup();
  assert.equal(main(['fix-one'], io), 0);
  assert.deepEqual(lines, ['703']);
});

test("main rejects an id whose label would pass GitHub's 50 characters", () => {
  const { io, calls } = setup();
  assert.equal(main(['a'.repeat(43)], io), 2);
  assert.equal(calls.length, 0, 'no label, issue or comment is attempted');
});

test('main rejects an unsafe change id', () => {
  const { io, calls } = setup();
  assert.equal(main(['../x'], io), 2);
  assert.equal(main([], io), 2);
  assert.equal(calls.length, 0);
});

test('main takes the id limit from the config', () => {
  const short = loadConfig(tempRoot({}, { extraConfig: ['change_id_max_length: 8'] }));
  assert.equal(main(['abcdefghi'], setup({ config: short }).io), 2);
  assert.equal(main(['abcdefgh'], setup({ config: short }).io), 0);
});

test('a malformed proposal is reported to the runner, not swallowed', () => {
  const root = tempRoot({
    odd: '# Odd\n\n## Autonomy\n\n```yaml\nno_go: nonsense\n```\n',
  });
  const { io } = setup({ adapter: loadAdapter(config, { root }), gh: () => '[]' });
  assert.throws(
    () => main(['odd'], io),
    (error) => error.userError === true,
  );
});
