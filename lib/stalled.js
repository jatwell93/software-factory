'use strict';

/** A factory PR with no activity for this long, and not settled, is stuck. */
const IDLE_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Why an open factory PR is stuck and needs the owner, or ''. Two signals:
 *
 * - It conflicts with the default branch. GitHub starts no `pull_request` checks on a
 *   conflicting PR, so the run the factory waits for never starts.
 * - It has been idle for IDLE_HOURS and something outstanding is the factory's to
 *   resolve (checks pending or failing, an unresolved review item). A settled PR that
 *   waits only for the owner's merge is not stuck: that is the owner's turn, and the
 *   digest lists it.
 *
 * The report is read only for a PR that is idle, because it costs several GitHub calls.
 *
 * @param {{mergeable?: string, updatedAt: string}} pr A `gh pr list` row.
 * @param {() => object} getReport The pr-feedback report of the PR, read on demand.
 * @param {number} now Milliseconds since the epoch.
 * @returns {string}
 */
function stallReason(pr, getReport, now) {
  if (pr.mergeable === 'CONFLICTING') return 'it conflicts with the default branch';
  const idle = now - Date.parse(pr.updatedAt);
  if (!(idle > IDLE_HOURS * HOUR_MS)) return '';
  const report = getReport();
  const outstanding = [];
  if (report.checks.fail.length) {
    outstanding.push(`checks failing: ${report.checks.fail.join(', ')}`);
  }
  if (report.checks.pending.length) {
    outstanding.push(`checks never finished: ${report.checks.pending.join(', ')}`);
  }
  // `actionable` already counts each failing check; only the rest are review items.
  const items = report.actionable - report.checks.fail.length;
  if (items > 0) outstanding.push(`${items} unresolved review item(s)`);
  if (!outstanding.length && !report.settled) {
    outstanding.push(`waiting on ${(report.waitingOn || []).join(', ')}`);
  }
  if (!outstanding.length) return '';
  const hours = Math.floor(idle / HOUR_MS);
  return `no activity for ${hours} hours and it is stuck (${outstanding.join('; ')})`;
}

/** The comment that asks the owner to look, with the way out. */
function stallComment({ owner, needsHuman, reason }) {
  const fix = reason.startsWith('it conflicts')
    ? 'Open the PR and use **Update branch** (or merge the default branch in). GitHub runs no checks on a conflicting PR.'
    : 'Open the PR, look at what is outstanding, and fix or close it.';
  return [
    `@${owner} This pull request is stuck: ${reason}.`,
    '',
    fix,
    `The factory will not touch it while it carries \`${needsHuman}\`. Remove the label when it can carry on.`,
  ].join('\n');
}

module.exports = { IDLE_HOURS, stallReason, stallComment };
