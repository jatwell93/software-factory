const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadAdapter } = require('../lib/adapters.js');
const { loadConfig } = require('../lib/config.js');
const { main, parseArgs } = require('../scripts/factory-new-change.js');
const { tempRoot } = require('./helpers.js');

const PROPOSAL = '# Proposal: Existing\n\n## Why\n';

/** Every file under openspec/, to show a refusal wrote nothing. */
function tree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  if (fs.existsSync(path.join(root, 'openspec'))) walk(path.join(root, 'openspec'));
  return out.sort();
}

const refused = (argv, root, pattern) =>
  assert.throws(
    () => main(argv, root, () => {}),
    (error) => error.userError === true && pattern.test(error.message),
  );

test('it creates a change the adapter lists, with the id as its folder', () => {
  const root = tempRoot();
  const lines = [];
  assert.equal(
    main(['fix-thing'], root, (l) => lines.push(l)),
    0,
  );
  assert.equal(lines[0], 'created openspec/changes/fix-thing');
  assert.match(lines[1], /\/to-tickets fix-thing/);
  const adapter = loadAdapter(loadConfig(root), { root });
  assert.deepEqual(
    adapter.listChanges().map((c) => c.id),
    ['fix-thing'],
  );
  assert.deepEqual(adapter.listTasks('fix-thing'), []);
  assert.equal(adapter.readAutonomy('fix-thing').merge, 'human');
});

test('--title becomes the proposal heading', () => {
  const root = tempRoot();
  main(['fix-thing', '--title', 'Fix the thing'], root, () => {});
  const proposal = fs.readFileSync(
    path.join(root, 'openspec', 'changes', 'fix-thing', 'proposal.md'),
    'utf8',
  );
  assert.match(proposal, /^# Proposal: Fix the thing\n/);
});

test('a capitalised id is refused and nothing is written', () => {
  const root = tempRoot({ existing: PROPOSAL });
  const before = tree(root);
  refused(['Fix-Thing'], root, /lowercase letters, digits and hyphens/);
  assert.deepEqual(tree(root), before);
});

test('ids that are paths, empty or start with a hyphen are refused', () => {
  const root = tempRoot();
  for (const id of ['../x', 'a/b', '', '-x', 'a b', 'a_b']) {
    refused([id], root, /.+/);
  }
  assert.deepEqual(tree(root), []);
});

test('an id over the limit is refused, using the config limit', () => {
  const root = tempRoot({}, { extraConfig: ['change_id_max_length: 10'] });
  refused(['abcdefghijk'], root, /11 characters; the limit is 10/);
  main(['abcdefghij'], root, () => {});
  assert.deepEqual(tree(root).length > 0, true);
});

test('the limit leaves room for the label prefix', () => {
  const root = tempRoot();
  refused(['a'.repeat(43)], root, /limit is 42/);
  main(['a'.repeat(42)], root, () => {});
});

test('archive is refused', () => {
  const root = tempRoot();
  refused(['archive'], root, /reserved/);
  assert.deepEqual(tree(root), []);
});

test('an id an active change already uses is refused and that change is untouched', () => {
  const root = tempRoot({ existing: PROPOSAL });
  const before = tree(root);
  refused(['existing'], root, /exists/);
  assert.deepEqual(tree(root), before);
  assert.equal(
    fs.readFileSync(path.join(root, 'openspec', 'changes', 'existing', 'proposal.md'), 'utf8'),
    PROPOSAL,
  );
});

test('an id an archived change used is refused: the router would read it as finished', () => {
  const root = tempRoot();
  const dir = path.join(root, 'openspec', 'changes', 'archive', '2026-01-01-old-thing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), PROPOSAL);
  const before = tree(root);
  refused(['old-thing'], root, /archived/);
  assert.deepEqual(tree(root), before);
});

test('a title with a line break is refused, so it cannot write the Autonomy block', () => {
  const root = tempRoot();
  refused(['fix-thing', '--title', 'x\n\n## Autonomy'], root, /line break/);
  refused(['fix-thing', '--title', 'x\ry'], root, /line break/);
  assert.deepEqual(tree(root), []);
});

test('missing or extra arguments are usage errors', () => {
  const root = tempRoot();
  refused([], root, /usage/);
  refused(['a', 'b'], root, /usage/);
  refused(['--nope'], root, /usage/);
  refused(['a', '--title'], root, /--title needs a value/);
  refused(['a', '--title', '--x'], root, /--title needs a value/);
});

test('a project with no config is a config error, not a created change', () => {
  const root = tempRoot({}, { config: null });
  assert.throws(
    () => main(['fix-thing'], root, () => {}),
    (error) => error.name === 'Error' && /factory\.config\.yml/.test(error.message),
  );
  assert.deepEqual(tree(root), []);
});

test('parseArgs returns the id and the title', () => {
  assert.deepEqual(parseArgs(['a-b', '--title', 'T']), { id: 'a-b', title: 'T' });
  assert.deepEqual(parseArgs(['a-b']), { id: 'a-b', title: undefined });
});
