'use strict';

const { missingBots } = require('./reviews-settled.js');

/** Time of day for a quiet-window end, in the machine's time zone. */
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Can the owner merge this PR now? Answers from a pr-feedback report, in plain words,
 * so the owner need not read the UI or wait for `factory/reviews-settled` when the
 * only thing outstanding is a quiet window or a bot that may never post.
 *
 * Levels: `done` (not open), `blocked` (a check failed, or findings are unresolved),
 * `wait` (checks still running), `safe` (everything passed; only the quiet window or a
 * bot's review is outstanding, so merging now is safe), `ready` (settled).
 *
 * @param {object} report A pr-feedback report.
 * @param {{bots?: string[], now?: number}} [options] The configured review bots.
 * @returns {{level: string, text: string}}
 */
function verdict(report, { bots = [], now = Date.now() } = {}) {
  if (report.state !== 'OPEN') {
    return { level: 'done', text: `${String(report.state).toLowerCase()}` };
  }
  const failing = report.checks.fail;
  if (failing.length) return { level: 'blocked', text: `checks failing: ${failing.join(', ')}` };
  const open = report.actionable;
  if (open) {
    return {
      level: 'blocked',
      text: `${open} unresolved review item(s): a babysit pass will handle them`,
    };
  }
  if (report.checks.pending.length) {
    return { level: 'wait', text: `checks running: ${report.checks.pending.join(', ')}` };
  }
  if (report.threadsTruncated) {
    return { level: 'wait', text: 'more than 100 review threads: some are not shown' };
  }
  const missing = missingBots(report, bots);
  const outstanding = [];
  if (report.quietUntil && now < Date.parse(report.quietUntil)) {
    outstanding.push(`quiet window until ${clock(report.quietUntil)}`);
  }
  for (const bot of missing) outstanding.push(`no review from ${bot} yet`);
  if (!outstanding.length) return { level: 'ready', text: 'settled, ready to merge' };
  return {
    level: 'safe',
    text:
      `all checks pass and nothing is unresolved; waiting only on ${outstanding.join(', ')}. ` +
      'Safe to merge now: a comment that lands after the merge opens a follow-up issue',
  };
}

/** One line: `#12 ready  title (text)`. */
function line(pr, v) {
  return `#${pr.number} ${v.level.padEnd(7)} ${pr.title}: ${v.text}`;
}

/**
 * The verdict of one PR, or of every open PR.
 *
 * @param {{pr?: number}} options
 * @param {{listOpen: Function, view: Function, report: Function, bots: string[], now?: number, log: Function}} io
 *   listOpen() returns [{number, title}], view(n) one PR, report(n) a pr-feedback report.
 * @returns {number} 0 when the one PR asked about can be merged now (`ready` or
 *   `safe`), or for a listing; 1 otherwise.
 */
function status(options, io) {
  const { listOpen, view, report, bots, now, log } = io;
  const prs = options.pr ? [view(options.pr)] : listOpen();
  if (!prs.length) {
    log('no open pull requests');
    return 0;
  }
  let mergeable = true;
  for (const pr of prs) {
    const v = verdict(report(pr.number), { bots, now });
    log(line(pr, v));
    mergeable = mergeable && (v.level === 'ready' || v.level === 'safe');
  }
  return options.pr && !mergeable ? 1 : 0;
}

module.exports = { verdict, status, line };
