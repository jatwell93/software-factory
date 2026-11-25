'use strict';

/**
 * A review finding that lands after the owner merged: the PR is closed and merged,
 * so no babysit pass will ever read it. Instead of waiting for the owner to notice,
 * the factory opens one follow-up issue per merged PR (and adds later findings to
 * it). A script does this, not an agent: the owner decides what to do with the issue.
 *
 * Two properties make it safe to run in a burst of comments:
 *  - every run reconciles ALL late comments on the PR, not only the one that started
 *    it, so a run GitHub drops (one pending run per concurrency group) loses nothing;
 *  - the issue is found through a marker comment on the PR, not through issue
 *    search, which lags behind a just-created issue.
 */

const TITLE_PREFIX = 'Late review comments on #';
const MAX_QUOTE = 1500;

/** Logins whose comments are the factory's own or an automation's chatter, never a finding. */
const IGNORED = new Set(['claude', 'claude[bot]', 'app/claude', 'github-actions[bot]']);

const findingMarker = (id) => `<!-- late-comment:${id} -->`;
const issueMarker = (number) => `<!-- late-comment-issue:${number} -->`;
const ISSUE_MARKER = /<!-- late-comment-issue:(\d+) -->/g;

/**
 * The finding one comment or review holds, or null: not by the owner or an ignored
 * login, and not empty. `pr` is the merged PR.
 */
function toFinding(pr, item, owner) {
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

/**
 * The finding a review event holds when the PR was already merged, or null. Only
 * a top-level inline comment, or a review that asks for changes, counts: a reply
 * in a thread is a conversation, and a review summary with no state is noise next
 * to its inline comments, which arrive as their own events.
 *
 * @param {string} eventName `pull_request_review_comment` or `pull_request_review`.
 * @param {object} event The webhook payload.
 * @param {string} [owner] The configured owner; the repository's owner login when
 *   absent (an organisation's name on an organisation repository, so pass the config's).
 */
function lateFinding(eventName, event, owner) {
  const pr = event.pull_request || {};
  if (!pr.merged_at) return null;
  const who = owner || (event.repository?.owner || {}).login || '';
  if (eventName === 'pull_request_review_comment' && event.action === 'created') {
    const item = event.comment;
    return !item || item.in_reply_to_id ? null : toFinding(pr, item, who);
  }
  if (eventName === 'pull_request_review' && event.action === 'submitted') {
    const item = event.review;
    if (!item || String(item.state).toLowerCase() !== 'changes_requested') return null;
    return toFinding(pr, item, who);
  }
  return null;
}

/**
 * Every late finding among a PR's inline comments (as `gh api pulls/N/comments`
 * returns them): top-level, created after the merge. The triggering event's own
 * finding is added by the caller, since a review is not in that list.
 */
function lateFindings(pr, comments, owner) {
  const mergedAt = Date.parse(pr.merged_at || 0);
  return comments
    .filter((c) => !c.in_reply_to_id && Date.parse(c.created_at || 0) > mergedAt)
    .map((c) => toFinding(pr, c, owner))
    .filter(Boolean);
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
    findingMarker(f.id),
  ].join('\n');
}

/** The open follow-up issue the PR's marker comments point to (the latest), or null. */
function openIssueFor(prNumber, gh) {
  const prComments = JSON.parse(
    gh(['pr', 'view', String(prNumber), '--json', 'comments']),
  ).comments;
  const numbers = [];
  for (const c of prComments) {
    for (const m of String(c.body || '').matchAll(ISSUE_MARKER)) numbers.push(Number(m[1]));
  }
  const latest = numbers.at(-1);
  if (!latest) return null;
  const issue = JSON.parse(
    gh(['issue', 'view', String(latest), '--json', 'number,state,body,comments']),
  );
  return issue.state === 'OPEN' ? issue : null;
}

const recorded = (issue, id) =>
  [issue.body, ...issue.comments.map((c) => c.body)].some((b) =>
    String(b || '').includes(findingMarker(id)),
  );

/**
 * Records each finding in the PR's open follow-up issue, opening it (and leaving a
 * marker comment on the PR that names it) when there is none. A finding already in
 * the issue is skipped, so a re-run or a re-delivered event is harmless.
 *
 * @param {object[]} findings From lateFinding / lateFindings; all for the same PR.
 * @param {(args: string[]) => string} gh Runs `gh` in the repository.
 * @returns {{created: boolean, issue?: number, added: number, duplicates: number}}
 */
function reportLate(all, gh) {
  const result = { created: false, added: 0, duplicates: 0 };
  // The same comment can arrive as the event and in the PR's list: record it once.
  const findings = all.filter((f, i) => all.findIndex((g) => g.id === f.id) === i);
  if (!findings.length) return result;
  const first = findings[0];
  let issue = openIssueFor(first.pr, gh);
  let rest = findings;
  if (issue) {
    result.issue = issue.number;
  } else {
    const mention = first.owner ? `@${first.owner} ` : '';
    const body = [
      `${mention}PR #${first.pr} (${first.prTitle}) was merged, then a reviewer commented. ${first.prUrl}`,
      'Each late finding is added here. Close the issue when you have dealt with them.',
      '',
      findingText(first),
    ].join('\n');
    const url = gh([
      'issue',
      'create',
      '--title',
      `${TITLE_PREFIX}${first.pr}: ${first.prTitle}`.slice(0, 200),
      '--body',
      body,
    ]);
    const number = Number(String(url).trim().split('/').pop());
    if (!Number.isFinite(number))
      throw new Error(`cannot read the new issue's number from: ${url}`);
    gh([
      'pr',
      'comment',
      String(first.pr),
      '--body',
      `Late review comments on this PR are tracked in #${number}. ${issueMarker(number)}`,
    ]);
    issue = { number, body, comments: [] };
    result.created = true;
    result.issue = number;
    rest = findings.slice(1);
  }
  for (const f of rest) {
    if (recorded(issue, f.id)) {
      result.duplicates += 1;
      continue;
    }
    gh(['issue', 'comment', String(issue.number), '--body', findingText(f)]);
    issue.comments.push({ body: findingText(f) });
    result.added += 1;
  }
  return result;
}

module.exports = { lateFinding, lateFindings, reportLate, findingText, TITLE_PREFIX };
