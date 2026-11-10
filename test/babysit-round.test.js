const test = require('node:test');
const assert = require('node:assert/strict');

const { highestRound, parseArgs, main } = require('../scripts/babysit-round.js');
const { tempRoot } = require('./helpers.js');

/** A fake git: `taskSha` answers the Factory-Task lookup, `trailers` the round log. */
function run(argv, trailers, taskSha = '', root = tempRoot()) {
  const out = { log: [], error: [], gitArgs: null };
  const code = main(argv, {
    root,
    git: (args) => {
      if (args.includes('-1')) return taskSha ? `${taskSha}\n` : '';
      out.gitArgs = args;
      return trailers;
    },
    log: (s) => out.log.push(s),
    error: (s) => out.error.push(s),
  });
  return { code, ...out };
}

test('no trailers: round 0, the first round is allowed', () => {
  const r = run([], '\n\n');
  assert.equal(r.code, 0);
  assert.deepEqual(r.log, ['round=0 next=1 capped=false']);
  assert.deepEqual(r.gitArgs, [
    'log',
    'origin/main..HEAD',
    '--format=%(trailers:key=Babysit-Round,valueonly)',
  ]);
});

test('rounds 1 to 4: the highest counts and another round is allowed', () => {
  for (const n of [1, 2, 3, 4]) {
    const trailers = Array.from({ length: n }, (_, i) => String(i + 1)).join('\n\n');
    const r = run([], `${trailers}\n`);
    assert.equal(r.code, 0, `round ${n}`);
    assert.deepEqual(r.log, [`round=${n} next=${n + 1} capped=false`]);
  }
});

test('round 5: capped, exit 3', () => {
  const r = run([], '3\n\n5\n\n4\n');
  assert.equal(r.code, 3);
  assert.deepEqual(r.log, ['round=5 next=6 capped=true']);
});

test('highestRound ignores blank and non-numeric values', () => {
  assert.equal(highestRound('\n2\nabc\n 7 \n'), 7);
  assert.equal(highestRound(''), 0);
});

test('--base and --max are honoured; bad arguments exit 2', () => {
  assert.deepEqual(parseArgs(['--base', 'origin/dev', '--max', '3']), {
    base: 'origin/dev',
    max: 3,
  });
  const r = run(['--max', '2'], '2\n');
  assert.equal(r.code, 3);
  assert.equal(run(['--max', 'x'], '').code, 2);
  assert.equal(run(['--bogus'], '').code, 2);
});

test('rounds count only after the newest Factory-Task commit (one PR per change)', () => {
  const r = run([], '2\n', 'abc123');
  assert.equal(r.code, 0);
  assert.deepEqual(r.gitArgs, [
    'log',
    'abc123..HEAD',
    '--format=%(trailers:key=Babysit-Round,valueonly)',
  ]);
});

test('the base branch and the round cap come from factory.config.yml', () => {
  const root = tempRoot({}, { extraConfig: ['default_branch: develop', 'max_babysit_rounds: 2'] });
  const r = run([], '1\n\n2\n', '', root);
  assert.equal(r.code, 3, 'two rounds reach a cap of 2');
  assert.deepEqual(r.log, ['round=2 next=3 capped=true']);
  assert.equal(r.gitArgs[1], 'origin/develop..HEAD');
});

test('a flag overrides the config', () => {
  const root = tempRoot({}, { extraConfig: ['default_branch: develop', 'max_babysit_rounds: 2'] });
  const r = run(['--base', 'origin/release', '--max', '9'], '1\n\n2\n', '', root);
  assert.equal(r.code, 0);
  assert.equal(r.gitArgs[1], 'origin/release..HEAD');
});

test('a missing or invalid config exits 2 and says so', () => {
  const missing = run([], '', '', tempRoot({}, { config: null }));
  assert.equal(missing.code, 2);
  assert.match(missing.error[0], /^babysit-round: cannot read factory\.config\.yml/);
  const invalid = run([], '', '', tempRoot({}, { extraConfig: ['max_babysit_rounds: 0'] }));
  assert.equal(invalid.code, 2);
});
