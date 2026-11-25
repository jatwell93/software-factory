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
// What this status's own run shows on the PR: the workflow (its caller template's
// name) and the status itself. Both are pending while the run computes, so the
// report must ignore them or the status would wait for itself.
const OWN_CHECKS = ['Reviews settled', CONTEXT];
// GitHub shows at most 140 characters of a status description.
const MAX_DESCRIPTION = 140;

/** A login as the config writes it: lowercase, without the [bot] suffix. */
const normalise = (login) => login.toLowerCase().replace(/\[bot\]$/, '');

const clip = (text) =>
  text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;

/**
 * The configured bots that have not reported on the PR. A bot has reported when it
 * posted, or when the check run `botChecks` names for it has finished: a bot that
 * comments only on findings posts nothing on a clean PR, but its check still ends.
 * A bot with no `botChecks` entry can only report by posting.
 */
function missingBots(report, bots, botChecks = {}) {
  const posted = new Set(report.posters.map(normalise));
  const finished = new Set(report.finishedChecks || []);
  return bots.filter((bot) => {
    if (posted.has(normalise(bot))) return false;
    const check = Object.hasOwn(botChecks, bot) ? botChecks[bot] : undefined;
    return !(check && finished.has(check));
  });
}

/**
 * @param {object} report A pr-feedback report.
 * @param {{bots: string[], timeoutMinutes: number, now: number}} options
 * @returns {{state: 'pending'|'success', description: string}|null} null for a PR
 *   that is not open: it needs no status.
 */
function settledStatus(report, { bots, botChecks = {}, timeoutMinutes, now }) {
  if (report.state !== 'OPEN') return null;
  const missing = missingBots(report, bots, botChecks);
  const waiting = [...report.waitingOn, ...missing.map((bot) => `${bot}`)];
  if (waiting.length === 0) {
    const what = bots.length
      ? `all ${bots.length} review bot(s) have reported`
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

module.exports = { CONTEXT, MAX_DESCRIPTION, OWN_CHECKS, missingBots, normalise, settledStatus };
