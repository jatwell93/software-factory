const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const {
  DELIMITER,
  JOB_MARGIN_MINUTES,
  envLines,
  multiline,
  main,
} = require('../scripts/factory-env.js');
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
    main([], tempRoot(), (l) => lines.push(l)),
    0,
  );
  assert.equal(lines[0].split('\n').length, 3);
});

test('--run adds the rules, bots, timeouts and a heredoc of agent arguments', () => {
  const config = loadConfig(
    tempRoot({}, { extraConfig: ['timeout_minutes: 30', 'review_bots:', '  - sentry'] }),
  );
  const lines = envLines(config, { run: true });
  assert.ok(lines.includes('rules=.claude AGENTS.md CLAUDE.md factory.config.yml'));
  assert.ok(lines.includes('allowed_bots=sentry[bot],claude[bot],github-actions[bot]'));
  assert.ok(lines.includes('step_timeout=30'));
  assert.ok(lines.includes('job_timeout=' + (30 + JOB_MARGIN_MINUTES)));
  const start = lines.findIndex((l) => l.startsWith('claude_args<<'));
  assert.ok(start !== -1);
  // The heredoc is one array item: header, the arguments, then the closing delimiter.
  const [header, ...body] = lines[start].split('\n');
  const delimiter = header.split('<<')[1];
  assert.equal(body.at(-1), delimiter);
  assert.equal(body[0], '--max-turns 200');
});

test('without --run the agent settings are not computed, so a bad gate cannot break a digest', () => {
  const config = loadConfig(tempRoot());
  config.gates = [{ run: 'echo "x"' }];
  assert.equal(envLines(config).length, 3);
  assert.throws(() => envLines(config, { run: true }), /cannot hold safely/);
});

test('a multi-line output that contains the closing delimiter is refused', () => {
  assert.equal(multiline('k', 'a\nb'), `k<<${DELIMITER}\na\nb\n${DELIMITER}`);
  assert.throws(() => multiline('k', `a\n${DELIMITER}\nb`), /contains FACTORY_OUTPUT_EOF/);
  assert.doesNotThrow(() => multiline('k', `prefix ${DELIMITER} inside a line`));
});
