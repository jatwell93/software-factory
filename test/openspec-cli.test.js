const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { main } = require('../scripts/factory-install-spec-cli.js');
const { createOpenSpecAdapter } = require('../adapters/openspec.js');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = YAML.parse(
  fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'factory.yml'), 'utf8'),
);
const STEPS = WORKFLOW.jobs.run.steps;
const NAME = "Install the spec source's CLI when the project has none";
const CLI = { bin: 'tool', install: ['npm', 'install', '--global', 'tool@1.0.0'] };

/** A fake process runner: `fails` lists the "command args" strings that throw. */
function harness(fails, cli = CLI) {
  const calls = [];
  const out = [];
  const run = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    if (fails.includes(line)) throw new Error(`exit 1: ${line}`);
  };
  const io = {
    adapter: { cli },
    config: {},
    run,
    log: (m) => out.push(m),
    error: (m) => out.push(m),
  };
  return { calls, out, io };
}

test('the run job calls the script after the project install, before Claude runs', () => {
  const at = STEPS.findIndex((s) => s.name === NAME);
  const install = STEPS.findIndex((s) => s.name === "Install the project's dependencies");
  const claude = STEPS.findIndex((s) => s.id === 'claude');
  assert.ok(at !== -1, 'the step exists');
  assert.ok(install < at, "the project's own install runs first, so its copy wins");
  assert.ok(at < claude, 'the CLI is there when the agent runs');
  assert.equal(STEPS[at].run, 'node "$FACTORY_DIR/scripts/factory-install-spec-cli.js"');
});

test('the OpenSpec adapter pins its CLI exactly and skips install scripts', () => {
  const { cli } = createOpenSpecAdapter({ root: ROOT, maxIdLength: 40 });
  assert.equal(cli.bin, 'openspec');
  assert.deepEqual(cli.install.slice(0, 3), ['npm', 'install', '--global']);
  assert.ok(cli.install.includes('--ignore-scripts'));
  assert.match(cli.install.at(-1), /^@fission-ai\/openspec@\d+\.\d+\.\d+$/);
});

test('a CLI the project provides is left alone', () => {
  const { calls, io } = harness([]);
  assert.equal(main(io), 0);
  assert.deepEqual(calls, ['npx --no-install tool --version']);
});

test('a missing CLI is installed, then checked by name', () => {
  const { calls, io } = harness(['npx --no-install tool --version']);
  assert.equal(main(io), 0);
  assert.deepEqual(calls, [
    'npx --no-install tool --version',
    'npm install --global tool@1.0.0',
    'tool --version',
  ]);
});

test('after the install, npx finding the tool is enough', () => {
  const { io } = harness(['tool --version']);
  io.run = ((inner) => (command, args) => {
    if (command === 'npx' && inner.n++ === 0) throw new Error('missing');
    if (command === 'tool') throw new Error('not on PATH');
    return undefined;
  })({ n: 0 });
  assert.equal(main(io), 0);
});

test('a failed install fails the step and says which tool', () => {
  const { calls, out, io } = harness([
    'npx --no-install tool --version',
    'npm install --global tool@1.0.0',
  ]);
  assert.equal(main(io), 1);
  assert.ok(!calls.includes('tool --version'), 'no check after a failed install');
  assert.match(out.join('\n'), /could not install tool/);
});

test('an installed tool that does not run fails the step', () => {
  const { out, io } = harness([
    'npx --no-install tool --version',
    'tool --version',
    // the second npx call is the same string: fail it for every call
  ]);
  io.run = (command, args) => {
    if (command === 'npm') return;
    throw new Error(`exit 1: ${command} ${args.join(' ')}`);
  };
  assert.equal(main(io), 1);
  assert.match(out.join('\n'), /does not run/);
});

test('an adapter with no CLI needs nothing', () => {
  const { calls, io } = harness([], undefined);
  io.adapter = {};
  assert.equal(main(io), 0);
  assert.deepEqual(calls, []);
});

test('run-spec calls the CLI by the name the runner installs it under', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'run-spec', 'SKILL.md'), 'utf8');
  for (const call of ['validate <id> --strict', 'archive <id> -y', 'validate --specs --strict']) {
    assert.ok(skill.includes(`\`openspec ${call}`), call);
  }
  assert.ok(!/`npx openspec (validate|archive)/.test(skill), 'no bare npx call left');
});
