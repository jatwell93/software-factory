'use strict';

/**
 * A run the agent was refused tool calls in, and that then made nothing: no pull request
 * for a first task, no new commit on the PR of a later one. It ended `success` and looked
 * fine, and the owner had to read the run log for `denied:` lines to learn why (#81).
 *
 * A babysit pass is left out: ending with no push is its normal outcome when every
 * comment was answered in a reply.
 */

const MODES = ['task', 'archive'];

/**
 * @param {{mode: string, denied: number|null, pr: string, prs: number[], headBefore: string, headAfter: string}} run
 *   `pr` is the PR the run started on ('' for a first task), `prs` the open PRs of the change
 *   after the run, `headBefore` and `headAfter` the head commit of `pr` around the run.
 * @returns {boolean} True when the run was denied something and produced nothing.
 */
function deniedWithoutResult({ mode, denied, pr, prs, headBefore, headAfter }) {
  if (!MODES.includes(mode) || !(denied > 0)) return false;
  if (pr === '') return prs.length === 0;
  return Boolean(headBefore) && headBefore === headAfter;
}

/** The comment on the tracking issue: what was refused, and the usual fix. */
function deniedComment({ id, mode, denied, lines, runUrl }) {
  const shown = lines.map((line) => `- \`${line.replace(/^denied: /, '')}\``);
  const more = denied > lines.length ? [`- and ${denied - lines.length} more`] : [];
  return [
    `A ${mode} run of \`${id}\` was refused ${denied} tool call(s) and made nothing, so the factory marked it failed:`,
    '',
    ...shown,
    ...more,
    '',
    `Run: ${runUrl}`,
    '',
    'The usual cause is a command the project has not allowed: add it to `gates` in `factory.config.yml` (an owner edit, on its own pull request). The factory retries once an hour after the first failure; a second failure asks you.',
  ].join('\n');
}

module.exports = { MODES, deniedComment, deniedWithoutResult };
