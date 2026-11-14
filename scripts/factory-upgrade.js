#!/usr/bin/env node
/**
 * Move a project's factory pin to a new commit or v* tag and show the diff: the
 * `uses:` ref and `factory_ref` input of each caller workflow, and the five skills
 * (copied from this factory checkout, which must be at that commit). Run it from
 * the project's root. A ref GitHub does not know is refused, since every workflow
 * would break. It never touches the config.
 *
 * Usage: node factory-upgrade.js [--ref <sha|v*>] [--no-skills] [--dry-run]
 *
 * --ref defaults to the commit this factory checkout is on (it must be pushed).
 * Exit codes: 0 done, 2 usage error.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runCli } = require('../lib/cli.js');
const { usage } = require('../lib/init.js');
const { runUpgrade } = require('../lib/upgrade.js');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-skills') options.skills = false;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--ref') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw usage('--ref needs a value');
      options.ref = value;
    } else throw usage(`unknown argument ${flag}`);
  }
  return options;
}

const run = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log, io) {
  const options = { ...parseArgs(argv), root };
  const git = run('git', root);
  const factoryGit = run('git', path.join(__dirname, '..'));
  options.checkoutCommit = factoryGit(['rev-parse', 'HEAD']);
  if (!options.ref) {
    options.ref = options.checkoutCommit;
    log(`pin: ${options.ref} (this factory checkout; pass --ref to choose another)`);
  }
  const result = runUpgrade(options, io || { gh: run('gh', root) });
  for (const file of result.files) {
    log(`${file.status.padEnd(9)} ${file.path}${file.note ? `  (${file.note})` : ''}`);
  }
  for (const warning of result.warnings) log(`warning: ${warning}`);
  const changed = result.files.filter((f) => f.status === 'updated' || f.status === 'created');
  if (options.dryRun) log(`\ndry run: ${changed.length} file(s) would change`);
  else if (changed.length) {
    log('');
    try {
      log(git(['diff', '--', ...changed.map((f) => f.path)]) || '(no diff against HEAD)');
    } catch {
      log('(not a git checkout: no diff to show)');
    }
  } else log('\nnothing to change');
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { main, parseArgs };
