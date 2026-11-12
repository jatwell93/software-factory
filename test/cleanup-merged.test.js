const test = require('node:test');
const assert = require('node:assert/strict');

const { parseBranches, parseWorktrees, plan, main, cli } = require('../scripts/cleanup-merged.js');
const { tempRoot } = require('./helpers.js');

const BRANCHES = [
  'main\torigin/main\t',
  'feature/merged\torigin/feature/merged\t[gone]',
  'feature/open\torigin/feature/open\t[ahead 1]',
  'feature/local-only\t\t',
  'feature/in-worktree\torigin/feature/in-worktree\t[gone]',
  'feature/dirty-wt\torigin/feature/dirty-wt\t[gone]',
].join('\n');

const WORKTREES = [
  'worktree C:/repo\nHEAD aaa\nbranch refs/heads/main',
  'worktree C:/repo/.claude/worktrees/agent-1\nHEAD bbb\nbranch refs/heads/feature/in-worktree\nlocked claude agent',
  'worktree C:/repo/.claude/worktrees/agent-2\nHEAD ccc\nbranch refs/heads/feature/dirty-wt',
  'worktree C:/repo/.claude/worktrees/agent-3\nHEAD ddd\ndetached',
].join('\n\n');

const ALL_VERIFIED = new Set(['feature/merged', 'feature/in-worktree', 'feature/dirty-wt']);

test('parseBranches marks only [gone] upstreams', () => {
  const b = parseBranches(BRANCHES);
  assert.deepEqual(
    b.filter((x) => x.gone).map((x) => x.name),
    ['feature/merged', 'feature/in-worktree', 'feature/dirty-wt'],
  );
  assert.equal(b.find((x) => x.name === 'feature/local-only').upstream, '');
});

test('parseWorktrees reads path, branch, lock, and which entry is the main checkout', () => {
  const w = parseWorktrees(WORKTREES);
  assert.equal(w.length, 4);
  assert.equal(w[0].main, true);
  assert.equal(w[0].branch, 'main');
  assert.equal(w[1].locked, true);
  assert.equal(w[1].branch, 'feature/in-worktree');
  assert.equal(w[3].branch, null);
});

test('plan deletes verified gone branches, keeps open, local-only and dirty ones', () => {
  const { actions, kept } = plan({
    branches: parseBranches(BRANCHES),
    worktrees: parseWorktrees(WORKTREES),
    dirty: new Set(['C:/repo/.claude/worktrees/agent-2']),
    verified: ALL_VERIFIED,
  });
  assert.deepEqual(actions, [
    { type: 'remove-worktree', path: 'C:/repo/.claude/worktrees/agent-1', locked: true },
    { type: 'delete-branch', branch: 'feature/merged' },
    { type: 'delete-branch', branch: 'feature/in-worktree' },
    { type: 'prune-worktrees' },
  ]);
  assert.deepEqual(kept, [
    {
      branch: 'feature/dirty-wt',
      reason: 'worktree C:/repo/.claude/worktrees/agent-2 has uncommitted changes',
      hint: 'to inspect: git -C C:/repo/.claude/worktrees/agent-2 status',
    },
  ]);
});

test('a gone branch whose tip is not on GitHub is kept, even when clean', () => {
  const { actions, kept } = plan({
    branches: parseBranches('feature/merged\torigin/feature/merged\t[gone]'),
    worktrees: parseWorktrees('worktree C:/repo\nHEAD a\nbranch refs/heads/main'),
    dirty: new Set(),
    verified: new Set(),
  });
  assert.deepEqual(actions, []);
  assert.deepEqual(kept, [
    {
      branch: 'feature/merged',
      reason: 'local commits not in any merged PR or origin/main',
      hint: 'to delete anyway: git branch -D feature/merged',
    },
  ]);
});

test('a merged branch in the main checkout switches to main first, unless dirty', () => {
  const base = {
    branches: parseBranches(BRANCHES),
    worktrees: parseWorktrees('worktree C:/repo\nHEAD a\nbranch refs/heads/feature/merged'),
    verified: ALL_VERIFIED,
  };
  const clean = plan({ ...base, dirty: new Set() });
  assert.deepEqual(clean.actions[0], {
    type: 'switch-to-default',
    from: 'feature/merged',
    to: 'main',
  });
  assert.ok(clean.actions.some((a) => a.type === 'delete-branch' && a.branch === 'feature/merged'));

  const dirty = plan({ ...base, dirty: new Set(['C:/repo']) });
  assert.ok(!dirty.actions.some((a) => a.type === 'switch-to-default'));
  assert.ok(!dirty.actions.some((a) => a.branch === 'feature/merged'));
  assert.equal(dirty.kept[0].branch, 'feature/merged');
});

