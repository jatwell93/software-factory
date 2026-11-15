const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { sameText } = require('../lib/text.js');
const { runInit } = require('../lib/init.js');
const { runDoctor } = require('../lib/doctor.js');
const { runUpgrade } = require('../lib/upgrade.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';

test('sameText ignores CRLF against LF and nothing else', () => {
  assert.equal(sameText('a\nb\n', 'a\r\nb\r\n'), true);
  assert.equal(sameText('a\r\nb', 'a\nb'), true);
  assert.equal(sameText('a\nb\n', 'a\nb'), false);
  assert.equal(sameText('a b', 'a  b'), false);
  assert.equal(sameText('a\rb', 'a\nb'), false);
  assert.equal(sameText('a\rb', 'ab'), false);
  assert.equal(sameText('', ''), true);
});

/** Every file under a root except .git, as { relative path: text }. */
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

/** What a checkout with core.autocrlf does to the text files `init` wrote. */
function toCrlf(root) {
  for (const [rel, text] of Object.entries(snapshot(root))) {
    if (/\.(yml|md|sh)$|pre-commit$|pre-push$/.test(rel)) {
      fs.writeFileSync(path.join(root, rel), text.replace(/\r?\n/g, '\r\n'));
    }
  }
}

/** A project `init` set up, then converted to CRLF as a Windows checkout would be. */
function crlfProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-crlf-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guide\n\nMine.\n');
  const io = { git, gh: () => '', setup: () => {} };
  runInit({ root, ref: OLD, labels: false, adapterSetup: false }, io);
  toCrlf(root);
  return { root, git, io };
}

test('a second init on a CRLF checkout changes nothing and rewrites nothing', () => {
  const { root, io } = crlfProject();
  const before = snapshot(root);
  const result = runInit({ root, ref: OLD, labels: false, adapterSetup: false }, io);
  assert.deepEqual(
    result.files.filter((f) => f.status !== 'unchanged'),
    [],
  );
  assert.deepEqual(snapshot(root), before);
  assert.ok(
    Object.values(before).some((t) => t.includes('\r\n')),
    'the fixture is CRLF',
  );
});

test('a real difference is still found in a CRLF file', () => {
  const { root, io } = crlfProject();
  const file = path.join(root, '.github', 'workflows', 'no-go-guard.yml');
  fs.writeFileSync(file, 'name: mine\r\n');
  const result = runInit({ root, ref: OLD, labels: false, adapterSetup: false }, io);
  assert.equal(result.files.find((f) => f.path.endsWith('no-go-guard.yml')).status, 'skipped');
});

test('doctor does not call CRLF copies of the skills stale, but still finds an edit', () => {
  const { root, git } = crlfProject();
  const gh = (args) => {
    const key = args.join(' ');
    if (key.startsWith('api') && key.includes('/commits/')) return OLD;
    if (key.startsWith('label list')) return '';
    throw new Error('HTTP 500');
  };
  const skills = (results) => results.find((r) => r.name === 'skills');
  assert.equal(skills(runDoctor(root, { git, gh })).status, 'ok');

  const skill = path.join(root, '.claude', 'skills', 'handover', 'SKILL.md');
  fs.writeFileSync(skill, `${fs.readFileSync(skill, 'utf8')}local edit\r\n`);
  const edited = skills(runDoctor(root, { git, gh }));
  assert.equal(edited.status, 'warn');
  assert.match(edited.detail, /handover/);
});

test('upgrade leaves CRLF skills alone, and moves CRLF pins without changing the endings', () => {
  const { root } = crlfProject();
  const gh = () => NEW;
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: NEW }, { gh });
  assert.deepEqual(
    result.files.filter((f) => f.path.includes('.claude/skills') && f.status !== 'unchanged'),
    [],
  );
  const file = path.join(root, '.github', 'workflows', 'factory.yml');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(`@${NEW}`) && !text.includes(OLD));
  assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF was introduced');
  assert.ok(text.includes(`uses: ${REPO}/`));
});

test('the AGENTS.md block is not rewritten when the file is CRLF', () => {
  const { root, io } = crlfProject();
  const before = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(before.includes('\r\n'));
  runInit({ root, ref: OLD, labels: false, adapterSetup: false }, io);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), before);
});
