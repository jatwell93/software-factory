const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { CALLERS } = require('../lib/callers.js');
const { loadConfig } = require('../lib/config.js');
const { SKILLS, runInit, withAgentsBlock } = require('../lib/init.js');
const { parseArgs } = require('../scripts/factory-init.js');

const REF = 'a'.repeat(40);

/** A git checkout of a small Node project with one CI workflow. */
function project({ ci = true, scripts = { lint: 'eslint .', test: 'node --test' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-init-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  if (ci) {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  }
  return { root, git };
}

/** Real git, a recording gh and a recording adapter setup. */
function fakeIo(git, { labels = [], ghError = null, setupError = null } = {}) {
  const calls = { gh: [], setup: 0 };
  return {
    calls,
    git,
    gh: (args) => {
      calls.gh.push(args);
      if (ghError) throw new Error(ghError);
      return args[1] === 'list' ? labels.join('\n') : '';
    },
    setup: () => {
      calls.setup += 1;
      if (setupError) throw new Error(setupError);
    },
  };
}

/** Every file under a root (not .git) with its text, to compare two states. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.git') continue;
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

const statusOf = (result, file) => result.files.find((f) => f.path === file)?.status;

test('init writes the config, callers, skills, AGENTS.md block, hooks and labels', () => {
  const { root, git } = project();
  const io = fakeIo(git);
  const result = runInit({ root, ref: REF }, io);

  const config = loadConfig(root);
  assert.equal(config.owner, 'octo');
  assert.equal(config.spec_source, 'openspec');
  assert.deepEqual(config.gates, [{ run: 'npm run lint' }, { run: 'npm run test' }]);
  assert.deepEqual(config.ci_workflows, ['CI']);
  assert.deepEqual(config.protected_paths, ['package.json', 'package-lock.json']);
  assert.equal(config.runner.install, 'npm ci');

  for (const name of CALLERS) {
    const text = fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    assert.ok(text.includes(REF), `${name} is pinned to the ref`);
    assert.equal(statusOf(result, `.github/workflows/${name}`), 'created');
  }
  for (const skill of SKILLS) {
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', skill, 'SKILL.md')), skill);
  }
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /software-factory:begin/);
  assert.ok(fs.existsSync(path.join(root, '.githooks', 'pre-commit')));
  assert.equal(git(['config', '--get', 'core.hooksPath']), '.githooks');
  assert.equal(statusOf(result, '.githooks/pre-commit'), 'created');
  assert.equal(statusOf(result, '.githooks/pre-push'), 'created');
  assert.equal(config.default_branch, 'main');
  assert.equal(io.calls.setup, 1);
  const created = io.calls.gh.filter((args) => args[0] === 'label' && args[1] === 'create');
  assert.deepEqual(created.map((args) => args[2]).sort(), [
    'factory-digest',
    'factory-ready',
    'factory-retry',
    'factory-retrying',
    'needs-human',
  ]);
  assert.ok(result.steps.some((s) => s.includes('CLAUDE_CODE_OAUTH_TOKEN')));
  assert.deepEqual(result.warnings, []);
});

test('a second run changes nothing', () => {
  const { root, git } = project();
  runInit({ root, ref: REF }, fakeIo(git));
  const before = snapshot(root);
  const io = fakeIo(git, {
    labels: ['factory-digest', 'factory-ready', 'factory-retry', 'factory-retrying', 'needs-human'],
  });
  const result = runInit({ root, ref: REF }, io);

  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(
    result.files.filter((f) => f.status !== 'unchanged'),
    [],
  );
  assert.equal(io.calls.gh.filter((args) => args[1] === 'create').length, 0);
});

test('only the labels the project lacks are created', () => {
  const { root, git } = project();
  const io = fakeIo(git, { labels: ['needs-human', 'factory-ready'] });
  runInit({ root, ref: REF }, io);
  const created = io.calls.gh.filter((args) => args[1] === 'create').map((args) => args[2]);
  assert.deepEqual(created.sort(), ['factory-digest', 'factory-retry', 'factory-retrying']);
});

test('no gate found is a usage error and nothing is written', () => {
  const { root, git } = project({ scripts: {} });
  const before = snapshot(root);
  assert.throws(
    () => runInit({ root, ref: REF }, fakeIo(git)),
    (error) => error.userError && /--gate/.test(error.message),
  );
  assert.deepEqual(snapshot(root), before);
});

test('--gate and --ci-workflow replace what was detected', () => {
  const { root, git } = project({ ci: false });
  runInit({ root, ref: REF, gates: ['make check'], ciWorkflows: ['Build', 'Lint'] }, fakeIo(git));
  const config = loadConfig(root);
  assert.deepEqual(config.gates, [{ run: 'make check' }]);
  assert.deepEqual(config.ci_workflows, ['Build', 'Lint']);
});

test('no CI workflow is a usage error and nothing is written', () => {
  const { root, git } = project({ ci: false });
  const before = snapshot(root);
  assert.throws(
    () => runInit({ root, ref: REF }, fakeIo(git)),
    (error) => error.userError && /--ci-workflow/.test(error.message),
  );
  assert.deepEqual(snapshot(root), before);
});

test('an unpinned ref is refused before anything is written', () => {
  const { root, git } = project();
  const before = snapshot(root);
  assert.throws(() => runInit({ root, ref: 'main' }, fakeIo(git)), /40-character commit SHA/);
  assert.deepEqual(snapshot(root), before);
});

test("the default branch is the remote's, unless --default-branch says otherwise", () => {
  const { root, git } = project();
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  runInit({ root, ref: REF }, fakeIo(git));
  assert.equal(loadConfig(root).default_branch, 'trunk');
  assert.match(fs.readFileSync(path.join(root, '.githooks', 'pre-push'), 'utf8'), /heads\/trunk/);

  const other = project();
  other.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  runInit({ root: other.root, ref: REF, defaultBranch: 'develop' }, fakeIo(other.git));
  assert.equal(loadConfig(other.root).default_branch, 'develop');
});

test('an owner that cannot be told is a usage error', () => {
  const { root, git } = project();
  git(['remote', 'remove', 'origin']);
  assert.throws(
    () => runInit({ root, ref: REF }, fakeIo(git)),
    (error) => error.userError && /--owner/.test(error.message),
  );
});

test('an existing config is never overwritten', () => {
  const { root, git } = project();
  const text = [
    'spec_source: openspec',
    'owner: someone-else',
    'gates:',
    '  - run: make',
    'ci_workflows:',
    '  - Mine',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'factory.config.yml'), text);
  const result = runInit({ root, ref: REF }, fakeIo(git));
  assert.equal(fs.readFileSync(path.join(root, 'factory.config.yml'), 'utf8'), text);
  assert.equal(statusOf(result, 'factory.config.yml'), 'unchanged');
  const relay = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'factory-ci-relay.yml'),
    'utf8',
  );
  assert.match(relay, /'Mine'/);
});

test('an invalid existing config fails init rather than being used', () => {
  const { root, git } = project();
  fs.writeFileSync(path.join(root, 'factory.config.yml'), 'owner: x\n');
  assert.throws(() => runInit({ root, ref: REF }, fakeIo(git)), /factory.config.yml/);
});

test('a differing caller workflow is skipped unless --force', () => {
  const { root, git } = project();
  const file = path.join(root, '.github', 'workflows', 'no-go-guard.yml');
  fs.writeFileSync(file, 'name: mine\n');
  const result = runInit({ root, ref: REF }, fakeIo(git));
  assert.equal(statusOf(result, '.github/workflows/no-go-guard.yml'), 'skipped');
  assert.equal(fs.readFileSync(file, 'utf8'), 'name: mine\n');

  const forced = runInit({ root, ref: REF, force: true }, fakeIo(git));
  assert.equal(statusOf(forced, '.github/workflows/no-go-guard.yml'), 'updated');
  assert.ok(fs.readFileSync(file, 'utf8').includes(REF));
});

test('the factory callers are not offered as CI workflows on a rerun', () => {
  const { root, git } = project();
  runInit({ root, ref: REF }, fakeIo(git));
  fs.rmSync(path.join(root, 'factory.config.yml'));
  runInit({ root, ref: REF }, fakeIo(git));
  assert.deepEqual(loadConfig(root).ci_workflows, ['CI']);
});

test('AGENTS.md keeps its own text and gets one block, replaced in place on a rerun', () => {
  const { root, git } = project();
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guide\n\nMine.\n');
  runInit({ root, ref: REF }, fakeIo(git));
  const once = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(once.startsWith('# Guide\n\nMine.\n'));
  assert.equal(once.split('software-factory:begin').length - 1, 1);

  fs.writeFileSync(path.join(root, 'AGENTS.md'), once.replace('Mine.', 'Mine, edited.'));
  runInit({ root, ref: REF }, fakeIo(git));
  const twice = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.equal(twice.split('software-factory:begin').length - 1, 1);
  assert.match(twice, /Mine, edited\./);
});

test('withAgentsBlock replaces only what is between the markers', () => {
  const block = '<!-- software-factory:begin -->\nNEW\n<!-- software-factory:end -->\n';
  const old =
    'before\n\n<!-- software-factory:begin -->\nOLD\n<!-- software-factory:end -->\n\nafter\n';
  assert.equal(
    withAgentsBlock(old, block),
    'before\n\n<!-- software-factory:begin -->\nNEW\n<!-- software-factory:end -->\n\nafter\n',
  );
  assert.equal(withAgentsBlock(null, block), block);
});

test("a project's own hooks are left alone, with a warning, until --adopt-hooks", () => {
  const { root, git } = project();
  fs.mkdirSync(path.join(root, '.githooks'));
  const own = path.join(root, '.githooks', 'pre-commit');
  fs.writeFileSync(own, '#!/bin/sh\necho mine\n');
  const result = runInit({ root, ref: REF }, fakeIo(git));
  assert.equal(fs.readFileSync(own, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /--adopt-hooks/);
  assert.equal(statusOf(result, '.githooks/pre-commit'), 'skipped');

  const adopted = runInit({ root, ref: REF, adoptHooks: true }, fakeIo(git));
  assert.match(fs.readFileSync(own, 'utf8'), /Written by software-factory/);
  assert.equal(statusOf(adopted, '.githooks/pre-commit'), 'updated');
  assert.equal(git(['config', '--get', 'core.hooksPath']), '.githooks');
});

test('--dry-run writes nothing and calls nothing', () => {
  const { root, git } = project();
  const before = snapshot(root);
  const io = fakeIo(git);
  const result = runInit({ root, ref: REF, dryRun: true }, io);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(io.calls, { gh: [], setup: 0 });
  assert.equal(statusOf(result, 'factory.config.yml'), 'created');
});

test('--no-labels and --no-adapter-setup skip those steps', () => {
  const { root, git } = project();
  const io = fakeIo(git);
  runInit({ root, ref: REF, labels: false, adapterSetup: false }, io);
  assert.deepEqual(io.calls, { gh: [], setup: 0 });
});

test('a failing adapter setup or gh is a warning, not a failed init', () => {
  const { root, git } = project();
  const io = fakeIo(git, { ghError: 'gh: not logged in', setupError: 'openspec: not found' });
  const result = runInit({ root, ref: REF }, io);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => /openspec: not found/.test(w)));
  assert.ok(result.warnings.some((w) => /not logged in/.test(w)));
  assert.ok(fs.existsSync(path.join(root, 'factory.config.yml')));
});

test('outside a git checkout the hooks are skipped with a warning', () => {
  const { root } = project();
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
  const git = () => {
    throw new Error('not a git repository');
  };
  const result = runInit({ root, ref: REF, owner: 'octo' }, fakeIo(git));
  assert.equal(statusOf(result, '.githooks/pre-commit'), 'skipped');
  assert.ok(result.warnings.some((w) => /not a git checkout/.test(w)));
});

test('parseArgs reads values, repeated lists and switches', () => {
  assert.deepEqual(
    parseArgs([
      '--ref',
      'abc',
      '--gate',
      'a',
      '--gate',
      'b',
      '--ci-workflow',
      'CI',
      '--force',
      '--no-labels',
    ]),
    { gates: ['a', 'b'], ciWorkflows: ['CI'], ref: 'abc', force: true, labels: false },
  );
});

test('parseArgs rejects an unknown flag and a flag with no value', () => {
  assert.throws(
    () => parseArgs(['--nope']),
    (error) => error.userError && /unknown argument/.test(error.message),
  );
  assert.throws(
    () => parseArgs(['--owner']),
    (error) => error.userError && /needs a value/.test(error.message),
  );
  assert.throws(() => parseArgs(['--owner', '--force']), /needs a value/);
});

test('--adopt-hooks keeps the project hooks when the installer declines', () => {
  const { root, git } = project();
  git(['config', 'core.hooksPath', 'elsewhere']);
  fs.mkdirSync(path.join(root, '.githooks'));
  const own = path.join(root, '.githooks', 'pre-commit');
  fs.writeFileSync(own, '#!/bin/sh\necho mine\n', { mode: 0o755 });
  const result = runInit({ root, ref: REF, adoptHooks: true }, fakeIo(git));
  assert.equal(fs.readFileSync(own, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(statusOf(result, '.githooks/pre-commit'), 'skipped');
  assert.ok(result.warnings.some((w) => /core.hooksPath is already elsewhere/.test(w)));
  assert.equal(git(['config', '--get', 'core.hooksPath']), 'elsewhere');
});

test('--adopt-hooks keeps the project hooks when the installer throws', () => {
  const { root, git } = project();
  fs.mkdirSync(path.join(root, '.githooks'));
  const own = path.join(root, '.githooks', 'pre-commit');
  fs.writeFileSync(own, '#!/bin/sh\necho mine\n');
  const failing = (args) => {
    if (args[0] === 'config' && args[1] === 'core.hooksPath' && args[2]) throw new Error('boom');
    return git(args);
  };
  assert.throws(() => runInit({ root, ref: REF, adoptHooks: true }, fakeIo(failing)), /boom/);
  assert.equal(fs.readFileSync(own, 'utf8'), '#!/bin/sh\necho mine\n');
});
