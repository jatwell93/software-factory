#!/usr/bin/env node
/**
 * Find the tracking issue of a change for the factory, adopting or creating one,
 * and print its number. run-spec escalates and reports completion on it; the
 * router holds every new task of the change while it carries the needs-human
 * label. See lib/tracking-issue.js for how the issue is found.
 *
 * Usage: node scripts/factory-issue.js <change-id>
 */
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const { trackingIssue } = require('../lib/tracking-issue.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const id = argv[0] || '';
  const problem = factoryIdProblem(id);
  if (problem) {
    (io.error || console.error)(`usage: factory-issue.js <change-id>: ${problem}`);
    return 2;
  }
  const ctx = { config, adapter: io.adapter || loadAdapter(config), gh: io.gh || defaultGh };
  (io.out || console.log)(String(trackingIssue(id, ctx)));
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { main };
