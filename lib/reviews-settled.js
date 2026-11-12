'use strict';

/**
 * The `factory/reviews-settled` commit status of a factory PR: pending until the
 * quiet window has ended, the checks have finished and every configured review
 * bot has posted; success after. It also turns to success once `timeoutMinutes`
 * have passed since the last push, naming the bots that never posted, so a bot
 * that is down or has nothing to say cannot hold the status forever.
 *
 * Pure: the report is pr-feedback's, and `now` is passed in.
 */

const CONTEXT = 'factory/reviews-settled';
// GitHub shows at most 140 characters of a status description.
const MAX_DESCRIPTION = 140;

/** A login as the config writes it: lowercase, without the [bot] suffix. */
const normalise = (login) => login.toLowerCase().replace(/\[bot\]$/, '');

const clip = (text) =>
  text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;

/** The configured bots that have not posted on the PR. */
function missingBots(report, bots) {
  const posted = new Set(report.posters.map(normalise));
  return bots.filter((bot) => !posted.has(normalise(bot)));
}

/**
 * @param {object} report A pr-feedback report.
 * @param {{bots: string[], timeoutMinutes: number, now: number}} options
 * @returns {{state: 'pending'|'success', description: string}|null} null for a PR
 *   that is not open: it needs no status.
 */
function settledStatus(report, { bots, timeoutMinutes, now }) {
  if (report.state !== 'OPEN') return null;
  const missing = missingBots(report, bots);
  const waiting = [...report.waitingOn, ...missing.map((bot) => `${bot}`)];
  if (waiting.length === 0) {
    const what = bots.length
      ? `all ${bots.length} review bot(s) have posted`
      : 'no review bots set';
    return { state: 'success', description: clip(`Quiet window over; ${what}`) };
  }
  // An unknown push time parses to NaN, and `NaN >= limit` is false: no timeout then.
  const pushedAt = Date.parse(report.lastPushAt);
  const limit = timeoutMinutes * 60000;
  if (now - pushedAt >= limit) {
    const who = missing.length
      ? `no review from ${missing.join(', ')}`
      : `still ${report.waitingOn.join(', ')}`;
    return { state: 'success', description: clip(`Timed out after ${timeoutMinutes}m: ${who}`) };
  }
  return { state: 'pending', description: clip(`Waiting on: ${waiting.join(', ')}`) };
}

module.exports = { CONTEXT, MAX_DESCRIPTION, missingBots, normalise, settledStatus };
