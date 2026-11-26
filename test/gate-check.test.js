const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { staticGateProblems, tryGates } = require('../lib/gate-check.js');
const { runDoctor } = require('../lib/doctor.js');
const { runInit } = require('../lib/init.js');
const { main } = require('../scripts/factory-doctor.js');

/** A project folder with the given files (path -> text). */
function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-gates-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const pkg = (scripts) => JSON.stringify({ scripts });
const problems = (root, ...runs) =>
  staticGateProblems(
    root,
    runs.map((run) => ({ run })),
  );

test('tsc from a root with no tsconfig.json is a problem, naming the folder that has one', () => {
  const root = project({ 'frontend/tsconfig.json': '{}', 'package.json': pkg({}) });
  const [found] = problems(root, 'tsc --noEmit');
  assert.equal(found.gate, 'tsc --noEmit');
  assert.match(found.problem, /no tsconfig\.json/);
  assert.match(found.problem, /tsc -p frontend/);
});

test('tsc is fine with -p, --project, -b, named files, or a tsconfig.json in the root', () => {
  const root = project({ 'package.json': pkg({}) });
  for (const run of [
    'tsc -p frontend',
    'tsc --project=frontend',
    'tsc -b',
    'npx tsc src/a.ts',
    'tsc --version',
  ]) {
    assert.deepEqual(problems(root, run), [], run);
  }
  const withConfig = project({ 'tsconfig.json': '{}', 'package.json': pkg({}) });
  assert.deepEqual(problems(withConfig, 'tsc --noEmit'), []);
});

test('a package script is followed: npm run typecheck that runs a bare tsc is found', () => {
  const root = project({
    'package.json': pkg({ typecheck: 'tsc --noEmit', check: 'npm run typecheck && echo ok' }),
  });
  assert.equal(problems(root, 'npm run check').length, 1);
  assert.match(problems(root, 'npm run check')[0].problem, /tsc/);
  assert.deepEqual(problems(project({ 'package.json': pkg({ test: 'echo hi' }) }), 'npm test'), []);
});

test('a package script that does not exist is a problem; a folder-moving command is not checked', () => {
  const root = project({ 'package.json': pkg({ test: 'echo hi' }) });
  assert.match(problems(root, 'npm run lint')[0].problem, /no script "lint"/);
  assert.deepEqual(problems(root, 'npm --prefix frontend run lint'), []);
  assert.deepEqual(problems(root, 'cd frontend && npm test'), []);
});

test('a program that is nowhere to be found is a problem; one in node_modules/.bin is not', () => {
  const root = project({ 'package.json': pkg({}) });
  assert.match(problems(root, 'no-such-tool-xyz --fast')[0].problem, /not on PATH/);
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'my-tool'), '');
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'my-tool.cmd'), '');
  assert.deepEqual(problems(root, 'my-tool --fast'), []);
  assert.deepEqual(problems(root, 'node --version'), []);
});

test('a tool a script names is not flagged before the project is installed here', () => {
  const root = project({ 'package.json': pkg({ lint: 'no-such-tool-xyz .' }) });
  assert.deepEqual(problems(root, 'npm run lint'), []);
  fs.mkdirSync(path.join(root, 'node_modules'));
  assert.match(problems(root, 'npm run lint')[0].problem, /no-such-tool-xyz/);
});

test('the same problem in a gate is reported once', () => {
  const root = project({ 'package.json': pkg({}) });
  assert.equal(problems(root, 'tsc && tsc --noEmit').length, 1);
});

