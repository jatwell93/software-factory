#!/usr/bin/env node
/**
 * Fail a task or archive run that the agent was refused tool calls in and that then made
 * nothing. Run by the `run` job of the factory workflow right after the agent step, so
 * the run ends red instead of `success` with no pull request. The `report` job then
 * labels the tracking issue for the one retry, and a second failure asks the owner.
 *
 * It comments the refused commands on the change's tracking issue first, so the owner
 * sees what was refused without opening the run log.
 *
 * Usage: node scripts/factory-denied.js <mode> <change-id> [<pr>] --execution <file>
 *          --run-url <url> [--head-before <sha>]
 *   <pr> is the PR the run started on, with --head-before its head commit before the run.
 * Exit codes: 0 nothing to flag, 1 the run was denied and made nothing, 2 usage error.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { deniedComment, deniedWithoutResult } = require('../lib/denied-run.js');
const { denialLines, parseExecution } = require('../lib/run-record.js');
const { createRouter } = require('../lib/router.js');
const { trackingIssue } = require('../lib/tracking-issue.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** Takes `--name value` out of args and returns the value, or '' when absent. */
function take(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return '';
  const [, value = ''] = args.splice(at, 2);
  return value;
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const args = [...argv];
  const executionFile = take(args, '--execution');
  const runUrl = take(args, '--run-url');
  const headBefore = take(args, '--head-before');
  const [mode = '', id = '', pr = ''] = args;
  let problem = '';
  if (args.length > 3) problem = 'too many arguments';
  else if (factoryIdProblem(id)) problem = factoryIdProblem(id);
  else if (!/^([1-9][0-9]*)?$/.test(pr)) problem = 'invalid pr';
  else if (!RUN_URL.test(runUrl)) problem = 'invalid run url';
  else if (headBefore && !SHA.test(headBefore)) problem = 'invalid head commit';
  if (problem) {
    (io.error || console.error)(
      `usage: factory-denied.js <mode> <change-id> [<pr>] --execution <file> --run-url <url> [--head-before <sha>]: ${problem}`,
    );
    return 2;
  }
  const log = io.log || console.log;
  let text = '';
  try {
    text = (io.read || ((file) => fs.readFileSync(file, 'utf8')))(executionFile);
  } catch {
    return 0; // No log (a crash): the run failed on its own, nothing to add.
  }
  const { denied } = parseExecution(text);
  if (!(denied > 0)) return 0;

  const gh = io.gh || defaultGh;
  const { labels } = config;
  let prs = [];
  let headAfter = '';
  if (pr === '') {
    const found = gh([
      'pr',
      'list',
      '--state',
      'open',
      '--label',
      `${labels.change_prefix}${id}`,
      '--json',
      'number',
    ]);
    prs = JSON.parse(found).map((p) => p.number);
  } else {
    headAfter = JSON.parse(gh(['pr', 'view', pr, '--json', 'headRefOid'])).headRefOid;
  }
  if (!deniedWithoutResult({ mode, denied, pr, prs, headBefore, headAfter })) return 0;

  const lines = denialLines(text);
  const adapter = io.adapter || loadAdapter(config);
  const number = String(trackingIssue(id, { config, adapter, gh }));
  gh(['issue', 'comment', number, '--body', deniedComment({ id, mode, denied, lines, runUrl })]);
  for (const line of lines) log(line);
  log(`::error::run was refused ${denied} tool call(s) and made nothing; commented on #${number}`);
  return 1;
}

if (require.main === module) runCli(main);

module.exports = { main };
