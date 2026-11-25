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
 * fails the label goes back, so the change is never left unlabelled and idle. The failure is noted
 * on the issue with a hidden marker, so next hour retries although the restored label is
 * newer than the owner's reply.
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

// Hidden markers on the factory's own comments. A failed resume puts the label back,
// which stamps a new label time later than the owner's reply; the marker is how the
// next run knows that reply still stands.
const RESUMED = '<!-- factory-requeue:resumed -->';
const FAILED = '<!-- factory-requeue:failed -->';

const isOwner = (c, owner) => c.user?.login?.toLowerCase() === owner.toLowerCase();

/** True when the owner commented after `since` (ms). */
const ownerReplied = (comments, owner, since) =>
  comments.some((c) => isOwner(c, owner) && Date.parse(c.created_at) > since);

/** The last marker the factory left (never the owner's), or ''. */
function lastMarker(comments, owner) {
  const marked = comments.filter(
    (c) => !isOwner(c, owner) && (c.body?.includes(RESUMED) || c.body?.includes(FAILED)),
  );
  const last = marked.at(-1);
  if (!last) return '';
  return last.body.includes(FAILED) ? FAILED : RESUMED;
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
  const comment = (n, body) => gh(['issue', 'comment', String(n), '--body', body]);
  const resumed = [];
  let failure = null;
  for (const issue of parked) {
    const id = changeFromLabels(issue.labels || []);
    if (!id) continue;
    const n = issue.number;
    const comments = pages(gh, `repos/{owner}/{repo}/issues/${n}/comments`);
    // A resume that failed last hour left the label back on; the owner's reply stands.
    const retrying = lastMarker(comments, owner) === FAILED;
    if (!retrying) {
      const since = labelledAt(gh, n, labels.needs_human);
      if (!since) {
        log(`#${n}: no needs-human label event found, left alone`);
        continue;
      }
      if (!ownerReplied(comments, owner, since)) {
        log(`#${n}: waiting on the owner`);
        continue;
      }
    }
    gh(['issue', 'edit', String(n), '--remove-label', labels.needs_human]);
    try {
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
      failure = failure || error;
      restore(n, error, retrying);
      continue;
    }
    // Said only once the dispatch worked; a failure of the note itself costs nothing.
    try {
      comment(
        n,
        `Resuming \`${id}\`: @${owner} replied after \`${labels.needs_human}\` was added, so the label is removed and the factory is running.\n${RESUMED}`,
      );
    } catch (error) {
      log(`#${n}: resumed, but the note failed: ${error.message}`);
    }
    log(`#${n}: resumed ${id}`);
    resumed.push(n);
  }
  if (failure) throw failure;
  return resumed;

  /** Put the label back so the change is never left unlabelled and idle; try again next hour. */
  function restore(n, error, alreadyFlagged) {
    try {
      gh(['issue', 'edit', String(n), '--add-label', labels.needs_human]);
      if (!alreadyFlagged) {
        comment(
          n,
          `Could not resume this change (${String(error.message).split('\n')[0]}). The label is back; the factory tries again next hour.\n${FAILED}`,
        );
      }
    } catch (again) {
      log(`#${n}: could not put ${labels.needs_human} back: ${again.message}`);
    }
  }
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
