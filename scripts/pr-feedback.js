#!/usr/bin/env node
/**
 * Collect the review feedback on one pull request, so an agent can work
 * through it without the user pasting bot comments into the session.
 *
 * Feedback arrives from three places, and GitHub's REST API splits them:
 *
 *   * Sentry (Seer) and Copilot post inline review threads. Sentry resolves
 *     its own thread when a later commit fixes the issue ("Resolved in
 *     <sha>"), so only UNRESOLVED threads are actionable.
 *   * CodeScene posts a review per push: APPROVED when its gates pass,
 *     CHANGES_REQUESTED when they fail, plus inline threads for code smells.
 *   * Humans can do any of the above, or leave a plain issue comment.
 *
 * GraphQL is the only API that exposes `isResolved` on a thread, so one
 * GraphQL query reads all three; `gh pr checks` adds the CI state.
 *
 * Usage:
 *   node pr-feedback.js <pr> [--quiet-minutes N]   # JSON report
 *   node pr-feedback.js <pr> --summary              # one-line report
 *   node pr-feedback.js reply <threadId> <body>     # reply in a thread
 *   node pr-feedback.js resolve <threadId>          # resolve a thread
 *
 * The report's `settled` flag is true when every check has finished and no
 * feedback or commit is newer than the quiet window (default 10 minutes).
 * Seer posts several minutes after a push, so "checks are green" alone does
 * not mean the reviews are in. When it is false, `waitingOn` says why
 * ("checks", "quiet window", "truncated threads") and `quietUntil` says when
 * the quiet window ends. `--summary` prints that state as one line instead:
 * `#<pr> settled=<bool> waitingOn=<list or -> actionable=<n> checks=<p> pass/<f> fail/<n> pending`.
 */

const { execFileSync } = require('node:child_process');
const { ConfigError, loadConfig } = require('../lib/config.js');

const DEFAULT_QUIET_MINUTES = 10;
const BODY_LIMIT = 4000;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      url
      headRefName
      commits(last: 1) { nodes { commit { oid committedDate } } }
      reviewThreads(last: 100) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes { author { login } createdAt url body }
          }
        }
      }
      reviews(last: 50) {
        nodes { author { login } state submittedAt url body }
      }
      comments(last: 50) {
        nodes { author { login } createdAt url body }
      }
    }
  }
}`;

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function clip(body) {
  const text = (body || '').trim();
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}\n…[truncated]` : text;
}

function login(node) {
  return node?.author?.login || 'ghost';
}

function latestTime(times) {
  const valid = times
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
}

// Right after a push no check exists yet; CI checks are about to start.
const NO_CHECKS_WORKFLOW = '(no checks reported yet)';

/**
 * Map `gh pr checks --json name,bucket,workflow,...` rows to pass/fail/pending
 * counts. `pendingActions` lists the pending checks of `ciWorkflows`, the
 * project's `ci_workflows` from factory.config.yml. That list must match the
 * `workflow_run` trigger list of the relay workflow (`init` writes one from the
 * other and `doctor` checks them): a pass may only wait for a check whose
 * completion the relay will report, or it waits forever. Other apps' checks
 * (CodeScene, Seer, CodeQL's own check; `workflow` empty) report through
 * reviews, and the factory's own workflows (a review starts a Factory run that
 * shows up as a check on the PR) are not CI, so a pass that waited for either
 * would wait for something that never starts it.
 */
function summarizeChecks(rows, ciWorkflows = []) {
  const waitedFor = new Set([...ciWorkflows, NO_CHECKS_WORKFLOW]);
  const summary = { pass: 0, fail: [], pending: [], pendingActions: [], skipped: 0 };
  for (const row of rows || []) {
    if (row.bucket === 'pass') summary.pass += 1;
    else if (row.bucket === 'fail' || row.bucket === 'cancel') summary.fail.push(row.name);
    else if (row.bucket === 'skipping') summary.skipped += 1;
    else {
      summary.pending.push(row.name);
      // Decided on this row, not by name: workflows share job names such as
      // `test`, so a passed check must not count because another is pending.
      if (waitedFor.has(row.workflow)) summary.pendingActions.push(row.name);
    }
  }
  return summary;
}

function nodes(connection) {
  return connection?.nodes || [];
}

