#!/usr/bin/env node
/**
 * Resume a change when the owner has answered it. Run hourly by the `requeue` job
 * of the factory workflow.
 *
 * A change waits on the owner while its tracking issue has the needs-human label.
 * The owner used to answer in a comment and then remove the label by hand. This
 * removes the label for them: an open tracking issue whose owner comment is newer
 * than the label's last addition loses the label, gets a short comment saying why,
 * and the factory workflow is dispatched for the change.
 *
 * The dispatch is needed because a label removed with the workflow's token starts
 * no workflow run, so the router never sees an `unlabeled` event. If the dispatch
 * fails the label goes back, so the change is never left unlabelled and idle.
 *
 * Only the owner's comments count, and only on tracking issues (an open issue
 * labelled <prefix><id>). If the answer was "I did the owner task" but the task is
 * still unticked, the router escalates again, which adds the label after the
 * comment, so the same comment never requeues twice.
 *
 * Usage: node scripts/factory-requeue.js
 */
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const { FACTORY_WORKFLOW } = require('../lib/workflow.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

/** Every item of a paginated `gh api` listing. */
const pages = (gh, endpoint) => JSON.parse(gh(['api', '--paginate', '--slurp', endpoint])).flat();

/** When the needs-human label was last added to issue `n` (ms), or 0. */
function labelledAt(gh, n, label) {
  const added = pages(gh, `repos/{owner}/{repo}/issues/${n}/events`).filter(
    (e) => e.event === 'labeled' && e.label?.name === label,
  );
  return added.length ? Date.parse(added.at(-1).created_at) : 0;
}

/** True when the owner commented on issue `n` after `since` (ms). */
function ownerReplied(gh, n, owner, since) {
  return pages(gh, `repos/{owner}/{repo}/issues/${n}/comments`).some(
    (c) => c.user?.login?.toLowerCase() === owner.toLowerCase() && Date.parse(c.created_at) > since,
  );
}

/**
 * Resume every tracking issue the owner has answered.
 *
 * @returns {number[]} The issue numbers resumed.
 */
function requeue(config, gh, log) {
  const { labels, owner } = config;
  const { changeFromLabels } = createRouter(config);
  const parked = JSON.parse(
    gh([
      'issue',
      'list',
      '--state',
      'open',
      '--label',
      labels.needs_human,
      '--limit',
      '100',
      '--json',
      'number,labels',
    ]),
  );
  const resumed = [];
  for (const issue of parked) {
    const id = changeFromLabels(issue.labels || []);
    if (!id) continue;
    const since = labelledAt(gh, issue.number, labels.needs_human);
    if (!since) {
      log(`#${issue.number}: no needs-human label event found, left alone`);
      continue;
    }
    if (!ownerReplied(gh, issue.number, owner, since)) {
      log(`#${issue.number}: waiting on the owner`);
      continue;
    }
    gh(['issue', 'edit', String(issue.number), '--remove-label', labels.needs_human]);
    try {
      gh([
        'issue',
        'comment',
        String(issue.number),
        '--body',
        `Resuming \`${id}\`: @${owner} commented after \`${labels.needs_human}\` was added, so the label is removed.`,
      ]);
      gh([
        'workflow',
        'run',
        FACTORY_WORKFLOW,
        '--ref',
        config.default_branch,
        '-f',
        `change_id=${id}`,
      ]);
    } catch (error) {
      // Never leave the change unlabelled and idle.
      gh(['issue', 'edit', String(issue.number), '--add-label', labels.needs_human]);
      throw error;
    }
    log(`#${issue.number}: resumed ${id}`);
    resumed.push(issue.number);
  }
  return resumed;
}

function main(io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const log = io.log || console.log;
  const resumed = requeue(config, io.gh || defaultGh, log);
  log(`resumed ${resumed.length} change(s)`);
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { requeue, main };
