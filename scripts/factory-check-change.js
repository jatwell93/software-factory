#!/usr/bin/env node
/**
 * Fail a run early when its change is not there: the agent step is the expensive
 * one, and a missing change is found here in a second. A babysit pass on a
 * per-change PR may find the change archived on the branch already, which is
 * fine: there is nothing left to build, only a review to answer.
 *
 * Run from the checkout the agent will work in (the PR branch for a babysit
 * pass, the default branch for a task).
 *
 * Usage: node scripts/factory-check-change.js <change-id> <mode>
 * Exit codes: 0 the run may go on, 1 the change is missing, 2 usage error.
 */
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');

const MODES = ['task', 'archive', 'babysit'];

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const [id = '', mode = ''] = argv;
  const problem =
    factoryIdProblem(id) || (MODES.includes(mode) ? '' : 'mode must be task, archive or babysit');
  if (problem) {
    (io.error || console.error)(`usage: factory-check-change.js <change-id> <mode>: ${problem}`);
    return 2;
  }
  const adapter = io.adapter || loadAdapter(config);
  if (adapter.listChanges().some((c) => c.id === id)) return 0;
  if (mode === 'babysit' && adapter.isArchived(id)) return 0;
  (io.error || console.error)(`::error::no change ${id}`);
  return 1;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
