'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BASELINE } = require('../lib/baseline.js');
const { loadConfig } = require('../lib/config.js');
const {
  factoryScope,
  globToRegExp,
  patternsFor,
  findMatches,
  main,
} = require('../scripts/check-no-go.js');
const { loadAdapter } = require('../lib/adapters.js');
const { parseNoGo } = require('../adapters/openspec.js');
const { tempRoot, fakeIo } = require('./helpers.js');

const adapterFor = (root) => loadAdapter(loadConfig(root), { root });

const PROPOSAL = [
  '# Proposal',
  '',
  '## Autonomy',
  '',
  '```yaml',
  'merge: human',
  'no_go:',
  '  - frontend/src/legacy/** # retired screens',
  "  - 'workers/wrangler.toml'",
  'other: x',
  '```',
].join('\n');

test('the baseline is the six generic paths and nothing project-specific', () => {
  assert.deepEqual(BASELINE, [
    '.github/**',
    '.claude/**',
    '.githooks/**',
    'AGENTS.md',
    'CLAUDE.md',
    'factory.config.yml',
  ]);
});

test('globToRegExp: ** spans directories, * stays inside one segment', () => {
  assert.ok(globToRegExp('.github/**').test('.github/workflows/factory.yml'));
  assert.ok(globToRegExp('scripts/*.sh').test('scripts/database-backup.sh'));
  assert.ok(!globToRegExp('scripts/*.sh').test('scripts/sub/x.sh'));
  assert.ok(globToRegExp('AGENTS.md').test('AGENTS.md'));
  assert.ok(!globToRegExp('AGENTS.md').test('docs/AGENTS.md'));
  assert.ok(!globToRegExp('AGENTS.md').test('AGENTSxmd'), 'a dot is literal');
});

test('globToRegExp: **/ matches zero directories; a trailing / covers the directory', () => {
  assert.ok(globToRegExp('**/.env').test('.env'));
  assert.ok(globToRegExp('**/.env').test('workers/.env'));
  assert.ok(globToRegExp('docs/**/x.md').test('docs/x.md'));
  assert.ok(globToRegExp('docs/legacy/').test('docs/legacy/old/page.md'));
  assert.ok(!globToRegExp('docs/legacy/').test('docs/legacy-notes.md'));
});

test('parseNoGo reads the Autonomy yaml list, dropping comments and quotes', () => {
  assert.deepEqual(parseNoGo(PROPOSAL), ['frontend/src/legacy/**', 'workers/wrangler.toml']);
  assert.deepEqual(parseNoGo('# Proposal\n\nno Autonomy block'), []);
  assert.deepEqual(parseNoGo(PROPOSAL.replace(/\n/g, '\r\n')), [
    'frontend/src/legacy/**',
    'workers/wrangler.toml',
  ]);
});

test('parseNoGo keeps items after blank and comment lines, and reads flow lists', () => {
  const block = PROPOSAL.replace(
    "  - 'workers/wrangler.toml'",
    "\n  # runtime config\n  - 'workers/wrangler.toml'\n  - docs/legacy/",
  );
  assert.deepEqual(parseNoGo(block), [
    'frontend/src/legacy/**',
    'workers/wrangler.toml',
    'docs/legacy/',
  ]);
  const flow = PROPOSAL.replace(/no_go:[\s\S]*?other/, "no_go: [a/**, 'b.md'] # two\nother");
  assert.deepEqual(parseNoGo(flow), ['a/**', 'b.md']);
  const unindented = PROPOSAL.replace(/^ {2}- /gm, '- ');
  assert.deepEqual(parseNoGo(unindented), ['frontend/src/legacy/**', 'workers/wrangler.toml']);
});

test('patternsFor adds the project and change lists to the baseline and never drops it', () => {
  const root = tempRoot({ shrink: PROPOSAL }, { extraConfig: ['protected_paths:', '  - db/**'] });
  const config = loadConfig(root);
  const patterns = patternsFor('shrink', adapterFor(root), config);
  for (const p of BASELINE) assert.ok(patterns.includes(p), `baseline ${p} kept`);
  assert.ok(patterns.includes('frontend/src/legacy/**'));
  assert.ok(patterns.includes('db/**'));
  assert.deepEqual(patternsFor('', adapterFor(root), config), [...BASELINE, 'db/**']);
  assert.deepEqual(patternsFor('missing-change', adapterFor(root), config), [...BASELINE, 'db/**']);
});

