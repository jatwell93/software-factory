#!/usr/bin/env node
/**
 * Tidy the local checkout after PRs merge: delete local branches whose remote
 * branch is gone, remove their clean worktrees, and move off a merged branch
 * back onto an up-to-date default branch (`default_branch` of factory.config.yml). Each kept branch prints a manual-command hint;
 * the script never runs it.
 *
 * A branch is deleted only when BOTH hold:
 *
 *   * Its upstream is `[gone]`. GitHub deletes the head branch when a PR merges
 *     (repo setting `delete_branch_on_merge`), and `git fetch --prune` then
 *     marks the local upstream gone. A never-pushed branch has no upstream and
 *     is never touched.
 *   * Its local tip is already on GitHub: equal to (or behind) the head of a
 *     merged PR for that branch, or contained in `origin/<default branch>`. `[gone]` hides
 *     the ahead/behind count, so without this check a commit made after the
 *     merge would be lost to `git branch -D`. `git branch -d` cannot do this
 *     check: squash merges leave the branch "unmerged" as far as git can tell.
 *
 * A worktree with uncommitted changes is never removed, and its branch is kept.
 * The script refuses to run from a linked worktree, because it may need to
 * check out the default branch in the main checkout and remove linked worktrees.
 *
 * Usage:
 *   node scripts/cleanup-merged.js            # act, and print what was done
 *   node scripts/cleanup-merged.js --dry-run  # print the plan only
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');

// Never deleted, whatever the project's default branch is called.
const ALWAYS_PROTECTED = ['main', 'master'];

function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function defaultGh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
}

/** Parse `git for-each-ref --format=%(refname:short)%09%(upstream:short)%09%(upstream:track)`. */
function parseBranches(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream = '', track = ''] = line.split('\t');
      return { name, upstream, gone: track.trim() === '[gone]' };
    });
}

/** Parse `git worktree list --porcelain`. The first entry is the main checkout. */
function parseWorktrees(text) {
  return text
    .split(/\n\n+/)
    .filter((block) => block.trim())
    .map((block, index) => {
      const wt = { path: '', branch: null, locked: false, main: index === 0 };
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) wt.path = line.slice('worktree '.length);
        else if (line.startsWith('branch refs/heads/'))
          wt.branch = line.slice('branch refs/heads/'.length);
        else if (line === 'locked' || line.startsWith('locked ')) wt.locked = true;
      }
      return wt;
    });
}

/** Free a gone branch from the worktree holding it: the main checkout moves to main, others go. */
function releaseAction(wt, defaultBranch) {
  return wt.main
    ? { type: 'switch-to-default', from: wt.branch, to: defaultBranch }
    : { type: 'remove-worktree', path: wt.path, locked: wt.locked };
}

/** Gone, unprotected branches whose tip is on GitHub; the unverified rest go to `kept`. */
function deletableBranches(branches, verified, kept, protectedNames, defaultBranch) {
  const gone = new Set();
  for (const b of branches.filter((x) => x.gone && !protectedNames.has(x.name))) {
    if (verified.has(b.name)) gone.add(b.name);
    else
      kept.push({
        branch: b.name,
        reason: `local commits not in any merged PR or origin/${defaultBranch}`,
        hint: `to delete anyway: git branch -D ${b.name}`,
      });
  }
  return gone;
}

/**
 * A gone branch checked out somewhere must be released before it can be
 * deleted; a dirty checkout keeps its branch instead (removed from `gone`).
 * The main checkout is listed first, so a switch precedes removals.
 */
function releaseWorktrees(worktrees, gone, dirty, kept, defaultBranch) {
  const actions = [];
  for (const wt of worktrees.filter((w) => gone.has(w.branch))) {
    if (!dirty.has(wt.path)) {
      actions.push(releaseAction(wt, defaultBranch));
      continue;
    }
    const where = wt.main ? 'current branch' : `worktree ${wt.path}`;
    kept.push({
      branch: wt.branch,
      reason: `${where} has uncommitted changes`,
      hint: `to inspect: git -C ${wt.path} status`,
    });
    gone.delete(wt.branch);
  }
  return actions;
}

/**
 * Decide what to do. Pure: `dirty` is the set of worktree paths with
 * uncommitted changes, `verified` the set of branch names whose tip is
 * already on GitHub.
 */
function plan({ branches, worktrees, dirty, verified, defaultBranch = 'main' }) {
  const kept = [];
  const protectedNames = new Set([...ALWAYS_PROTECTED, defaultBranch]);
  const gone = deletableBranches(branches, verified, kept, protectedNames, defaultBranch);
  const actions = releaseWorktrees(worktrees, gone, dirty, kept, defaultBranch);
  for (const name of gone) actions.push({ type: 'delete-branch', branch: name });
  if (actions.length) actions.push({ type: 'prune-worktrees' });
  return { actions, kept };
}

