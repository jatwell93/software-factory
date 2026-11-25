'use strict';

const { normalise } = require('./reviews-settled.js');

const SAMPLE = 10;
// A bot that posted on fewer than this share of the sample holds most PRs for the whole timeout.
const MIN_SHARE = 0.5;
// Fewer merged PRs than this is too few to judge a bot by.
const MIN_PRS = 3;

/**
 * Which of the configured review bots actually post. `factory/reviews-settled` waits
 * for each listed bot until it posts or `reviews_timeout_minutes` pass, so a bot that
 * stays quiet when it finds nothing (or reports only through a check run) makes every
 * PR wait the full timeout. This reads the last merged PRs and counts, per bot, the
 * PRs it reviewed or commented on.
 *
 * @param {string[]} bots The config's review_bots.
 * @param {(args: string[]) => string} gh Runs `gh` in the repository.
 * @returns {{sampled: number, bots: {bot: string, posted: number}[]}}
 */
function probeBots(bots, gh) {
  const prs = JSON.parse(
    gh(['pr', 'list', '--state', 'merged', '--limit', String(SAMPLE), '--json', 'number']),
  );
  const posters = prs.map((pr) => {
    const view = JSON.parse(gh(['pr', 'view', String(pr.number), '--json', 'reviews,comments']));
    const logins = [...view.reviews, ...view.comments].map((item) =>
      normalise((item.author || {}).login || ''),
    );
    return new Set(logins);
  });
  return {
    sampled: prs.length,
    bots: bots.map((bot) => ({
      bot,
      posted: posters.filter((set) => set.has(normalise(bot))).length,
    })),
  };
}

/**
 * The doctor line for a probe: ok, or a warning naming each bot that posted on too few
 * of the sampled PRs, with the two ways out. `undefined` when there are too few merged
 * PRs to judge by.
 */
function botFinding(probe, { timeoutMinutes = 30 } = {}) {
  if (probe.sampled < MIN_PRS) return undefined;
  const quiet = probe.bots.filter((b) => b.posted / probe.sampled < MIN_SHARE);
  if (!quiet.length) {
    return {
      status: 'ok',
      detail: `${probe.bots.map((b) => b.bot).join(', ')}: each posted on at least half of the last ${probe.sampled} merged PRs`,
    };
  }
  const list = quiet.map((b) => `${b.bot} on ${b.posted} of ${probe.sampled}`).join(', ');
  return {
    status: 'warn',
    detail: `rarely posts: ${list}. Each PR waits up to ${timeoutMinutes} minutes for it`,
    fix:
      'Remove it from review_bots in factory.config.yml (a protected file: use its own pull request); ' +
      'its comments still start a babysit pass, it just stops holding factory/reviews-settled.\n' +
      'Or lower reviews_timeout_minutes.',
  };
}

module.exports = { probeBots, botFinding, SAMPLE, MIN_SHARE, MIN_PRS };
