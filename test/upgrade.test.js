const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { CALLERS } = require('../lib/callers.js');
const { readPins, refKind, setPins } = require('../lib/pin.js');
const { runInit, SKILLS } = require('../lib/init.js');
const { runUpgrade } = require('../lib/upgrade.js');
const { main, parseArgs } = require('../scripts/factory-upgrade.js');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const REPO = 'jatwell93/software-factory';

function initialised(ref = OLD) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-upgrade-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: Test\non: push\n');
  runInit(
    { root, ref, labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git };
}

/** A gh that knows the refs given (ref -> commit sha) and 404s on the rest. */
const ghKnowing = (known) => (args) => {
  const match = /commits\/(.+)$/.exec(args[1]);
  if (args[0] !== 'api' || !match || !known[match[1]]) throw new Error('HTTP 404: Not Found');
  return known[match[1]];
};

const workflows = (root) =>
  Object.fromEntries(
    CALLERS.map((n) => [n, fs.readFileSync(path.join(root, '.github', 'workflows', n), 'utf8')]),
  );

test('readPins and setPins read and move both the uses ref and the factory_ref input', () => {
  const text = `jobs:\n  a:\n    uses: ${REPO}/.github/workflows/x.yml@${OLD}\n    with:\n      factory_ref: ${OLD}\n`;
  assert.deepEqual(readPins(text), { uses: [OLD], inputs: [OLD] });
  const next = setPins(text, NEW);
  assert.equal(next.changed, 2);
  assert.deepEqual(readPins(next.text), { uses: [NEW], inputs: [NEW] });
  assert.equal(setPins(next.text, NEW).changed, 0);
  assert.equal(setPins(text, 'v1.2.0').text.includes('@v1.2.0'), true);
});

test('setPins leaves another repository pin alone and refuses a branch', () => {
  const other = `uses: someone/else/.github/workflows/x.yml@${OLD}\n`;
  assert.equal(setPins(other, NEW).changed, 0);
  assert.throws(() => setPins('', 'main'), /40-character commit SHA/);
  assert.equal(refKind(OLD), 'sha');
  assert.equal(refKind('v1'), 'tag');
  assert.equal(refKind('main'), 'other');
});

test('upgrade moves every pin, replaces the skills and keeps a project edit to a trigger', () => {
  const { root } = initialised();
  const relay = path.join(root, '.github', 'workflows', 'factory-ci-relay.yml');
  fs.writeFileSync(relay, `${fs.readFileSync(relay, 'utf8')}# local note\n`);
  const result = runUpgrade(
    { root, ref: NEW, checkoutCommit: NEW },
    { gh: ghKnowing({ [NEW]: NEW }) },
  );
  for (const [name, text] of Object.entries(workflows(root))) {
    assert.ok(text.includes(NEW), name);
    assert.ok(!text.includes(OLD), name);
  }
  assert.match(fs.readFileSync(relay, 'utf8'), /# local note/);
  assert.equal(result.files.filter((f) => f.status === 'updated').length, 6);
  assert.deepEqual(result.warnings, []);
});

test('a second upgrade changes nothing', () => {
  const { root } = initialised();
  const io = { gh: ghKnowing({ [NEW]: NEW }) };
  runUpgrade({ root, ref: NEW, checkoutCommit: NEW }, io);
  const before = workflows(root);
  const again = runUpgrade({ root, ref: NEW, checkoutCommit: NEW }, io);
  assert.deepEqual(workflows(root), before);
  assert.deepEqual(
    again.files.filter((f) => f.status !== 'unchanged'),
    [],
  );
});

test('a ref GitHub does not know is refused and nothing is written', () => {
  const { root } = initialised();
  const before = workflows(root);
  assert.throws(
    () => runUpgrade({ root, ref: NEW, checkoutCommit: NEW }, { gh: ghKnowing({}) }),
    (error) => error.userError && /push it first/.test(error.message),
  );
  assert.deepEqual(workflows(root), before);
});

test('a branch ref is refused before GitHub is asked', () => {
  const { root } = initialised();
  let asked = false;
  assert.throws(
    () => runUpgrade({ root, ref: 'main', checkoutCommit: NEW }, { gh: () => (asked = true) }),
    /40-character commit SHA/,
  );
  assert.equal(asked, false);
});

test('skills are left alone, with a warning, when this checkout is not the target commit', () => {
  const { root } = initialised();
  const skill = path.join(root, '.claude', 'skills', 'handover', 'SKILL.md');
  fs.writeFileSync(skill, 'local\n');
  const result = runUpgrade(
    { root, ref: NEW, checkoutCommit: 'c'.repeat(40) },
    { gh: ghKnowing({ [NEW]: NEW }) },
  );
  assert.equal(fs.readFileSync(skill, 'utf8'), 'local\n');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /skills not updated/);
  assert.ok(workflows(root)['factory.yml'].includes(NEW));
});

