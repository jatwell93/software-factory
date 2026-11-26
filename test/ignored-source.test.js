const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ignoredSource } = require('../lib/ignored-source.js');
const { main } = require('../scripts/check-ignored.js');
const { runDoctor } = require('../lib/doctor.js');
const { runInit } = require('../lib/init.js');

/** A real git repository: tracked backend/routers/a.py, then an ignore rule that hides the folder. */
function repo({ ignore = 'backend/routers/\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ignored-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).replace(/\n$/, '');
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 'x']);
  const write = (rel, text = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('backend/routers/a.py');
  write('backend/main.py');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'one']);
  if (ignore) write('.gitignore', ignore);
  return { root, git, write };
}

test('a new source file in an ignored folder that git tracks is found, with its rule', () => {
  const { git, write } = repo();
  write('backend/routers/url_validation.py');
  const found = ignoredSource(git);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'backend/routers/url_validation.py');
  assert.match(found[0].rule, /\.gitignore:1 backend\/routers\//);
});

test('nothing is reported when no rule hides a source file', () => {
  const { git, write } = repo({ ignore: '' });
  write('backend/routers/b.py');
  assert.deepEqual(ignoredSource(git), []);
});

test('files meant to be ignored are left alone: whole folders, .env, logs, caches', () => {
  const { git, write } = repo({ ignore: 'node_modules/\n.env\n*.log\n__pycache__/\n*.pyc\n' });
  write('node_modules/pkg/index.js');
  write('.env');
  write('backend/run.log');
  write('backend/__pycache__/a.cpython-312.pyc');
  assert.deepEqual(ignoredSource(git), []);
});

test('a file name with spaces is reported whole', () => {
  const { git, write } = repo({ ignore: 'backend/routers/\n' });
  write('backend/routers/my file.py');
  assert.deepEqual(
    ignoredSource(git).map((f) => f.file),
    ['backend/routers/my file.py'],
  );
});

test('the script exits 1 and names each file and rule, or 0 when there are none', () => {
  const clean = repo({ ignore: '' });
  const out = [];
  assert.equal(main({ git: clean.git, log: (l) => out.push(l) }), 0);
  assert.match(out[0], /no ignored source files/);

  const bad = repo();
  bad.write('backend/routers/new.py');
  const lines = [];
  assert.equal(main({ git: bad.git, log: (l) => lines.push(l) }), 1);
  assert.match(
    lines[0],
    /^ignored: backend\/routers\/new\.py \(\.gitignore:1 backend\/routers\/\)$/,
  );
  assert.match(lines.at(-1), /1 source file\(s\) that git add will skip. Do not push/);
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ignored-doctor-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).replace(/\n$/, '');
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  runInit({ root, ref: 'a'.repeat(40) }, { git, gh: () => '', setup: () => {} });
  return { root, git };
}
const find = (results) => results.find((r) => r.name === 'ignored source');

test('doctor warns about an ignored source file, naming it and the rule', () => {
  const { root, git } = project();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'kept.js'), 'x\n');
  git(['add', 'src/kept.js']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'src/*.js\n!src/kept.js\n');
  fs.writeFileSync(path.join(root, 'src', 'lost.js'), 'x\n');
  const result = find(runDoctor(root, { git, gh: () => '' }));
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /src\/lost\.js/);
  assert.match(result.detail, /\.gitignore:1 src\/\*\.js/);
  assert.match(result.fix, /narrow the rule|git add -f/);
});

test('doctor is ok when nothing is hidden, and skips outside a git checkout', () => {
  const { root, git } = project();
  assert.equal(find(runDoctor(root, { git, gh: () => '' })).status, 'ok');
  const none = () => {
    throw new Error('fatal: not a git repository');
  };
  assert.equal(find(runDoctor(root, { git: none, gh: () => '' })).status, 'skip');
});

test('a new subfolder of an ignored folder is opened, however deep', () => {
  const { git, write } = repo();
  write('backend/routers/v2/deep/new.py');
  write('backend/routers/v2/notes.txt');
  const found = ignoredSource(git);
  assert.deepEqual(
    found.map((f) => f.file),
    ['backend/routers/v2/deep/new.py'],
  );
  assert.match(found[0].rule, /\.gitignore:1 backend\/routers\//);
});

test('a source folder that is ignored whole is reported; dependency, build and dot folders are not', () => {
  const { git, write } = repo({ ignore: 'generated/\ndist/\n.cache/\nnode_modules/\n' });
  write('generated/api.ts');
  write('dist/bundle.js');
  write('.cache/x.js');
  write('backend/node_modules/pkg/index.js');
  assert.deepEqual(
    ignoredSource(git).map((f) => f.file),
    ['generated/api.ts'],
  );
});
