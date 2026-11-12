'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOOKS_DIR = '.githooks';
// The names git itself would accept; the branch is written into a shell script.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkBranch(branch) {
  if (!BRANCH.test(branch)) throw new Error(`default_branch "${branch}" cannot go in a git hook`);
}

/**
 * The lines that run the project's own hook commands (`hooks.chain`) after the
 * factory's check, for example a secret scan. Each runs in the shell with the
 * hook's arguments and a non-zero exit refuses the commit.
 */
function chainLines(chain) {
  return chain.map((command) => {
    if (CONTROL.test(command)) throw new Error(`hooks.chain entry has a control character`);
    return `${command} "$@" || exit 1`;
  });
}

// Marks a hook as the factory's own, so a rerun may replace it and nothing else.
const MARKER = '# Written by software-factory';
const BANNER =
  `${MARKER} from factory.config.yml (default_branch, hooks.chain).\n` +
  '# Change those and rerun the installer; edits here are overwritten.';

/** pre-commit: refuse a commit on the default branch, then run the project's own hooks. */
function renderPreCommit({ defaultBranch, chain = [] }) {
  checkBranch(defaultBranch);
  return [
    '#!/bin/sh',
    BANNER,
    `if [ "$(git branch --show-current)" = "${defaultBranch}" ]; then`,
    `  echo "pre-commit: refusing to commit on ${defaultBranch}. Run: git switch -c feature/<name>" >&2`,
    '  exit 1',
    'fi',
    ...chainLines(chain),
    'exit 0',
    '',
  ].join('\n');
}

/**
 * pre-push: refuse a push that updates the default branch on the remote. Git
 * passes one line per ref being pushed: <local ref> <local sha> <remote ref>
 * <remote sha>. The default branch changes only through a merged PR.
 */
function renderPrePush({ defaultBranch }) {
  checkBranch(defaultBranch);
  return [
    '#!/bin/sh',
    BANNER,
    'while read -r local_ref local_sha remote_ref remote_sha; do',
    `  if [ "$remote_ref" = "refs/heads/${defaultBranch}" ]; then`,
    `    echo "pre-push: refusing to push to ${defaultBranch} ($local_ref). Push a feature branch and open a PR." >&2`,
    '    exit 1',
    '  fi',
    'done',
    'exit 0',
    '',
  ].join('\n');
}

/** The hooks a config produces, by file name. */
function renderHooks(config) {
  const options = { defaultBranch: config.default_branch, chain: config.hooks.chain };
  return { 'pre-commit': renderPreCommit(options), 'pre-push': renderPrePush(options) };
}

/**
 * The hooks already in <root>/.githooks that the factory did not write: ones it
 * would overwrite and must not.
 */
function foreignHooks(root) {
  return ['pre-commit', 'pre-push'].filter((name) => {
    const file = path.join(root, HOOKS_DIR, name);
    return fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER);
  });
}

/**
 * Writes the hooks into <root>/.githooks, executable. Returns the file names.
 * A hook there that the factory did not write is never overwritten: it throws.
 */
function writeHooks(root, config) {
  const foreign = foreignHooks(root);
  if (foreign.length) {
    throw new Error(
      `${HOOKS_DIR} already has hooks the factory did not write (${foreign.join(', ')})`,
    );
  }
  const dir = path.join(root, HOOKS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const hooks = renderHooks(config);
  for (const [name, text] of Object.entries(hooks)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  return Object.keys(hooks);
}

module.exports = {
  HOOKS_DIR,
  foreignHooks,
  renderHooks,
  renderPreCommit,
  renderPrePush,
  writeHooks,
};
