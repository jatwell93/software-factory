'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfigError, loadConfig } = require('../lib/config.js');
const { tempRoot } = require('./helpers.js');

test('loadConfig applies every default to the smallest config', () => {
  const config = loadConfig(tempRoot({}));
  assert.equal(config.default_branch, 'main');
  assert.equal(config.branch_prefix, 'feature/factory-');
  assert.deepEqual(config.protected_paths, []);
  assert.deepEqual(config.review_bots, []);
  assert.equal(config.reviews_timeout_minutes, 30);
  assert.equal(config.spend_cap_usd, 20);
  assert.equal(config.max_turns, 200);
  assert.equal(config.max_babysit_rounds, 5);
  assert.equal(config.timeout_minutes, 80);
  assert.equal(config.change_id_max_length, 42);
  assert.deepEqual(config.runner, { node_version: '22', install: 'npm ci' });
  assert.equal(config.labels.ready, 'factory-ready');
  assert.equal(config.labels.change_prefix, 'factory:');
  assert.deepEqual(config.hooks, { chain: [] });
});

test('loadConfig keeps what the project set', () => {
  const root = tempRoot(
    {},
    {
      extraConfig: ['default_branch: develop', 'runner:', '  install: pip install -r req.txt'],
    },
  );
  const config = loadConfig(root);
  assert.equal(config.default_branch, 'develop');
  assert.deepEqual(config.runner, {
    node_version: '22',
    install: 'pip install -r req.txt',
  });
});

const failures = [
  ['a missing file', { config: null }, /cannot read factory\.config\.yml/],
  ['invalid YAML', { config: 'spec_source: [unclosed' }, /not valid YAML/],
  ['an empty file', { config: '' }, /factory\.config\.yml:/],
  ['a list instead of a map', { config: '- a\n- b' }, /factory\.config\.yml:/],
  ['a missing required key', { config: 'spec_source: openspec\nowner: octo' }, /gates/],
  ['an unknown key', { extraConfig: ['unprotect: [x]'] }, /unprotect|additional/i],
];
for (const [title, options, pattern] of failures) {
  test(`loadConfig throws ConfigError for ${title}`, () => {
    assert.throws(
      () => loadConfig(tempRoot({}, options)),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, pattern);
        return true;
      },
    );
  });
}
