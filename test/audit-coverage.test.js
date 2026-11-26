const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  GREENFIELD_COMMITS,
  auditCoverage,
  auditFix,
  auditProject,
  cooldownHint,
} = require('../lib/audit-coverage.js');
const { CALLERS } = require('../lib/callers.js');
const { runDoctor } = require('../lib/doctor.js');
const { runInit } = require('../lib/init.js');
const { COVERED_CI, DEPENDABOT_CONFIG } = require('./helpers.js');

/** A project folder with the given files (path -> text). */
function project(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-audit-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const ci = (...steps) =>
  `name: CI\non: push\njobs:\n  j:\n    steps:\n${steps.map((s) => `      - ${s}`).join('\n')}\n`;
const workflow = (text) => ({ '.github/workflows/ci.yml': text });
const labels = (audit) => audit.missing.map((m) => m.label);

test('each kind of audit is found in a workflow, and the rest are reported missing', () => {
  const root = project(workflow(ci('run: npm test')));
  const audit = auditCoverage(root, { stack: 'node', commits: 100 });
  assert.deepEqual(audit.present, ['tests']);
  assert.deepEqual(labels(audit), [
    'lint or type check',
    'security scan',
    'secrets scan',
    'dependency updates',
  ]);
  const cases = {
    tests: ['run: pytest -q', 'run: go test ./...', 'run: cargo test', 'run: make test'],
    'lint or type check': ['run: ruff check .', 'run: npx tsc --noEmit', 'run: yarn lint'],
    'security scan': ['uses: github/codeql-action/analyze@v3', 'run: npm audit', 'run: trivy fs .'],
    'secrets scan': [
      'uses: gitleaks/gitleaks-action@v2',
      'run: trufflehog git file://.',
      'run: git secrets --scan',
      'run: git-secrets --scan',
    ],
  };
  for (const [label, steps] of Object.entries(cases)) {
    for (const step of steps) {
      const found = auditCoverage(project(workflow(ci(step))), { commits: 100 });
      assert.ok(found.present.includes(label), `${label}: ${step}`);
    }
  }
});

test('a commented-out step is no evidence, and the factory callers are not the project’s CI', () => {
  const commented = ci('run: echo hi').replace('      - run: echo hi', '      # - run: npm test');
  assert.deepEqual(auditCoverage(project(workflow(commented)), { commits: 100 }).present, []);
  const own = project({ '.github/workflows/no-go-guard.yml': ci('run: npm test') });
  const audit = auditCoverage(own, { commits: 100, skipFiles: CALLERS });
  assert.deepEqual(audit.present, []);
});

test('Dependabot and Renovate count as a dependency policy; a cooldown is noted when absent', () => {
  const dependabot = project({ '.github/dependabot.yml': DEPENDABOT_CONFIG });
  const withCooldown = auditCoverage(dependabot, { commits: 100 });
  assert.deepEqual(withCooldown.dependency, { tool: 'dependabot', cooldown: true });
  assert.equal(cooldownHint(withCooldown.dependency), '');
  const bare = project({ '.github/dependabot.yaml': 'version: 2\nupdates: []\n' });
  const noCooldown = auditCoverage(bare, { commits: 100 }).dependency;
  assert.deepEqual(noCooldown, { tool: 'dependabot', cooldown: false });
  assert.match(cooldownHint(noCooldown), /dependabot has no cooldown/);
  const renovate = project({ 'renovate.json': '{"minimumReleaseAge": "7 days"}' });
  assert.deepEqual(auditCoverage(renovate, { commits: 100 }).dependency, {
    tool: 'renovate',
    cooldown: true,
  });
  // A cooldown named only in a comment is not one.
  const comment = project({ '.github/dependabot.yml': '# cooldown: 7\nversion: 2\n' });
  assert.equal(auditCoverage(comment, { commits: 100 }).dependency.cooldown, false);
  // Nor is the word as a value.
  const value = project({
    '.github/dependabot.yml': 'version: 2\nupdates:\n  - commit-message:\n      prefix: cooldown\n',
  });
  assert.equal(auditCoverage(value, { commits: 100 }).dependency.cooldown, false);
});

test('the advice names the tools of the project’s stack, and a generic one for an unknown stack', () => {
  const root = project({});
  const python = auditCoverage(root, { stack: 'python', commits: 100 });
  assert.match(python.missing.find((m) => m.key === 'tests').advice, /pytest/);
  assert.match(python.missing.find((m) => m.key === 'security').advice, /pip-audit/);
  const rust = auditCoverage(root, { stack: 'rust', commits: 100 });
  assert.match(rust.missing.find((m) => m.key === 'security').advice, /cargo audit/);
  const unknown = auditCoverage(root, { stack: 'unknown', commits: 100 });
  assert.match(unknown.missing.find((m) => m.key === 'tests').advice, /project’s tests/);
});

test('a project with no CI, or few commits, is greenfield; otherwise brownfield', () => {
  const some = project(workflow(ci('run: npm test')));
  assert.equal(auditCoverage(some, { commits: GREENFIELD_COMMITS }).mode, 'brownfield');
  assert.equal(auditCoverage(some, { commits: GREENFIELD_COMMITS - 1 }).mode, 'greenfield');
  assert.equal(auditCoverage(project({}), { commits: 500 }).mode, 'greenfield');
  // An unknown history counts as a project with history.
  assert.equal(auditCoverage(some).mode, 'brownfield');
});

test('greenfield advice requires every check at once and asks for tests first', () => {
  const fix = auditFix(auditCoverage(project({}), { stack: 'node', commits: 3 }));
  assert.match(fix, /^New project/);
  assert.match(fix, /required check/);
  assert.match(fix, /tests and their CI job before the first factory task/);
  assert.doesNotMatch(fix, /not required/);
  assert.match(fix, /CodeQL default setup/);
});

test('brownfield advice keeps existing jobs and adds each new scan without requiring it first', () => {
  const root = project(workflow(ci('run: npm test')));
  const fix = auditFix(auditCoverage(root, { stack: 'node', commits: 400 }));
  assert.match(fix, /^Existing project: keep the CI jobs it has/);
  assert.match(fix, /not required/);
  assert.match(fix, /block every factory PR/);
  assert.doesNotMatch(fix, /^New project/);
  assert.doesNotMatch(fix, /- tests:/); // tests are covered: not listed
});

test('auditProject reads the commit count from git, and treats a git failure as history', () => {
  const root = project({ ...workflow(ci('run: npm test')), 'package.json': '{"scripts":{}}' });
  assert.equal(auditProject(root, () => '5\n').mode, 'greenfield');
  assert.equal(auditProject(root, () => '400\n').mode, 'brownfield');
  const throws = () => {
    throw new Error('not a git repository');
  };
  assert.equal(auditProject(root, throws).mode, 'brownfield');
  assert.equal(auditProject(root, () => 'garbage').mode, 'brownfield');
});

// doctor and init

function repo(files, commits = 100) {
  const root = project({
    'package.json': JSON.stringify({ scripts: { test: 'node --version' } }),
    'package-lock.json': '{}',
    ...files,
  });
  const git = (args) => {
    if (args[0] === 'rev-list') return String(commits);
    if (args[0] === 'remote') return 'https://github.com/octo/app.git';
    throw new Error(`git ${args.join(' ')}`);
  };
  return { root, git };
}
const gh = () => {
  throw new Error('no network');
};
const initAudit = (root, git) =>
  runInit(
    { root, ref: 'a'.repeat(40), labels: false, adapterSetup: false, gates: ['node --version'] },
    { git, gh: () => '', setup: () => {} },
  ).warnings.filter((w) => /^ci audit/.test(w));

test('init warns, for the kind of project it is, about the audits CI lacks', () => {
  const { root, git } = repo(workflow(ci('run: npm test')));
  const [warning] = initAudit(root, git);
  assert.match(warning, /^ci audit: brownfield project; no CI job found for lint or type check/);
  assert.match(warning, /Existing project/);
  const young = repo(workflow(ci('run: npm test')), 4);
  assert.match(initAudit(young.root, young.git)[0], /greenfield project/);
});

test('init is quiet when CI covers every kind of audit', () => {
  const covered = repo({
    ...workflow(COVERED_CI('CI')),
    '.github/dependabot.yml': DEPENDABOT_CONFIG,
  });
  assert.deepEqual(initAudit(covered.root, covered.git), []);
});

test('doctor reports the gaps as one warning with the fix, and ok when none is missing', () => {
  const gaps = repo(workflow(ci('run: npm test')));
  runInit(
    {
      root: gaps.root,
      ref: 'a'.repeat(40),
      labels: false,
      adapterSetup: false,
      gates: ['node --version'],
    },
    { git: gaps.git, gh: () => '', setup: () => {} },
  );
  const warned = runDoctor(gaps.root, { git: gaps.git, gh }).find((r) => r.name === 'ci audit');
  assert.equal(warned.status, 'warn');
  assert.match(warned.detail, /brownfield project; nothing found for: lint or type check/);
  assert.match(warned.detail, /Covered: tests/);
  assert.match(warned.fix, /Existing project/);

  const full = repo({
    ...workflow(COVERED_CI('CI')),
    '.github/dependabot.yml': DEPENDABOT_CONFIG,
  });
  runInit(
    {
      root: full.root,
      ref: 'a'.repeat(40),
      labels: false,
      adapterSetup: false,
      gates: ['node --version'],
    },
    { git: full.git, gh: () => '', setup: () => {} },
  );
  const good = runDoctor(full.root, { git: full.git, gh }).find((r) => r.name === 'ci audit');
  assert.equal(good.status, 'ok');
  assert.match(good.detail, /CI covers tests, lint or type check/);
});