test('a --change that is not a plain id reads no folder, so it cannot walk out of changes/', () => {
  const root = tempRoot({ shrink: PROPOSAL });
  // Both spellings resolve to the real openspec/changes/shrink/proposal.md, so
  // only the id check keeps its no_go list out of the result.
  assert.deepEqual(patternsFor('../changes/shrink', adapterFor(root)), BASELINE);
  assert.deepEqual(patternsFor('shrink/../shrink', adapterFor(root)), BASELINE);
  assert.ok(patternsFor('shrink', adapterFor(root)).includes('workers/wrangler.toml'));
});

test('findMatches reports protected paths only, once each', () => {
  const m = findMatches(
    [
      'frontend/src/App.tsx',
      '.claude/skills/run-spec/SKILL.md',
      '.claude/skills/run-spec/SKILL.md',
      '',
    ],
    BASELINE,
  );
  assert.deepEqual(m, [{ path: '.claude/skills/run-spec/SKILL.md', pattern: '.claude/**' }]);
});

test('diff mode diffs the merge base with --no-renames and -z, and passes clean branches', () => {
  const io = fakeIo({
    diff: 'scripts/route-map.js\0scripts/route-map.test.js\0',
  });
  assert.equal(main([], io, tempRoot({})), 0);
  assert.deepEqual(io.out.gitArgs, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    'origin/main...HEAD',
  ]);
});

test('diff mode follows the configured default branch, and --base overrides it', () => {
  const root = tempRoot({}, { extraConfig: ['default_branch: develop'] });
  const io = fakeIo();
  assert.equal(main([], io, root), 0);
  assert.equal(io.out.gitArgs.at(-1), 'origin/develop...HEAD');
  const other = fakeIo();
  assert.equal(main(['--base', 'origin/release'], other, root), 0);
  assert.equal(other.out.gitArgs.at(-1), 'origin/release...HEAD');
});

test('a path the project protects fails, and one it does not protect passes', () => {
  const root = tempRoot({}, { extraConfig: ['protected_paths:', '  - database/migrations/**'] });
  const hit = fakeIo({ diff: 'database/migrations/0014_x.sql\0' });
  assert.equal(main([], hit, root), 1);
  assert.match(
    hit.out.log.join('\n'),
    /^database\/migrations\/0014_x\.sql\t\(database\/migrations\/\*\*\)/,
  );
  assert.equal(main([], fakeIo({ diff: 'src/app.js\0' }), root), 0);
  assert.equal(main([], fakeIo({ diff: 'database/migrations/0014_x.sql\0' }), tempRoot({})), 0);
});

test('a protected path with non-ASCII characters is matched unquoted', () => {
  const io = fakeIo({ diff: '.claude/skills/café/SKILL.md\0' });
  assert.equal(main([], io, tempRoot({})), 1);
});

test('a rename out of a protected path still fails (both sides are listed)', () => {
  const io = fakeIo({
    diff: '.claude/skills/run-spec/SKILL.md\0docs/run-spec.md\0',
  });
  assert.equal(main([], io, tempRoot({})), 1);
  assert.match(io.out.log.join('\n'), /^\.claude\/skills\/run-spec\/SKILL\.md\t/);
});

test('a change whose own list omits .github/** still fails on a workflow edit', () => {
  const root = tempRoot({ pilot: PROPOSAL });
  const io = fakeIo({
    files: '.github/workflows/factory.yml\nfrontend/src/legacy/Old.tsx\n',
  });
  assert.equal(main(['--change', 'pilot', '--files', 'list.txt'], io, root), 1);
  assert.deepEqual(
    io.out.log.map((l) => l.split('\t')[0]),
    ['.github/workflows/factory.yml', 'frontend/src/legacy/Old.tsx'],
  );
});

test('bad arguments print usage and exit 2', () => {
  const io = fakeIo();
  assert.equal(main(['--change'], io, tempRoot({})), 2);
  assert.equal(main(['--bogus', 'x'], io, tempRoot({})), 2);
  assert.match(io.out.error[0], /^usage:/);
});

test('a missing config fails with exit 2 and says so', () => {
  const io = fakeIo({ diff: 'docs/x.md\0' });
  assert.equal(main([], io, tempRoot({}, { config: null })), 2);
  assert.match(io.out.error[0], /^no_go: cannot read factory\.config\.yml/);
});

