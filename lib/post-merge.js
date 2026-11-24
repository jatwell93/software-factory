'use strict';

const { usage } = require('./init.js');

const PR_FIELDS = 'number,title,state,headRefName,headRefOid,labels,url';

const succeeds = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

/** The checked-out branch, or null when HEAD is detached. */
function currentBranch(git) {
  try {
    return git(['symbolic-ref', '--short', '-q', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * True when the local branch tip is already on GitHub: the merged PR's head, behind
 * it, or inside the default branch. `git branch -d` cannot tell for a squash merge,
 * and a commit made after the merge must never be thrown away.
 */
function tipIsOnGitHub(git, branch, headOid, defaultBranch) {
  const tip = git(['rev-parse', `refs/heads/${branch}`]).trim();
  const ancestorOf = (ref) => succeeds(() => git(['merge-base', '--is-ancestor', tip, ref]));
  return tip === headOid || ancestorOf(headOid) || ancestorOf(`origin/${defaultBranch}`);
}

/**
 * After a PR merges: confirm it, put the checkout on an up-to-date default branch,
 * delete the merged local branch when nothing on it would be lost, clean up the
 * rest, and say what happens next. Never deletes a branch with commits GitHub lacks
 * and never touches a dirty tree.
 *
 * @param {{pr?: string}} options The PR number; with none, the current branch's PR.
 * @param {{git: Function, gh: Function, config: object, cleanup: Function, log: Function}} io
 *   git and gh take an args array and return stdout, or throw.
 * @returns {number} 0 merged and tidied, 1 not merged (yet).
 */
function postMerge(options, io) {
  const { git, gh, config, cleanup, log } = io;
  const defaultBranch = config.default_branch;
  let pr;
  try {
    pr = JSON.parse(gh(['pr', 'view', ...(options.pr ? [options.pr] : []), '--json', PR_FIELDS]));
  } catch {
    throw usage(
      options.pr
        ? `cannot read PR ${options.pr}: check the number and that gh is logged in`
        : 'no PR for the current branch: pass a PR number, as in `factory post-merge 123`',
    );
  }

  if (pr.state !== 'MERGED') {
    log(
      pr.state === 'CLOSED'
        ? `PR #${pr.number} was closed without merging: ${pr.url}`
        : `PR #${pr.number} is not merged yet: ${pr.url}`,
    );
    return 1;
  }
  log(`PR #${pr.number} merged: ${pr.title}`);

  git(['fetch', '-q', '--prune', 'origin']);
  const here = currentBranch(git);
  const dirty = git(['status', '--porcelain']).trim() !== '';

  if (dirty) {
    log(`keep ${here || 'HEAD'}: uncommitted changes, nothing switched or deleted`);
  } else {
    const onMergedBranch = here === pr.headRefName && here !== defaultBranch;
    if (onMergedBranch && !tipIsOnGitHub(git, here, pr.headRefOid, defaultBranch)) {
      log(`keep ${here}: it has commits GitHub does not, so it is not deleted`);
    } else {
      if (here !== defaultBranch) git(['switch', '-q', defaultBranch]);
      git(['pull', '-q', '--ff-only']);
      log(`on ${defaultBranch}, up to date`);
      if (onMergedBranch) {
        git(['branch', '-D', here]);
        log(`deleted ${here}`);
      }
    }
  }

  try {
    cleanup();
  } catch (error) {
    log(`cleanup skipped: ${String(error.message || error).split('\n')[0]}`);
  }

  next(pr, config, gh, log);
  return 0;
}

/** What the factory does now, and what is waiting on the owner. */
function next(pr, config, gh, log) {
  const { change_prefix: prefix, needs_human: needsHuman } = config.labels;
  const change = pr.labels.map((l) => l.name).find((n) => n.startsWith(prefix));
  if (change) {
    log(
      `change ${change.slice(prefix.length)}: the factory starts its next task by itself; ` +
        'nothing to run',
    );
  }
  let open = [];
  try {
    open = JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number,title,labels,url']));
  } catch {
    log('open PRs: could not be read');
    return;
  }
  const waiting = open.filter((p) => p.labels.some((l) => l.name === needsHuman));
  const factory = open.filter(
    (p) => !waiting.includes(p) && p.labels.some((l) => l.name.startsWith(prefix)),
  );
  for (const p of waiting) log(`waiting on you: #${p.number} ${p.title} (${needsHuman}) ${p.url}`);
  for (const p of factory) log(`factory PR in flight: #${p.number} ${p.title}`);
  if (!waiting.length && !factory.length) log('no factory PR is open or waiting on you');
}

module.exports = { postMerge, tipIsOnGitHub };
