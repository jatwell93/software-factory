const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lateFinding, reportLate } = require('../lib/late-comment.js');
const { createRouter } = require('../lib/router.js');
const { main } = require('../scripts/factory-late-comment.js');

const MERGED = '2026-11-25T01:00:00Z';
const event = (over = {}) => ({
  action: 'created',
  pull_request: {
    number: 7,
    title: 'feat: x',
    html_url: 'https://github.com/o/r/pull/7',
    merged_at: MERGED,
  },
  repository: { owner: { login: 'owner' } },
  comment: {
    id: 11,
    user: { login: 'cursor[bot]' },
    body: '### Bug\nthis breaks',
    html_url: 'https://github.com/o/r/pull/7#discussion_r11',
    path: 'lib/a.js',
    line: 4,
  },
  ...over,
});
const COMMENT = 'pull_request_review_comment';

test('a top-level inline comment from a bot on a merged PR is a finding', () => {
  const f = lateFinding(COMMENT, event());
  assert.equal(f.pr, 7);
  assert.equal(f.author, 'cursor[bot]');
  assert.equal(f.path, 'lib/a.js');
  assert.equal(f.owner, 'owner');
});

test('nothing is a finding while the PR is open, or for the owner, the factory or a reply', () => {
  const open = event();
  open.pull_request.merged_at = null;
  assert.equal(lateFinding(COMMENT, open), null);
  for (const login of ['owner', 'claude[bot]', 'claude', 'github-actions[bot]']) {
    const e = event();
    e.comment.user.login = login;
    assert.equal(lateFinding(COMMENT, e), null, login);
  }
  const reply = event();
  reply.comment.in_reply_to_id = 5;
  assert.equal(lateFinding(COMMENT, reply), null);
  const empty = event();
  empty.comment.body = '  ';
  assert.equal(lateFinding(COMMENT, empty), null);
});

test('a review counts only when it asks for changes', () => {
  const review = (state) => ({
    action: 'submitted',
    pull_request: event().pull_request,
    repository: event().repository,
    review: { id: 3, user: { login: 'human' }, body: 'please fix', state, html_url: 'u' },
  });
  assert.equal(lateFinding('pull_request_review', review('commented')), null);
  assert.equal(lateFinding('pull_request_review', review('approved')), null);
  assert.equal(lateFinding('pull_request_review', review('changes_requested')).author, 'human');
  assert.equal(lateFinding('issue_comment', event()), null);
});

/** A fake gh over an in-memory issue list. */
function fakeGh(issues = []) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(issues);
    if (args[1] === 'create') return 'https://github.com/o/r/issues/30\n';
    return '';
  };
  return { gh, calls };
}

test('the first finding opens one issue that names the PR, owner and comment', () => {
  const { gh, calls } = fakeGh();
  const result = reportLate(lateFinding(COMMENT, event()), gh);
  assert.deepEqual(result, { action: 'created', issue: 30 });
  const create = calls.find((c) => c[1] === 'create');
  assert.match(create[create.indexOf('--title') + 1], /^Late review comments on #7: feat: x$/);
  const body = create[create.indexOf('--body') + 1];
  assert.match(body, /@owner/);
  assert.match(body, /cursor\[bot\]\*\* on `lib\/a\.js:4`/);
  assert.match(body, /> ### Bug/);
  assert.match(body, /<!-- late-comment:11 -->/);
});

test('an @mention inside a quoted comment cannot notify anyone', () => {
  const { gh, calls } = fakeGh();
  const e = event();
  e.comment.body = 'ping @someone and @org/team';
  reportLate(lateFinding(COMMENT, e), gh);
  const create = calls.find((c) => c[1] === 'create');
  const body = create[create.indexOf('--body') + 1];
  assert.doesNotMatch(body, /@someone|@org/);
  assert.match(body, /@owner/, 'the owner is still mentioned on purpose');
});

test('a later finding on the same PR is added to the open issue, not a second issue', () => {
  const issue = {
    number: 30,
    title: 'Late review comments on #7: feat: x',
    body: '<!-- late-comment:11 -->',
    comments: [],
  };
  const { gh, calls } = fakeGh([issue]);
  const later = event();
  later.comment.id = 12;
  const result = reportLate(lateFinding(COMMENT, later), gh);
  assert.deepEqual(result, { action: 'added', issue: 30 });
  assert.equal(calls.filter((c) => c[1] === 'create').length, 0);
  assert.deepEqual(calls.find((c) => c[1] === 'comment').slice(0, 3), ['issue', 'comment', '30']);
});

test('a re-delivered event records nothing twice', () => {
  const issue = {
    number: 30,
    title: 'Late review comments on #7: feat: x',
    body: 'x',
    comments: [{ body: 'old <!-- late-comment:11 -->' }],
  };
  const { gh, calls } = fakeGh([issue]);
  assert.deepEqual(reportLate(lateFinding(COMMENT, event()), gh), {
    action: 'duplicate',
    issue: 30,
  });
  assert.equal(calls.filter((c) => c[1] !== 'list').length, 0);
});

test('an issue for another PR with a similar number is not reused', () => {
  const other = { number: 5, title: 'Late review comments on #70: y', body: '', comments: [] };
  const { gh, calls } = fakeGh([other]);
  assert.equal(reportLate(lateFinding(COMMENT, event()), gh).action, 'created');
  assert.equal(calls.filter((c) => c[1] === 'comment').length, 0);
});

test('the router sends a finding on a merged PR to the late-comment job, no Claude run', () => {
  const { route } = createRouter({
    labels: { change_prefix: 'factory:', ready: 'factory-ready', needs_human: 'needs-human' },
    change_id_max_length: 42,
  });
  const result = route(COMMENT, event(), {});
  assert.equal(result.mode, 'late-comment');
  assert.equal(result.pr, 7);
  const quiet = event();
  quiet.comment.user.login = 'owner';
  assert.equal(route(COMMENT, quiet, {}).mode, 'none');
});

test('the script reports from the event file and ignores a non-finding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));
  try {
    const file = path.join(dir, 'event.json');
    const { gh } = fakeGh();
    const lines = [];
    const env = { GITHUB_EVENT_NAME: COMMENT, GITHUB_EVENT_PATH: file };
    fs.writeFileSync(file, JSON.stringify(event()));
    main(env, { gh, log: (m) => lines.push(m) });
    assert.match(lines.at(-1), /created #30 for PR #7/);
    const open = event();
    open.pull_request.merged_at = null;
    fs.writeFileSync(file, JSON.stringify(open));
    main(env, { gh, log: (m) => lines.push(m) });
    assert.match(lines.at(-1), /not a late finding/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