test('a config that tries to un-protect the baseline fails with exit 2', () => {
  const root = tempRoot({}, { extraConfig: ['unprotect:', '  - .github/**'] });
  const io = fakeIo({ diff: '.github/workflows/x.yml\0' });
  assert.equal(main([], io, root), 2);
  assert.match(io.out.error[0], /^no_go: factory\.config\.yml:/);
  assert.equal(io.out.log.length, 0);
});

test('an invalid config value fails with exit 2', () => {
  const root = tempRoot({}, { extraConfig: ['spend_cap_usd: 0'] });
  assert.equal(main([], fakeIo({ diff: '' }), root), 2);
});

test('an unrecognised no_go shape fails closed with exit 2', () => {
  const multiLineFlow = PROPOSAL.replace(
    /no_go:[\s\S]*?other/,
    'no_go: [\n    a/**,\n    b.md\n  ]\nother',
  );
  const scalarValue = PROPOSAL.replace(/no_go:[\s\S]*?other/, 'no_go: a/**\nother');
  for (const body of [multiLineFlow, scalarValue]) {
    assert.throws(() => parseNoGo(body), /unrecognised/);
    const io = fakeIo({ diff: 'docs/x.md\0' });
    assert.equal(main(['--change', 'odd'], io, tempRoot({ odd: body })), 2);
    assert.match(io.out.error[0], /^no_go: unrecognised/);
  }
});

test('factoryScope: the Claude App author or any factory:* label marks a factory PR', () => {
  assert.equal(factoryScope(['bug'], 'octo'), 'factory=false\n');
  assert.equal(
    factoryScope([], 'claude[bot]'),
    'factory=true\n',
    'removing labels does not unmark',
  );
  assert.equal(factoryScope(['factory:add-x'], 'octo'), 'factory=true\n');
  assert.equal(factoryScope(['build:add-x'], 'octo', 'build:'), 'factory=true\n');
  assert.equal(factoryScope(['factory:add-x'], 'octo', 'build:'), 'factory=false\n');
});

test('scope mode prints the GITHUB_OUTPUT line from LABELS and AUTHOR', () => {
  const io = fakeIo();
  const env = { LABELS: '["factory:pilot"]', AUTHOR: 'claude[bot]' };
  assert.equal(main(['scope'], io, tempRoot({}), env), 0);
  assert.deepEqual(io.out.log, ['factory=true']);
});

test('scope mode uses the configured label prefix, and the default when the config is broken', () => {
  const env = { LABELS: '["build:pilot"]', AUTHOR: 'octo' };
  const custom = tempRoot({}, { extraConfig: ['labels:', '  change_prefix: "build:"'] });
  const io = fakeIo();
  assert.equal(main(['scope'], io, custom, env), 0);
  assert.deepEqual(io.out.log, ['factory=true']);
  const broken = fakeIo();
  assert.equal(main(['scope'], broken, tempRoot({}, { config: null }), env), 0);
  assert.deepEqual(broken.out.log, ['factory=false']);
});

test('--change all applies every active change list, skipping the archive', () => {
  const other = PROPOSAL.replace('frontend/src/legacy/**', 'docs/other/**');
  const root = tempRoot({
    pilot: PROPOSAL,
    other,
    archive: PROPOSAL.replace('frontend', 'zzz'),
  });
  const patterns = patternsFor('all', adapterFor(root));
  for (const p of [...BASELINE, 'frontend/src/legacy/**', 'docs/other/**']) {
    assert.ok(patterns.includes(p), `${p} applies`);
  }
  assert.ok(!patterns.includes('zzz/src/legacy/**'), 'archive is not an active change');
  const io = fakeIo({ files: 'docs/other/x.md\n' });
  assert.equal(
    main(['--change', 'all', '--files', 'f'], io, root),
    1,
    'another change list blocks',
  );
});

test('--change all also applies the list of a folder whose name is not a valid id', () => {
  const bad = PROPOSAL.replace('frontend/src/legacy/**', 'docs/capital/**');
  const root = tempRoot({ 'Bad-Name': bad });
  assert.ok(patternsFor('all', adapterFor(root)).includes('docs/capital/**'));
});

test('a protected path containing a newline still matches', () => {
  const io = fakeIo({ diff: '.claude/a\nb.md\0' });
  assert.equal(main([], io, tempRoot({})), 1);
});

test("a --change naming a badly named folder still reads that folder's list", () => {
  const root = tempRoot({ 'Odd Name': PROPOSAL });
  assert.ok(patternsFor('Odd Name', adapterFor(root)).includes('frontend/src/legacy/**'));
});
