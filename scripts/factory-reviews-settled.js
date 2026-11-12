#!/usr/bin/env node
/**
 * Publish the `factory/reviews-settled` commit status on factory PRs (see
 * lib/reviews-settled.js for the rule). A factory PR is an open PR the Claude
 * app authored with a change label; any other PR is ignored.
 *
 * Usage: node scripts/factory-reviews-settled.js [<pr>]
 *   with a PR number, only that PR; without, every open factory PR (the
 *   scheduled run, which also ends a quiet window no event announces).
 *
 * The status is posted only when its state or description changed, so a frequent
 * run does not fill the PR with identical statuses.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { CONTEXT, settledStatus } = require('../lib/reviews-settled.js');
const { createRouter, authorOf, isAppAuthor } = require('../lib/router.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const FEEDBACK = path.join(__dirname, 'pr-feedback.js');
const defaultFeedback = (n) =>
  JSON.parse(execFileSync('node', [FEEDBACK, String(n)], { encoding: 'utf8' }));

/** The open factory PRs: the given one, or all. */
function factoryPrs(gh, changeFromLabels, only) {
  const args = only
    ? ['pr', 'view', String(only), '--json', 'number,labels,author,state']
    : ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,labels,author,state'];
  const found = JSON.parse(gh(args));
  return (Array.isArray(found) ? found : [found]).filter(
    (pr) => pr.state === 'OPEN' && changeFromLabels(pr.labels || []) && isAppAuthor(authorOf(pr)),
  );
}

/** The newest status of this context on a commit: { state, description } or null. */
function currentStatus(gh, sha) {
  const rows = JSON.parse(gh(['api', `repos/{owner}/{repo}/commits/${sha}/statuses?per_page=100`]));
  return rows.find((row) => row.context === CONTEXT) || null;
}

function publish(gh, sha, status) {
  gh([
    'api',
    `repos/{owner}/{repo}/statuses/${sha}`,
    '-f',
    `state=${status.state}`,
    '-f',
    `context=${CONTEXT}`,
    '-f',
    `description=${status.description}`,
  ]);
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const gh = io.gh || defaultGh;
  const feedback = io.feedback || defaultFeedback;
  const log = io.log || console.log;
  const now = io.now ?? Date.now();
  const [arg] = argv;
  if (arg !== undefined && !/^[1-9][0-9]*$/.test(arg)) {
    (io.error || console.error)('usage: factory-reviews-settled.js [<pr>]');
    return 2;
  }
  const { changeFromLabels } = createRouter(config);
  for (const pr of factoryPrs(gh, changeFromLabels, arg)) {
    const report = feedback(pr.number);
    const status = settledStatus(report, {
      bots: config.review_bots,
      timeoutMinutes: config.reviews_timeout_minutes,
      now,
    });
    if (!status) continue;
    const current = currentStatus(gh, report.head);
    if (current && current.state === status.state && current.description === status.description) {
      log(`#${pr.number}: ${status.state} (unchanged)`);
      continue;
    }
    publish(gh, report.head, status);
    log(`#${pr.number}: ${status.state} (${status.description})`);
  }
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { currentStatus, factoryPrs, main, publish };
