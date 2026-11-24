const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { syncRepo, syncPins, parseConsumers, refLabel } = require('../lib/pin-sync.js');

const REF = 'a'.repeat(40);
const sh = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** A bare origin and a clone of it on main with one workflow file committed. */
function consumer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-sync-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, root], { stdio: 'pipe' });
  sh(root, 'config', 'user.email', 'a@b.c');
  sh(root, 'config', 'user.name', 'a');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'f.yml'), 'pin: old\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-q', '-m', 'init');
  sh(root, 'push', '-q', '-u', 'origin', 'main');
  return { dir, root };
}

/** Real git, a recording gh, and an upgrade that rewrites the pin like the real one. */
function io(calls, { changed = true } = {}) {
  return {
    git: (root, args) => sh(root, ...args),
    gh: (root, args) => {
      calls.push(args);
      return 'https://github.com/o/r/pull/9';
    },
    upgrade: ({ root, dryRun }) => {
      const rel = '.github/workflows/f.yml';
      if (changed && !dryRun) fs.writeFileSync(path.join(root, rel), `pin: ${REF}\n`);
      return {
        files: [{ path: rel, status: changed ? 'updated' : 'unchanged', note: 'old -> new' }],
        warnings: [],
        commit: REF,
      };
    },
  };
}

test('opens a branch, a commit, a push and a PR, then restores the original branch', () => {
  const { dir, root } = consumer();
  try {
    const calls = [];
    const result = syncRepo(root, { ref: REF, checkoutCommit: REF }, io(calls));
    assert.equal(result.status, 'opened');
    assert.equal(result.url, 'https://github.com/o/r/pull/9');
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    const branch = `chore/factory-pin-${REF.slice(0, 7)}`;
    assert.match(sh(root, 'ls-remote', '--heads', 'origin', branch), /refs\/heads\//);
    assert.match(
      sh(root, 'log', '-1', '--format=%s', branch),
      /move the pin to software-factory aaaaaaa/,
    );
    const create = calls.find((c) => c[0] === 'pr' && c[1] === 'create');
    assert.ok(create.includes('--head') && create.includes(branch));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty working tree is skipped and nothing is changed', () => {
  const { dir, root } = consumer();
  try {
    fs.writeFileSync(path.join(root, 'wip.txt'), 'x');
    const calls = [];
    const result = syncRepo(root, { ref: REF, checkoutCommit: REF }, io(calls));
    assert.equal(result.status, 'skipped');
    assert.match(result.note, /not clean/);
    assert.equal(calls.length, 0);
    assert.equal(sh(root, 'branch', '--list', 'chore/*'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository already at the pin leaves no branch and opens no PR', () => {
  const { dir, root } = consumer();
  try {
    const calls = [];
    const result = syncRepo(root, { ref: REF, checkoutCommit: REF }, io(calls, { changed: false }));
    assert.equal(result.status, 'unchanged');
    assert.equal(calls.length, 0);
    assert.equal(sh(root, 'branch', '--list', 'chore/*'), '');
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run does not open a second PR', () => {
  const { dir, root } = consumer();
  try {
    const calls = [];
    syncRepo(root, { ref: REF, checkoutCommit: REF }, io(calls));
    const again = syncRepo(root, { ref: REF, checkoutCommit: REF }, io(calls));
    assert.equal(again.status, 'skipped');
    assert.match(again.note, /already exists/);
    assert.equal(calls.filter((c) => c[1] === 'create').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run reports what would change and writes nothing', () => {
  const { dir, root } = consumer();
  try {
    const calls = [];
    const result = syncRepo(root, { ref: REF, checkoutCommit: REF, dryRun: true }, io(calls));
    assert.equal(result.status, 'would-open');
    assert.equal(calls.length, 0);
    assert.equal(sh(root, 'branch', '--list', 'chore/*'), '');
    assert.equal(sh(root, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing repository is reported and the next one still runs', () => {
  const a = consumer();
  const b = consumer();
  try {
    const calls = [];
    const fake = io(calls);
    let n = 0;
    const wrapped = {
      ...fake,
      upgrade: (opts) => {
        if (n++ === 0) throw new Error('cannot confirm ref');
        return fake.upgrade(opts);
      },
    };
    const results = syncPins([a.root, b.root], { ref: REF, checkoutCommit: REF }, wrapped);
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].note, /cannot confirm ref/);
    assert.equal(results[1].status, 'opened');
    assert.equal(sh(a.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(sh(a.root, 'branch', '--list', 'chore/*'), '');
  } finally {
    fs.rmSync(a.dir, { recursive: true, force: true });
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
});

test('parseConsumers ignores blanks and comments', () => {
  assert.deepEqual(parseConsumers('# mine\nC:\\a\n\n  /b  # note\r\n'), ['C:\\a', '/b']);
});

test('refLabel keeps a tag whole and cuts only a full commit SHA', () => {
  assert.equal(refLabel(REF), 'aaaaaaa');
  assert.equal(refLabel('v1.2.3'), 'v1.2.3');
  assert.notEqual(refLabel('v1.2.3'), refLabel('v1.2.30'));
  assert.equal(refLabel('v1.2.'), 'v1.2');
  assert.equal(refLabel('v1..2/x.lock'), 'v1.2-x-lock');
});

test('a detached checkout is put back on the same commit', () => {
  const { dir, root } = consumer();
  try {
    const head = sh(root, 'rev-parse', 'HEAD');
    sh(root, 'switch', '-q', '--detach', head);
    const result = syncRepo(root, { ref: REF, checkoutCommit: REF }, io([]));
    assert.equal(result.status, 'opened');
    assert.equal(sh(root, 'rev-parse', 'HEAD'), head);
    assert.throws(() => sh(root, 'symbolic-ref', '-q', 'HEAD'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed PR create removes the remote branch so a retry works', () => {
  const { dir, root } = consumer();
  try {
    const fake = io([]);
    let fail = true;
    const flaky = {
      ...fake,
      gh: (r, args) => {
        if (fail) throw new Error('gh: network down');
        return fake.gh(r, args);
      },
    };
    const first = syncPins([root], { ref: REF, checkoutCommit: REF }, flaky)[0];
    assert.equal(first.status, 'failed');
    assert.equal(
      sh(root, 'ls-remote', '--heads', 'origin'),
      sh(root, 'ls-remote', '--heads', 'origin', 'main'),
    );
    assert.equal(sh(root, 'branch', '--list', 'chore/*'), '');
    fail = false;
    assert.equal(syncRepo(root, { ref: REF, checkoutCommit: REF }, flaky).status, 'opened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry run reads the default branch, not the checked-out branch, and leaves no worktree', () => {
  const { dir, root } = consumer();
  try {
    sh(root, 'switch', '-q', '-c', 'side');
    const seen = [];
    const fake = io([]);
    const result = syncRepo(
      root,
      { ref: REF, checkoutCommit: REF, dryRun: true },
      {
        ...fake,
        upgrade: (opts) => {
          seen.push(opts.root);
          return fake.upgrade(opts);
        },
      },
    );
    assert.equal(result.status, 'would-open');
    assert.notEqual(path.resolve(seen[0]), path.resolve(root));
    assert.equal(sh(root, 'worktree', 'list').split('\n').length, 1);
    assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
