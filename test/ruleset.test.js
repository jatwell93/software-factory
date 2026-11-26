const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { applyRuleset, rulesetBody } = require('../lib/ruleset.js');
const { runInit } = require('../lib/init.js');

const config = { default_branch: 'main' };
const REF = 'a'.repeat(40);

/** A gh that answers the ruleset calls and records the bodies it was sent. */
function fakeGh({ callers = true, rules = [], rulesets = [], refuse = false } = {}) {
  const calls = [];
  const sent = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'repo') return 'octo/app';
    const endpoint = args.find((a) => a.startsWith('repos/')) || '';
    if (endpoint.includes('/contents/')) {
      if (callers) return 'sha';
      throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
    }
    if (endpoint.endsWith('/rules/branches/main')) return JSON.stringify(rules);
    if (args.includes('--method')) {
      if (refuse)
        throw Object.assign(new Error('x'), { stderr: 'Must have admin rights (HTTP 403)' });
      sent.push({
        method: args[args.indexOf('--method') + 1],
        endpoint,
        body: JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8')),
      });
      return '{}';
    }
    if (endpoint.endsWith('/rulesets')) return JSON.stringify(rulesets);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { gh, calls, sent };
}

const rulesFor = (...contexts) => [
  { type: 'non_fast_forward' },
  {
    type: 'required_status_checks',
    parameters: { required_status_checks: contexts.map((context) => ({ context })) },
  },
];

test('the body requires the factory checks and the project checks, blocks force pushes and deletion', () => {
  const body = rulesetBody(['check', 'factory/no-go-guard']);
  assert.equal(body.enforcement, 'active');
  assert.deepEqual(body.bypass_actors, []);
  assert.deepEqual(body.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  const types = body.rules.map((r) => r.type);
  assert.deepEqual(types, ['deletion', 'non_fast_forward', 'required_status_checks']);
  assert.deepEqual(
    body.rules[2].parameters.required_status_checks.map((c) => c.context),
    ['factory/no-go-guard', 'factory/change-ids', 'check'],
  );
});

test('a branch with no ruleset gets one created, with no pull request opened', () => {
  const { gh, calls, sent } = fakeGh();
  assert.deepEqual(applyRuleset(config, ['check'], gh), { status: 'created' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].endpoint, 'repos/octo/app/rulesets');
  assert.equal(sent[0].body.name, 'software-factory');
  assert.ok(!calls.some((c) => /^pr /.test(c)));
});

test('a branch that already requires everything is left alone', () => {
  const { gh, sent } = fakeGh({
    rules: rulesFor('factory/no-go-guard', 'factory/change-ids', 'check'),
  });
  assert.deepEqual(applyRuleset(config, ['check'], gh), { status: 'unchanged' });
  assert.deepEqual(sent, []);
});

test('a missing project check, or force pushes allowed, is fixed by updating our own ruleset', () => {
  const rulesets = [
    { id: 1, name: 'other' },
    { id: 7, name: 'software-factory' },
  ];
  const { gh, sent } = fakeGh({
    rules: rulesFor('factory/no-go-guard', 'factory/change-ids'),
    rulesets,
  });
  assert.deepEqual(applyRuleset(config, ['check'], gh), { status: 'updated' });
  assert.equal(sent[0].method, 'PUT');
  assert.equal(sent[0].endpoint, 'repos/octo/app/rulesets/7');
});

test('the check callers must be on the default branch first, and nothing is sent without them', () => {
  const { gh, sent } = fakeGh({ callers: false });
  const result = applyRuleset(config, ['check'], gh);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /no-go-guard\.yml is not on main yet: merge the init pull request/);
  assert.deepEqual(sent, []);
});

