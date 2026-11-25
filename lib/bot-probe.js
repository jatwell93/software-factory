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
function botFinding(probe, { timeoutMinutes = 30 } = {}) {
  if (probe.sampled < MIN_PRS) return undefined;
  const silent = probe.bots.filter((b) => b.posted === 0);
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
  return {
    status: 'ok',
    detail:
      `last merged PRs it posted on: ${rates}. A bot that comments only on findings posts on ` +
      `a minority; on the rest the PR waits up to ${timeoutMinutes} minutes for it`,
  };
}

module.exports = { probeBots, botFinding, SAMPLE, MIN_PRS_FOR_SILENT, MIN_PRS };
