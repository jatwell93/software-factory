#!/usr/bin/env node
/**
 * Can I merge yet? Prints one line per open pull request (or for one): ready, safe
 * to merge now (only a quiet window or a slow bot is outstanding), still waiting on
 * checks, or blocked by a failed check or unresolved review items. Run it from the
 * project's root, logged in to gh.
 *
 * Usage: node factory-status.js [<pr-number>]
 *
 * With a number it exits 0 when that PR is `ready` or `safe`, 1 otherwise; with none
 * it lists every open PR and exits 0. Review bots come from factory.config.yml when
 * the project has one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { CONFIG_FILE, loadConfig } = require('../lib/config.js');
const { usage } = require('../lib/init.js');
const { status } = require('../lib/status.js');
const { fetchReport } = require('./pr-feedback.js');

const run = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log, io) {
  if (argv.length > 1 || (argv[0] && !/^#?\d+$/.test(argv[0]))) {
    throw usage('usage: factory-status.js [<pr-number>]');
  }
  const gh = run('gh', root);
  const config = fs.existsSync(path.join(root, CONFIG_FILE)) ? loadConfig(root) : null;
  const options = { gh, ciWorkflows: config ? config.ci_workflows : [] };
  return status(
    { pr: argv[0] ? Number(argv[0].replace('#', '')) : 0 },
    {
      listOpen: () =>
        JSON.parse(gh(['pr', 'list', '--state', 'open', '--json', 'number,title'])).sort(
          (a, b) => a.number - b.number,
        ),
      view: (number) => JSON.parse(gh(['pr', 'view', String(number), '--json', 'number,title'])),
      report: (number) => fetchReport(number, options),
      bots: config ? config.review_bots || [] : [],
      log,
      ...io,
    },
  );
}

if (require.main === module) runCli(main);

module.exports = { main };
