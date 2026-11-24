#!/usr/bin/env node
/**
 * Tidy up after you merge a PR, so you do not tell the agent "merged and pulled":
 * confirm the merge, switch to an up-to-date default branch, delete the merged
 * local branch (only when GitHub has every commit on it), run cleanup-merged for
 * the rest, and print what the factory does next and what waits on you. Run it
 * from the project's root, on the merged branch or anywhere.
 *
 * Usage: node factory-post-merge.js [<pr-number>]
 *
 * With no number it uses the current branch's PR. Exit codes: 0 merged and tidied,
 * 1 the PR is not merged (yet), 2 usage error or an unreadable config.
 */

const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { usage } = require('../lib/init.js');
const { postMerge } = require('../lib/post-merge.js');
const { cli: cleanupCli } = require('./cleanup-merged.js');

const run = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log, io) {
  if (argv.length > 1 || (argv[0] && !/^#?\d+$/.test(argv[0]))) {
    throw usage('usage: factory-post-merge.js [<pr-number>]');
  }
  const config = loadConfig(root);
  const git = run('git', root);
  const gh = run('gh', root);
  return postMerge(
    { pr: argv[0] && argv[0].replace('#', '') },
    {
      git,
      gh,
      config,
      log,
      cleanup: () => cleanupCli(root, [], { log }),
      ...io,
    },
  );
}

if (require.main === module) runCli(main);

module.exports = { main };