test('main and master are never deleted, even if their upstream is gone', () => {
  const { actions } = plan({
    branches: parseBranches('main\torigin/main\t[gone]\nmaster\torigin/master\t[gone]'),
    worktrees: parseWorktrees('worktree C:/repo\nHEAD a\nbranch refs/heads/feature/x'),
    dirty: new Set(),
    verified: new Set(['main', 'master']),
  });
  assert.deepEqual(actions, []);
});

/**
 * Fake git: `tips` maps branch -> SHA, `ancestors` lists "sha ref" pairs for
 * which `merge-base --is-ancestor` succeeds. `linked` simulates a linked worktree.
 */
function fakeGit({ branches, worktrees, tips = {}, ancestors = [], linked = false }) {
  const calls = [];
  const gitDirs = linked
    ? 'C:/repo/.git/worktrees/a\nC:/repo/.git\n'
    : 'C:/repo/.git\nC:/repo/.git\n';
  const isAncestor = (args) => {
    if (ancestors.includes(`${args[2]} ${args[3]}`)) return '';
    throw new Error('not ancestor');
  };
  // Keyed by the first one or two args; the most specific key wins.
  const handlers = {
    'rev-parse --path-format=absolute': () => gitDirs,
    'rev-parse': (args) => `${tips[args[1].replace('refs/heads/', '')]}\n`,
    'merge-base': isAncestor,
    'for-each-ref': () => branches,
    'worktree list': () => worktrees,
  };
  const git = (args) => {
    calls.push(args.join(' '));
    const handler = handlers[args.slice(0, 2).join(' ')] || handlers[args[0]];
    return handler ? handler(args) : '';
  };
  return { git, calls };
}

const ghMerged = (rows) => () => JSON.stringify(rows);

test('--dry-run fetches and plans but runs no destructive git command', () => {
  const { git, calls } = fakeGit({
    branches: BRANCHES,
    worktrees: WORKTREES,
    tips: { 'feature/merged': 's1', 'feature/in-worktree': 's2', 'feature/dirty-wt': 's3' },
  });
  const gh = ghMerged([
    { headRefName: 'feature/merged', headRefOid: 's1' },
    { headRefName: 'feature/in-worktree', headRefOid: 's2' },
    { headRefName: 'feature/dirty-wt', headRefOid: 's3' },
  ]);
  const lines = [];
  main(['--dry-run'], { git, gh, log: (l) => lines.push(l) });
  assert.ok(calls.some((c) => c.startsWith('fetch')));
  assert.ok(
    !calls.some((c) => /^(branch -D|worktree remove|worktree unlock|checkout|pull)/.test(c)),
  );
  assert.ok(lines.includes('would delete branch feature/merged (merged, remote gone)'));
});

test('a tip ahead of the merged PR head is kept; one behind it or in origin/main is deleted', () => {
  const { git, calls } = fakeGit({
    branches: [
      'feature/ahead\torigin/feature/ahead\t[gone]',
      'feature/behind\torigin/feature/behind\t[gone]',
      'feature/in-main\torigin/feature/in-main\t[gone]',
    ].join('\n'),
    worktrees: 'worktree C:/repo\nHEAD a\nbranch refs/heads/main',
    tips: { 'feature/ahead': 'new', 'feature/behind': 'old', 'feature/in-main': 'm1' },
    ancestors: ['old head2', 'm1 origin/main'],
  });
  const gh = ghMerged([
    { headRefName: 'feature/ahead', headRefOid: 'head1' },
    { headRefName: 'feature/behind', headRefOid: 'head2' },
  ]);
  const lines = [];
  main([], { git, gh, log: (l) => lines.push(l) });
  const deleted = calls.filter((c) => c.startsWith('branch -D'));
  assert.deepEqual(deleted, ['branch -D feature/behind', 'branch -D feature/in-main']);
  assert.ok(
    lines.includes('keep feature/ahead: local commits not in any merged PR or origin/main'),
  );
  const at = lines.findIndex((l) => l.startsWith('keep feature/ahead'));
  assert.equal(lines[at + 1], '  to delete anyway: git branch -D feature/ahead');
  assert.ok(!calls.includes('branch -D feature/ahead'));
});

