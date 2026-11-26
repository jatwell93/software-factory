'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CALLERS } = require('./callers.js');
const { ownerDoc } = require('./owner-docs.js');
const { detectStack } = require('./detect.js');

/**
 * Which kinds of independent audit a project's CI has (#71). The factory's agent and its
 * review bots do not decide what may merge: the required CI checks do, and they run
 * outside the agent's environment. A project with only a lint job gets the same green
 * tick as one with tests and scans, so this names what is missing.
 *
 * Static and advisory: it reads the workflow files and the dependency-update config, runs
 * nothing, and never blocks. A scan set up in GitHub's settings (CodeQL's default setup)
 * leaves no file, so the fix text says to ignore the finding then.
 *
 * Advice differs by how mature the project is. A greenfield project has no history to
 * clear: require every check from the first commit, and write the test harness first,
 * because a gate that cannot fail makes every change look good. A brownfield project has
 * findings already: a new scan required at once would block every factory PR, so add it
 * report-only, clear the baseline, then require it.
 */

const GREENFIELD_COMMITS = 20;

/** Evidence of each category in the text of a workflow file. */
const CATEGORIES = [
  {
    key: 'tests',
    label: 'tests',
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpm t\b|\bpytest\b|\bgo test\b|\bcargo (?:test|nextest)\b|\b(?:vitest|jest|mocha|rspec|phpunit)\b|\b(?:dotnet|mvn|gradle|make)\s+test\b/,
  },
  {
    key: 'lint',
    label: 'lint or type check',
    pattern:
      /\b(?:eslint|ruff|flake8|pylint|mypy|pyright|tsc|clippy|golangci-lint|go vet|prettier|rubocop|biome)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|typecheck|type-check)\b/,
  },
  {
    key: 'security',
    label: 'security scan',
    pattern:
      /github\/codeql-action|\b(?:trivy|snyk|semgrep|bandit|gosec|govulncheck|osv-scanner|pip-audit)\b|\bcargo (?:audit|deny)\b|\bnpm audit\b|dependency-review-action/,
  },
  {
    key: 'secrets',
    label: 'secrets scan',
    pattern:
      /\b(?:gitleaks|trufflehog|detect-secrets|gitguardian|ggshield|secretlint)\b|\bgit[- ]secrets\b/,
  },
];

/** What to add, per stack and category. The first option is the one to start with. */
const ADVICE = {
  node: {
    tests: 'a job that runs `npm test` (vitest or jest)',
    lint: 'a job that runs `npm run lint` and the type check (`tsc --noEmit`)',
    security: 'the CodeQL action (javascript-typescript) and `dependency-review-action`',
    secrets: 'gitleaks',
  },
  python: {
    tests: 'a job that runs `pytest`',
    lint: 'a job that runs `ruff check .` and `mypy .`',
    security: 'the CodeQL action (python) and `pip-audit`',
    secrets: 'gitleaks',
  },
  go: {
    tests: 'a job that runs `go test ./...`',
    lint: 'a job that runs `go vet ./...` and `golangci-lint`',
    security: 'the CodeQL action (go) and `govulncheck`',
    secrets: 'gitleaks',
  },
  rust: {
    tests: 'a job that runs `cargo test`',
    lint: 'a job that runs `cargo clippy`',
    security: '`cargo audit` or `cargo deny`',
    secrets: 'gitleaks',
  },
};
const GENERIC_ADVICE = {
  tests: 'a job that runs the project’s tests',
  lint: 'a job that runs the project’s linter or type checker',
  security: 'a static analysis or dependency scan (CodeQL, Trivy, Semgrep or similar)',
  secrets: 'gitleaks',
};

const DEPENDABOT = ['.github/dependabot.yml', '.github/dependabot.yaml'];
const RENOVATE = [
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.github/renovate.json',
  '.github/renovate.json5',
];

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * A text without its YAML comments, whole-line or at the end of a line, so a `# TODO: add
 * pytest` is no evidence. A `#` counts only at the start or after a space: `a#b` is a word.
 */
