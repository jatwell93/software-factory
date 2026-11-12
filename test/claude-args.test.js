const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const {
  allowedBots,
  allowedTools,
  claudeArgs,
  deniedTools,
  prefixesOf,
} = require('../lib/claude-args.js');
const { tempRoot } = require('./helpers.js');

const configWith = (...extra) => loadConfig(tempRoot({}, { extraConfig: extra }));

test('prefixesOf names the program and subcommand of each segment', () => {
  assert.deepEqual(prefixesOf('npm run test:db'), ['npm run']);
  assert.deepEqual(prefixesOf('npm ci'), ['npm ci']);
  assert.deepEqual(prefixesOf('pnpm install --frozen-lockfile'), ['pnpm install']);
  assert.deepEqual(prefixesOf('pytest -q tests'), ['pytest']);
  assert.deepEqual(prefixesOf('make'), ['make']);
  assert.deepEqual(prefixesOf('(cd workers && npm run typecheck)'), ['cd', 'npm run']);
  assert.deepEqual(prefixesOf('npm run lint; npm test || true'), ['npm run', 'npm test', 'true']);
});

test("the allowed tools are the fixed ones, the adapter's, and the gates' and install commands", () => {
  const config = configWith();
  config.gates = [
    { run: 'npm run test:db' },
    { when: ['workers/**'], run: '(cd workers && npm run typecheck)' },
  ];
  config.runner.install = 'pnpm install --frozen-lockfile';
  const tools = allowedTools(config);
  for (const expected of ['Read', 'Bash(git:*)', 'Bash(node:*)', 'Bash(npx openspec:*)']) {
    assert.ok(tools.includes(expected), expected);
  }
  for (const derived of ['Bash(npm run:*)', 'Bash(cd:*)', 'Bash(pnpm install:*)']) {
    assert.ok(tools.includes(derived), derived);
  }
  assert.ok(!tools.includes('Bash(npm ci:*)'), 'npm ci only when the install says so');
  assert.equal(new Set(tools).size, tools.length, 'no duplicates');
});

test('the project cannot add a shell-unsafe prefix to the tool list', () => {
  for (const run of ['echo "x" && true', 'run $(x)', 'run `x`']) {
    const config = configWith();
    config.gates = [{ run }];
    assert.throws(() => allowedTools(config), /cannot hold safely/, run);
  }
  const install = configWith();
  install.runner.install = '$(x) ci';
  assert.throws(() => allowedTools(install), /runner\.install has a command/);
  const forbidden = configWith();
  forbidden.forbidden_commands = ['a"b'];
  assert.throws(() => deniedTools(forbidden), /forbidden_commands has a command/);
});

test('the denied tools are the fixed ones plus forbidden_commands, and never fewer', () => {
  const denied = deniedTools(
    configWith('forbidden_commands:', '  - npm run test:prod', '  - doppler'),
  );
  for (const fixed of [
    'Bash(gh pr merge:*)',
    'Bash(gh pr review:*)',
    'Bash(gh api:*)',
    'Bash(curl:*)',
  ]) {
    assert.ok(denied.includes(fixed), fixed);
  }
  assert.ok(denied.includes('Bash(npm run test:prod:*)') && denied.includes('Bash(doppler:*)'));
  assert.equal(deniedTools(configWith()).length, 7);
});

test('claudeArgs carries the caps and both tool lists, one option per line', () => {
  const lines = claudeArgs(configWith('max_turns: 50', 'spend_cap_usd: 7.5')).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '--max-turns 50');
  assert.equal(lines[1], '--max-budget-usd 7.5');
  assert.match(lines[2], /^--allowedTools "Read,Edit,.*Bash\(npm test:\*\)/);
  assert.match(lines[3], /^--disallowedTools "Bash\(gh pr merge:\*\),/);
  assert.equal(claudeArgs(configWith()).split('\n')[0], '--max-turns 200');
});

test("review bots get the [bot] suffix, and the factory's own actors are always allowed", () => {
  assert.equal(allowedBots(configWith()), 'claude[bot],github-actions[bot]');
  assert.equal(
    allowedBots(configWith('review_bots:', '  - sentry', '  - copilot-pull-request-reviewer')),
    'sentry[bot],copilot-pull-request-reviewer[bot],claude[bot],github-actions[bot]',
  );
  assert.equal(
    allowedBots(configWith('review_bots:', '  - claude')),
    'claude[bot],github-actions[bot]',
    'no duplicate',
  );
});

test('prefixesOf gives a prefix to every line of a multi-line gate, and to each side of a pipe', () => {
  assert.deepEqual(prefixesOf('npm run lint\nnpm test\r\nmake check'), [
    'npm run',
    'npm test',
    'make check',
  ]);
  assert.deepEqual(prefixesOf('npm run lint | tee out.txt'), ['npm run', 'tee out.txt']);
  assert.deepEqual(prefixesOf('npm run build & npm test'), ['npm run', 'npm test']);
  assert.deepEqual(prefixesOf('npm run build \\n  --workspaces\nnpm test'), [
    'npm run',
    'npm test',
  ]);
  assert.deepEqual(prefixesOf('# lint first\nnpm run lint\n\n  # then test\nnpm test'), [
    'npm run',
    'npm test',
  ]);
});

test('a multi-line gate allows the program on every line', () => {
  const config = configWith();
  config.gates = [{ run: 'npm run lint\ncargo test\n' }];
  const tools = allowedTools(config);
  assert.ok(tools.includes('Bash(npm run:*)') && tools.includes('Bash(cargo test:*)'));
});
