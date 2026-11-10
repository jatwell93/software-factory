'use strict';

/**
 * Decides what one GitHub event means for the factory. It is pure: everything it
 * learns from GitHub or the project comes through `deps`, so a test can drive it
 * with plain objects (lib/router-deps.js builds the real ones). The label names
 * come from the project's config.
 *
 * A route is { mode, change_id, pr, ref, task, retry, per_change, reason } with
 * mode `task`, `babysit`, `archive`, `escalate` or `none`:
 *
 *   workflow_dispatch(change_id)    task on that change
 *   pull_request closed, merged     task on the next unchecked task of the change
 *     (a factory PR, or a plan PR   (a plan PR carries the ready label and only
 *     the owner merged)             counts when the owner merged it)
 *   issues unlabeled needs-human    task: the owner answered an escalation
 *     (by the owner, on an issue
 *     labelled <prefix><id>)
 *   issues labeled ready            task: the owner approved the plan and starts
 *     (same conditions)             the change
 *   schedule (hourly)               the one retry of a failed run: babysit if the
 *                                   change has an open factory PR, else task
 *   pull_request_review(_comment),  babysit pass on the PR, when it has work the
 *   workflow_dispatch(pr)           factory has not handled yet and no Actions
 *     (a finished CI run, relayed   check pending
 *     by factory-ci-relay.yml)
 *
 * Every route becomes `none` while the change's tracking issue has the
 * needs-human or retry label, and `escalate` when the next unchecked task is
 * marked `(owner)`: the escalate job asks the owner without a Claude run.
 *
 * A change with `pr: per-change` in its Autonomy block keeps every task on one
 * PR. Every route that lands on that PR advances it by one step: a babysit pass
 * on actionable items, else, once the PR is settled, the next task of the
 * branch's task list (escalated if it is an `(owner)` task), else an archive run
 * that commits the archived change on the PR, else marking the PR ready for the
 * owner. A merge of the archived PR starts nothing: the change is complete.
 *
 * A change with no unchecked task left on the default branch and not yet
 * archived routes `mode: archive`: a Claude run that archives it on one archive
 * PR. An archived change routes to nothing.
 *
 * Only PRs authored by the Claude GitHub App AND labelled <prefix><id> count as
 * factory PRs, which the factory babysits and continues: the factory can edit
 * labels, so a label alone must never point the factory at an owner's branch.
 * The one exception is a plan PR: its labels count only once the owner has
 * merged it, and it starts a task from the default branch, never from its
 * branch. Deciding "nothing to do" here, before the Claude step, keeps most
 * events from spending a Claude run.
 */

const { ID_PATTERN, idProblem } = require('./change-id.js');
const { maxIdLength } = require('./config.js');

const FACTORY_AUTHOR = 'claude[bot]';
// GraphQL gives an app's login without the [bot] suffix.
const FACTORY_LOGINS = new Set(['claude', 'claude[bot]', 'app/claude']);
const HOUR = 60 * 60 * 1000;
/** The modes that start a Claude run. */
const CLAUDE_MODES = new Set(['task', 'babysit', 'archive']);

const none = (reason) => ({ mode: 'none', reason });

/**
 * The first unchecked task of an adapter's task list, as { number, text, owner },
 * or null.
 */
function firstOpenTask(tasks) {
  const task = tasks.find((t) => !t.done);
  return task ? { number: task.id, text: task.title, owner: task.owner } : null;
}

const authorOf = (pr) => pr.user?.login || pr.author?.login || '';
const isAppAuthor = (login) => login === FACTORY_AUTHOR || login === 'app/claude';

const labelName = (l) => (typeof l === 'string' ? l : l.name);
const hasLabel = (item, name) => (item.labels || []).some((l) => labelName(l) === name);

/**
 * PR number the event is about, or 0. A finished CI run reaches this workflow
 * as a dispatch with `inputs.pr` (from factory-ci-relay.yml), so this workflow
 * never checks out PR code under workflow_run.
 */
