#!/usr/bin/env node
/**
 * Advance every open per-change factory PR. Run hourly by the `route` job of the
 * factory workflow, after the router.
 *
 * A per-change PR moves on only when an event lands on it. An event can be
 * missed (GitHub drops some), and the quiet window ends with no event at all, so
 * a settled PR would sit idle. The sweep applies the router's step choice
 * (lib/router.js) to each open per-change PR:
 *
 *   babysit pass, task, owner task,  dispatch the factory workflow with `pr`,
 *     archive run                    which routes the same step again in its
 *                                    own run
 *   archived on the branch           mark the PR ready (the router does it)
 *   waiting, finished, parked        nothing
 *
 * A PR is parked by the needs-human label on the PR or its tracking issue, and
 * skipped while the tracking issue has the retry or retrying label (the retry
 * check owns that run). A duplicate dispatch only queues in the change's
 * concurrency group and finds nothing left to do.
 *
 * Usage: node scripts/factory-sweep.js
 */
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const { createDeps } = require('../lib/router-deps.js');
const { FACTORY_WORKFLOW } = require('../lib/workflow.js');

const DISPATCHED = new Set(['babysit', 'task', 'archive', 'escalate']);

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

/** The deps the router needs, plus the sweep's own reads and its dispatch. */
function sweepDeps(config, gh = defaultGh) {
  return {
    ...createDeps(config, { gh }),
    openAppPrs: () =>
      JSON.parse(
        gh(['pr', 'list', '--state', 'open', '--author', 'app/claude', '--json', 'number,labels']),
      ),
    dispatch: (n) => gh(['workflow', 'run', FACTORY_WORKFLOW, '-f', `pr=${n}`]),
  };
}

function sweep(config, deps, log) {
  const { babysitRoute, changeFromLabels } = createRouter(config);

  /** The step for one PR, or a reason it gets none. */
  function sweepOne(pr) {
    const id = changeFromLabels(pr.labels || []);
    if (!id || !deps.perChange(id)) return { mode: 'none', reason: 'not a per-change PR' };
    const retrying = deps.retryingIssue(id);
    if (retrying) return { mode: 'none', reason: `retry running: #${retrying}` };
    return babysitRoute(pr.number, deps);
  }

  let dispatched = 0;
  for (const pr of deps.openAppPrs()) {
    const step = sweepOne(pr);
    log(`#${pr.number}: ${step.mode} (${step.reason})`);
    if (!DISPATCHED.has(step.mode)) continue;
    deps.dispatch(pr.number);
    dispatched += 1;
  }
  return dispatched;
}

function main(io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const log = io.log || console.log;
  log(`dispatched ${sweep(config, io.deps || sweepDeps(config), log)} run(s)`);
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { sweep, sweepDeps, main };