function toThread(t) {
  const [first = {}, ...rest] = nodes(t.comments);
  return {
    id: t.id,
    author: login(first),
    path: t.path,
    line: t.line,
    outdated: t.isOutdated,
    url: first.url,
    createdAt: first.createdAt,
    body: clip(first.body),
    replies: rest.map((c) => ({ author: login(c), body: clip(c.body) })),
  };
}

// Review states that set a reviewer's verdict. A later COMMENTED review does
// not clear an earlier CHANGES_REQUESTED, matching GitHub's review decision.
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

function newer(map, key, r) {
  const prev = map.get(key);
  if (!prev || Date.parse(r.submittedAt) >= Date.parse(prev.submittedAt)) map.set(key, r);
}

/**
 * The latest review per author (CodeScene re-reviews every push), with that
 * author's latest decisive state. CodeScene reports failed gates as a
 * COMMENTED review, so its body is the only signal for those.
 */
function latestReviews(reviewNodes) {
  const latest = new Map();
  const decisive = new Map();
  for (const r of reviewNodes) {
    newer(latest, login(r), r);
    if (DECISIVE.has(r.state)) newer(decisive, login(r), r);
  }
  return [...latest.values()].map((r) => {
    const decision = decisive.get(login(r))?.state || null;
    return {
      author: login(r),
      state: r.state,
      decision,
      submittedAt: r.submittedAt,
      url: r.url,
      actionable: decision === 'CHANGES_REQUESTED' || /\*\*Gates Failed\*\*/.test(r.body || ''),
      body: clip(r.body),
    };
  });
}

function toComment(c) {
  return { author: login(c), createdAt: c.createdAt, url: c.url, body: clip(c.body) };
}

/**
 * Every timestamp that restarts the quiet window. Check start and completion
 * times stand in for the push time: the commit date can be long before the
 * push, and Seer posts after its own check completes.
 */
function activityTimes(pr, head, checkRows) {
  return [
    head.committedDate,
    ...(checkRows || []).flatMap((c) => [c.startedAt, c.completedAt]),
    ...nodes(pr.reviewThreads).flatMap((t) => nodes(t.comments).map((c) => c.createdAt)),
    ...nodes(pr.reviews).map((r) => r.submittedAt),
    ...nodes(pr.comments).map((c) => c.createdAt),
  ];
}

/** Why the PR is not settled yet; empty when it is. */
function blockers({ checks, threadsTruncated, quietUntil, now }) {
  const reasons = [];
  if (checks.pending.length) reasons.push('checks');
  if (quietUntil && now < Date.parse(quietUntil)) reasons.push('quiet window');
  if (threadsTruncated) reasons.push('truncated threads');
  return reasons;
}

/**
 * Reduce the GraphQL pull request and the checks rows to what an agent acts
 * on. Pure, so the tests can drive it with fixtures.
 */
function summarize(
  pr,
  checkRows,
  { now = Date.now(), quietMinutes = DEFAULT_QUIET_MINUTES, ciWorkflows = [] } = {},
) {
  const head = nodes(pr.commits)[0]?.commit || {};
  const threads = nodes(pr.reviewThreads)
    .filter((t) => !t.isResolved)
    .map(toThread);
  const reviews = latestReviews(nodes(pr.reviews));
  const comments = nodes(pr.comments).map(toComment);
  const checks = summarizeChecks(checkRows, ciWorkflows);

  // The query reads the newest 100 threads. Past that, older unresolved threads
  // would be invisible, so the report refuses to call the PR settled.
  const threadsTruncated = (pr.reviewThreads?.totalCount ?? 0) > nodes(pr.reviewThreads).length;

  const lastActivityAt = latestTime(activityTimes(pr, head, checkRows));
  const quietUntil = lastActivityAt
    ? new Date(Date.parse(lastActivityAt) + quietMinutes * 60000).toISOString()
    : null;
  const waitingOn = blockers({ checks, threadsTruncated, quietUntil, now });

  return {
    pr: pr.number,
    state: pr.state,
    url: pr.url,
    branch: pr.headRefName,
    head: head.oid,
    headCommittedAt: head.committedDate || null,
    checks,
    settled: waitingOn.length === 0,
    waitingOn,
    quietUntil,
    threadsTruncated,
    lastActivityAt,
    unresolvedThreads: threads,
    reviews,
    comments,
    actionable: threads.length + reviews.filter((r) => r.actionable).length + checks.fail.length,
  };
}

