const test = require('node:test');
const assert = require('node:assert/strict');

const { ghReason, ghText, isNoSuchRef } = require('../lib/gh-error.js');

const failed = (stderr, command = 'gh api repos/o/r/commits/404abc') =>
  Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { stderr });

test('isNoSuchRef accepts HTTP 404 and 422 and nothing else', () => {
  assert.equal(isNoSuchRef(failed('gh: Not Found (HTTP 404)')), true);
  assert.equal(isNoSuchRef(failed('gh: No commit found for SHA: x (HTTP 422)')), true);
  assert.equal(isNoSuchRef(failed('gh: Bad Gateway (HTTP 502)')), false);
  assert.equal(isNoSuchRef(failed('gh: Bad credentials (HTTP 401)')), false);
  assert.equal(isNoSuchRef(failed('')), false);
});

test('the command line is never read as the answer', () => {
  assert.equal(isNoSuchRef(failed('gh: Bad Gateway (HTTP 502)', 'gh api commits/HTTP 404')), false);
  assert.equal(ghText(failed('real answer')), 'real answer');
});

test('an error with no stderr falls back to its message', () => {
  assert.equal(isNoSuchRef(new Error('HTTP 404: Not Found')), true);
  assert.equal(ghReason(new Error('first\nsecond')), 'first');
});

test('ghReason is the first non-empty line of the answer', () => {
  assert.equal(
    ghReason(failed('\n  \n\t\ngh: Bad Gateway (HTTP 502)\nmore')),
    'gh: Bad Gateway (HTTP 502)',
  );
});
