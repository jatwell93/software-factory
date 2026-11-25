'use strict';

/**
 * A review finding that lands after the owner merged: the PR is closed and merged,
 * so no babysit pass will ever read it. Instead of waiting for the owner to notice,
 * the factory opens one follow-up issue per merged PR (and adds later findings to
 * it). A script does this, not an agent: the owner decides what to do with the issue.
 */

const TITLE_PREFIX = 'Late review comments on #';
const MAX_QUOTE = 1500;

/** Logins whose comments are the factory's own or an automation's chatter, never a finding. */
const IGNORED = new Set(['claude', 'claude[bot]', 'app/claude', 'github-actions[bot]']);

const marker = (id) => `<!-- late-comment:${id} -->`;

/**
 * The finding a review event holds when the PR was already merged, or null. Only
 * a top-level inline comment, or a review that asks for changes, counts: a reply
 * in a thread is a conversation, and a review summary with no state is noise next
 * to its inline comments, which arrive as their own events.
 *
 * @param {string} eventName `pull_request_review_comment` or `pull_request_review`.
 * @param {object} event The webhook payload.
 */
function lateFinding(eventName, event) {
  const pr = event.pull_request || {};
  if (!pr.merged_at) return null;
  const owner = (event.repository?.owner || {}).login;
  let item;
  if (eventName === 'pull_request_review_comment' && event.action === 'created') {
    item = event.comment;
    if (!item || item.in_reply_to_id) return null;
  } else if (eventName === 'pull_request_review' && event.action === 'submitted') {
    item = event.review;
    if (!item || String(item.state).toLowerCase() !== 'changes_requested') return null;
  } else {
    return null;
  }
  const author = (item.user || {}).login || '';
  const body = String(item.body || '').trim();
  if (!body || !author || author === owner || IGNORED.has(author)) return null;
  return {
    pr: pr.number,
    prTitle: pr.title || '',
    prUrl: pr.html_url || '',
    id: item.id,
    author,
    body,
    url: item.html_url || '',
    path: item.path || '',
    line: item.line || item.original_line || null,
    owner: owner || '',
  };
}

/** `@name` in quoted text would notify that user from the factory's issue: break it. */
const defang = (text) => text.replace(/@(?=[A-Za-z0-9_-])/g, '@​');

const quote = (raw) => {
  const text = defang(raw);
  const cut = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}\n[cut]` : text;
  return cut
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
};

/** Markdown for one late finding. */
function findingText(f) {
  const where = f.path ? ` on \`${f.path}${f.line ? `:${f.line}` : ''}\`` : '';
  return [
    `**${f.author}**${where}, after the merge: ${f.url}`,
    '',
    quote(f.body),
    '',
    marker(f.id),
  ].join('\n');
}

/**
 * Opens the follow-up issue for the PR, or adds the finding to the one already
 * open. A finding already recorded (same marker) is not recorded twice, so a
 * re-delivered event is harmless.
 *
 * @param {object} finding From lateFinding.
 * @param {(args: string[]) => string} gh Runs `gh` in the repository.
 * @returns {{action: string, issue?: number}} `created`, `added` or `duplicate`.
 */
function reportLate(finding, gh) {
  const prefix = `${TITLE_PREFIX}${finding.pr}:`;
  const open = JSON.parse(
    gh([
      'issue',
      'list',
      '--state',
      'open',
      '--search',
      `"${TITLE_PREFIX}${finding.pr}:" in:title`,
      '--json',
      'number,title,body,comments',
    ]),
  ).filter((issue) => issue.title.startsWith(prefix));
  const text = findingText(finding);
  const tag = marker(finding.id);
  if (open.length) {
    const issue = open[0];
    const seen = [issue.body, ...issue.comments.map((c) => c.body)].some((b) =>
      String(b || '').includes(tag),
    );
    if (seen) return { action: 'duplicate', issue: issue.number };
    gh(['issue', 'comment', String(issue.number), '--body', text]);
    return { action: 'added', issue: issue.number };
  }
  const mention = finding.owner ? `@${finding.owner} ` : '';
  const body = [
    `${mention}PR #${finding.pr} (${finding.prTitle}) was merged, then a reviewer commented. ${finding.prUrl}`,
    'Each late finding is added here. Close the issue when you have dealt with them.',
    '',
    text,
  ].join('\n');
  const url = gh([
    'issue',
    'create',
    '--title',
    `${prefix} ${finding.prTitle}`.slice(0, 200),
    '--body',
    body,
  ]);
  const number = Number(String(url).trim().split('/').pop());
  return { action: 'created', issue: Number.isFinite(number) ? number : undefined };
}

module.exports = { lateFinding, reportLate, findingText, TITLE_PREFIX };
