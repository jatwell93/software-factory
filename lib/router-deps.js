'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('./adapters.js');
const { githubSource } = require('./github-source.js');
const { authorOf, changeTitle, firstOpenTask, isAppAuthor } = require('./router.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const PR_FEEDBACK = path.join(__dirname, '..', 'scripts', 'pr-feedback.js');
const defaultFeedback = (n) =>
  JSON.parse(execFileSync('node', [PR_FEEDBACK, String(n)], { encoding: 'utf8' }));

/** The comment that tells the owner a finished per-change PR is ready. */
function readyComment(owner) {
  return [
    `@${owner} Every task of this change is done and its reviews have settled, so this PR is ready for your review.`,
    'If GitHub says the branch is out of date, use "Update branch" before merging.',
  ].join('\n');
}

/**
 * The deps lib/router.js reads from GitHub and the project. Run from a checkout
 * of the default branch: `adapter` reads that checkout, and a branch that is not
 * checked out is read through the GitHub contents API.
 *
 * @param {object} config A loaded factory.config.yml.
 * @param {object} [io] Injected by tests: `gh(args)`, `feedback(n)`, `adapter`,
 *   `branchAdapter(ref)`, `now()`.
 */
function createDeps(config, io = {}) {
  const { labels } = config;
  const gh = io.gh || defaultGh;
  const adapter = io.adapter || loadAdapter(config);
  const branchAdapter =
    io.branchAdapter || ((ref) => loadAdapter(config, { source: githubSource(ref, gh) }));
  const changeLabel = (id) => `${labels.change_prefix}${id}`;

  /** Number of the change's open tracking issue that carries `label`, or 0. */
  function issueWith(id, label) {
    const args = ['issue', 'list', '--state', 'open', '--label', changeLabel(id)];
    const list = JSON.parse(gh([...args, '--label', label, '--json', 'number']));
    return list.length ? list[0].number : 0;
  }

  /** When the retry label was last added to issue `n` (ISO time), or ''. */
  function retryLabelledAt(n) {
    const events = JSON.parse(
      gh(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${n}/events`]),
    ).flat();
    const added = events.filter((e) => e.event === 'labeled' && e.label?.name === labels.retry);
    return added.length ? added.at(-1).created_at : '';
  }

  const isActive = (id) => adapter.listChanges().some((c) => c.id === id);

  return {
    // A change with no task at all is a plan still being written: not worth a run.
    changeExists: (id) => isActive(id) && adapter.listTasks(id).length > 0,
    nextTask: (id) => firstOpenTask(adapter.listTasks(id)),
    parkedIssue: (id) => issueWith(id, labels.needs_human),
    retryIssue: (id) => issueWith(id, labels.retry),
    retryCandidates: () =>
      JSON.parse(
        gh([
          'issue',
          'list',
          '--state',
          'open',
          '--label',
          labels.retry,
          '--json',
          'number,labels',
        ]),
      ).map((issue) => ({ ...issue, labelledAt: retryLabelledAt(issue.number) })),
    startRetry: (n) =>
      gh([
        'issue',
        'edit',
        String(n),
        '--remove-label',
        labels.retry,
        '--add-label',
        labels.retrying,
      ]),
    dropRetry: (n) => gh(['issue', 'edit', String(n), '--remove-label', labels.retry]),
    openFactoryPr: (id) => {
      const args = ['pr', 'list', '--state', 'open', '--label', changeLabel(id)];
      const prs = JSON.parse(gh([...args, '--json', 'number,author']));
      const pr = prs.find((p) => isAppAuthor(authorOf(p)));
      return pr ? pr.number : 0;
    },
    now: io.now || (() => Date.now()),
    prView: (n) =>
      JSON.parse(
        gh(['pr', 'view', String(n), '--json', 'state,labels,author,headRefName,title,isDraft']),
      ),
    feedback: io.feedback || defaultFeedback,
    // A change that has no autonomy to read (not on the default branch) is per-task.
    perChange: (id) => isActive(id) && adapter.readAutonomy(id).pr === 'per-change',
    branchTask: (id, ref) => firstOpenTask(branchAdapter(ref).listTasks(id)),
    branchArchived: (id, ref) => branchAdapter(ref).isArchived(id),
    markReady: (pr, n, id) => {
      if (pr.isDraft) gh(['pr', 'ready', String(n)]);
      const name = branchAdapter(pr.headRefName).archivedTitle(id);
      const title = changeTitle(pr.title, name, id);
      if (title !== pr.title) gh(['pr', 'edit', String(n), '--title', title]);
      gh(['pr', 'comment', String(n), '--body', readyComment(config.owner)]);
    },
  };
}

module.exports = { createDeps, readyComment };
