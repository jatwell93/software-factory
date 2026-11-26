'use strict';

/**
 * The permission rules `init` adds to a project's .claude/settings.json, so the agent stops
 * asking about the factory's read-only commands. Each entry says why it is safe.
 *
 * Never here: `gh api` (it can write with any verb), `gh pr merge`, `gh ... delete`, a force
 * push. A script that writes outside the working tree, or to GitHub, is not here either:
 * NOT_ALLOWED names each one and says why, and a test fails when a script is in neither list.
 */

const FACTORY = '$FACTORY_DIR';

/** The rules for one script: with and without quotes round the path, as skills write it either way. */
const script = (rel) => [`Bash(node "${FACTORY}/${rel}":*)`, `Bash(node ${FACTORY}/${rel}:*)`];

/** @type {{label: string, rules: string[], reason: string}[]} */
const ALLOWED = [
  {
    label: 'scripts/pr-feedback.js',
    rules: script('scripts/pr-feedback.js'),
    reason:
      'Reads a pull request: checks, threads, reviews. Its reply and resolve commands only answer and close review threads.',
  },
  {
    label: 'scripts/factory-status.js',
    rules: script('scripts/factory-status.js'),
    reason: 'Reads every open pull request and prints one line each.',
  },
  {
    label: 'scripts/factory-doctor.js',
    rules: script('scripts/factory-doctor.js'),
    reason: 'Reads the project and GitHub and prints each gap with its fix.',
  },
  {
    label: 'scripts/check-no-go.js',
    rules: script('scripts/check-no-go.js'),
    reason: 'Reads a diff and fails when it touches a protected path.',
  },
  {
    label: 'scripts/check-ignored.js',
    rules: script('scripts/check-ignored.js'),
    reason: 'Reads git’s ignore rules and fails when a source file is hidden by one.',
  },
  {
    label: 'scripts/check-change-ids.js',
    rules: script('scripts/check-change-ids.js'),
    reason: 'Reads the change ids in a pull request and fails on a clash.',
  },
  {
    label: 'scripts/babysit-round.js',
    rules: script('scripts/babysit-round.js'),
    reason: 'Reads the commit trailers of the current branch and prints the round count.',
  },
  {
    label: 'scripts/factory-check-change.js',
    rules: script('scripts/factory-check-change.js'),
    reason: 'Reads the spec source and fails when a change is missing.',
  },
  {
    label: 'bin/factory.js status and doctor',
    rules: ['status', 'doctor'].flatMap((sub) => [
      `Bash(node "${FACTORY}/bin/factory.js" ${sub}:*)`,
      `Bash(node ${FACTORY}/bin/factory.js ${sub}:*)`,
    ]),
    reason:
      'The front door, for the two read-only commands only. The rest (init, upgrade, cleanup) write and still ask.',
  },
  ...[
    ['pr view', 'a pull request'],
    ['pr list', 'pull requests'],
    ['pr checks', 'a pull request’s checks'],
    ['pr diff', 'a pull request’s diff'],
    ['run view', 'a workflow run and its log'],
    ['run list', 'workflow runs'],
    ['workflow view', 'a workflow'],
    ['workflow list', 'workflows'],
    ['issue view', 'an issue'],
    ['issue list', 'issues'],
  ].map(([verb, what]) => ({
    label: `gh ${verb}`,
    rules: [`Bash(gh ${verb}:*)`],
    reason: `Reads ${what}. It has no write verb.`,
  })),
];

/** Every script in scripts/ the allowlist leaves out, with the reason. Keeps the list honest. */
const NOT_ALLOWED = {
  'cleanup-merged.js': 'deletes local branches and worktrees',
  'factory-denied.js': 'comments on the tracking issue; runs inside the workflow runner',
  'factory-digest.js': 'posts a comment on GitHub',
  'factory-env.js': 'runs inside the workflow runner only',
  'factory-escalate.js': 'labels and comments on GitHub',
  'factory-init.js': 'writes the project and GitHub (labels, ruleset)',
  'factory-install-spec-cli.js': 'installs a program',
  'factory-issue.js': 'creates a tracking issue when there is none',
  'factory-late-comment.js': 'opens an issue on GitHub',
  'factory-new-change.js': 'writes a change into the project',
  'factory-pin-sync.js': 'opens pull requests in other projects',
  'factory-post-merge.js': 'pulls the default branch and deletes the merged branch',
  'factory-requeue.js': 'edits labels and starts workflow runs',
  'factory-retry.js': 'edits labels and comments on GitHub',
  'factory-reviews-settled.js': 'posts a commit status on GitHub',
  'factory-route.js': 'starts workflow runs',
  'factory-run-record.js': 'writes the run record on GitHub',
  'factory-stalled.js': 'edits labels and comments on GitHub',
  'factory-sweep.js': 'starts workflow runs',
  'factory-ticket.js': 'creates issues on GitHub',
  'factory-upgrade.js': 'rewrites the workflows and skills of the project',
  'install-git-hooks.js': 'writes git hooks and changes git config',
};

/** Every rule, once. */
const RULES = ALLOWED.flatMap((entry) => entry.rules);

/**
 * The settings text with the rules added to permissions.allow, and what was added. Everything
 * else in the file stays as it was. Throws an Error that says what is wrong with a file it
 * cannot merge into, so init can warn and carry on.
 *
 * @param {string|null} existing The current text, or null when there is no file.
 * @returns {{text: string|null, added: string[]}} text is null when nothing changes.
 */
function mergeSettings(existing, rules = RULES) {
  let doc = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      doc = JSON.parse(existing);
    } catch (error) {
      throw new Error(`not valid JSON (${error.message})`);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('not a JSON object');
    }
  }
  const permissions = doc.permissions ?? {};
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error('"permissions" is not an object');
  }
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) throw new Error('"permissions.allow" is not a list');
  const added = rules.filter((rule) => !allow.includes(rule));
  if (added.length === 0) return { text: null, added };
  doc.permissions = { ...permissions, allow: [...allow, ...added] };
  return { text: `${JSON.stringify(doc, null, 2)}\n`, added };
}

/** The rules a settings text lacks (all of them when it is absent). Throws as mergeSettings does for a file it cannot read. */
function missingRules(existing, rules = RULES) {
  return mergeSettings(existing, rules).added;
}

module.exports = { ALLOWED, NOT_ALLOWED, RULES, mergeSettings, missingRules };
