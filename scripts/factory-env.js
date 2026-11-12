#!/usr/bin/env node
/**
 * Print the config values a workflow needs before it can set up the runner, as
 * `key=value` lines for $GITHUB_OUTPUT:
 *
 *   node_version=<n>  install=<command>  default_branch=<name>
 *
 * A workflow cannot read factory.config.yml itself, and the Node version has to
 * be known before `setup-node` runs. Run it from the project's root, on the
 * default branch's checkout. A value with a line break is refused, because it
 * would write a second output line.
 *
 * Usage: node scripts/factory-env.js
 */
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');

/** The output lines for a config. */
function envLines(config) {
  const values = {
    node_version: config.runner.node_version,
    install: config.runner.install,
    default_branch: config.default_branch,
  };
  return Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`${key} cannot contain a line break`);
    return `${key}=${value}`;
  });
}

function main(root = process.cwd(), log = console.log) {
  log(envLines(loadConfig(root)).join('\n'));
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { envLines, main };