/** The one-line form of a report, for polling without reading JSON. */
function formatSummary(report) {
  const { checks } = report;
  const waitingOn = report.waitingOn.length ? report.waitingOn.join(',') : '-';
  return (
    `#${report.pr} settled=${report.settled} waitingOn=${waitingOn} actionable=${report.actionable}` +
    ` checks=${checks.pass} pass/${checks.fail.length} fail/${checks.pending.length} pending`
  );
}

function repoSlug(gh) {
  const [owner, repo] = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
    .trim()
    .split('/');
  return { owner, repo };
}

function fetchReport(number, { gh = defaultGh, now, quietMinutes, ciWorkflows } = {}) {
  const { owner, repo } = repoSlug(gh);
  const raw = gh([
    'api',
    'graphql',
    '-f',
    `query=${QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `repo=${repo}`,
    '-F',
    `number=${number}`,
  ]);
  const pr = JSON.parse(raw).data.repository.pullRequest;
  return summarize(pr, fetchChecks(gh, number), { now, quietMinutes, ciWorkflows });
}

// Stands in for checks GitHub has not registered yet, so the PR is not settled.
// Counted in pendingActions (see NO_CHECKS_WORKFLOW): a one-shot pass waits for
// the CI checks that are about to start.
const NO_CHECKS_YET = [
  { name: '(no checks reported yet)', bucket: 'pending', workflow: NO_CHECKS_WORKFLOW },
];

function fetchChecks(gh, number) {
  try {
    return JSON.parse(
      gh(['pr', 'checks', String(number), '--json', 'name,bucket,workflow,startedAt,completedAt']),
    );
  } catch (err) {
    // `gh pr checks` exits 8 while checks are pending and 1 when one failed,
    // but still prints the JSON on stdout. Right after a push it exits 1 with
    // only "no checks reported" on stderr.
    if (err.stdout) return JSON.parse(err.stdout);
    if (/no checks reported/i.test(String(err.stderr || err.message))) return NO_CHECKS_YET;
    throw err;
  }
}

function reply(threadId, body, { gh = defaultGh } = {}) {
  gh([
    'api',
    'graphql',
    '-f',
    'query=mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }',
    '-F',
    `id=${threadId}`,
    '-f',
    `body=${body}`,
  ]);
}

function resolve(threadId, { gh = defaultGh } = {}) {
  gh([
    'api',
    'graphql',
    '-f',
    'query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }',
    '-F',
    `id=${threadId}`,
  ]);
}

/** `--quiet-minutes N` as a non-negative number, the default when absent, or null when invalid. */
function parseQuietMinutes(args) {
  const i = args.indexOf('--quiet-minutes');
  if (i < 0) return DEFAULT_QUIET_MINUTES;
  // A strict decimal match, because Number('') and Number(' ') are 0.
  return /^\d+(\.\d+)?$/.test(args[i + 1] ?? '') ? Number(args[i + 1]) : null;
}

function usage() {
  process.stderr.write(
    'usage: pr-feedback.js <pr> [--quiet-minutes N] [--summary] | reply <threadId> <body> | resolve <threadId>\n',
  );
  return 2;
}

/** The project's ci_workflows, or null (after printing why) when its config cannot be read. */
function ciWorkflowsOf(root) {
  try {
    return loadConfig(root).ci_workflows;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`pr-feedback: ${err.message}\n`);
    return null;
  }
}

function main(argv, { gh = defaultGh, out = process.stdout, root = process.cwd() } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === 'reply' && rest.length >= 2) {
    reply(rest[0], rest.slice(1).join(' '), { gh });
    return 0;
  }
  if (cmd === 'resolve' && rest.length === 1) {
    resolve(rest[0], { gh });
    return 0;
  }
  const quietMinutes = parseQuietMinutes(rest);
  if (!/^\d+$/.test(cmd || '') || quietMinutes === null) return usage();
  const ciWorkflows = ciWorkflowsOf(root);
  if (ciWorkflows === null) return 2;
  const report = fetchReport(Number(cmd), { gh, quietMinutes, ciWorkflows });
  out.write(
    rest.includes('--summary')
      ? `${formatSummary(report)}\n`
      : `${JSON.stringify(report, null, 2)}\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  summarize,
  summarizeChecks,
  formatSummary,
  fetchReport,
  reply,
  resolve,
  main,
  QUERY,
};
