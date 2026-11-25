#!/usr/bin/env node
/**
 * Open (or add to) the follow-up issue for a review finding that arrived after the
 * owner merged a PR. Run by the `late-comment` job of the factory workflow when the
 * router finds one; it re-reads the event, so it does nothing on any other event.
 *
 * Usage: node scripts/factory-late-comment.js   (reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH)
 * Exit codes: 0 reported, or not a late finding.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { lateFinding, reportLate } = require('../lib/late-comment.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

function main(env = process.env, { log = console.log, gh = defaultGh } = {}) {
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const finding = lateFinding(env.GITHUB_EVENT_NAME, event);
  if (!finding) {
    log('not a late finding: nothing to report');
    return 0;
  }
  const result = reportLate(finding, gh);
  log(`${result.action}${result.issue ? ` #${result.issue}` : ''} for PR #${finding.pr}`);
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
