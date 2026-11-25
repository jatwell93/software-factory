#!/usr/bin/env node
/**
 * Flag the open factory PRs that are stuck. Run hourly by the `sweep` job of the
 * factory workflow, before the sweep itself.
 *
 * A stuck PR (it conflicts with the default branch, or it has been idle for a day with
 * something the factory should have resolved still outstanding; lib/stalled.js) gets
 * the needs-human label and one comment that mentions the owner. The label parks it:
 * the sweep and the router skip it, and `factory status` and the digest list it.
 *
 * The factory does not rebase or update the branch itself. A push made with the job's
 * token starts no checks, so the PR would only look fixed. The owner uses **Update
 * branch**, which does start them, then removes the label.
 *
 * Usage: node scripts/factory-stalled.js
 */
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const { stallReason, stallComment } = require('../lib/stalled.js');
const { fetchReport } = require('./pr-feedback.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

/**
 * @returns {number[]} The PR numbers flagged.
 */
function flagStalled(config, { gh = defaultGh, report, now = Date.now(), log = () => {} } = {}) {
  const { labels, owner } = config;
  const { changeFromLabels } = createRouter(config);
  const read = report || ((n) => fetchReport(n, { gh, ciWorkflows: config.ci_workflows }));
  const prs = JSON.parse(
    gh([
      'pr',
      'list',
      '--state',
      'open',
      '--author',
      'app/claude',
      '--limit',
      '100',
      '--json',
      'number,labels,mergeable,updatedAt',
    ]),
  );
  const flagged = [];
  let failure = null;
  for (const pr of prs) {
    const names = (pr.labels || []).map((l) => l.name);
    if (!changeFromLabels(pr.labels || []) || names.includes(labels.needs_human)) continue;
    try {
      const reason = stallReason(pr, () => read(pr.number), now);
      if (!reason) continue;
      // Label first: the hold matters more than the comment.
      gh(['pr', 'edit', String(pr.number), '--add-label', labels.needs_human]);
      gh([
        'pr',
        'comment',
        String(pr.number),
        '--body',
        stallComment({ owner, needsHuman: labels.needs_human, reason }),
      ]);
      log(`#${pr.number}: flagged (${reason})`);
      flagged.push(pr.number);
    } catch (error) {
      failure = failure || error;
      log(`#${pr.number}: ${error.message}`);
    }
  }
  if (failure) throw failure;
  return flagged;
}

function main(io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const log = io.log || console.log;
  log(`flagged ${flagStalled(config, { ...io, log }).length} stuck PR(s)`);
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { flagStalled, main };
