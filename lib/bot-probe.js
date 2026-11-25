'use strict';

const { normalise } = require('./reviews-settled.js');

const SAMPLE = 30;
// A bot with no post at all needs a sample this large before it is called silent: bots that
// comment only on findings post on a minority of PRs, so a short sample can miss them.
const MIN_PRS_FOR_SILENT = 20;
// Fewer merged PRs than this is too few to say anything.
const MIN_PRS = 5;

/**
 * How often each configured review bot posts. `factory/reviews-settled` waits for each
 * listed bot until it posts or `reviews_timeout_minutes` pass. Many bots comment only
 * when they find a problem, so on most PRs they post nothing and the PR waits the whole
 * timeout. This reads the last merged PRs in one call and counts, per bot, the PRs it
 * reviewed or commented on.
 *
 * @param {string[]} bots The config's review_bots.
 * @param {(args: string[]) => string} gh Runs `gh` in the repository.
 * @returns {{sampled: number, bots: {bot: string, posted: number}[]}}
 */
function probeBots(bots, gh) {
  const prs = JSON.parse(
    gh([
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(SAMPLE),
      '--json',
      'number,reviews,comments',
    ]),
  );
  const posters = prs.map(
    (pr) =>
      new Set(
        [...(pr.reviews || []), ...(pr.comments || [])].map((item) =>
          normalise((item.author || {}).login || ''),
        ),
      ),
  );
  return {
    sampled: prs.length,
    bots: bots.map((bot) => ({
      bot,
      posted: posters.filter((set) => set.has(normalise(bot))).length,
    })),
  };
}

/**
 * The doctor line for a probe, or `undefined` when there are too few merged PRs to say
 * anything. It warns only about a bot that posted on none of a large sample: that is a
 * bot not installed on this repository, or one that reports only through a check run,
 * and either way every PR waits the full timeout for it. Any other bot gets its rate
 * reported, not judged: a bot that comments only on findings posts on a minority of PRs.
 */
function botFinding(probe, { timeoutMinutes = 30, mapped = [] } = {}) {
  if (probe.sampled < MIN_PRS) return undefined;
  // A bot with a mapped check run settles on that check, so silence in comments is normal.
  const viaCheck = new Set(mapped.map(normalise));
  const silent = probe.bots.filter((b) => b.posted === 0 && !viaCheck.has(normalise(b.bot)));
  if (silent.length && probe.sampled >= MIN_PRS_FOR_SILENT) {
    const names = silent.map((b) => b.bot).join(', ');
    return {
      status: 'warn',
      detail:
        `${names} posted on none of the last ${probe.sampled} merged PRs: not installed here, ` +
        `or it reports only through a check run. Every PR waits up to ${timeoutMinutes} minutes for it`,
      fix:
        'Check the bot is installed on this repository. If it is, and its findings arrive as a check ' +
        'run, remove it from review_bots in factory.config.yml (a protected file: use its own pull ' +
        'request); its comments still start a babysit pass.\nOr lower reviews_timeout_minutes.',
    };
  }
  const rates = probe.bots.map((b) => `${b.bot} on ${b.posted} of ${probe.sampled}`).join(', ');
  const waiting = probe.bots.filter((b) => !viaCheck.has(normalise(b.bot)));
  const wait = waiting.length
    ? `. A bot that comments only on findings posts on a minority; on the rest the PR waits up to ${timeoutMinutes} minutes for ${waiting.map((b) => b.bot).join(', ')}`
    : '. Every bot settles on its mapped check, so no PR waits for a post';
  return { status: 'ok', detail: `last merged PRs it posted on: ${rates}${wait}` };
}

/**
 * How often each mapped check run appears on the last merged PRs, in one call. A check
 * run shows as `name`; a commit status shows as `context`.
 *
 * @param {Record<string, string>} botChecks The config's review_bot_checks.
 * @param {(args: string[]) => string} gh Runs `gh` in the repository.
 * @returns {{sampled: number, checks: {bot: string, check: string, seen: number}[]}}
 */
function probeChecks(botChecks, gh) {
  const prs = JSON.parse(
    gh([
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(SAMPLE),
      '--json',
      'number,statusCheckRollup',
    ]),
  );
  const names = prs.map(
    (pr) => new Set((pr.statusCheckRollup || []).map((row) => row.name || row.context)),
  );
  return {
    sampled: prs.length,
    checks: Object.entries(botChecks).map(([bot, check]) => ({
      bot,
      check,
      seen: names.filter((set) => set.has(check)).length,
    })),
  };
}

/**
 * The doctor line for `review_bot_checks`, or `undefined` when there is nothing to say.
 * A mapping for a bot that is not in `review_bots` does nothing. A mapped check that
 * appeared on none of the last merged PRs is a typo, a bot that is gone or one that is
 * not installed here, and its bot then waits the whole timeout, as if unmapped.
 */
function checkMapFinding(probe, bots, { timeoutMinutes = 30 } = {}) {
  const listed = new Set(bots.map(normalise));
  const dead = probe.checks.filter((c) => !listed.has(normalise(c.bot)));
  if (dead.length) {
    return {
      status: 'warn',
      detail: `review_bot_checks names ${dead.map((c) => c.bot).join(', ')}, which is not in review_bots, so it does nothing`,
      fix: 'Remove the entry, or add the bot to review_bots (a protected file: use its own pull request).',
    };
  }
  if (probe.sampled < MIN_PRS) return undefined;
  const missing = probe.checks.filter((c) => c.seen === 0);
  if (missing.length) {
    const list = missing.map((c) => `"${c.check}" (${c.bot})`).join(', ');
    return {
      status: 'warn',
      detail:
        `${list} appeared on none of the last ${probe.sampled} merged PRs: wrong name, or the bot ` +
        `is not installed here. That bot waits up to ${timeoutMinutes} minutes for a post, as if unmapped`,
      fix: "Copy the check's name exactly from a pull request's checks list into review_bot_checks (a protected file: use its own pull request).",
    };
  }
  const seen = probe.checks.map((c) => `${c.check} on ${c.seen} of ${probe.sampled}`).join(', ');
  const unmapped = bots.filter((b) => !probe.checks.some((c) => normalise(c.bot) === normalise(b)));
  return {
    status: 'ok',
    detail:
      `mapped checks seen on the last merged PRs: ${seen}` +
      (unmapped.length ? `. No check mapped for ${unmapped.join(', ')}: waits for a post` : ''),
  };
}

module.exports = {
  probeBots,
  botFinding,
  probeChecks,
  checkMapFinding,
  SAMPLE,
  MIN_PRS_FOR_SILENT,
  MIN_PRS,
};
