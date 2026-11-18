#!/usr/bin/env node
/**
 * Make the spec source's command-line tool available to the agent. The archive step
 * of run-spec runs it, and a project that does not pin it (a Python project has no
 * package.json) would otherwise fail there after the whole change was built.
 *
 * A tool the project already provides (npx finds it) is left alone. Otherwise the
 * adapter's own pinned install command runs, and the tool must then answer
 * `--version`. An adapter with no `cli` needs nothing.
 *
 * Run from the default branch's checkout, which holds the config.
 *
 * Usage: node scripts/factory-install-spec-cli.js
 * Exit codes: 0 the tool is usable, 1 it could not be installed, 2 bad config.
 */
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');

function succeeds(run, command, args) {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function main(io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const adapter = io.adapter || loadAdapter(config);
  const log = io.log || console.log;
  const run = io.run || ((command, args) => execFileSync(command, args, { stdio: 'inherit' }));
  if (!adapter.cli) return 0;
  const { bin, install } = adapter.cli;
  if (succeeds(run, 'npx', ['--no-install', bin, '--version'])) {
    log(`${bin}: the project provides it`);
    return 0;
  }
  log(`${bin}: not found, installing: ${install.join(' ')}`);
  if (!succeeds(run, install[0], install.slice(1))) {
    (io.error || console.error)(`::error::could not install ${bin}`);
    return 1;
  }
  if (
    succeeds(run, bin, ['--version']) ||
    succeeds(run, 'npx', ['--no-install', bin, '--version'])
  ) {
    return 0;
  }
  (io.error || console.error)(`::error::${bin} is installed but does not run`);
  return 1;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
