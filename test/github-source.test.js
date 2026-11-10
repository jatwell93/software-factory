'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { githubSource } = require('../lib/github-source.js');

function ghError(stderr) {
  const error = new Error('gh failed');
  error.stderr = stderr;
  return error;
}

function recorder(handler) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return handler(args);
  };
  return { gh, calls };
}

test('read asks the contents API for the raw file on the branch', () => {
  const { gh, calls } = recorder(() => 'file text');
  const text = githubSource('feature/x y', gh).read('openspec/changes/a/tasks.md');
  assert.equal(text, 'file text');
  assert.deepEqual(calls, [
    [
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      'repos/{owner}/{repo}/contents/openspec/changes/a/tasks.md?ref=feature%2Fx%20y',
    ],
  ]);
});

test('read gives null for a file that is not on the branch', () => {
  const { gh } = recorder(() => {
    throw ghError('gh: Not Found (HTTP 404)');
  });
  assert.equal(githubSource('main', gh).read('nope.md'), null);
});

test('an empty file reads as an empty string, not as missing', () => {
  const { gh } = recorder(() => '');
  assert.equal(githubSource('main', gh).read('empty.md'), '');
});

test('read and list rethrow any error that is not a 404', () => {
  for (const stderr of ['gh: Bad credentials (HTTP 401)', 'HTTP 403 rate limit', 'HTTP 4040 odd']) {
    const { gh } = recorder(() => {
      throw ghError(stderr);
    });
    assert.throws(() => githubSource('main', gh).read('a.md'), /gh failed/, stderr);
    assert.throws(() => githubSource('main', gh).list('dir'), /gh failed/, stderr);
  }
});

test('list parses type and name, splitting on the first colon only', () => {
  const { gh, calls } = recorder(() => 'dir:2026-01-01-a\nfile:notes.md\ndir:odd:name\n\n');
  const entries = githubSource('main', gh).list('openspec/changes/archive');
  assert.deepEqual(entries, [
    { name: '2026-01-01-a', dir: true },
    { name: 'notes.md', dir: false },
    { name: 'odd:name', dir: true },
  ]);
  assert.equal(calls[0][1], 'repos/{owner}/{repo}/contents/openspec/changes/archive?ref=main');
  assert.deepEqual(calls[0].slice(2), ['--jq', '.[] | .type + ":" + .name']);
});

test('list gives [] for a folder that is not on the branch', () => {
  const { gh } = recorder(() => {
    throw ghError('gh: Not Found (HTTP 404)');
  });
  assert.deepEqual(githubSource('main', gh).list('openspec/changes/archive'), []);
});
