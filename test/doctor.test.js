const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runInit } = require('../lib/init.js');
const { runDoctor, tagProtected } = require('../lib/doctor.js');
const { main } = require('../scripts/factory-doctor.js');

const SHA = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';
const LABELS = [
  'factory-ready',
  'needs-human',
  'factory-retry',
  'factory-retrying',
  'factory-digest',
];
const RULES = [
  {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [
        { context: 'factory/no-go-guard' },
        { context: 'factory/change-ids' },
        { context: 'Test' },
      ],
    },
  },
  { type: 'non_fast_forward' },
];

/** A project that `init` set up, with real git. */
function initialised(ref = SHA) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-doctor-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: Test\non: push\n');
  runInit(
    { root, ref, labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git };
}

/** A gh that answers like a healthy repository, with any answer replaceable by `over`. */
function healthyGh(over = {}) {
  const replies = {
    [`api repos/${REPO}/commits/${SHA} --jq .sha`]: SHA,
    'label list --limit 200 --json name --jq .[].name': LABELS.join('\n'),
    'secret list --json name --jq .[].name': 'CLAUDE_CODE_OAUTH_TOKEN',
    'repo view --json nameWithOwner --jq .nameWithOwner': 'octo/app',
    'api repos/octo/app/rules/branches/main': JSON.stringify(RULES),
    ...over,
  };
  return (args) => {
    const reply = replies[args.join(' ')];
    if (reply === undefined) throw new Error(`HTTP 500 for ${args.join(' ')}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

const find = (results, name) => results.find((r) => r.name === name);
const bad = (results) => results.filter((r) => r.status === 'fail' || r.status === 'warn');

test('a project init set up, in a healthy repository, has nothing to fix', () => {
  const { root, git } = initialised();
  const results = runDoctor(root, { git, gh: healthyGh() });
  assert.deepEqual(bad(results), []);
  assert.deepEqual(
    results.filter((r) => r.status === 'skip').map((r) => r.name),
    ['claude app'],
  );
  assert.equal(find(results, 'config').status, 'ok');
  assert.equal(find(results, 'pin').status, 'ok');
});

test('a missing or invalid config is the only result', () => {
  const { root, git } = initialised();
  fs.writeFileSync(path.join(root, 'factory.config.yml'), 'owner: x\n');
  const results = runDoctor(root, { git, gh: healthyGh() });
  assert.deepEqual(
    results.map((r) => r.name),
    ['config'],
  );
  assert.equal(results[0].status, 'fail');
  assert.match(results[0].fix, /factory-init/);
  fs.rmSync(path.join(root, 'factory.config.yml'));
  assert.equal(runDoctor(root, { git, gh: healthyGh() })[0].status, 'fail');
});

test('a spec_source with no adapter fails', () => {
  const { root, git } = initialised();
  const file = path.join(root, 'factory.config.yml');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace('spec_source: openspec', 'spec_source: paul'),
  );
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'adapter');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /paul/);
});

test('a missing caller workflow fails and names it', () => {
  const { root, git } = initialised();
  fs.rmSync(path.join(root, '.github', 'workflows', 'reviews-settled.yml'));
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'callers');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /reviews-settled\.yml/);
});

test('a caller that no longer calls the factory fails', () => {
  const { root, git } = initialised();
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'factory-digest.yml'), 'name: mine\n');
  assert.equal(
    find(runDoctor(root, { git, gh: healthyGh() }), 'caller factory-digest.yml').status,
    'fail',
  );
});

test('callers pinned to different refs fail', () => {
  const { root, git } = initialised();
  const file = path.join(root, '.github', 'workflows', 'no-go-guard.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(SHA, 'c'.repeat(40)));
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'pin');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /different refs/);
});

test('a uses: ref that differs from its factory_ref input fails', () => {
  const { root, git } = initialised();
  const file = path.join(root, '.github', 'workflows', 'no-go-guard.yml');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace(`factory_ref: ${SHA}`, `factory_ref: ${'c'.repeat(40)}`),
  );
  assert.equal(
    find(runDoctor(root, { git, gh: healthyGh() }), 'caller no-go-guard.yml').status,
    'fail',
  );
});

test('a branch pin fails: it can move under the project', () => {
  const { root, git } = initialised();
  for (const name of fs.readdirSync(path.join(root, '.github', 'workflows'))) {
    const file = path.join(root, '.github', 'workflows', name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(SHA, 'main'));
  }
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'pin');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /can move/);
});

test('a pin GitHub does not have fails; any other GitHub error is a skip', () => {
  const { root, git } = initialised();
  const key = `api repos/${REPO}/commits/${SHA} --jq .sha`;
  const missing = find(
    runDoctor(root, { git, gh: healthyGh({ [key]: new Error('HTTP 404: Not Found') }) }),
    'pin',
  );
  assert.equal(missing.status, 'fail');
  assert.match(missing.fix, /factory-upgrade/);
  const outage = find(
    runDoctor(root, { git, gh: healthyGh({ [key]: new Error('HTTP 502') }) }),
    'pin',
  );
  assert.equal(outage.status, 'skip');
});

function setPin(root, ref) {
  for (const name of fs.readdirSync(path.join(root, '.github', 'workflows'))) {
    const file = path.join(root, '.github', 'workflows', name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll(SHA, ref));
  }
}

const tagRuleset = (over = {}) => ({
  target: 'tag',
  enforcement: 'active',
  conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
  rules: [{ type: 'update' }, { type: 'deletion' }],
  ...over,
});

test('a v* tag pin passes only when a ruleset blocks moving and deleting it', () => {
  const { root, git } = initialised();
  setPin(root, 'v1.0.0');
  const answers = (sets) => ({
    [`api repos/${REPO}/commits/v1.0.0 --jq .sha`]: SHA,
    [`api repos/${REPO}/rulesets --jq [.[].id]`]: JSON.stringify(sets.map((_, i) => i + 1)),
    ...Object.fromEntries(
      sets.map((s, i) => [`api repos/${REPO}/rulesets/${i + 1}`, JSON.stringify(s)]),
    ),
  });
  const protectedPin = runDoctor(root, { git, gh: healthyGh(answers([tagRuleset()])) });
  assert.equal(find(protectedPin, 'pin protection').status, 'ok');
  const loose = runDoctor(root, { git, gh: healthyGh(answers([])) });
  assert.equal(find(loose, 'pin protection').status, 'warn');
  assert.match(find(loose, 'pin protection').detail, /can be moved/);
});

test('tagProtected needs an active tag ruleset that includes the tag and blocks both', () => {
  assert.equal(tagProtected([tagRuleset()], 'v1.0.0'), true);
  assert.equal(
    tagProtected([tagRuleset({ conditions: { ref_name: { include: ['~ALL'] } } })], 'v1.0.0'),
    true,
  );
  assert.equal(tagProtected([tagRuleset({ enforcement: 'disabled' })], 'v1.0.0'), false);
  assert.equal(tagProtected([tagRuleset({ target: 'branch' })], 'v1.0.0'), false);
  assert.equal(tagProtected([tagRuleset({ rules: [{ type: 'update' }] })], 'v1.0.0'), false);
  assert.equal(tagProtected([tagRuleset({ rules: [{ type: 'deletion' }] })], 'v1.0.0'), false);
  assert.equal(tagProtected([tagRuleset()], 'x1.0.0'), false);
  const excluded = tagRuleset({
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: ['refs/tags/v1.*'] } },
  });
  assert.equal(tagProtected([excluded], 'v1.0.0'), false);
  assert.equal(tagProtected([excluded], 'v2.0.0'), true);
});

test('a relay trigger that differs from ci_workflows fails with both sides named', () => {
  const { root, git } = initialised();
  const file = path.join(root, 'factory.config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- Test', '- Build'));
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'ci relay');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /not watched: Build/);
  assert.match(result.detail, /not in ci_workflows: Test/);
});

test('a relay with no workflow_run list fails', () => {
  const { root, git } = initialised();
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'factory-ci-relay.yml'),
    `uses: ${REPO}/.github/workflows/x.yml@${SHA}\n`,
  );
  assert.equal(find(runDoctor(root, { git, gh: healthyGh() }), 'ci relay').status, 'fail');
});

test('missing skills fail and edited skills warn', () => {
  const { root, git } = initialised();
  const skill = path.join(root, '.claude', 'skills', 'handover', 'SKILL.md');
  fs.writeFileSync(skill, `${fs.readFileSync(skill, 'utf8')}\nlocal edit\n`);
  const edited = find(runDoctor(root, { git, gh: healthyGh() }), 'skills');
  assert.equal(edited.status, 'warn');
  assert.match(edited.detail, /handover/);
  fs.rmSync(path.join(root, '.claude', 'skills', 'run-spec'), { recursive: true });
  const missing = find(runDoctor(root, { git, gh: healthyGh() }), 'skills');
  assert.equal(missing.status, 'fail');
  assert.match(missing.detail, /run-spec/);
});

test('git hooks that are not wired warn', () => {
  const { root, git } = initialised();
  git(['config', '--unset', 'core.hooksPath']);
  assert.equal(find(runDoctor(root, { git, gh: healthyGh() }), 'git hooks').status, 'warn');
});

test('missing labels fail with a create command each', () => {
  const { root, git } = initialised();
  const gh = healthyGh({ 'label list --limit 200 --json name --jq .[].name': 'needs-human' });
  const result = find(runDoctor(root, { git, gh }), 'labels');
  assert.equal(result.status, 'fail');
  assert.equal(result.fix.split('\n').length, 4);
  assert.match(result.fix, /gh label create "factory-ready" --color 0E8A16/);
});

test('a missing secret fails', () => {
  const { root, git } = initialised();
  const gh = healthyGh({ 'secret list --json name --jq .[].name': 'OTHER' });
  const result = find(runDoctor(root, { git, gh }), 'secret');
  assert.equal(result.status, 'fail');
  assert.match(result.fix, /gh secret set CLAUDE_CODE_OAUTH_TOKEN/);
});

test('the ruleset must require both factory checks; the gate and force pushes warn', () => {
  const { root, git } = initialised();
  const rules = (checks, extra = []) => [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: checks.map((context) => ({ context })) },
    },
    ...extra,
  ];
  const run = (list) =>
    runDoctor(root, {
      git,
      gh: healthyGh({ 'api repos/octo/app/rules/branches/main': JSON.stringify(list) }),
    });

  const none = run([]);
  assert.equal(find(none, 'ruleset checks').status, 'fail');
  assert.match(find(none, 'ruleset checks').detail, /factory\/no-go-guard, factory\/change-ids/);
  assert.equal(find(none, 'force pushes').status, 'warn');

  const one = run(rules(['factory/no-go-guard', 'Test'], [{ type: 'non_fast_forward' }]));
  assert.match(find(one, 'ruleset checks').detail, /does not require factory\/change-ids/);
  assert.equal(find(one, 'ruleset gate').status, 'ok');

  const noGate = run(rules(['factory/no-go-guard', 'factory/change-ids']));
  assert.equal(find(noGate, 'ruleset checks').status, 'ok');
  assert.equal(find(noGate, 'ruleset gate').status, 'warn');
});

test('when GitHub cannot be asked the file checks still run and the rest are skips', () => {
  const { root, git } = initialised();
  fs.rmSync(path.join(root, '.github', 'workflows', 'reviews-settled.yml'));
  const results = runDoctor(root, {
    git,
    gh: () => {
      throw new Error('gh: not logged in');
    },
  });
  assert.equal(find(results, 'callers').status, 'fail');
  for (const name of ['pin', 'labels', 'secret', 'repository']) {
    assert.equal(find(results, name).status, 'skip', name);
  }
  assert.ok(!find(results, 'ruleset checks'));
});

test('the doctor script exits 1 on a failure, 0 otherwise, and prints each fix', () => {
  const { root, git } = initialised();
  const lines = [];
  assert.equal(
    main([], root, (l) => lines.push(l), { git, gh: healthyGh() }),
    0,
  );
  assert.match(lines.at(-1), /^0 warn|, 0 fail,/);

  const gh = healthyGh({ 'secret list --json name --jq .[].name': '' });
  const out = [];
  assert.equal(
    main([], root, (l) => out.push(l), { git, gh }),
    1,
  );
  assert.ok(out.some((l) => /^FAIL secret/.test(l)));
  assert.ok(out.some((l) => /fix: claude setup-token/.test(l)));
});

test('the doctor script takes no arguments', () => {
  assert.throws(
    () => main(['--x']),
    (error) => error.userError,
  );
});

test('a tag pin GitHub does not have fails without asking about protection', () => {
  const { root, git } = initialised();
  setPin(root, 'v1.0.0');
  const gh = healthyGh({
    [`api repos/${REPO}/commits/v1.0.0 --jq .sha`]: new Error('HTTP 404: Not Found'),
  });
  const results = runDoctor(root, { git, gh });
  assert.equal(find(results, 'pin').status, 'fail');
  assert.ok(!find(results, 'pin protection'));
});

test('a relay that watches a workflow ci_workflows does not list fails', () => {
  const { root, git } = initialised();
  const file = path.join(root, '.github', 'workflows', 'factory-ci-relay.yml');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace("- 'Test'", "- 'Test'\n      - 'Extra'"),
  );
  const result = find(runDoctor(root, { git, gh: healthyGh() }), 'ci relay');
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /not in ci_workflows: Extra/);
});

test('force pushes warn when the ruleset has checks but no non_fast_forward rule', () => {
  const { root, git } = initialised();
  const checks = RULES.filter((r) => r.type === 'required_status_checks');
  const gh = healthyGh({ 'api repos/octo/app/rules/branches/main': JSON.stringify(checks) });
  assert.equal(find(runDoctor(root, { git, gh }), 'force pushes').status, 'warn');
});
