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

/** A CI workflow, named `name`, with a job for every kind of audit; plus a Dependabot config. */
const COVERED_CI = (name) =>
  [
    `name: ${name}`,
    'on: push',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm test',
    '      - run: npm run lint',
    '      - uses: github/codeql-action/analyze@v3',
    '      - uses: gitleaks/gitleaks-action@v2',
    '',
  ].join('\n');
const DEPENDABOT_CONFIG =
  'version: 2\nupdates:\n  - package-ecosystem: npm\n    cooldown:\n      default-days: 7\n';

/** Writes the covered CI workflow and the Dependabot config into a project. */
function writeCoveredCi(root, name) {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), COVERED_CI(name));
  fs.writeFileSync(path.join(root, '.github', 'dependabot.yml'), DEPENDABOT_CONFIG);
}

module.exports = {
  tempRoot,
  fakeIo,
  MINIMAL_CONFIG,
  COVERED_CI,
  DEPENDABOT_CONFIG,
  writeCoveredCi,
};
