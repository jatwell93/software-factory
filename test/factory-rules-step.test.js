// Runs the run job's "use the default branch's copy of the project's rules" step for
// real, in a temp git repo, because what it does to a working tree is what makes a
// babysit pass safe from the PR it reviews.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { RULES } = require('../lib/baseline.js');

const WORKFLOW = YAML.parse(
  fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'factory.yml'), 'utf8'),
);
const STEP = WORKFLOW.jobs.run.steps.find((s) => (s.name || '').includes("project's rules"));
const hasBash = spawnSync('bash', ['--version']).status === 0;

/**
 * A checkout of a PR branch. `main` holds `mainFiles`; the PR branch starts from
 * it and then applies `edit(repo)`, committed. The step runs with the PR branch
 * checked out.
 */
function setup(mainFiles, edit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-step-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'work');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  spawnSync('git', ['init', '-q', '--bare', remote]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', remote);
  for (const [file, text] of Object.entries(mainFiles)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'main');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'pr');
  edit(repo);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'pr');
  const run = () => {
    const r = spawnSync('bash', ['-c', STEP.run], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFAULT_BRANCH: 'main',
        RULES: RULES.join(' '),
        RUNNER_TEMP: root,
      },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  // A Windows checkout may turn line endings into CRLF; the content is what matters.
  const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');
  const exists = (file) => fs.existsSync(path.join(repo, file));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };
  return { git, run, read, exists, write };
}

const skip = hasBash ? false : 'bash is not available';

test(
  'a rule the PR edited is restored from the default branch, and never shows as a change',
  { skip },
  () => {
    const t = setup({ 'CLAUDE.md': 'main rules\n', 'src/a.js': 'a\n' }, (repo) =>
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'pr rules\n'),
    );
    t.run();
    assert.equal(t.read('CLAUDE.md'), 'main rules\n');
    assert.equal(t.git('status', '--porcelain').trim(), '', 'nothing for git add to pick up');
    t.git('add', '-A');
    assert.equal(t.git('diff', '--cached', '--name-only').trim(), '');
  },
);

test(
  'a rule file the PR added, which the default branch lacks, is removed and stays out of a commit',
  { skip },
  () => {
    const t = setup({ 'src/a.js': 'a\n' }, (repo) => {
      fs.mkdirSync(path.join(repo, '.claude', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"pr":true}\n');
      fs.writeFileSync(path.join(repo, '.claude', 'skills', 'mine.md'), 'steer\n');
      fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'pr agents\n');
    });
    t.run();
    for (const file of ['.claude/settings.json', '.claude/skills/mine.md', 'AGENTS.md']) {
      assert.equal(t.exists(file), false, `${file} is gone from the working tree`);
    }
    assert.equal(t.git('status', '--porcelain').trim(), '', 'their removal is hidden from git add');
    t.write('src/b.js', 'b\n');
    t.git('add', '-A');
    assert.equal(
      t.git('diff', '--cached', '--name-only').trim(),
      'src/b.js',
      'only real work commits',
    );
  },
);

test(
  'a PR file outside the rules is left alone, and a rule the PR deleted is restored',
  { skip },
  () => {
    const t = setup({ 'CLAUDE.md': 'main\n', '.claude/x.md': 'x\n', 'src/a.js': 'a\n' }, (repo) => {
      fs.rmSync(path.join(repo, 'CLAUDE.md'));
      fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'changed\n');
      fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'new\n');
    });
    t.run();
    assert.equal(t.read('CLAUDE.md'), 'main\n');
    assert.equal(t.read('src/a.js'), 'changed\n');
    assert.equal(t.read('src/new.js'), 'new\n');
    t.git('add', '-A');
    assert.equal(
      t.git('diff', '--cached', '--name-only').trim(),
      '',
      'src work is already committed',
    );
  },
);

test(
  'a default branch with none of the rules is fine, and the PR copies still go',
  { skip },
  () => {
    const t = setup({ 'src/a.js': 'a\n' }, (repo) =>
      fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'pr only\n'),
    );
    t.run();
    assert.equal(t.exists('CLAUDE.md'), false);
  },
);

test('a rules file with an unusual name is handled byte-safely', { skip }, () => {
  const t = setup({ 'src/a.js': 'a\n' }, (repo) => {
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'with space é.md'), 'x\n');
  });
  t.run();
  assert.equal(t.exists('.claude/with space é.md'), false);
});
