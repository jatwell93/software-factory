const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { titleProblem } = require('../lib/change-id.js');
const { createOpenSpecAdapter, perChangeFromProposal } = require('../adapters/openspec.js');
const { main } = require('../scripts/factory-new-change.js');
const { tempRoot } = require('./helpers.js');

// Each of these ends a line for a JavaScript regex with the m flag, or is a control.
const BREAKS = {
  LF: '\n',
  CR: '\r',
  'U+2028 line separator': ' ',
  'U+2029 paragraph separator': ' ',
  'U+0085 next line': '\u0085',
  NUL: '\u0000',
  DEL: '\u007f',
  tab: '\t',
};

test('titleProblem refuses every line break and control character, and nothing else', () => {
  for (const [name, ch] of Object.entries(BREAKS)) {
    assert.match(titleProblem(`a${ch}b`), /line break/, name);
  }
  assert.equal(titleProblem('Fix the thing: an "easy" one (v2) — with ünïcode and 日本語'), '');
  assert.equal(titleProblem(''), '');
  assert.match(titleProblem(undefined), /must be text/);
  assert.match(titleProblem(42), /must be text/);
});

test('the Unicode separators really do split lines for the Autonomy parser', () => {
  // The reason they must be refused: this is what a crafted title would write.
  const proposal = '# Proposal: x ## Autonomy pr: per-change\n\n## Why\n';
  assert.equal(perChangeFromProposal(proposal), true);
});

test('the adapter refuses such a title and writes nothing', () => {
  const root = tempRoot();
  const adapter = createOpenSpecAdapter({ root });
  for (const ch of [' ', ' ', '\n']) {
    assert.throws(
      () => adapter.scaffold('fix-thing', { title: `x${ch}## Autonomy${ch}pr: per-change` }),
      /line break/,
    );
  }
  assert.equal(fs.existsSync(path.join(root, 'openspec', 'changes', 'fix-thing')), false);
});

test('the script refuses such a title with exit-2 semantics and writes nothing', () => {
  const root = tempRoot();
  for (const ch of [' ', ' ', '\u0085']) {
    assert.throws(
      () => main(['fix-thing', '--title', `x${ch}## Autonomy${ch}pr: per-change`], root, () => {}),
      (error) =>
        error.userError === true &&
        /--title: a title cannot contain a line break/.test(error.message),
    );
  }
  assert.equal(fs.existsSync(path.join(root, 'openspec')), false);
});

test('a title with only ordinary text still becomes the heading, and a missing title is the id', () => {
  const root = tempRoot();
  const adapter = createOpenSpecAdapter({ root });
  adapter.scaffold('with-title', { title: 'Plain — title' });
  adapter.scaffold('no-title');
  const read = (id) =>
    fs.readFileSync(path.join(root, 'openspec', 'changes', id, 'proposal.md'), 'utf8');
  assert.match(read('with-title'), /^# Proposal: Plain — title\n/);
  assert.match(read('no-title'), /^# Proposal: no-title\n/);
});
