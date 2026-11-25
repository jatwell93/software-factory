#!/usr/bin/env node
/**
 * Open (or add to) the follow-up issue for review findings that arrived after the
 * owner merged a PR. Run by the `late-comment` job of the factory workflow when the
 * router finds one. It re-reads the event, so it does nothing on any other event,
 * and it records EVERY late comment on the PR, not only the one that started the
 * run: GitHub keeps one pending run per concurrency group, so a burst of comments
 * drops runs, and the run that survives must cover the dropped ones.
 *
 * Usage: node scripts/factory-late-comment.js   (reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH)
 * Exit codes: 0 reported, or not a late finding; 2 an unreadable config.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { lateFinding, lateFindings, reportLate } = require('../lib/late-comment.js');

const defaultGh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function main(env = process.env, { log = console.log, gh = defaultGh, config } = {}) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const { owner } = config || loadConfig(process.cwd());
  const triggering = lateFinding(env.GITHUB_EVENT_NAME, event, owner);
  if (!triggering) {
    log('not a late finding: nothing to report');
    return 0;
  }
  const pr = event.pull_request;
  const listed = JSON.parse(
    gh(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${pr.number}/comments`]),
  ).flat();
  const findings = [triggering, ...lateFindings(pr, listed, owner)];
  const result = reportLate(findings, gh);
  log(
    `PR #${pr.number}: ${result.created ? 'opened' : 'updated'} #${result.issue}, ` +
      `${result.added + (result.created ? 1 : 0)} recorded, ${result.duplicates} already there`,
  );
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
