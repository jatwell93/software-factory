const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { main } = require('../scripts/factory-check-change.js');
const { createStubAdapter } = require('./stub-adapter.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const run = (argv, adapter = createStubAdapter()) => {
  const errors = [];
  const status = main(argv, { config, adapter, error: (m) => errors.push(m) });
  return { status, errors };
};

test('an active change lets any run go on', () => {
  for (const mode of ['task', 'archive', 'babysit']) {
    assert.equal(run(['fix-one', mode]).status, 0, mode);
  }
});

test('a missing change fails with an annotation', () => {
  const r = run(['gone', 'task']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.errors, ['::error::no change gone']);
});

test('an archived change lets only a babysit pass go on', () => {
  const adapter = createStubAdapter();
  adapter.archive('fix-one');
  assert.equal(run(['fix-one', 'babysit'], adapter).status, 0);
  assert.equal(run(['fix-one', 'task'], adapter).status, 1);
  assert.equal(run(['fix-one', 'archive'], adapter).status, 1);
});

test('a bad id or mode is a usage error before any read', () => {
  const adapter = {
    listChanges() {
      throw new Error('read');
    },
  };
  for (const argv of [
    ['../x', 'task'],
    ['', 'task'],
    ['fix-one', 'bogus'],
    ['fix-one'],
    ['a'.repeat(43), 'task'],
  ]) {
    assert.equal(run(argv, adapter).status, 2, argv.join(' '));
  }
});
