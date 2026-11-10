#!/usr/bin/env node
/**
 * Ask the owner to do an `(owner)` task. Run by the `escalate` job of the factory
 * workflow when the router finds that the next unchecked task of a change is an
 * owner task, so no Claude run is spent finding out that the task is not the
 * factory's.
 *
 * It adds the needs-human label to the change's tracking issue
 * (lib/tracking-issue.js) and comments the task. The router holds the change
 * until the owner removes the label; if the task is still unticked then, the
 * router escalates again.
 *
 * On a per-change PR the task list is the PR branch's, so the router passes that
 * branch and the owner ticks the task there.
 *
 * Usage: node scripts/factory-escalate.js <change-id> <task-number> [<branch>]
 * Exit codes: 0 escalated, or nothing to do (the task is no longer next);
 * 2 usage error.
 */
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { githubSource } = require('../lib/github-source.js');
const { ensureNeedsHuman } = require('../lib/labels.js');
const { createRouter, firstOpenTask } = require('../lib/router.js');
const { trackingIssue } = require('../lib/tracking-issue.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const TASK_NUMBER = /^[0-9][0-9A-Za-z.]{0,19}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Markdown body of the escalation comment. */
function comment(config, id, task, ref = '') {
  return [
    `@${config.owner} Task ${task.number} of \`${id}\` is an owner task, so the factory will not attempt it:`,
    '',
    `> ${task.text}`,
    '',
    `Do it, tick it in the change's task list on \`${ref || config.default_branch}\`, then remove \`${config.labels.needs_human}\` to resume.`,
    'If the task is still unticked when the label goes, the factory asks again.',
  ].join('\n');
}

/**
 * The change's next task on `ref` (a PR branch) or on the checkout, or null. A
 * change that is gone from there (archived meanwhile) has no task left to ask about.
 */
function nextTaskOf(adapter, id) {
  if (!adapter.listChanges().some((c) => c.id === id)) return null;
  return firstOpenTask(adapter.listTasks(id));
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const [id, number, ref] = [0, 1, 2].map((i) => argv[i] || '');
  let problem = '';
  if (ref && !BRANCH.test(ref)) problem = 'invalid branch';
  else problem = factoryIdProblem(id) || (TASK_NUMBER.test(number) ? '' : 'invalid task number');
  if (problem) {
    (io.error || console.error)(
      `usage: factory-escalate.js <change-id> <task-number> [<branch>]: ${problem}`,
    );
    return 2;
  }
  const gh = io.gh || defaultGh;
  const log = io.log || console.log;
  const adapter = ref
    ? (io.branchAdapter || ((r) => loadAdapter(config, { source: githubSource(r, gh) })))(ref)
    : io.adapter || loadAdapter(config);
  const task = nextTaskOf(adapter, id);
  // The list can change after routing: ask only while this is still the next owner task.
  if (!task || !task.owner || task.number !== number) {
    log(`Task ${number} of ${id} is no longer the next owner task; nothing to do.`);
    return 0;
  }
  const issue = String(
    trackingIssue(id, { config, adapter: io.adapter || loadAdapter(config), gh }),
  );
  // Label first: the hold matters more than the comment.
  ensureNeedsHuman(gh, config);
  gh(['issue', 'edit', issue, '--add-label', config.labels.needs_human]);
  gh(['issue', 'comment', issue, '--body', comment(config, id, task, ref)]);
  log(`Escalated task ${task.number} of ${id} on #${issue}.`);
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { comment, main };