const withoutComments = (text) => text.replace(/(^|\s)#.*$/gm, '$1');

/** The text of each workflow file that is the project's own: not one of the factory's callers. */
function projectWorkflows(root, skipFiles) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file) && !skipFiles.includes(file))
    .map((file) => withoutComments(readOrNull(path.join(dir, file)) || ''));
}

/** The dependency-update tool the project configures, and whether it waits before proposing. */
function dependencyPolicy(root) {
  for (const rel of DEPENDABOT) {
    const text = readOrNull(path.join(root, rel));
    if (text !== null) {
      return { tool: 'dependabot', cooldown: /^\s*cooldown\s*:/m.test(withoutComments(text)) };
    }
  }
  for (const rel of RENOVATE) {
    const text = readOrNull(path.join(root, rel));
    if (text !== null) {
      return { tool: 'renovate', cooldown: /minimumReleaseAge|stabilityDays/.test(text) };
    }
  }
  return null;
}

/**
 * @param {string} root The project's root.
 * @param {{stack?: string, commits?: number, skipFiles?: string[]}} options `commits` is the
 *   number of commits on the branch (unknown counts as a project with history).
 * @returns {{mode: 'greenfield'|'brownfield', present: string[], missing: {key: string,
 *   label: string, advice: string}[], dependency: {tool: string, cooldown: boolean}|null}}
 */
function auditCoverage(root, { stack = 'unknown', commits = Infinity, skipFiles = [] } = {}) {
  const texts = projectWorkflows(root, skipFiles);
  const advice = ADVICE[stack] || GENERIC_ADVICE;
  const present = [];
  const missing = [];
  for (const { key, label, pattern } of CATEGORIES) {
    if (texts.some((text) => pattern.test(text))) present.push(label);
    else missing.push({ key, label, advice: advice[key] });
  }
  const dependency = dependencyPolicy(root);
  if (dependency) present.push('dependency updates');
  else {
    missing.push({
      key: 'dependencies',
      label: 'dependency updates',
      advice: 'a Dependabot or Renovate config with a cooldown of a few days',
    });
  }
  const greenfield = texts.length === 0 || commits < GREENFIELD_COMMITS;
  return { mode: greenfield ? 'greenfield' : 'brownfield', present, missing, dependency };
}

/** What to do about the gaps, for the kind of project. */
function auditFix({ mode, missing }) {
  const list = missing.map((m) => `- ${m.label}: ${m.advice}`).join('\n');
  const settings =
    'If a scan runs from GitHub settings (CodeQL default setup) it leaves no workflow: ignore that line.';
  if (mode === 'greenfield') {
    return [
      'New project: add these to CI from the start, and list each job as a required check (--apply-ruleset --ci-check <job>).',
      list,
      'Write the tests and their CI job before the first factory task: a gate that cannot fail makes every change look good.',
      settings,
      `Details: ${ownerDoc('ciAudit')}`,
    ].join('\n');
  }
  return [
    'Existing project: keep the CI jobs it has and add only what is missing, as separate jobs.',
    list,
    'Start each new scan as a check that is not required. It will report findings the code already has, and a required check would block every factory PR. Clear or baseline them, then require it (--apply-ruleset --ci-check <job>).',
    settings,
    `Details: ${ownerDoc('ciAudit')}`,
  ].join('\n');
}

/** A cooldown is worth saying even when the policy exists: a fresh release is the risky one. */
function cooldownHint(dependency) {
  return dependency && !dependency.cooldown
    ? ` ${dependency.tool} has no cooldown: set one, so a version published minutes ago is not proposed.`
    : '';
}

/**
 * The audit coverage of a project on disk: its stack from its files, its history from git.
 * @param {(args: string[]) => string} git Runs git in the project's root.
 */
function auditProject(root, git) {
  let commits = Infinity;
  try {
    const count = Number.parseInt(git(['rev-list', '--count', 'HEAD']), 10);
    if (Number.isFinite(count)) commits = count;
  } catch {
    // No history to read (not a repository yet): treated as a project with history.
  }
  return auditCoverage(root, { stack: detectStack(root).stack, commits, skipFiles: CALLERS });
}

module.exports = {
  ADVICE,
  GENERIC_ADVICE,
  auditProject,
  GREENFIELD_COMMITS,
  auditCoverage,
  auditFix,
  cooldownHint,
};
