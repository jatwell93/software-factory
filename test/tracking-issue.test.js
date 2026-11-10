const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');
const { trackingIssue } = require('../lib/tracking-issue.js');
const { tempRoot } = require('./helpers.js');

/** A fake `gh`: answers by subcommand and records every call. */
function fakeGh({
  labelled = [],
  state = 'OPEN',
  created = 'https://github.com/o/r/issues/90',
} = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(labelled);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ state });
    if (args[0] === 'issue' && args[1] === 'create') return `${created}\n`;
    return '';
  };
  return { gh, calls };
}

const proposal = (autonomy) =>
  `## Why\n\nIssue #12 is related; see also issue #40.\n\n## Autonomy\n\n\`\`\`yaml\nmerge: human\n${autonomy}no_go:\n  - backend/**\n\`\`\`\n\n## Impact\n\nissue: 99\n`;
const PROPOSAL = proposal('issue: 671 # the bug report\n');

function ctx(gh, { text = PROPOSAL, extraConfig = [] } = {}) {
  const root = tempRoot({ 'add-x': text }, { extraConfig });
  const config = loadConfig(root);
  return { config, adapter: loadAdapter(config, { root }), gh };
}

test('an open issue labelled <prefix><id> wins, untouched', () => {
  const { gh, calls } = fakeGh({ labelled: [{ number: 703 }] });
  assert.equal(trackingIssue('add-x', ctx(gh)), 703);
  assert.equal(calls.length, 1);
});

test("the proposal's open issue is adopted: labelled, never duplicated", () => {
  const { gh, calls } = fakeGh();
  assert.equal(trackingIssue('add-x', ctx(gh)), 671);
  assert.ok(calls.includes('issue edit 671 --add-label factory:add-x'));
  assert.ok(!calls.some((c) => c.startsWith('issue create')));
});

test('issues cited in prose or other sections never count', () => {
  const { gh, calls } = fakeGh();
  assert.equal(trackingIssue('add-x', ctx(gh, { text: proposal('') })), 90);
  assert.ok(calls.some((c) => c.startsWith('issue create')));
});

test('a closed proposal issue is not reused; a new one is created', () => {
  const { gh, calls } = fakeGh({ state: 'CLOSED' });
  assert.equal(trackingIssue('add-x', ctx(gh)), 90);
  assert.ok(!calls.some((c) => c.startsWith('issue edit')));
  assert.ok(
    calls.some((c) => c.startsWith('issue create --title factory: add-x --label factory:add-x')),
  );
});

test('a change that is not active has nothing to adopt', () => {
  const { gh, calls } = fakeGh();
  assert.equal(trackingIssue('gone', ctx(gh)), 90);
  assert.ok(!calls.some((c) => c.startsWith('issue view')));
});

test('the label is created with --force, so a second run does not fail on it', () => {
  const { gh, calls } = fakeGh();
  trackingIssue('add-x', ctx(gh));
  const create = calls.find((c) => c.startsWith('label create'));
  assert.match(create, /^label create factory:add-x --force /);
});

test('the label uses the configured change prefix', () => {
  const { gh, calls } = fakeGh();
  trackingIssue('add-x', ctx(gh, { extraConfig: ['labels:', '  change_prefix: "bot-"'] }));
  assert.ok(calls[0].includes('--label bot-add-x'));
  assert.ok(calls.includes('issue edit 671 --add-label bot-add-x'));
});
