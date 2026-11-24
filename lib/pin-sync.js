'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runUpgrade } = require('./upgrade.js');

/**
 * A label for the ref that is safe in a branch name and a PR title: seven characters
 * of a commit SHA, or the sanitised tag (`v1.2.3` must not collapse to `v1.2.3`'s
 * first seven characters, which would collide with `v1.2.30` and can end in a dot).
 */
function refLabel(ref) {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7).toLowerCase();
  const label = ref
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.lock$/i, '-lock');
  return label.slice(0, 60) || 'ref';
}

/** The default branch's tip on origin: `origin/HEAD`, else `origin/main`. */
function baseRef(git) {
  try {
    return git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  } catch {
    return 'origin/main';
  }
}

/**
 * Opens one pin-bump PR in a consumer repository: a branch from the default
 * branch, `upgrade` run on it, one commit, a push and a PR. It runs on the
 * owner's machine with the owner's `gh` login on purpose: the pin edits
 * `.github/workflows`, and the factory's own tokens must not hold the
 * `workflows` scope. It never touches a dirty tree, and it puts the checkout back
 * on the branch (or the detached commit) it found. A dry run works in a throwaway
 * worktree of the default branch's tip, so it reports what a real run would do
 * whatever the checkout is on.
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
  const short = refLabel(ref);
  const skip = (note) => ({ root, status: 'skipped', note });

  if (dryRun) {
    git('fetch', 'origin', '--quiet');
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pin-sync-'));
    git('worktree', 'add', '--detach', '--quiet', tree, baseRef(git));
    try {
      const result = upgrade({ root: tree, ref, checkoutCommit, dryRun: true });
      const changed = result.files.filter((f) => f.status === 'updated' || f.status === 'created');
      return changed.length === 0
        ? { root, status: 'unchanged', note: `already at ${short}` }
        : { root, status: 'would-open', note: `${changed.length} file(s) would change` };
    } finally {
      try {
        git('worktree', 'remove', '--force', tree);
      } catch {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    }
  }

  if (git('status', '--porcelain') !== '') return skip('working tree is not clean');
  let restore;
  try {
    const name = git('symbolic-ref', '--short', '-q', 'HEAD');
    restore = (...flags) => git('switch', ...flags, name);
  } catch {
    const commit = git('rev-parse', 'HEAD');
    restore = (...flags) => git('switch', ...flags, '--detach', commit);
  }

  git('fetch', 'origin', '--quiet');
  const base = baseRef(git);
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
  let pushed = false;
  try {
    const result = upgrade({ root, ref, checkoutCommit });
    const changed = result.files.filter((f) => f.status === 'updated' || f.status === 'created');
    if (changed.length === 0) {
      restore();
      git('branch', '-d', branch);
      return { root, status: 'unchanged', note: `already at ${short}` };
    }
    git('add', '--', ...changed.map((f) => f.path));
    const title = `ci(factory): move the pin to software-factory ${short}`;
    git('commit', '-q', '-m', title);
    git('push', '-q', '-u', 'origin', branch);
    pushed = true;
    const body = [
      `Moves the factory pin to \`${ref}\`. Written by \`factory pin-sync\`.`,
      '',
      ...changed.map((f) => `- \`${f.path}\`${f.note ? `: ${f.note}` : ''}`),
      ...(result.warnings.length ? ['', ...result.warnings.map((w) => `Warning: ${w}`)] : []),
    ].join('\n');
    const url = io.gh(root, ['pr', 'create', '--title', title, '--body', body, '--head', branch]);
    restore();
    return {
      root,
      status: 'opened',
      note: `${changed.length} file(s)`,
      url: url.split('\n').pop(),
    };
  } catch (error) {
    // Undo everything this run made, so the next run starts clean: a branch left on
    // origin would make every later run skip this repository.
    for (const undo of [
      () => restore('--discard-changes'),
      () => git('branch', '-D', branch),
      () => pushed && git('push', 'origin', '--delete', branch),
    ]) {
      try {
        undo();
      } catch {
        // Leave the state for the owner; the error below says what failed.
      }
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

module.exports = { syncRepo, syncPins, parseConsumers, refLabel };
