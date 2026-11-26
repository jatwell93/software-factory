#!/usr/bin/env node
/**
 * Check a project against what the factory needs and print the command that fixes
 * each gap: the config, the adapter, the caller workflows and their pin, the CI
 * relay's list, the skills, git hooks, labels, the secret, Actions settings and
 * the default branch's ruleset. Run it from the project's root, logged in to gh.
 * A GitHub call that fails is reported as `skip`, so the file checks still run.
 *
 * Usage: node factory-doctor.js [--json]
 *
 * --json prints one JSON object ({ok, counts, results}) instead of text, so an agent
 * can read the result without a paste. The exit code is the same.
 *
 * Exit codes: 0 no failure (warnings and skips do not fail), 1 at least one
 * failure, 2 usage error.
 */

const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { runDoctor } = require('../lib/doctor.js');

const run = (cmd, cwd) => (args) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log, io) {
  const json = argv.length === 1 && argv[0] === '--json';
  if (argv.length && !json) {
    const error = new Error('usage: factory-doctor.js [--json]');
    error.userError = true;
    throw error;
  }
  const results = runDoctor(root, io || { git: run('git', root), gh: run('gh', root) });
  const count = (s) => results.filter((r) => r.status === s).length;
  if (json) {
    const counts = {
      ok: count('ok'),
      warn: count('warn'),
      fail: count('fail'),
      skip: count('skip'),
    };
    log(JSON.stringify({ ok: counts.fail === 0, counts, results }, null, 2));
    return counts.fail ? 1 : 0;
  }
  for (const r of results) {
    log(`${MARK[r.status]} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    if (r.fix) for (const line of r.fix.split('\n')) log(`       fix: ${line}`);
  }
  log(`\n${count('ok')} ok, ${count('warn')} warn, ${count('fail')} fail, ${count('skip')} skip`);
  return count('fail') ? 1 : 0;
}

if (require.main === module) runCli(main);

module.exports = { main };