test('a tag target compares the commit it resolves to', () => {
  const { root } = initialised();
  const skill = path.join(root, '.claude', 'skills', 'handover', 'SKILL.md');
  fs.writeFileSync(skill, 'local\n');
  const result = runUpgrade(
    { root, ref: 'v1.0.0', checkoutCommit: NEW },
    { gh: ghKnowing({ 'v1.0.0': NEW }) },
  );
  assert.notEqual(fs.readFileSync(skill, 'utf8'), 'local\n');
  assert.ok(workflows(root)['no-go-guard.yml'].includes('@v1.0.0'));
  assert.ok(
    result.files.some((f) => f.path.endsWith('handover/SKILL.md') && f.status === 'updated'),
  );
});

test('--no-skills and --dry-run leave the files alone', () => {
  const { root } = initialised();
  const skill = path.join(root, '.claude', 'skills', 'handover', 'SKILL.md');
  fs.writeFileSync(skill, 'local\n');
  const io = { gh: ghKnowing({ [NEW]: NEW }) };
  runUpgrade({ root, ref: NEW, checkoutCommit: NEW, skills: false }, io);
  assert.equal(fs.readFileSync(skill, 'utf8'), 'local\n');
  assert.ok(workflows(root)['factory.yml'].includes(NEW));

  const second = initialised();
  const before = workflows(second.root);
  const dry = runUpgrade({ root: second.root, ref: NEW, checkoutCommit: NEW, dryRun: true }, io);
  assert.deepEqual(workflows(second.root), before);
  assert.equal(dry.files.filter((f) => f.status === 'updated').length, 6 + 0);
});

test('a missing caller is a warning and a caller that does not call the factory is skipped', () => {
  const { root } = initialised();
  fs.rmSync(path.join(root, '.github', 'workflows', 'reviews-settled.yml'));
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'factory-digest.yml'), 'name: mine\n');
  const result = runUpgrade(
    { root, ref: NEW, checkoutCommit: NEW, skills: false },
    { gh: ghKnowing({ [NEW]: NEW }) },
  );
  assert.ok(result.warnings.some((w) => /reviews-settled\.yml is missing/.test(w)));
  assert.equal(result.files.find((f) => f.path.endsWith('factory-digest.yml')).status, 'skipped');
  assert.equal(
    fs.readFileSync(path.join(root, '.github', 'workflows', 'factory-digest.yml'), 'utf8'),
    'name: mine\n',
  );
});

test('the script prints the diff of what it changed', () => {
  const { root, git } = initialised();
  git(['switch', '-q', '-c', 'feature/x']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  }).trim();
  const lines = [];
  const code = main(['--ref', head], root, (l) => lines.push(l), {
    gh: ghKnowing({ [head]: head }),
  });
  const out = lines.join('\n');
  assert.equal(code, 0);
  assert.match(out, /updated\s+\.github\/workflows\/factory\.yml/);
  assert.match(out, new RegExp(`\\+.*${head}`));
  assert.match(out, new RegExp(`-.*${OLD}`));

  const again = [];
  main(['--ref', head], root, (l) => again.push(l), { gh: ghKnowing({ [head]: head }) });
  assert.match(again.join('\n'), /nothing to change|no diff/);
});

test('the script reports a dry run without a diff', () => {
  const { root } = initialised();
  const lines = [];
  main(['--ref', NEW, '--dry-run', '--no-skills'], root, (l) => lines.push(l), {
    gh: ghKnowing({ [NEW]: NEW }),
  });
  assert.match(lines.join('\n'), /dry run: 6 file\(s\) would change/);
});

test('parseArgs reads the flags and rejects the rest', () => {
  assert.deepEqual(parseArgs(['--ref', 'abc', '--no-skills', '--dry-run']), {
    ref: 'abc',
    skills: false,
    dryRun: true,
  });
  assert.throws(
    () => parseArgs(['--ref']),
    (e) => e.userError && /needs a value/.test(e.message),
  );
  assert.throws(
    () => parseArgs(['--nope']),
    (e) => e.userError,
  );
  assert.equal(SKILLS.length, 5);
});
