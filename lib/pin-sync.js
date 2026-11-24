'use strict';

const { runUpgrade } = require('./upgrade.js');

/**
 * Opens one pin-bump PR in a consumer repository: a branch from the default
 * branch, `upgrade` run on it, one commit, a push and a PR. It runs on the
 * owner's machine with the owner's `gh` login on purpose: the pin edits
 * `.github/workflows`, and the factory's own tokens must not hold the
 * `workflows` scope. It never touches a dirty tree, and it puts the checkout back
 * on the branch it found.
 *
 * @param {string} root The consumer repository's root.
 * @param {object} options ref, checkoutCommit, dryRun.
 * @param {{git: Function, gh: Function, upgrade?: Function}} io git and gh take
 *   (root, args) and return trimmed stdout, or throw.
 * @returns {{root: string, status: string, note: string, url?: string}}
 *   status is `opened`, `unchanged`, `skipped` or `would-open`.
 */
function syncRepo(root, options, io) {
  const { ref, checkoutCommit, dryRun } = options;
  const git = (...args) => io.git(root, args);
  const upgrade = io.upgrade || ((opts) => runUpgrade(opts, { gh: (args) => io.gh(root, args) }));
  const short = ref.slice(0, 7);
  const skip = (note) => ({ root, status: 'skipped', note });

  if (git('status', '--porcelain') !== '') return skip('working tree is not clean');
  const original = git('rev-parse', '--abbrev-ref', 'HEAD');

  if (dryRun) {
    const result = upgrade({ root, ref, checkoutCommit, dryRun: true });
    const changed = result.files.filter((f) => f.status !== 'unchanged' && f.status !== 'skipped');
    return changed.length === 0
      ? { root, status: 'unchanged', note: `already at ${short}` }
      : { root, status: 'would-open', note: `${changed.length} file(s) would change` };
  }

  git('fetch', 'origin', '--quiet');
  let base = 'origin/main';
  try {
    base = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    // origin/HEAD is not set: main is the fallback.
  }
  const branch = `chore/factory-pin-${short}`;
  try {
    git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
    return skip(`branch ${branch} already exists`);
  } catch {
    // Not there: good.
  }
  try {
    git('ls-remote', '--exit-code', '--heads', 'origin', branch);
    return skip(`branch ${branch} is already on origin`);
  } catch {
    // Not there: good.
  }

  git('switch', '-c', branch, base);
  try {
    const result = upgrade({ root, ref, checkoutCommit });
    const changed = result.files.filter((f) => f.status === 'updated' || f.status === 'created');
    if (changed.length === 0) {
      git('switch', original);
      git('branch', '-d', branch);
      return { root, status: 'unchanged', note: `already at ${short}` };
    }
    git('add', '--', ...changed.map((f) => f.path));
    const title = `ci(factory): move the pin to software-factory ${short}`;
    git('commit', '-q', '-m', title);
    git('push', '-q', '-u', 'origin', branch);
    const body = [
      `Moves the factory pin to \`${ref}\`. Written by \`factory pin-sync\`.`,
      '',
      ...changed.map((f) => `- \`${f.path}\`${f.note ? `: ${f.note}` : ''}`),
      ...(result.warnings.length ? ['', ...result.warnings.map((w) => `Warning: ${w}`)] : []),
    ].join('\n');
    const url = io.gh(root, ['pr', 'create', '--title', title, '--body', body, '--head', branch]);
    git('switch', original);
    return {
      root,
      status: 'opened',
      note: `${changed.length} file(s)`,
      url: url.split('\n').pop(),
    };
  } catch (error) {
    try {
      git('switch', '--discard-changes', original);
      git('branch', '-D', branch);
    } catch {
      // Leave the state for the owner; the error below says what failed.
    }
    throw error;
  }
}

/** Runs `syncRepo` for each root; one repository failing does not stop the rest. */
function syncPins(roots, options, io) {
  return roots.map((root) => {
    try {
      return syncRepo(root, options, io);
    } catch (error) {
      return { root, status: 'failed', note: String(error.message || error).split('\n')[0] };
    }
  });
}

/** Parses a consumers file: one path per line, `#` starts a comment. */
function parseConsumers(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

module.exports = { syncRepo, syncPins, parseConsumers };
