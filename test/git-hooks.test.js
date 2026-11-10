const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');
const { renderHooks, renderPreCommit, renderPrePush, writeHooks } = require('../lib/hooks.js');
const { main: install } = require('../scripts/install-git-hooks.js');
const { tempRoot } = require('./helpers.js');

const configWith = (...extra) => loadConfig(tempRoot({}, { extraConfig: extra }));
const config = configWith();

/** A temp repo whose default branch is `branch`, with a bare remote and the hooks written. */
function makeRepo(cfg = config, branch = cfg.default_branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-'));
  const repo = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '--bare', remote]);
  spawnSync('git', ['init', '-q', '-b', branch, repo]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', remote);
  writeHooks(repo, cfg);
  git('config', 'core.hooksPath', '.githooks');
  return { git, repo };
}

test('pre-commit refuses a commit on the default branch and allows one on a feature branch', () => {
  const { git } = makeRepo();
  const onMain = git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.notEqual(onMain.status, 0);
  assert.match(onMain.stderr, /refusing to commit on main/);
  git('switch', '-q', '-c', 'feature/x');
  assert.equal(git('commit', '-q', '--allow-empty', '-m', 'x').status, 0);
});

test('a project with another default branch is protected under that name only', () => {
  const trunk = configWith('default_branch: trunk');
  const { git } = makeRepo(trunk);
  const refused = git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to commit on trunk/);
  git('switch', '-q', '-c', 'main');
  assert.equal(git('commit', '-q', '--allow-empty', '-m', 'x').status, 0, 'main is just a branch');
});

test('pre-push refuses any push that updates the default branch, however it is spelled', () => {
  const { git } = makeRepo();
  git('switch', '-q', '-c', 'feature/x');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  for (const spec of ['HEAD:main', 'feature/x:main', 'HEAD:refs/heads/main']) {
    const r = git('push', '-q', 'origin', spec);
    assert.notEqual(r.status, 0, spec);
    assert.match(r.stderr, /refusing to push to main/, spec);
  }
  assert.equal(git('push', '-q', 'origin', 'feature/x').status, 0);
});

test('pre-push guards the configured default branch, not main', () => {
  const trunk = configWith('default_branch: trunk');
  const { git } = makeRepo(trunk, 'feature/start');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  const refused = git('push', '-q', 'origin', 'HEAD:trunk');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refusing to push to trunk/);
  assert.equal(git('push', '-q', 'origin', 'HEAD:main').status, 0);
});

test('hooks.chain commands run after the check, and one that fails refuses the commit', () => {
  const failing = configWith('hooks:', '  chain:', '    - echo scan-failed >&2; false #');
  const { git } = makeRepo(failing);
  git('switch', '-q', '-c', 'feature/x');
  const r = git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /scan-failed/);

  const passing = configWith('hooks:', '  chain:', '    - echo scan-ran >&2 #');
  const ok = makeRepo(passing);
  ok.git('switch', '-q', '-c', 'feature/x');
  const done = ok.git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.equal(done.status, 0);
  assert.match(done.stderr, /scan-ran/);
});

test('the chain does not run on the default branch: the refusal comes first', () => {
  const chained = configWith('hooks:', '  chain:', '    - echo scan-ran >&2 #');
  const { git } = makeRepo(chained);
  const r = git('commit', '-q', '--allow-empty', '-m', 'x');
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /scan-ran/);
});

test('a branch name that is not safe in a shell script, or a control character, is refused', () => {
  for (const defaultBranch of ['main"; rm -rf ~ #', '$(x)', '-x', 'a b', '']) {
    assert.throws(
      () => renderPreCommit({ defaultBranch }),
      /cannot go in a git hook/,
      defaultBranch,
    );
    assert.throws(() => renderPrePush({ defaultBranch }), /cannot go in a git hook/, defaultBranch);
  }
  assert.throws(
    () => renderPreCommit({ defaultBranch: 'main', chain: ['ok\nrm -rf ~'] }),
    /control character/,
  );
  assert.match(renderPreCommit({ defaultBranch: 'release/2026.1' }), /release\/2026\.1/);
});

test('renderHooks and writeHooks produce executable pre-commit and pre-push files', () => {
  assert.deepEqual(Object.keys(renderHooks(config)), ['pre-commit', 'pre-push']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  assert.deepEqual(writeHooks(root, config), ['pre-commit', 'pre-push']);
  for (const name of ['pre-commit', 'pre-push']) {
    const file = path.join(root, '.githooks', name);
    assert.match(fs.readFileSync(file, 'utf8'), /^#!\/bin\/sh\n/);
    if (process.platform !== 'win32')
      assert.ok(fs.statSync(file).mode & 0o100, `${name} is executable`);
  }
});

const unset = () => {
  throw new Error('unset');
};

/** Fake git and directory listing for the installer. */
function installDeps({ hooksPath = '', files = [] } = {}) {
  const calls = [];
  const writes = [];
  const answers = {
    'config --get': hooksPath ? () => hooksPath : unset,
    'rev-parse --git-path': () => hooksPath || '.git/hooks',
  };
  const git = (args) => {
    calls.push(args);
    return (answers[args.slice(0, 2).join(' ')] || (() => 'true'))();
  };
  return { calls, writes, git, list: () => files, write: (...a) => writes.push(a) };
}

const setHooksPath = (calls) => calls.some((a) => a[0] === 'config' && a[1] === 'core.hooksPath');

test('install writes the hooks and sets core.hooksPath in a checkout, and skips outside one', () => {
  const deps = installDeps({ files: ['pre-commit.sample'] });
  assert.match(install(config, deps), /^git hooks installed/);
  assert.deepEqual(deps.calls.at(-1), ['config', 'core.hooksPath', '.githooks']);
  assert.equal(deps.writes.length, 1);
  assert.match(install(config, installDeps({ hooksPath: '.githooks' })), /^git hooks installed/);
  const skipped = install(config, {
    git: () => {
      throw new Error('not a repo');
    },
    list: () => [],
  });
  assert.match(skipped, /not a git checkout/);
});

test('install never replaces hooks someone set up already, and writes nothing then', () => {
  const elsewhere = installDeps({ hooksPath: '.husky' });
  assert.match(install(config, elsewhere), /already \.husky/);
  assert.ok(!setHooksPath(elsewhere.calls));
  assert.equal(elsewhere.writes.length, 0);
  const local = installDeps({ files: ['pre-commit', 'pre-push.sample'] });
  assert.match(install(config, local), /already has hooks \(pre-commit\)/);
  assert.ok(!setHooksPath(local.calls));
  assert.equal(local.writes.length, 0);
});

test('install treats a git-secrets hook like any other hook of the project', () => {
  const secrets = installDeps({ files: ['pre-commit', 'commit-msg'] });
  assert.match(install(config, secrets), /already has hooks \(pre-commit, commit-msg\)/);
  assert.ok(!setHooksPath(secrets.calls));
});
