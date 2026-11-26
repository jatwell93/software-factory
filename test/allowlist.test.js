const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ALLOWED, NOT_ALLOWED, RULES, mergeSettings, missingRules } = require('../lib/allowlist.js');
const { runInit } = require('../lib/init.js');
const { runDoctor } = require('../lib/doctor.js');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'owner-setup.md'), 'utf8');
const REF = 'a'.repeat(40);

test('every script is either allowed or named in NOT_ALLOWED with a reason, never both', () => {
  const allowed = new Set(RULES.map((r) => /scripts\/([\w-]+\.js)/.exec(r)?.[1]).filter(Boolean));
  for (const file of fs.readdirSync(SCRIPTS)) {
    const inAllowed = allowed.has(file);
    const reason = NOT_ALLOWED[file];
    assert.ok(inAllowed !== Boolean(reason), `${file}: must be in exactly one list`);
    if (!inAllowed) assert.ok(reason.length > 5, `${file}: needs a reason`);
  }
  for (const file of [...allowed, ...Object.keys(NOT_ALLOWED)]) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, file)), `${file} does not exist`);
  }
});

test('no rule can write: no gh api, no merge, no delete, no force, no wildcard on the program', () => {
  for (const rule of RULES) {
    assert.doesNotMatch(
      rule,
      /gh api|merge|delete|force|--|Bash\(\*|Bash\(node:\*|Bash\(gh:\*/,
      rule,
    );
    assert.match(rule, /^Bash\((node |gh )/, rule);
  }
  const gh = RULES.filter((r) => r.startsWith('Bash(gh '));
  for (const rule of gh) {
    assert.match(rule, /^Bash\(gh (pr|run|workflow|issue) (view|list|checks|diff):\*\)$/, rule);
  }
});

test('the front door is allowed for status and doctor only', () => {
  const door = RULES.filter((r) => r.includes('bin/factory.js'));
  assert.equal(door.length, 4);
  for (const rule of door) assert.match(rule, /factory\.js"? (status|doctor):\*\)$/);
});

test('every entry has a reason and appears in the owner setup page', () => {
  assert.match(DOC, /^## The command allowlist$/m);
  for (const entry of ALLOWED) {
    assert.ok(entry.reason.length > 10, entry.label);
    // A gh verb shares a row with its siblings: the page names the command and the noun.
    const named = entry.label.replace(/^(gh \w+) .*/, '$1');
    assert.ok(DOC.includes(named), `${entry.label} is not in docs/owner-setup.md`);
  }
  // The writers an owner is most likely to wonder about are named one by one.
  for (const file of [
    'cleanup-merged.js',
    'factory-post-merge.js',
    'factory-init.js',
    'factory-upgrade.js',
  ]) {
    assert.ok(DOC.includes(`scripts/${file}`), `${file} is not in docs/owner-setup.md`);
  }
});

test('merging adds the rules to a file that has none, and nothing else changes', () => {
  const { text, added } = mergeSettings(null);
  assert.deepEqual(added, RULES);
  assert.deepEqual(JSON.parse(text), { permissions: { allow: RULES } });
});

test('merging keeps every other key and every rule already there, and adds only what is missing', () => {
  const before = {
    model: 'x',
    permissions: { allow: ['Bash(npm test:*)', RULES[0]], deny: ['Bash(rm:*)'] },
    hooks: { Stop: [] },
  };
  const { text, added } = mergeSettings(JSON.stringify(before));
  const after = JSON.parse(text);
  assert.equal(added.length, RULES.length - 1);
  assert.deepEqual(after.permissions.allow.slice(0, 2), ['Bash(npm test:*)', RULES[0]]);
  assert.deepEqual(after.permissions.deny, ['Bash(rm:*)']);
  assert.equal(after.model, 'x');
  assert.deepEqual(after.hooks, { Stop: [] });
  assert.equal(new Set(after.permissions.allow).size, after.permissions.allow.length);
});

test('merging a file that already has every rule changes nothing', () => {
  const { text, added } = mergeSettings(JSON.stringify({ permissions: { allow: RULES } }));
  assert.equal(text, null);
  assert.deepEqual(added, []);
});

test('a file that cannot be merged into is refused with the reason', () => {
  assert.throws(() => mergeSettings('{ nope'), /not valid JSON/);
  assert.throws(() => mergeSettings('[]'), /not a JSON object/);
  assert.throws(() => mergeSettings('{"permissions":[]}'), /"permissions" is not an object/);
  assert.throws(() => mergeSettings('{"permissions":{"allow":"x"}}'), /not a list/);
  assert.throws(() => missingRules('{ nope'), /not valid JSON/);
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-allow-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  return { root, git, io: { git, gh: () => '', setup: () => {} } };
}
const settings = (root) => path.join(root, '.claude', 'settings.json');
const statusOf = (result) => result.files.find((f) => f.path === '.claude/settings.json').status;

test('init writes the rules, once, and keeps what the project had', () => {
  const { root, io } = project();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(
    settings(root),
    JSON.stringify({ permissions: { allow: ['Bash(gh pr view:*)'] }, hooks: { Stop: [] } }),
  );
  const first = runInit({ root, ref: REF }, io);
  assert.equal(statusOf(first), 'updated');
  const doc = JSON.parse(fs.readFileSync(settings(root), 'utf8'));
  assert.equal(doc.permissions.allow.filter((r) => r === 'Bash(gh pr view:*)').length, 1);
  assert.deepEqual(doc.hooks, { Stop: [] });
  for (const rule of RULES) assert.ok(doc.permissions.allow.includes(rule), rule);
  assert.equal(statusOf(runInit({ root, ref: REF }, io)), 'unchanged');
});

test('init creates the file when there is none', () => {
  const { root, io } = project();
  assert.equal(statusOf(runInit({ root, ref: REF }, io)), 'created');
  assert.ok(fs.existsSync(settings(root)));
});

test('--no-permissions leaves settings alone, and --dry-run writes nothing', () => {
  const skipped = project();
  const result = runInit({ root: skipped.root, ref: REF, permissions: false }, skipped.io);
  assert.ok(!result.files.some((f) => f.path === '.claude/settings.json'));
  assert.ok(!fs.existsSync(settings(skipped.root)));
  const dry = project();
  runInit({ root: dry.root, ref: REF, dryRun: true }, dry.io);
  assert.ok(!fs.existsSync(settings(dry.root)));
});

test('an unreadable settings file is left as it is, with a warning', () => {
  const { root, io } = project();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(settings(root), '{ not json');
  const result = runInit({ root, ref: REF }, io);
  assert.equal(statusOf(result), 'skipped');
  assert.equal(fs.readFileSync(settings(root), 'utf8'), '{ not json');
  assert.ok(result.warnings.some((w) => /settings\.json left alone: not valid JSON/.test(w)));
});

test('doctor warns when rules are missing and is ok once init has added them', () => {
  const { root, git, io } = project();
  runInit({ root, ref: REF, permissions: false }, io);
  const find = (results) => results.find((r) => r.name === 'allowlist');
  const before = find(runDoctor(root, { git, gh: () => '' }));
  assert.equal(before.status, 'warn');
  assert.match(before.detail, new RegExp(`${RULES.length} of ${RULES.length}`));
  assert.match(before.fix, /factory-init\.js/);
  runInit({ root, ref: REF }, io);
  assert.equal(find(runDoctor(root, { git, gh: () => '' })).status, 'ok');
});

test('doctor says an unreadable settings file needs a hand fix, not another init run', () => {
  const { root, git, io } = project();
  runInit({ root, ref: REF }, io);
  fs.writeFileSync(settings(root), '{ not json');
  const result = runDoctor(root, { git, gh: () => '' }).find((r) => r.name === 'allowlist');
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /cannot be read \(not valid JSON.*init leaves it alone/);
  assert.match(result.fix, /^Fix the file/);
  assert.doesNotMatch(result.detail, /missing/);
});
