'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MINIMAL_CONFIG = ['spec_source: openspec', 'owner: octo', 'gates:', '  - run: npm test'];

/**
 * A temp project root with a factory.config.yml and OpenSpec changes.
 * `changes` maps a folder name to its proposal.md; `extraConfig` lines are
 * appended to the minimal config; `config: null` writes no config at all.
 */
function tempRoot(changes = {}, { extraConfig = [], config } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-'));
  if (config !== null) {
    const text = config ?? [...MINIMAL_CONFIG, ...extraConfig].join('\n');
    fs.writeFileSync(path.join(root, 'factory.config.yml'), `${text}\n`);
  }
  for (const [id, body] of Object.entries(changes)) {
    fs.mkdirSync(path.join(root, 'openspec', 'changes', id), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'openspec', 'changes', id, 'proposal.md'), body);
  }
  return root;
}

/** An io object that records what a script prints and returns canned input. */
function fakeIo({ diff = '', files = '' } = {}) {
  const out = { log: [], error: [], gitArgs: null };
  return {
    out,
    readFile: () => files,
    git: (args) => {
      out.gitArgs = args;
      return diff;
    },
    log: (s) => out.log.push(s),
    error: (s) => out.error.push(s),
  };
}

module.exports = { tempRoot, fakeIo, MINIMAL_CONFIG };
