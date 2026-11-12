const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { envLines, main } = require('../scripts/factory-env.js');
const { tempRoot } = require('./helpers.js');

test('prints the defaults for a minimal config', () => {
  assert.deepEqual(envLines(loadConfig(tempRoot())), [
    'node_version=22',
    'install=npm ci',
    'default_branch=main',
  ]);
});

test('prints the configured Node version, install command and default branch', () => {
  const config = loadConfig(
    tempRoot(
      {},
      {
        extraConfig: [
          'default_branch: trunk',
          'runner:',
          '  node_version: "20.11"',
          '  install: pnpm install --frozen-lockfile',
        ],
      },
    ),
  );
  assert.deepEqual(envLines(config), [
    'node_version=20.11',
    'install=pnpm install --frozen-lockfile',
    'default_branch=trunk',
  ]);
});

test('refuses a value with a line break, which would write a second output line', () => {
  const config = loadConfig(tempRoot());
  config.runner.install = 'npm ci\nmalicious=1';
  assert.throws(() => envLines(config), /install cannot contain a line break/);
});

test('main reads the config in the folder it is given', () => {
  const lines = [];
  assert.equal(
    main(tempRoot(), (l) => lines.push(l)),
    0,
  );
  assert.equal(lines[0].split('\n').length, 3);
});
