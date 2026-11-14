#!/usr/bin/env node
/**
 * Set a project up for the factory: factory.config.yml, the caller workflows, the
 * agent skills, the AGENTS.md block, git hooks, the spec source's own setup and
 * the labels. Run it from the project's root. Safe to run again: it changes
 * nothing that is already in place, and never overwrites the config.
 *
 * Usage:
 *   node factory-init.js [--ref <sha|v*>] [--owner <login>] [--default-branch <name>]
 *     [--gate <cmd>]... [--ci-workflow <name>]... [--spec-source <name>]
 *     [--force] [--adopt-hooks] [--dry-run] [--no-labels] [--no-adapter-setup]
 *
 * --ref defaults to the commit this factory checkout is on: it must be pushed, as
 * the callers fetch the factory at that commit. Exit codes: 0 done, 2 usage error.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { runInit, usage } = require('../lib/init.js');

const VALUE_FLAGS = {
  '--ref': 'ref',
  '--owner': 'owner',
  '--default-branch': 'defaultBranch',
  '--spec-source': 'specSource',
};
const LIST_FLAGS = { '--gate': 'gates', '--ci-workflow': 'ciWorkflows' };
const SWITCHES = {
  '--force': ['force', true],
  '--adopt-hooks': ['adoptHooks', true],
  '--dry-run': ['dryRun', true],
  '--no-labels': ['labels', false],
  '--no-adapter-setup': ['adapterSetup', false],
};

function parseArgs(argv) {
  const options = { gates: [], ciWorkflows: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (SWITCHES[flag]) {
      const [key, value] = SWITCHES[flag];
      options[key] = value;
    } else if (VALUE_FLAGS[flag] || LIST_FLAGS[flag]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw usage(`${flag} needs a value`);
      if (VALUE_FLAGS[flag]) options[VALUE_FLAGS[flag]] = value;
      else options[LIST_FLAGS[flag]].push(value);
    } else {
      throw usage(`unknown argument ${flag}`);
    }
  }
  return options;
}

const run = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log) {
  const options = { ...parseArgs(argv), root };
  const factoryRoot = path.join(__dirname, '..');
  if (!options.ref) {
    options.ref = run('git', factoryRoot)(['rev-parse', 'HEAD']);
    log(`pin: ${options.ref} (this factory checkout; pass --ref to choose another)`);
  }
  const io = {
    git: run('git', root),
    gh: run('gh', root),
    setup: (config) => loadAdapter(config, { root }).setup(root),
  };
  const result = runInit(options, io);
  for (const file of result.files) {
    log(`${file.status.padEnd(9)} ${file.path}${file.note ? `  (${file.note})` : ''}`);
  }
  for (const warning of result.warnings) log(`warning: ${warning}`);
  log('\nOwner steps:');
  result.steps.forEach((step, i) => log(`${i + 1}. ${step}`));
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { main, parseArgs };
