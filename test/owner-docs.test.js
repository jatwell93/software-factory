const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runDoctor, REQUIRED_CHECKS } = require('../lib/doctor.js');
const { runInit, ownerSteps } = require('../lib/init.js');
const { ANCHORS, OWNER_SETUP, ownerDoc } = require('../lib/owner-docs.js');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'owner-setup.md'), 'utf8');
const SHA = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');

const headings = DOC.split('\n')
  .filter((l) => l.startsWith('## '))
  .map((l) => slug(l.slice(3)));

test('every section init and doctor link to exists in the owner setup page', () => {
  for (const [name, anchor] of Object.entries(ANCHORS)) {
    assert.ok(headings.includes(anchor), `${name}: no "## ..." heading makes #${anchor}`);
  }
  assert.match(
    OWNER_SETUP,
    new RegExp(`^https://github.com/${REPO}/blob/main/docs/owner-setup.md$`),
  );
  assert.equal(ownerDoc('ruleset'), `${OWNER_SETUP}#the-branch-ruleset`);
});

test('the ruleset section says it is a branch ruleset, the order, the names and the picker', () => {
  const start = DOC.indexOf('## The branch ruleset');
  const section = DOC.slice(start, DOC.indexOf('\n## ', start + 1));
  assert.match(section, /\*\*branch ruleset\*\*, not a tag ruleset/);
  assert.match(section, /New branch ruleset/);
  assert.match(section, /pull_request_target/);
  // The three checks are listed as the items of the "Add checks" instruction.
  for (const check of REQUIRED_CHECKS) {
    assert.match(section, new RegExp(`^\\s+- \`${check}\`$`, 'm'), check);
  }
  assert.match(section, /use \*\*Add checks\*\* to add these three:/);
  assert.match(section, /^\s+- your CI job's check name/m);
  assert.match(section, /tick \*\*Block force pushes\*\*/);
  // The order: merge the init PR, open another, then create the ruleset.
  const order = ['Merge the pull request', 'Open any other pull request', 'Create the ruleset'];
  const at = order.map((text) => section.indexOf(text));
  assert.ok(at.every((i) => i !== -1) && at[0] < at[1] && at[1] < at[2], at.join(','));
});

test('init prints each owner step with the link to its section', () => {
  const steps = ownerSteps({ default_branch: 'main' });
  const joined = steps.join('\n');
  for (const section of ['secret', 'app', 'ruleset', 'approval', 'factoryDir']) {
    assert.ok(joined.includes(ownerDoc(section)), section);
  }
  const ruleset = steps.find((s) => s.includes(ownerDoc('ruleset')));
  assert.match(ruleset, /--apply-ruleset --ci-check/);
  assert.match(ruleset, /on main/);
  assert.match(ruleset, /by hand/i);
  const done = ownerSteps({ default_branch: 'main' }, { rulesetDone: true });
  assert.ok(done.some((s) => /ruleset on main is in place/.test(s)));
  assert.ok(!done.some((s) => /--apply-ruleset/.test(s)));
});

/** A project `init` set up, with real git and a gh that answers like the repository says. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ownerdocs-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  runInit(
    { root, ref: SHA, labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git };
}

function ghWith(rules, secrets = '') {
  const replies = {
    [`api repos/${REPO}/commits/${SHA} --jq .sha`]: SHA,
    'label list --limit 200 --json name --jq .[].name': '',
    'secret list --json name --jq .[].name': secrets,
    'repo view --json nameWithOwner --jq .nameWithOwner': 'octo/app',
    'api repos/octo/app/rules/branches/main': JSON.stringify(rules),
  };
  return (args) => {
    const reply = replies[args.join(' ')];
    if (reply === undefined) throw new Error('HTTP 500');
    return reply;
  };
}

const find = (results, name) => results.find((r) => r.name === name);

test('doctor relays the page for the secret, the ruleset checks, the gate and force pushes', () => {
  const { root, git } = project();
  const results = runDoctor(root, { git, gh: ghWith([]) });

  const secret = find(results, 'secret');
  assert.match(secret.fix, /gh secret set CLAUDE_CODE_OAUTH_TOKEN/);
  assert.ok(secret.fix.includes(ownerDoc('secret')));

  const checks = find(results, 'ruleset checks');
  assert.match(checks.fix, /New branch ruleset \(not a tag ruleset\)/);
  assert.match(checks.fix, /factory\/no-go-guard and factory\/change-ids/);
  assert.match(checks.fix, /only offered once it has run on a pull request/);
  assert.ok(checks.fix.includes(ownerDoc('ruleset')));

  const gate = find(results, 'ruleset gate');
  assert.match(gate.fix, /your CI job's check/);
  assert.ok(gate.fix.includes(ownerDoc('ruleset')));

  const force = find(results, 'force pushes');
  assert.match(force.fix, /Block force pushes/);
  assert.ok(force.fix.includes(ownerDoc('ruleset')));
});

test('the Claude app skip points at its section', () => {
  const { root, git } = project();
  const app = find(runDoctor(root, { git, gh: ghWith([]) }), 'claude app');
  assert.equal(app.status, 'skip');
  assert.ok(app.detail.includes(ownerDoc('app')));
  assert.match(app.detail, /access to this repository/);
});