function prNumberOf(event) {
  if (event.pull_request) return event.pull_request.number;
  const input = String(event.inputs?.pr || '');
  return /^[1-9][0-9]*$/.test(input) ? Number(input) : 0;
}

const isFactoryPr = (pr, id) => pr.state === 'OPEN' && Boolean(id) && isAppAuthor(authorOf(pr));

/** Threads whose last word is not the factory's: it has not answered them yet. */
const awaitingThreads = (threads) =>
  threads.filter((t) => !FACTORY_LOGINS.has((t.replies.at(-1) || t).author));

/**
 * Reviews posted since the head commit. An older actionable review (a human's
 * CHANGES_REQUESTED, say) was already seen by the pass that made that commit;
 * counting it again would start a pass on every later event.
 */
const freshReviews = (reviews, headCommittedAt) =>
  reviews.filter(
    (r) => r.actionable && Date.parse(r.submittedAt) > Date.parse(headCommittedAt || 0),
  );

/** Items a pass has not handled yet: unanswered threads, new reviews, failing checks. */
function pendingWork(report) {
  return (
    awaitingThreads(report.unresolvedThreads || []).length +
    freshReviews(report.reviews || [], report.headCommittedAt).length +
    report.checks.fail.length
  );
}

/** Why the PR's feedback gives a pass nothing to do yet, or ''. */
function feedbackBlocker(report) {
  if (report.checks.pendingActions.length) return 'Actions checks still running';
  return pendingWork(report) ? '' : 'nothing actionable';
}

/** True while a per-change PR still has tasks to come: a draft or a `WIP:` title. */
const isWip = (pr) => Boolean(pr.isDraft) || /^WIP:/i.test(pr.title || '');

/** True when the event's sender is the repository owner. */
function sentByOwner({ sender = {}, repository = {} }) {
  const owner = (repository.owner || {}).login;
  return Boolean(owner) && sender.login === owner;
}

/** True when the owner merged the event's PR. */
const mergedByOwner = ({ pull_request, repository = {} }) =>
  sentByOwner({ sender: pull_request.merged_by || {}, repository });

const isRetryWait = (result) =>
  result.mode === 'none' &&
  (result.reason === 'Actions checks still running' || result.reason.startsWith('waiting on '));

/** An `(owner)` next task is escalated by the route job, never given to Claude. */
function ownerTaskRoute(result, task) {
  if (!task || !task.owner) return result;
  return {
    mode: 'escalate',
    change_id: result.change_id,
    task: task.number,
    reason: `task ${task.number} is an owner task`,
  };
}

/** $GITHUB_OUTPUT lines; values are ids, numbers and branch names only. */
function toOutput(result) {
  const keys = ['mode', 'change_id', 'pr', 'ref', 'task', 'retry', 'per_change', 'reason'];
  return keys.map((k) => `${k}=${String(result[k] ?? '').replace(/[\r\n]/g, ' ')}`).join('\n');
}

/**
 * The title of a finished per-change PR: the current title's conventional
 * prefix, the change's name and the change id, so the squash commit names the
 * change rather than its first task. Without a prefix or a name, the current
 * title with `WIP:` dropped.
 */
function changeTitle(title, name, id) {
  const bare = title.replace(/^WIP:\s*/i, '');
  const prefix = /^[a-z]+(\([^)]*\))?!?:/.exec(bare);
  if (!prefix || !name) return bare;
  // Keep an acronym ("API ...") as written; lowercase an ordinary first word.
  const lead = /^[A-Z](?![A-Z])/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
  return `${prefix[0]} ${lead} (${id})`;
}

/**
 * @param {object} config A loaded factory.config.yml (labels, change_id_max_length).
 * @returns The routing functions, with the project's label names applied.
 */
