const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { CALLERS } = require('../lib/callers.js');
const { grantPermissions, missingPermissions } = require('../lib/permissions.js');
const { runDoctor } = require('../lib/doctor.js');
const { runInit } = require('../lib/init.js');
const { runUpgrade } = require('../lib/upgrade.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';
const TEMPLATES = path.join(__dirname, '..', 'templates', 'workflows');
const template = (name) => fs.readFileSync(path.join(TEMPLATES, name), 'utf8');

// The reviews-settled caller as a project got it before it granted actions: read.
const withoutActions = (text) => text.replace(/^ {2}actions: read.*\r?\n/m, '');

function initialised() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-permissions-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: Test\non: push\n');
  runInit(
    { root, ref: OLD, labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git };
}

const caller = (root, name = 'reviews-settled.yml') =>
  path.join(root, '.github', 'workflows', name);
const gh = (args) => {
  if (args[0] === 'api' && args[1] === `repos/${REPO}/commits/${NEW}`) return NEW;
  throw new Error('HTTP 404: Not Found');
};

test('a caller short of what its template grants is reported with each scope', () => {
  const old = withoutActions(template('reviews-settled.yml'));
  assert.deepEqual(missingPermissions(old, 'reviews-settled.yml'), [['actions', 'read']]);
});

test('a caller that grants the template, or more, is not short', () => {
  for (const name of CALLERS) {
    assert.deepEqual(missingPermissions(template(name), name), [], name);
  }
  const more = template('reviews-settled.yml').replace('actions: read', 'actions: write');
  assert.deepEqual(missingPermissions(more, 'reviews-settled.yml'), []);
});

test('a read grant is short of a write need, and a caller with no permissions block is not judged', () => {
  const lower = template('factory.yml').replace(/^ {2}contents: write/m, '  contents: read');
  assert.deepEqual(missingPermissions(lower, 'factory.yml'), [['contents', 'write']]);
  const none = template('reviews-settled.yml').replace(/^permissions:[\s\S]*?\n\n/m, '');
  assert.deepEqual(missingPermissions(none, 'reviews-settled.yml'), []);
});

test('granting adds a missing scope to the block and a raised scope in place', () => {
  const old = withoutActions(template('reviews-settled.yml'));
  const fixed = grantPermissions(old, [['actions', 'read']]);
  assert.deepEqual(missingPermissions(fixed, 'reviews-settled.yml'), []);
  assert.match(fixed, /^permissions:\n(?: {2}\S.*\n)*? {2}actions: read\n/m);
  // The rest of the file is untouched.
  assert.equal(fixed.replace(/^ {2}actions: read\n/m, ''), old);
  const lower = template('factory.yml').replace(/^ {2}contents: write/m, '  contents: read');
  const raised = grantPermissions(lower, [['contents', 'write']]);
  assert.equal(raised, template('factory.yml'));
});

test('granting keeps CRLF line endings', () => {
  const old = withoutActions(template('reviews-settled.yml')).replace(/\n/g, '\r\n');
  const fixed = grantPermissions(old, [['actions', 'read']]);
  assert.ok(!/[^\r]\n/.test(fixed));
  assert.deepEqual(missingPermissions(fixed, 'reviews-settled.yml'), []);
});

test('doctor fails a caller short of its template and names the scope', () => {
  const { root, git } = initialised();
  fs.writeFileSync(caller(root), withoutActions(fs.readFileSync(caller(root), 'utf8')));
  const result = runDoctor(root, { git, gh }).find((r) => r.name === 'caller reviews-settled.yml');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /actions: read/);
  assert.match(result.fix, /factory-upgrade/);
});

test('upgrade from the target commit raises a short caller along with the pin', () => {
  const { root } = initialised();
  fs.writeFileSync(caller(root), withoutActions(fs.readFileSync(caller(root), 'utf8')));
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: NEW, skills: false }, { gh });
  const text = fs.readFileSync(caller(root), 'utf8');
  assert.deepEqual(missingPermissions(text, 'reviews-settled.yml'), []);
  assert.ok(text.includes(NEW) && !text.includes(OLD));
  const file = result.files.find((f) => f.path.endsWith('reviews-settled.yml'));
  assert.match(file.note, /permissions raised: actions: read/);
  assert.deepEqual(result.warnings, []);
});

test('upgrade raises a short caller even when the pin already matches', () => {
  const { root } = initialised();
  fs.writeFileSync(caller(root), withoutActions(fs.readFileSync(caller(root), 'utf8')));
  const gh2 = (args) => {
    if (args[1] === `repos/${REPO}/commits/${OLD}`) return OLD;
    throw new Error('HTTP 404: Not Found');
  };
  const result = runUpgrade({ root, ref: OLD, checkoutCommit: OLD, skills: false }, { gh: gh2 });
  assert.equal(result.files.find((f) => f.path.endsWith('reviews-settled.yml')).status, 'updated');
  assert.deepEqual(
    missingPermissions(fs.readFileSync(caller(root), 'utf8'), 'reviews-settled.yml'),
    [],
  );
});

test('upgrade from another commit leaves the permissions and warns', () => {
  const { root } = initialised();
  const short = withoutActions(fs.readFileSync(caller(root), 'utf8'));
  fs.writeFileSync(caller(root), short);
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: OLD, skills: false }, { gh });
  const text = fs.readFileSync(caller(root), 'utf8');
  assert.deepEqual(missingPermissions(text, 'reviews-settled.yml'), [['actions', 'read']]);
  assert.ok(result.warnings.some((w) => /reviews-settled\.yml grant less/.test(w)));
});

test('a missing scope goes at the end of the block, in the order given', () => {
  const old = withoutActions(template('reviews-settled.yml'));
  const fixed = grantPermissions(old, [
    ['actions', 'read'],
    ['issues', 'write'],
  ]);
  const lines = fixed.split('\n');
  const start = lines.indexOf('permissions:');
  const end = lines.findIndex((line, i) => i > start && !/^\s+\S/.test(line));
  assert.deepEqual(lines.slice(end - 2, end), ['  actions: read', '  issues: write']);
});

test('only the top-level block is edited, not a job that names the same scope', () => {
  const old = withoutActions(template('reviews-settled.yml')).replace(
    'jobs:\n',
    'jobs:\n  extra:\n    permissions:\n      actions: none\n',
  );
  const fixed = grantPermissions(old, [['actions', 'read']]);
  assert.match(fixed, /^ {6}actions: none$/m);
  assert.deepEqual(missingPermissions(fixed, 'reviews-settled.yml'), []);
});