test('tryGates runs each gate once and reports status and the first error line', () => {
  const calls = [];
  const runGate = (run, root, timeoutMs) => {
    calls.push([run, timeoutMs]);
    if (run === 'good') return { code: 0, output: 'warning: noisy but fine' };
    if (run === 'slow') return { code: null, timedOut: true, output: '' };
    return { code: 2, output: 'starting\nerror TS5057: Cannot find a tsconfig.json file\nbye\n' };
  };
  const [good, bad, slow] = tryGates('.', [{ run: 'good' }, { run: 'bad' }, { run: 'slow' }], {
    runGate,
    timeoutMs: 5000,
  });
  assert.deepEqual(calls, [
    ['good', 5000],
    ['bad', 5000],
    ['slow', 5000],
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.error, '');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 2);
  assert.match(bad.error, /TS5057/);
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
});

test('tryGates really runs a command from the root and sees its exit status', () => {
  const root = project({ 'marker.txt': 'x' });
  const gates = [
    { run: `node -e "process.exit(require('fs').existsSync('marker.txt') ? 0 : 1)"` },
    { run: `node -e "console.error('boom here'); process.exit(3)"` },
  ];
  const [here, fails] = tryGates(root, gates, { timeoutMs: 20000 });
  assert.equal(here.ok, true);
  assert.equal(fails.code, 3);
  assert.match(fails.error, /boom here/);
});

function initialised(gate) {
  const root = project({
    'package.json': pkg({ test: 'node --version' }),
    'package-lock.json': '{}',
    'frontend/tsconfig.json': '{}',
    '.github/workflows/ci.yml': 'name: Test\non: push\n',
  });
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  const result = runInit(
    { root, ref: 'a'.repeat(40), labels: false, adapterSetup: false, gates: [gate] },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git, result };
}
const gh = () => {
  throw new Error('no network');
};
const find = (results, name) => results.find((r) => r.name === name);

test('init warns about a gate that cannot pass, naming the fix, and stays quiet otherwise', () => {
  const bad = initialised('tsc --noEmit').result.warnings.filter((w) => /^gate /.test(w));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /gate `tsc --noEmit`: .*tsc -p frontend/);
  assert.deepEqual(
    initialised('node --version').result.warnings.filter((w) => /^gate /.test(w)),
    [],
  );
});

test('doctor warns about a gate that cannot pass without running it, and is ok otherwise', () => {
  const bad = initialised('tsc --noEmit');
  const found = find(runDoctor(bad.root, { git: bad.git, gh }), 'gates');
  assert.equal(found.status, 'warn');
  assert.match(found.detail, /tsc -p frontend/);
  const good = initialised('node --version');
  assert.equal(find(runDoctor(good.root, { git: good.git, gh }), 'gates').status, 'ok');
});

test('doctor --try-gates adds one result per gate with its status; without it no gate runs', () => {
  const { root, git } = initialised('node --version');
  const ran = [];
  const runGate = (run) => {
    ran.push(run);
    return { code: 1, output: 'Error: nope\n' };
  };
  const quiet = runDoctor(root, { git, gh, runGate });
  assert.deepEqual(ran, []);
  assert.ok(!quiet.some((r) => r.name.startsWith('gate ')));
  const results = runDoctor(root, { git, gh, runGate, tryGates: true, gateTimeoutMs: 1000 });
  const one = find(results, 'gate node --version');
  assert.equal(one.status, 'warn');
  assert.match(one.detail, /exit 1 from the repository root: Error: nope/);
  const passing = runDoctor(root, { git, gh, tryGates: true });
  assert.equal(find(passing, 'gate node --version').status, 'ok');
});

test('the doctor script takes --try-gates and --gate-timeout <seconds>, and rejects the rest', () => {
  const { root, git } = initialised('node --version');
  const out = [];
  const code = main(['--try-gates', '--gate-timeout', '30'], root, (l) => out.push(l), {
    git,
    gh,
  });
  assert.equal(code, 0);
  for (const argv of [
    ['--gate-timeout', '30'],
    ['--try-gates', '--gate-timeout'],
    ['--try-gates', '--gate-timeout', '0'],
    ['--try-gates', '--gate-timeout', 'x'],
  ]) {
    assert.throws(
      () => main(argv),
      (error) => error.userError,
      argv.join(' '),
    );
  }
});