function createRouter(config) {
  const { labels } = config;
  const idLimit = maxIdLength(config);
  // The labels that mark state, not a change: <prefix>run is reserved too.
  const stateLabels = new Set(
    [labels.ready, labels.needs_human, labels.retry, labels.retrying, labels.digest].concat(
      `${labels.change_prefix}run`,
    ),
  );

  /** The change id from a `<prefix><id>` label, or ''. */
  function changeFromLabels(list) {
    const ids = list
      .map(labelName)
      .filter((l) => l.startsWith(labels.change_prefix) && !stateLabels.has(l))
      .map((l) => l.slice(labels.change_prefix.length))
      .filter((id) => ID_PATTERN.test(id));
    return ids[0] || '';
  }

  const factoryIdProblem = (id) => idProblem(id, idLimit);

  function dispatchRoute(event) {
    const id = event.inputs?.change_id || '';
    const problem = factoryIdProblem(id);
    if (problem) return none(problem);
    return { mode: 'task', change_id: id, reason: 'dispatched' };
  }

  function mergedRoute(event, deps) {
    const pr = event.pull_request || {};
    if (event.action !== 'closed' || !pr.merged) return none('not a merge');
    const id = changeFromLabels(pr.labels || []);
    if (!id) return none('not a factory PR');
    if (!isAppAuthor(authorOf(pr))) return planMergedRoute(event, id, deps);
    // activeOnly decides what the merge starts: nothing once the change is
    // archived on the default branch, else its next task, else an archive run. A
    // per-change PR merged before its last task (the owner merged a WIP: PR)
    // carries on: the next task opens a new per-change PR.
    return { mode: 'task', change_id: id, reason: `#${pr.number} merged` };
  }

  /** Why an open PR is not one the factory may babysit now, or ''. */
  function prBlocker(pr, id) {
    if (!isFactoryPr(pr, id)) return 'not an open factory PR';
    return hasLabel(pr, labels.needs_human) ? 'waiting on the owner' : '';
  }

  /**
   * Why the change's tracking issue holds every Claude run, or '': the
   * needs-human label (waiting on the owner) or the retry label (a failed run
   * waiting for its retry).
   */
  function changeHold(id, deps) {
    const parked = deps.parkedIssue(id);
    if (parked) return `waiting on the owner: #${parked} has ${labels.needs_human}`;
    const retry = deps.retryIssue(id);
    return retry ? `waiting to retry: #${retry} has ${labels.retry}` : '';
  }

  /**
   * A babysit pass, if the open factory PR has something to act on now. A
   * per-change PR advances by one step instead (advanceRoute).
   */
  function babysitRoute(number, deps) {
    if (!number) return none('no pull request');
    const pr = deps.prView(number);
    const id = changeFromLabels(pr.labels || []);
    const held = prBlocker(pr, id) || changeHold(id, deps);
    if (held) return none(held);
    if (deps.perChange(id)) return advanceRoute(number, pr, id, deps);
    const blocked = feedbackBlocker(deps.feedback(number));
    if (blocked) return none(blocked);
    return {
      mode: 'babysit',
      change_id: id,
      pr: number,
      ref: pr.headRefName,
      reason: 'actionable',
    };
  }

  /**
   * One step on a per-change PR, chosen from its state now: a babysit pass on
   * actionable items; nothing while it waits (checks running, quiet window);
   * else the next task on its branch.
   */
  function advanceRoute(number, pr, id, deps) {
    const report = deps.feedback(number);
    const base = { change_id: id, pr: number, ref: pr.headRefName, per_change: true };
    if (report.checks.pendingActions.length) return none('Actions checks still running');
    if (pendingWork(report)) return { mode: 'babysit', ...base, reason: 'actionable' };
    if (!report.settled) return none(`waiting on ${(report.waitingOn || []).join(', ')}`);
    return nextStepRoute(pr, base, deps);
  }

  /**
   * On a settled per-change PR: the branch's next task (escalated if it is the
   * owner's), else an archive run on the PR, else, once the branch holds the
   * archived change, mark the PR ready and tell the owner, once. The archived
   * branch has no active change, so it is checked first.
   */
  function nextStepRoute(pr, base, deps) {
    if (deps.branchArchived(base.change_id, pr.headRefName)) return handOverRoute(pr, base, deps);
    const task = deps.branchTask(base.change_id, pr.headRefName);
    if (task && task.owner) {
      return { ...ownerTaskRoute(base, task), ref: base.ref, per_change: true };
    }
    if (task) {
      return {
        mode: 'task',
        ...base,
        task: task.number,
        reason: `task ${task.number} on #${base.pr}`,
      };
    }
    return { mode: 'archive', ...base, reason: `archive ${base.change_id} on #${base.pr}` };
  }

  /** A finished, archived per-change PR: mark it ready for the owner, once. */
  function handOverRoute(pr, base, deps) {
    if (!isWip(pr)) return none(`#${base.pr} is finished: waiting for the owner's merge`);
    deps.markReady(pr, base.pr, base.change_id);
    return none(`#${base.pr} marked ready for the owner`);
  }

  /**
   * Every task of a change is done on the default branch and it is not archived
   * yet: one archive run, which opens an archive PR. While a factory PR of the
   * change is open, its own events drive it.
   */
  function archiveRoute(id, deps) {
    const open = deps.openFactoryPr(id);
    if (open) return none(`${id} is already running on #${open}`);
    return { mode: 'archive', change_id: id, reason: `every task of ${id} is done` };
  }

  /** Why an `issues` event does not resume a change, or ''. */
  function resumeBlocker(event, id) {
    const removedLabel = event.action === 'unlabeled' ? (event.label || {}).name : '';
    if (removedLabel !== labels.needs_human) return `not a ${labels.needs_human} removal`;
    if (!id) return 'not a tracking issue';
    return sentByOwner(event)
      ? ''
      : `${labels.needs_human} removed by someone other than the owner`;
  }

  /**
   * The owner taking needs-human off a change's tracking issue resumes it. Only
   * the owner: the factory can edit labels too, and must not unpark itself.
   */
  function resumeRoute(event) {
    const issue = event.issue || {};
    const id = changeFromLabels(issue.labels || []);
    const blocked = resumeBlocker(event, id);
    if (blocked) return none(blocked);
    return { mode: 'task', change_id: id, reason: `#${issue.number} resumed by the owner` };
  }

  /** Why a `labeled` event does not start a change, or ''. */
  function readyBlocker(event, id) {
    if ((event.label || {}).name !== labels.ready) return `not a ${labels.ready} label`;
    if (!id) return 'not a tracking issue';
    return sentByOwner(event) ? '' : `${labels.ready} added by someone other than the owner`;
  }

  /**
   * The owner adding the ready label to a change's tracking issue starts its
   * first unchecked task, as a dispatch does. The ready label must not read as a
   * change id (changeFromLabels skips it). A change with an open factory PR is
   * already running, and its PR's own events drive it.
   */
  function readyRoute(event, deps) {
    const issue = event.issue || {};
    const id = changeFromLabels(issue.labels || []);
    const blocked = readyBlocker(event, id);
    if (blocked) return none(blocked);
    const open = deps.openFactoryPr(id);
    if (open) return none(`${id} is already running on #${open}`);
    return { mode: 'task', change_id: id, reason: `#${issue.number} marked ready by the owner` };
  }

  /**
   * The owner merging a plan PR starts its change. to-tickets opens that PR
   * labelled <prefix><id> and the ready label; its merge puts the task list on
   * the default branch, where the router reads it, so the merge rather than a
   * label on the tracking issue starts the build. Whoever authored the PR, only
   * the owner's merge counts.
   */
  function planMergedRoute(event, id, deps) {
    const pr = event.pull_request;
    if (!hasLabel(pr, labels.ready)) return none('not a factory PR');
    if (!mergedByOwner(event)) {
      return none(`plan #${pr.number} merged by someone other than the owner`);
    }
    const open = deps.openFactoryPr(id);
    if (open) return none(`${id} is already running on #${open}`);
    return { mode: 'task', change_id: id, reason: `plan #${pr.number} merged by the owner` };
  }

  /** An `issues` event: the owner starting a change, or resuming one. */
  const issuesRoute = (event, deps) =>
    event.action === 'labeled' ? readyRoute(event, deps) : resumeRoute(event);

  /**
   * A per-change change continues on its open PR; without one, its next task
   * opens it, and the prompt must say so (per_change). With no task left on the
   * default branch (the owner merged its PR before the archive), an archive PR
   * follows.
   */
  function perChangeStart(result, deps) {
    const open = deps.openFactoryPr(result.change_id);
    if (open) return babysitRoute(open, deps);
    const task = deps.nextTask(result.change_id);
    if (!task) return archiveRoute(result.change_id, deps);
    return { ...ownerTaskRoute(result, task), per_change: true };
  }

  /**
   * A task on a change that is not (or no longer) active, or whose tracking issue
   * waits on the owner, becomes `none`. Later tasks wait for the answer.
   */
  function activeOnly(result, deps) {
    if (result.mode !== 'task') return result;
    if (!deps.changeExists(result.change_id)) {
      return none(`${result.change_id} has no tasks (archived or missing)`);
    }
    const held = changeHold(result.change_id, deps);
    if (held) return none(held);
    if (deps.perChange(result.change_id)) return perChangeStart(result, deps);
    const task = deps.nextTask(result.change_id);
    return task ? ownerTaskRoute(result, task) : archiveRoute(result.change_id, deps);
  }

  /** What the retry would run, decided before any label changes. */
  function retryTarget(due, deps) {
    // This issue's own retry label must not hold the retry it asks for.
    const unheld = { ...deps, retryIssue: () => 0 };
    const pr = deps.openFactoryPr(due.id);
    if (pr) return babysitRoute(pr, unheld);
    const task = { mode: 'task', change_id: due.id, reason: `retry from #${due.number}` };
    return activeOnly(task, unheld);
  }

  /**
   * Labels follow the route: a run swaps the retry label for the retrying one; a
   * wait (checks running, owner hold) keeps the retry label for the next hour;
   * any other outcome (nothing actionable, an owner task, an archived change)
   * needs no retry, so the label goes and no stale retrying label is left behind.
   */
  function settleRetry(number, result, deps) {
    if (CLAUDE_MODES.has(result.mode)) {
      deps.startRetry(number);
      // Marks this run as the retry: only it clears the retrying label when it
      // succeeds, so a parallel success cannot reset the one-retry budget.
      return { ...result, retry: number };
    }
    if (isRetryWait(result)) return none(`retry from #${number} waits: ${result.reason}`);
    deps.dropRetry(number);
    if (result.mode === 'escalate') return result;
    return none(`retry from #${number} not needed: ${result.reason}`);
  }

  /**
   * The hourly schedule retries one failed run: the first open tracking issue
   * whose retry label is over an hour old and that does not also wait on the
   * owner. Its label becomes the retrying one, and the retry runs in this
   * workflow run: a babysit pass when the change has an open factory PR, else a
   * task.
   */
  function retryRoute(deps) {
    const due = deps
      .retryCandidates()
      .map((issue) => ({ ...issue, id: changeFromLabels(issue.labels || []) }))
      .find(
        (issue) =>
          issue.id &&
          !hasLabel(issue, labels.needs_human) &&
          deps.now() - Date.parse(issue.labelledAt) > HOUR,
      );
    if (!due) return none('no retry due');
    const result = retryTarget(due, deps);
    return settleRetry(due.number, result, deps);
  }

  function route(eventName, event, deps) {
    const relayedPr = eventName === 'workflow_dispatch' && event.inputs?.pr;
    if (relayedPr) return babysitRoute(prNumberOf(event), deps);
    if (eventName === 'workflow_dispatch') return activeOnly(dispatchRoute(event), deps);
    if (eventName === 'pull_request') return activeOnly(mergedRoute(event, deps), deps);
    if (eventName === 'issues') return activeOnly(issuesRoute(event, deps), deps);
    if (eventName === 'schedule') return retryRoute(deps);
    return babysitRoute(prNumberOf(event), deps);
  }

  return { route, babysitRoute, changeFromLabels, factoryIdProblem };
}

module.exports = {
  FACTORY_AUTHOR,
  authorOf,
  changeTitle,
  createRouter,
  firstOpenTask,
  isAppAuthor,
  toOutput,
};