function succeeds(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function isDirty(git, wtPath) {
  try {
    return git(['-C', wtPath, 'status', '--porcelain']).trim() !== '';
  } catch {
    // A worktree directory that no longer exists has nothing to lose.
    return false;
  }
}

/** name -> head SHAs of merged PRs from that branch (names can be reused). */
function mergedHeads(gh) {
  const rows = JSON.parse(
    gh(['pr', 'list', '--state', 'merged', '--limit', '300', '--json', 'headRefName,headRefOid']),
  );
  const heads = new Map();
  for (const r of rows)
    heads.set(r.headRefName, [...(heads.get(r.headRefName) || []), r.headRefOid]);
  return heads;
}

/** True when the branch tip is a merged PR head, behind one, or in origin/main. */
function tipIsOnGitHub(git, name, heads, defaultBranch) {
  const tip = git(['rev-parse', `refs/heads/${name}`]).trim();
  const ancestorOf = (ref) => succeeds(() => git(['merge-base', '--is-ancestor', tip, ref]));
  return (
    (heads.get(name) || []).some((oid) => oid === tip || ancestorOf(oid)) ||
    ancestorOf(`origin/${defaultBranch}`)
  );
}

function inLinkedWorktree(git) {
  const [gitDir, commonDir] = git([
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ])
    .trim()
    .split('\n');
  return path.resolve(gitDir) !== path.resolve(commonDir);
}

const ACTIONS = {
  'switch-to-default': {
    describe: (a) => `switch ${a.from} -> ${a.to} and pull --ff-only`,
    commands: (a) => [
      ['checkout', '-q', a.to],
      ['pull', '-q', '--ff-only'],
    ],
  },
  'remove-worktree': {
    describe: (a) => `remove worktree ${a.path}${a.locked ? ' (unlock first)' : ''}`,
    commands: (a) => [
      ...(a.locked ? [['worktree', 'unlock', a.path]] : []),
      ['worktree', 'remove', a.path],
    ],
  },
  'delete-branch': {
    describe: (a) => `delete branch ${a.branch} (merged, remote gone)`,
    commands: (a) => [['branch', '-D', a.branch]],
  },
  'prune-worktrees': {
    describe: () => 'git worktree prune',
    commands: () => [['worktree', 'prune']],
  },
};

function execute(actions, git) {
  for (const a of actions) ACTIONS[a.type].commands(a).forEach((args) => git(args));
}

function main(
  argv,
  { git = defaultGit, gh = defaultGh, log = console.log, defaultBranch = 'main' } = {},
) {
  const dryRun = argv.includes('--dry-run');
  if (inLinkedWorktree(git)) {
    log('run this from the main checkout, not a linked worktree');
    return 1;
  }
  git(['fetch', '-q', '--prune', 'origin']);
  const branches = parseBranches(
    git([
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)',
      'refs/heads',
    ]),
  );
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain']));
  const dirty = new Set(worktrees.filter((w) => isDirty(git, w.path)).map((w) => w.path));
  const goneNames = branches.filter((b) => b.gone).map((b) => b.name);
  const heads = goneNames.length ? mergedHeads(gh) : new Map();
  const verified = new Set(
    goneNames.filter((name) => tipIsOnGitHub(git, name, heads, defaultBranch)),
  );

  const { actions, kept } = plan({ branches, worktrees, dirty, verified, defaultBranch });
  for (const k of kept) {
    log(`keep ${k.branch}: ${k.reason}`);
    log(`  ${k.hint}`);
  }
  if (!actions.length) {
    log('nothing to clean');
    return 0;
  }
  for (const a of actions) log(`${dryRun ? 'would ' : ''}${ACTIONS[a.type].describe(a)}`);
  if (!dryRun) execute(actions, git);
  return 0;
}

/**
 * Runs on the project in `cwd`: the folder the script is run in, not where the
 * factory is installed. Its default branch is the config's.
 */
function cli(cwd, argv, { git, gh, log } = {}) {
  return main(argv, {
    git: git || ((args) => defaultGit(args, { cwd })),
    gh: gh || ((args) => defaultGh(args, { cwd })),
    log,
    defaultBranch: loadConfig(cwd).default_branch,
  });
}

if (require.main === module) runCli(() => cli(process.cwd(), process.argv.slice(2)));

module.exports = { parseBranches, parseWorktrees, plan, main, cli };
