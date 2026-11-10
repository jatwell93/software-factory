#!/usr/bin/env node
/**
 * Print the `Closes #<n>` line for one task of a change, or nothing when the
 * task has no ticket. run-spec puts the line in the PR body, so the owner's merge
 * closes the ticket that `to-tickets` published for the task.
 *
 * The ticket is the one the adapter reads from the task's own line (for OpenSpec
 * the first `(#<n>):` on it, the form to-tickets writes). A `#734` cited in the
 * title is a reference, not the ticket: closing it would close an unrelated
 * issue.
 *
 * Usage: node scripts/factory-ticket.js <change-id> <task-number>
 */
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');

const TASK_NUMBER = /^[0-9][0-9A-Za-z.]{0,19}$/;

/** The ticket number of task `number` of change `id`, or 0. */
function taskTicket(adapter, id, number) {
  if (!adapter.listChanges().some((c) => c.id === id)) return 0;
  return adapter.listTasks(id).find((t) => t.id === number)?.issue || 0;
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const [id = '', number = ''] = argv;
  const problem = factoryIdProblem(id) || (TASK_NUMBER.test(number) ? '' : 'bad task number');
  if (problem) {
    (io.error || console.error)(`usage: factory-ticket.js <change-id> <task-number>: ${problem}`);
    return 2;
  }
  const ticket = taskTicket(io.adapter || loadAdapter(config), id, number);
  if (ticket) (io.out || console.log)(`Closes #${ticket}`);
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { taskTicket, main };
