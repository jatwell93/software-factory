#!/usr/bin/env node
/**
 * Fail when a source file in the working tree is ignored by git inside a folder git
 * tracks: `git add` would drop it without a word, and the pull request would miss it.
 * run-spec runs it before every push; run it yourself from the project's root.
 *
 * Usage: node scripts/check-ignored.js
 * Exit codes: 0 none found, 1 at least one (each printed with the rule that ignores it).
 */
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { ignoredSource } = require('../lib/ignored-source.js');

const defaultGit = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });

function main(io = {}) {
  const log = io.log || console.log;
  const found = ignoredSource(io.git || defaultGit);
  if (found.length === 0) {
    log('no ignored source files in tracked folders');
    return 0;
  }
  for (const { file, rule } of found) log(`ignored: ${file} (${rule})`);
  log(
    `${found.length} source file(s) that git add will skip. Do not push: escalate with this list, or, if a file should be committed, the ignore rule needs narrowing (the owner decides).`,
  );
  return 1;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
