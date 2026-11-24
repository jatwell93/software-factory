#!/usr/bin/env node
/**
 * Open one pin-bump PR in each consumer repository, so a factory release is one
 * command instead of one pin PR typed out per project. Run it from anywhere; it
 * uses this factory checkout (which must be pushed) as the source of the new pin.
 *
 * Usage: node factory-pin-sync.js [--ref <sha|v*>] [--dry-run] [<repo-path>...]
 *
 * With no paths it reads ~/.factory-consumers (override with FACTORY_CONSUMERS):
 * one repository path per line, `#` starts a comment. A repository with a dirty
 * tree, or that already has the branch, is skipped and reported. You merge each PR.
 *
 * Exit codes: 0 every repository done or already current, 1 a repository failed or
 * was skipped, 2 usage error.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { usage } = require('../lib/init.js');
const { syncPins, parseConsumers } = require('../lib/pin-sync.js');

const run = (cmd) => (root, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();

function parseArgs(argv) {
  const options = { paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--ref') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw usage('--ref needs a value');
      options.ref = value;
    } else if (arg.startsWith('--')) throw usage(`unknown argument ${arg}`);
    else options.paths.push(arg);
  }
  return options;
}

function consumerPaths(options) {
  if (options.paths.length) return options.paths.map((p) => path.resolve(p));
  const file = process.env.FACTORY_CONSUMERS || path.join(os.homedir(), '.factory-consumers');
  if (!fs.existsSync(file)) {
    throw usage(`no repository paths given and ${file} does not exist: list one path per line`);
  }
  const paths = parseConsumers(fs.readFileSync(file, 'utf8'));
  if (!paths.length) throw usage(`${file} lists no repositories`);
  return paths;
}

function main(argv = process.argv.slice(2), log = console.log, io) {
  const options = parseArgs(argv);
  const roots = consumerPaths(options);
  const factoryGit = (args) =>
    execFileSync('git', args, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  const checkoutCommit = factoryGit(['rev-parse', 'HEAD']);
  const ref = options.ref || checkoutCommit;
  if (!options.ref) log(`pin: ${ref} (this factory checkout; pass --ref to choose another)`);
  const results = syncPins(
    roots,
    { ref, checkoutCommit, dryRun: options.dryRun },
    io || { git: run('git'), gh: run('gh') },
  );
  for (const r of results) {
    log(`${r.status.padEnd(10)} ${r.root}  (${r.note})${r.url ? `\n           ${r.url}` : ''}`);
  }
  const bad = results.filter((r) => r.status === 'failed' || r.status === 'skipped');
  return bad.length ? 1 : 0;
}

if (require.main === module) runCli(main);

module.exports = { main, parseArgs };