test('without --dry-run the planned actions run in order', () => {
  const { git, calls } = fakeGit({
    branches: 'feature/merged\torigin/feature/merged\t[gone]',
    worktrees: 'worktree C:/repo\nHEAD a\nbranch refs/heads/feature/merged',
    tips: { 'feature/merged': 's1' },
  });
  main([], {
    git,
    gh: ghMerged([{ headRefName: 'feature/merged', headRefOid: 's1' }]),
    log: () => {},
  });
  const destructive = calls.filter((c) => /^(checkout|pull|branch -D|worktree prune)/.test(c));
  assert.deepEqual(destructive, [
    'checkout -q main',
    'pull -q --ff-only',
    'branch -D feature/merged',
    'worktree prune',
  ]);
});

test('refuses to run from a linked worktree', () => {
  const { git, calls } = fakeGit({ branches: '', worktrees: '', linked: true });
  const lines = [];
  assert.equal(main([], { git, gh: ghMerged([]), log: (l) => lines.push(l) }), 1);
  assert.equal(calls.length, 1);
  assert.match(lines[0], /main checkout/);
});

test('a dirty worktree prints an inspect hint and nothing is removed', () => {
  const { git, calls } = fakeGit({
    branches: 'feature/dirty\torigin/feature/dirty\t[gone]',
    worktrees:
      'worktree C:/repo\nHEAD a\nbranch refs/heads/main\n\nworktree C:/repo/wt\nHEAD b\nbranch refs/heads/feature/dirty',
    tips: { 'feature/dirty': 's1' },
  });
  const dirtyGit = (args) =>
    args.join(' ') === '-C C:/repo/wt status --porcelain' ? ' M f\n' : git(args);
  const lines = [];
  main([], {
    git: dirtyGit,
    gh: ghMerged([{ headRefName: 'feature/dirty', headRefOid: 's1' }]),
    log: (l) => lines.push(l),
  });
  const at = lines.findIndex((l) => l.startsWith('keep feature/dirty'));
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], '  to inspect: git -C C:/repo/wt status');
  assert.ok(!calls.some((c) => /^(branch -D|worktree remove)/.test(c)));
});

test('a project with another default branch: it is protected, switched to and compared against', () => {
  const { git, calls } = fakeGit({
    branches: [
      'trunk\torigin/trunk\t[gone]',
      'feature/in-trunk\torigin/feature/in-trunk\t[gone]',
      'feature/ahead\torigin/feature/ahead\t[gone]',
    ].join('\n'),
    worktrees: 'worktree C:/repo\nHEAD a\nbranch refs/heads/feature/in-trunk',
    tips: { trunk: 't1', 'feature/in-trunk': 'm1', 'feature/ahead': 'new' },
    ancestors: ['m1 origin/trunk'],
  });
  const lines = [];
  main([], { git, gh: ghMerged([]), log: (l) => lines.push(l), defaultBranch: 'trunk' });
  const destructive = calls.filter((c) => /^(checkout|pull|branch -D)/.test(c));
  assert.deepEqual(destructive, [
    'checkout -q trunk',
    'pull -q --ff-only',
    'branch -D feature/in-trunk',
  ]);
  assert.ok(!calls.includes('branch -D trunk'), 'the default branch is never deleted');
  assert.ok(
    lines.includes('keep feature/ahead: local commits not in any merged PR or origin/trunk'),
  );
  assert.ok(lines.includes('switch feature/in-trunk -> trunk and pull --ff-only'));
});

test('the default branch is never deleted, whatever it is called', () => {
  const { actions } = plan({
    branches: parseBranches('trunk\torigin/trunk\t[gone]'),
    worktrees: parseWorktrees('worktree C:/repo\nHEAD a\nbranch refs/heads/feature/x'),
    dirty: new Set(),
    verified: new Set(['trunk']),
    defaultBranch: 'trunk',
  });
  assert.deepEqual(actions, []);
});

test('cli reads the default branch from the project config in the folder it runs in', () => {
  const root = tempRoot({}, { extraConfig: ['default_branch: trunk'] });
  const { git, calls } = fakeGit({
    branches: 'feature/merged\torigin/feature/merged\t[gone]',
    worktrees: 'worktree C:/repo\nHEAD a\nbranch refs/heads/feature/merged',
    tips: { 'feature/merged': 's1' },
  });
  const gh = ghMerged([{ headRefName: 'feature/merged', headRefOid: 's1' }]);
  assert.equal(cli(root, [], { git, gh, log: () => {} }), 0);
  assert.ok(calls.includes('checkout -q trunk'));
  assert.ok(!calls.includes('checkout -q main'));
});
