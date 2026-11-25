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
const { CONTEXT, OWN_CHECKS, settledStatus } = require('../lib/reviews-settled.js');
const { createRouter, authorOf, isAppAuthor } = require('../lib/router.js');
const { FACTORY_WORKFLOW, REQUIRED_STATUSES } = require('../lib/workflow.js');
const { ghReason } = require('../lib/gh-error.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const FEEDBACK = path.join(__dirname, 'pr-feedback.js');
const ignoreFlags = OWN_CHECKS.flatMap((name) => ['--ignore-check', name]);
/** The command line that reads a PR's report without waiting on this status's own checks. */
const feedbackArgs = (n) => [FEEDBACK, String(n), ...ignoreFlags];
const defaultFeedback = (n) =>
  JSON.parse(execFileSync('node', feedbackArgs(n), { encoding: 'utf8' }));

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

/** Every status on a commit, newest first. */
function statusesOf(gh, sha) {
  return JSON.parse(gh(['api', `repos/{owner}/{repo}/commits/${sha}/statuses?per_page=100`]));
}

/** The newest status of this context on a commit: { state, description } or null. */
function currentStatus(rows) {
  return rows.find((row) => row.context === CONTEXT) || null;
}

/** How long a head may go without a required status before the run dispatches for it. */
const MISSING_STATUS_GRACE_MINUTES = 10;

/**
 * Dispatch the caller workflow for each required status a head still lacks. The event
 * that should have posted it normally does so within a minute; GitHub sometimes starts
 * no run for a push, and then the PR cannot be merged and nothing else retries. A
 * dispatch reads the PR from the API and posts nothing if the head moved. A failed
 * dispatch only warns: the next run (every 15 minutes) tries again.
 */
function recoverStatuses(gh, config, pr, report, rows, now, log) {
  if (now - Date.parse(report.lastPushAt) < MISSING_STATUS_GRACE_MINUTES * 60000) return;
  for (const { context, workflow } of REQUIRED_STATUSES) {
    if (rows.some((row) => row.context === context)) continue;
    try {
      gh(['workflow', 'run', workflow, '--ref', config.default_branch, '-f', `pr=${pr}`]);
      log(`#${pr}: no ${context} status on the head; dispatched ${workflow}`);
    } catch (error) {
      log(`::warning::#${pr}: could not dispatch ${workflow}: ${ghReason(error)}`);
    }
  }
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

/**
 * Ask the factory workflow for a pass on a PR whose reviews just settled. The router
 * then picks the step: mark the PR ready, answer a review, or nothing. Nothing else
 * reliably follows: the CI relay is a workflow_run, and GitHub starts none for a run
 * that waited for the owner's approval (a private repository holds a run from the
 * Claude app), and the hourly sweep can lag by hours. This runs after the status
 * changed, so a PR is asked once per settling, not every 15 minutes. A failed
 * dispatch only warns: the status is already posted, and the sweep still covers it.
 */
function askFactory(gh, config, number, log) {
  try {
    gh(['workflow', 'run', FACTORY_WORKFLOW, '--ref', config.default_branch, '-f', `pr=${number}`]);
    log(`#${number}: asked the factory for a pass`);
  } catch (error) {
    log(`::warning::#${number}: could not ask the factory for a pass: ${ghReason(error)}`);
  }
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
      botChecks: config.review_bot_checks,
      timeoutMinutes: config.reviews_timeout_minutes,
      now,
    });
    if (!status) continue;
    const rows = statusesOf(gh, report.head);
    recoverStatuses(gh, config, pr.number, report, rows, now, log);
    const current = currentStatus(rows);
    if (current && current.state === status.state && current.description === status.description) {
      log(`#${pr.number}: ${status.state} (unchanged)`);
      continue;
    }
    publish(gh, report.head, status);
    log(`#${pr.number}: ${status.state} (${status.description})`);
    if (status.state === 'success') askFactory(gh, config, pr.number, log);
  }
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = {
  defaultFeedback,
  feedbackArgs,
  ignoreFlags,
  currentStatus,
  factoryPrs,
  main,
  publish,
};
