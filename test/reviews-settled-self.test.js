const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { CONTEXT, OWN_CHECKS } = require('../lib/reviews-settled.js');
const { feedbackArgs, ignoreFlags } = require('../scripts/factory-reviews-settled.js');

test('the status ignores its own run and its own status when it reads the report', () => {
  assert.deepEqual(OWN_CHECKS, ['Reviews settled', CONTEXT]);
  assert.deepEqual(ignoreFlags, [
    '--ignore-check',
    'Reviews settled',
    '--ignore-check',
    'factory/reviews-settled',
  ]);
});

test('the report is read with the ignore flags, so the status never waits on itself', () => {
  const args = feedbackArgs(42);
  assert.match(args[0], /pr-feedback\.js$/);
  assert.equal(args[1], '42');
  assert.deepEqual(args.slice(2), ignoreFlags);
});

test('the caller template is named after the workflow the report ignores', () => {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'workflows', 'reviews-settled.yml'),
    'utf8',
  );
  assert.ok(OWN_CHECKS.includes(YAML.parse(template).name));
});
