const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');

const { CALLERS } = require('../lib/callers.js');
const { addDispatch, missingDispatch } = require('../lib/triggers.js');
const { runDoctor } = require('../lib/doctor.js');
const { runInit } = require('../lib/init.js');
const { runUpgrade } = require('../lib/upgrade.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';
const NAME = 'check-change-ids.yml';
const ROOT = path.join(__dirname, '..');
const template = (name) => fs.readFileSync(path.join(ROOT, 'templates', 'workflows', name), 'utf8');
const reusable = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', NAME), 'utf8'));

// The change-ids caller as projects had it before it could be dispatched.
function undispatchable(text) {
  return text
    .replace(/^ {2}workflow_dispatch:\n(?: {3,}\S.*\n)+/m, '')
    .replace(' || inputs.pr }}', ' }}')
    .replace(/^ {6}pr: .*\n/m, '');
}

function initialised() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-triggers-'));
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
const callerPath = (root) => path.join(root, '.github', 'workflows', NAME);
const gh = (args) => {
  if (args[1] === `repos/${REPO}/commits/${NEW}`) return NEW;
  throw new Error('HTTP 404: Not Found');
};
const asPinned = (text, ref) => text.replaceAll('__FACTORY_REF__', ref);

test('the change-ids caller template can be dispatched with a PR number', () => {
  const on = YAML.parse(template(NAME)).on;
  assert.ok('workflow_dispatch' in on && 'pull_request_target' in on);
  assert.equal(on.workflow_dispatch.inputs.pr.required, true);
  const caller = YAML.parse(template(NAME));
  assert.equal(caller.jobs['change-ids'].with.pr, '${{ inputs.pr }}');
  assert.match(caller.concurrency.group, /pull_request\.number \|\| inputs\.pr/);
});

test('a caller is judged against its template only, and only for a missing trigger', () => {
  for (const name of CALLERS) assert.equal(missingDispatch(template(name), name), false, name);
  assert.equal(missingDispatch(undispatchable(template(NAME)), NAME), true);
  assert.equal(missingDispatch('on: [push]\n', NAME), false, 'an on: list is not judged');
  assert.equal(missingDispatch(': not yaml: [', NAME), false);
});

test('adding the trigger gives exactly the template, pin included', () => {
  const old = undispatchable(template(NAME));
  assert.notEqual(old, template(NAME));
  assert.equal(addDispatch(old, NAME), template(NAME));
  assert.equal(missingDispatch(addDispatch(old, NAME), NAME), false);
});

test('adding the trigger keeps the project edits and CRLF line endings', () => {
  const edited = undispatchable(template(NAME)).replace(
    'types: [opened, synchronize, reopened]',
    'types: [opened, synchronize, reopened]\n    branches: [main]',
  );
  const out = addDispatch(edited.replace(/\n/g, '\r\n'), NAME);
  assert.ok(!/[^\r]\n/.test(out), 'every line ending is still CRLF');
  assert.ok(out.includes('branches: [main]'));
  assert.equal(missingDispatch(out, NAME), false);
});

test('a caller with no on: block of lines is left for the owner', () => {
  assert.equal(addDispatch('name: x\non: { pull_request_target: {} }\n', NAME), null);
});

test('doctor fails a change-ids caller that cannot be dispatched', () => {
  const { root, git } = initialised();
  fs.writeFileSync(callerPath(root), undispatchable(fs.readFileSync(callerPath(root), 'utf8')));
  const row = runDoctor(root, { git, gh }).find((r) => r.name === `caller ${NAME}`);
  assert.equal(row.status, 'fail');
  assert.match(row.detail, /no workflow_dispatch trigger/);
  assert.match(row.fix, /factory-upgrade/);
});

test('upgrade from the target commit adds the trigger along with the pin', () => {
  const { root } = initialised();
  fs.writeFileSync(callerPath(root), undispatchable(fs.readFileSync(callerPath(root), 'utf8')));
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: NEW, skills: false }, { gh });
  assert.equal(fs.readFileSync(callerPath(root), 'utf8'), asPinned(template(NAME), NEW));
  const file = result.files.find((f) => f.path.endsWith(NAME));
  assert.match(file.note, /workflow_dispatch trigger added/);
  assert.deepEqual(result.warnings, []);
});

test('upgrade from another commit leaves the trigger out and warns', () => {
  const { root } = initialised();
  const old = undispatchable(fs.readFileSync(callerPath(root), 'utf8'));
  fs.writeFileSync(callerPath(root), old);
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: OLD, skills: false }, { gh });
  assert.equal(missingDispatch(fs.readFileSync(callerPath(root), 'utf8'), NAME), true);
  assert.ok(result.warnings.some((w) => /check-change-ids\.yml cannot be dispatched/.test(w)));
});

test('upgrade does not touch a caller that can already be dispatched', () => {
  const { root } = initialised();
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: NEW, skills: false }, { gh });
  const file = result.files.find((f) => f.path.endsWith(NAME));
  assert.doesNotMatch(file.note || '', /workflow_dispatch/);
});

test('the reusable workflow takes a pr, runs a dispatch only from the default branch, reads the head', () => {
  assert.equal(reusable.on.workflow_call.inputs.pr.default, '');
  const job = reusable.jobs['change-ids'];
  assert.match(job.if, /github\.event_name == 'pull_request_target'/);
  assert.match(
    job.if,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.equal(job.env.PR_NUMBER, '${{ github.event.pull_request.number || inputs.pr }}');
  const read = job.steps.find((s) => /head for a dispatch/.test(s.name));
  assert.equal(read.if, "github.event_name == 'workflow_dispatch'");
  assert.match(read.run, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(read.run, /HEAD_SHA=.*>> "\$GITHUB_ENV"/);
  const check = job.steps.find((s) => /Check the ids/.test(s.name));
  assert.match(check.run, /moved past \$HEAD_SHA; not posting a status/);
  assert.ok(job.steps.indexOf(read) < job.steps.indexOf(check));
});
