const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { postMerge } = require('../lib/post-merge.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const CONFIG = {
  default_branch: 'main',
  labels: { change_prefix: 'factory:', needs_human: 'needs-human' },
};

/**
 * A bare origin, a clone on `feature/x` pushed and with one commit, and main on
 * origin moved on by a squash-style commit. `headOid` is the pushed branch tip.
 */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'clone');
  const other = path.join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'pipe' });
  for (const r of [root]) {
    sh(r, 'config', 'user.email', 'a@b.c');
    sh(r, 'config', 'user.name', 'a');
  }
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'init');
  sh(root, 'push', '-q', '-u', 'origin', 'main');
  sh(root, 'switch', '-q', '-c', 'feature/x');
  fs.writeFileSync(path.join(root, 'b.txt'), '2');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'work');
  sh(root, 'push', '-q', '-u', 'origin', 'feature/x');
  const headOid = sh(root, 'rev-parse', 'HEAD').trim();
  // The squash merge: main on origin gets one new commit that git cannot tie to the branch.
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' });
  sh(other, 'config', 'user.email', 'a@b.c');
  sh(other, 'config', 'user.name', 'a');
  fs.writeFileSync(path.join(other, 'b.txt'), '2');
  sh(other, 'add', '.');
  sh(other, 'commit', '-q', '-m', 'squash of feature/x');
  sh(other, 'push', '-q', 'origin', 'main');
  return { dir, root, headOid };
}

function io(root, pr, { open = [], cleanupError } = {}) {
  const lines = [];
  const cleanups = [];
  return {
    lines,
    cleanups,
    git: (args) => sh(root, ...args),
    gh: (args) => {
      if (args[1] === 'view') {
        if (pr === null) throw new Error('no pull requests found');
        return JSON.stringify(pr);
      }
      return JSON.stringify(open);
    },
    config: CONFIG,
    cleanup: () => {
      cleanups.push(1);
      if (cleanupError) throw cleanupError;
    },
    log: (m) => lines.push(m),
  };
}

const merged = (headRefOid, labels = [{ name: 'factory:demo' }]) => ({
  number: 7,
  title: 'feat: x',
  state: 'MERGED',
  headRefName: 'feature/x',
  headRefOid,
  labels,
  url: 'https://github.com/o/r/pull/7',
});

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('merged: switches to an up-to-date main and deletes the merged branch', () => {
  const { dir, root, headOid } = setup();
  try {
    const x = io(root, merged(headOid));
    assert.equal(postMerge({}, x), 0);
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.ok(fs.existsSync(path.join(root, 'b.txt')), 'pulled the squash commit');
    assert.equal(sh(root, 'branch', '--list', 'feature/x').trim(), '');
    assert.equal(x.cleanups.length, 1);
    assert.match(x.lines.join('\n'), /deleted feature\/x/);
    assert.match(x.lines.join('\n'), /change demo: the factory starts its next task by itself/);
  } finally {
    cleanup(dir);
  }
});

test('a commit made after the merge keeps the branch and the checkout', () => {
  const { dir, root, headOid } = setup();
  try {
    fs.writeFileSync(path.join(root, 'late.txt'), 'x');
    sh(root, 'add', '.');
    sh(root, 'commit', '-q', '-m', 'late fix');
    const x = io(root, merged(headOid));
    assert.equal(postMerge({}, x), 0);
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/x');
    assert.match(sh(root, 'branch', '--list', 'feature/x'), /feature\/x/);
    assert.match(x.lines.join('\n'), /keep feature\/x: it has commits GitHub does not/);
  } finally {
    cleanup(dir);
  }
});

test('a dirty tree is never switched or deleted', () => {
  const { dir, root, headOid } = setup();
  try {
    fs.writeFileSync(path.join(root, 'wip.txt'), 'x');
    const x = io(root, merged(headOid));
    assert.equal(postMerge({}, x), 0);
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/x');
    assert.match(x.lines.join('\n'), /uncommitted changes/);
  } finally {
    cleanup(dir);
  }
});

test('an open PR is reported as not merged and nothing changes', () => {
  const { dir, root, headOid } = setup();
  try {
    const x = io(root, { ...merged(headOid), state: 'OPEN' });
    assert.equal(postMerge({}, x), 1);
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/x');
    assert.equal(x.cleanups.length, 0);
    assert.match(x.lines.join('\n'), /not merged yet/);
  } finally {
    cleanup(dir);
  }
});

test('a PR closed without merging says so', () => {
  const { dir, root, headOid } = setup();
  try {
    const x = io(root, { ...merged(headOid), state: 'CLOSED' });
    assert.equal(postMerge({}, x), 1);
    assert.match(x.lines.join('\n'), /closed without merging/);
  } finally {
    cleanup(dir);
  }
});

test('no PR for the branch is a usage error that asks for a number', () => {
  const { dir, root } = setup();
  try {
    assert.throws(() => postMerge({}, io(root, null)), /pass a PR number/);
    assert.throws(() => postMerge({ pr: '99' }, io(root, null)), /cannot read PR 99/);
  } finally {
    cleanup(dir);
  }
});

test('already on main: pulls and leaves every branch alone', () => {
  const { dir, root, headOid } = setup();
  try {
    sh(root, 'switch', '-q', 'main');
    const x = io(root, merged(headOid));
    assert.equal(postMerge({}, x), 0);
    assert.ok(fs.existsSync(path.join(root, 'b.txt')));
    assert.match(sh(root, 'branch', '--list', 'feature/x'), /feature\/x/);
  } finally {
    cleanup(dir);
  }
});

test('lists what waits on the owner and survives a cleanup failure', () => {
  const { dir, root, headOid } = setup();
  try {
    const open = [
      {
        number: 9,
        title: 'fix: y',
        url: 'https://github.com/o/r/pull/9',
        labels: [{ name: 'factory:demo' }, { name: 'needs-human' }],
      },
      { number: 10, title: 'feat: z', url: 'u', labels: [{ name: 'factory:demo' }] },
    ];
    const x = io(root, merged(headOid, []), { open, cleanupError: new Error('boom\nmore') });
    assert.equal(postMerge({}, x), 0);
    const text = x.lines.join('\n');
    assert.match(text, /cleanup skipped: boom/);
    assert.match(text, /waiting on you: #9 fix: y \(needs-human\)/);
    assert.match(text, /factory PR in flight: #10 feat: z/);
    assert.doesNotMatch(text, /starts its next task by itself/);
  } finally {
    cleanup(dir);
  }
});
