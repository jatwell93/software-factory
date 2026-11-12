'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { idProblem } = require('../lib/change-id.js');
const { maxIdLength, loadConfig } = require('../lib/config.js');
const { main } = require('../scripts/check-change-ids.js');
const { tempRoot, fakeIo } = require('./helpers.js');

const PROPOSAL = '# Proposal\n';

test('idProblem accepts lowercase letters, digits and hyphens up to the limit', () => {
  for (const id of ['a', 'fix-thing', '2fa-login', 'x'.repeat(42)]) {
    assert.equal(idProblem(id), '', id);
  }
});

test('idProblem names the rule a bad id breaks', () => {
  assert.match(idProblem('Fix-Thing'), /lowercase letters, digits and hyphens/);
  assert.match(idProblem('standardise-on-camelCase'), /lowercase/);
  assert.match(idProblem('-leading'), /starting with a letter or digit/);
  assert.match(idProblem('has space'), /lowercase/);
  assert.match(idProblem('a/b'), /lowercase/);
  assert.match(idProblem('x'.repeat(43)), /43 characters; the limit is 42/);
  assert.match(idProblem('x'.repeat(11), 10), /the limit is 10/);
  assert.match(idProblem(''), /empty/);
});

test('maxIdLength is capped by the label prefix as well as the configured limit', () => {
  const plain = loadConfig(tempRoot({}));
  assert.equal(maxIdLength(plain), 42);
  const longPrefix = loadConfig(
    tempRoot({}, { extraConfig: ['labels:', '  change_prefix: "factory-run-"'] }),
  );
  assert.equal(maxIdLength(longPrefix), 50 - 'factory-run-'.length);
  const lowered = loadConfig(tempRoot({}, { extraConfig: ['change_id_max_length: 10'] }));
  assert.equal(maxIdLength(lowered), 10);
});

test('every active folder with a valid id passes', () => {
  const io = fakeIo();
  assert.equal(main([], io, tempRoot({ 'fix-one': PROPOSAL, 'add-two': PROPOSAL })), 0);
  assert.deepEqual(io.out.log, ['change ids: all valid']);
});

test('a folder with a capital letter fails and is named', () => {
  const io = fakeIo();
  assert.equal(main([], io, tempRoot({ 'Fix-Thing': PROPOSAL, 'ok-one': PROPOSAL })), 1);
  assert.match(io.out.log.join('\n'), /^Fix-Thing\t/);
  assert.ok(!io.out.log.join('\n').includes('ok-one'));
});

test('a folder over the limit fails, and the configured limit applies', () => {
  const long = 'x'.repeat(43);
  assert.equal(main([], fakeIo(), tempRoot({ [long]: PROPOSAL })), 1);
  const root = tempRoot(
    { 'twelve-chars': PROPOSAL },
    { extraConfig: ['change_id_max_length: 10'] },
  );
  assert.equal(main([], fakeIo(), root), 1);
});

test('the archive folder is not an id', () => {
  assert.equal(main([], fakeIo(), tempRoot({ archive: PROPOSAL })), 0);
});

test('--files checks only the folders a PR touches', () => {
  const root = tempRoot({ 'Old-Bad': PROPOSAL });
  const clean = fakeIo({
    files: 'openspec/changes/fine-one/tasks.md\nsrc/app.js\n',
  });
  assert.equal(main(['--files', 'list.txt'], clean, root), 0);
  const bad = fakeIo({
    files: 'openspec/changes/Fix-Thing/proposal.md\nopenspec/changes/Fix-Thing/tasks.md\n',
  });
  assert.equal(main(['--files', 'list.txt'], bad, root), 1);
  assert.deepEqual(
    bad.out.log.map((l) => l.split('\t')[0]),
    ['Fix-Thing'],
  );
});

test('--files ignores files under the archive and outside changes/', () => {
  const io = fakeIo({
    files: 'openspec/changes/archive/2026-01-01-Old/x.md\nopenspec/specs/a.md\n',
  });
  assert.equal(main(['--files', 'f'], io, tempRoot({})), 0);
});

test('a missing config and bad arguments exit 2', () => {
  assert.equal(main([], fakeIo(), tempRoot({}, { config: null })), 2);
  const io = fakeIo();
  assert.equal(main(['--bogus'], io, tempRoot({})), 2);
  assert.match(io.out.error[0], /^usage:/);
  assert.equal(main(['--files'], fakeIo(), tempRoot({})), 2);
});