test('a refusal from GitHub is a skip that says what to do', () => {
  const { gh } = fakeGh({ refuse: true });
  const result = applyRuleset(config, ['check'], gh);
  assert.equal(result.status, 'skipped');
  assert.match(result.note, /admin rights/);
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ruleset-init-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  return { root, git };
}

const io = (git, gh) => ({ git, gh, setup: () => {} });

test('--apply-ruleset needs --ci-check, and refuses before anything is written', () => {
  const { root, git } = project();
  assert.throws(
    () => runInit({ root, ref: REF, applyRuleset: true }, io(git, fakeGh().gh)),
    (error) => error.userError && /--ci-check/.test(error.message),
  );
  assert.ok(!fs.existsSync(path.join(root, 'factory.config.yml')));
});

test('init --apply-ruleset applies it after the files and reports it as done', () => {
  const { root, git } = project();
  const { gh, sent } = fakeGh();
  const result = runInit({ root, ref: REF, applyRuleset: true, ciChecks: ['check'] }, io(git, gh));
  assert.equal(sent.length, 1);
  assert.equal(result.files.find((f) => f.path === 'ruleset software-factory').status, 'created');
  assert.ok(result.steps.some((s) => /ruleset on main is in place/.test(s)));
});

test('init --apply-ruleset with the callers missing warns and does not call the step done', () => {
  const { root, git } = project();
  const { gh, sent } = fakeGh({ callers: false });
  const result = runInit({ root, ref: REF, applyRuleset: true, ciChecks: ['check'] }, io(git, gh));
  assert.deepEqual(sent, []);
  assert.ok(
    result.warnings.some((w) => /ruleset not applied: .*merge the init pull request/.test(w)),
  );
  assert.ok(result.steps.some((s) => /--apply-ruleset --ci-check/.test(s)));
});

test('init without --apply-ruleset never calls the ruleset API', () => {
  const { root, git } = project();
  const { gh, calls } = fakeGh();
  runInit({ root, ref: REF }, io(git, gh));
  assert.ok(!calls.some((c) => /rulesets|rules\/branches/.test(c)));
});

test('--dry-run applies no ruleset', () => {
  const { root, git } = project();
  const { gh, calls } = fakeGh();
  runInit({ root, ref: REF, dryRun: true, applyRuleset: true, ciChecks: ['check'] }, io(git, gh));
  assert.deepEqual(calls, []);
});

test('init adds the agent scaffold folder to .gitignore, once, keeping what was there', () => {
  const { root, git } = project();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  const first = runInit({ root, ref: REF }, io(git, fakeGh().gh));
  assert.equal(first.files.find((f) => f.path === '.gitignore').status, 'updated');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n.agents/\n');
  const second = runInit({ root, ref: REF }, io(git, fakeGh().gh));
  assert.equal(second.files.find((f) => f.path === '.gitignore').status, 'unchanged');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'node_modules/\n.agents/\n');
});

test('init creates a .gitignore when there is none, and --dry-run writes nothing', () => {
  const dry = project();
  runInit({ root: dry.root, ref: REF, dryRun: true }, io(dry.git, fakeGh().gh));
  assert.ok(!fs.existsSync(path.join(dry.root, '.gitignore')));
  const real = project();
  runInit({ root: real.root, ref: REF }, io(real.git, fakeGh().gh));
  assert.equal(fs.readFileSync(path.join(real.root, '.gitignore'), 'utf8'), '.agents/\n');
});

test('a file init writes that .gitignore ignores gets a warning naming it', () => {
  const { root, git } = project();
  fs.writeFileSync(path.join(root, '.gitignore'), '.github/workflows/factory.yml\n');
  const result = runInit({ root, ref: REF }, io(git, fakeGh().gh));
  assert.ok(
    result.warnings.some((w) =>
      /^\.github\/workflows\/factory\.yml is ignored by \.gitignore/.test(w),
    ),
  );
  assert.equal(result.warnings.filter((w) => /is ignored by/.test(w)).length, 1);
});

test('force pushes allowed is enough to change a branch that requires every check', () => {
  const checks = rulesFor('factory/no-go-guard', 'factory/change-ids', 'check').slice(1);
  const { gh, sent } = fakeGh({ rules: checks });
  assert.deepEqual(applyRuleset(config, ['check'], gh), { status: 'created' });
  assert.equal(sent.length, 1);
});
