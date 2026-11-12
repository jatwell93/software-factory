#!/usr/bin/env node
/**
 * Fail when a change folder has an id the factory cannot run: not lowercase
 * letters, digits and hyphens, or longer than the project's limit. Without this
 * check a bad id is first caught when a run starts, after the plan PR merged.
 *
 * Usage (run from the project's root, which holds factory.config.yml):
 *   node check-change-ids.js                  # every active change folder
 *   node check-change-ids.js --files <path|-> # only folders named in a list of
 *                                              changed paths, one per line (a PR's files)
 *
 * Exit codes: 0 every id is valid, 1 a bad id (printed as `folder<TAB>reason`),
 * 2 usage error or an unreadable config.
 */

const fs = require('node:fs');
const { ConfigError, loadConfig, maxIdLength } = require('../lib/config.js');
const { idProblem } = require('../lib/change-id.js');
const { loadAdapter } = require('../lib/adapters.js');

const USAGE = 'usage: check-change-ids.js [--files <path|->]';

const defaultIo = {
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  log: (s) => console.log(s),
  error: (s) => console.error(s),
};

function main(argv, io = defaultIo, root = process.cwd()) {
  const useFiles = argv[0] === '--files';
  if (argv.length !== 0 && !(useFiles && argv.length === 2)) {
    io.error(USAGE);
    return 2;
  }
  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.error(`change ids: ${err.message}`);
    return 2;
  }
  const adapter = loadAdapter(config, { root });
  const folders = useFiles
    ? adapter.changesIn(io.readFile(argv[1] === '-' ? 0 : argv[1]).split(/\r?\n/))
    : adapter.listChanges().map((c) => c.id);
  const max = maxIdLength(config);
  const bad = folders.map((f) => [f, idProblem(f, max)]).filter(([, why]) => why);
  if (bad.length === 0) {
    io.log('change ids: all valid');
    return 0;
  }
  io.error(`change ids: ${bad.length} invalid`);
  for (const [folder, why] of bad) io.log(`${folder}\t${why}`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
