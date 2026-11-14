#!/usr/bin/env node
/**
 * Create an empty change through the project's spec-source adapter, so a new change
 * starts with an id the factory can run. Run it from the project's root.
 *
 * Usage: node factory-new-change.js <id> [--title <text>]
 *
 * It refuses, and writes nothing, when the id is not lowercase letters, digits and
 * hyphens or is longer than the limit (see change_id_max_length), is `archive`, is
 * taken by an active change, or was used by a change that is now archived: the
 * router reads an archived id as a finished change, so reusing one would never run.
 *
 * Exit codes: 0 created, 2 usage error or an unreadable config.
 */

const { runCli } = require('../lib/cli.js');
const { idProblem, titleProblem } = require('../lib/change-id.js');
const { loadConfig, maxIdLength } = require('../lib/config.js');
const { loadAdapter } = require('../lib/adapters.js');

const USAGE = 'usage: factory-new-change.js <id> [--title <text>]';

function usage(message) {
  return Object.assign(new Error(message), { userError: true });
}

function parseArgs(argv) {
  let id;
  let title;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') {
      title = argv[++i];
      if (title === undefined || title.startsWith('--')) throw usage('--title needs a value');
    } else if (argv[i].startsWith('--') || id !== undefined) {
      throw usage(USAGE);
    } else {
      id = argv[i];
    }
  }
  if (id === undefined) throw usage(USAGE);
  return { id, title };
}

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log, adapter) {
  const { id, title } = parseArgs(argv);
  const config = loadConfig(root);
  const problem = idProblem(id, maxIdLength(config));
  if (problem) throw usage(problem);
  const titleIssue = title === undefined ? '' : titleProblem(title);
  if (titleIssue) throw usage(`--title: ${titleIssue}`);
  if (id === 'archive') throw usage('archive is reserved for finished changes');
  const spec = adapter || loadAdapter(config, { root });
  if (spec.listChanges().some((change) => change.id === id)) throw usage(`change ${id} exists`);
  if (spec.isArchived(id)) {
    throw usage(`${id} was used by a change that is now archived: choose another id`);
  }
  const { path } = spec.scaffold(id, title === undefined ? {} : { title });
  log(`created ${path}`);
  log(
    `Fill in proposal.md (Why, What changes, Autonomy) and the specs, then run /to-tickets ${id}.`,
  );
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { main, parseArgs };
