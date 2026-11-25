const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { lateFinding, lateFindings, reportLate } = require('../lib/late-comment.js');
const { createRouter } = require('../lib/router.js');
const { main } = require('../scripts/factory-late-comment.js');

const MERGED = '2026-11-25T01:00:00Z';
const AFTER = '2026-11-25T02:00:00Z';
const PR = {
  number: 7,
  title: 'feat: x',
  html_url: 'https://github.com/o/r/pull/7',
  merged_at: MERGED,
};
const comment = (id, over = {}) => ({
  id,
  user: { login: 'cursor[bot]' },
  body: `### Bug ${id}\nthis breaks`,
  html_url: `https://github.com/o/r/pull/7#discussion_r${id}`,
  path: 'lib/a.js',
  line: 4,
  created_at: AFTER,
  ...over,
});
const event = (over = {}) => ({
  action: 'created',
  pull_request: PR,
  repository: { owner: { login: 'owner' } },
  comment: comment(11),
  ...over,
});
const COMMENT = 'pull_request_review_comment';
const finding = (id, owner = 'owner') =>
  lateFinding(COMMENT, event({ comment: comment(id) }), owner);

/**
 * An in-memory GitHub: the PR's comments, issues and inline comments. `issue list`
 * (search) throws, because the code must not depend on it: search lags.
 */
function fakeGh({ inline = [] } = {}) {
  const state = { prComments: [], issues: new Map(), next: 30, calls: [] };
  const gh = (args) => {
    state.calls.push(args);
    const [a, b] = args;
    if (a === 'issue' && b === 'list') throw new Error('issue search must not be used');
    if (a === 'pr' && b === 'view') return JSON.stringify({ comments: state.prComments });
    if (a === 'pr' && b === 'comment') {
      state.prComments.push({ body: args[args.indexOf('--body') + 1] });
      return '';
    }
    if (a === 'issue' && b === 'view') {
      const issue = state.issues.get(Number(args[2]));
      return JSON.stringify(issue);
    }
    if (a === 'issue' && b === 'create') {
      const number = state.next++;
      state.issues.set(number, {
        number,
        state: 'OPEN',
        title: args[args.indexOf('--title') + 1],
        body: args[args.indexOf('--body') + 1],
        comments: [],
      });
      return `https://github.com/o/r/issues/${number}\n`;
    }
    if (a === 'issue' && b === 'comment') {
      state.issues.get(Number(args[2])).comments.push({ body: args[args.indexOf('--body') + 1] });
      return '';
    }
    if (a === 'api') return JSON.stringify([inline]);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, state };
}

test('a top-level inline comment from a bot on a merged PR is a finding', () => {
  const f = finding(11);
  assert.equal(f.pr, 7);
  assert.equal(f.author, 'cursor[bot]');
  assert.equal(f.path, 'lib/a.js');
  assert.equal(f.owner, 'owner');
});

test('nothing is a finding while the PR is open, or for the owner, the factory or a reply', () => {
  const open = event({ pull_request: { ...PR, merged_at: null } });
  assert.equal(lateFinding(COMMENT, open, 'owner'), null);
  for (const login of ['owner', 'claude[bot]', 'claude', 'github-actions[bot]']) {
    const e = event({ comment: comment(11, { user: { login } }) });
    assert.equal(lateFinding(COMMENT, e, 'owner'), null, login);
  }
  assert.equal(
    lateFinding(COMMENT, event({ comment: comment(11, { in_reply_to_id: 5 }) }), 'owner'),
    null,
  );
  assert.equal(
    lateFinding(COMMENT, event({ comment: comment(11, { body: '  ' }) }), 'owner'),
    null,
  );
});

test('the configured owner is the owner, not the repository owner (an organisation)', () => {
  const org = {
    repository: { owner: { login: 'my-org' } },
    comment: comment(11, { user: { login: 'jatwell93' } }),
  };
  assert.equal(lateFinding(COMMENT, event(org), 'jatwell93'), null, 'the owner is ignored');
  const bot = event({ ...org, comment: comment(12) });
  const f = lateFinding(COMMENT, bot, 'jatwell93');
  assert.equal(f.owner, 'jatwell93', 'the issue mentions the owner, not the org');
  assert.equal(
    lateFinding(COMMENT, bot).owner,
    'my-org',
    'the repository owner is only the fallback',
  );
});

test('a review counts only when it asks for changes', () => {
  const review = (state) => ({
    action: 'submitted',
    pull_request: PR,
    repository: { owner: { login: 'owner' } },
    review: { id: 3, user: { login: 'human' }, body: 'please fix', state, html_url: 'u' },
  });
  assert.equal(lateFinding('pull_request_review', review('commented'), 'owner'), null);
  assert.equal(lateFinding('pull_request_review', review('approved'), 'owner'), null);
  assert.equal(
    lateFinding('pull_request_review', review('changes_requested'), 'owner').author,
    'human',
  );
  assert.equal(lateFinding('issue_comment', event(), 'owner'), null);
});

test('lateFindings keeps only top-level comments made after the merge', () => {
  const listed = [
    comment(1, { created_at: '2026-11-25T00:00:00Z' }),
    comment(2),
    comment(3, { in_reply_to_id: 2 }),
    comment(4, { user: { login: 'owner' } }),
    comment(5),
  ];
  assert.deepEqual(
    lateFindings(PR, listed, 'owner').map((f) => f.id),
    [2, 5],
  );
});

test('the first finding opens one issue and leaves a marker on the PR', () => {
  const { gh, state } = fakeGh();
  const result = reportLate([finding(11)], gh);
  assert.deepEqual(result, { created: true, added: 0, duplicates: 0, issue: 30 });
  const issue = state.issues.get(30);
  assert.match(issue.title, /^Late review comments on #7: feat: x$/);
  assert.match(issue.body, /@owner/);
  assert.match(issue.body, /cursor\[bot\]\*\* on `lib\/a\.js:4`/);
  assert.match(issue.body, /> ### Bug 11/);
  assert.match(issue.body, /<!-- late-comment:11 -->/);
  assert.match(state.prComments[0].body, /tracked in #30\. <!-- late-comment-issue:30 -->/);
});

test('a burst in one run opens one issue and adds the rest; a second run adds nothing', () => {
  const { gh, state } = fakeGh();
  const burst = [finding(11), finding(12), finding(13)];
  assert.deepEqual(reportLate(burst, gh), { created: true, added: 2, duplicates: 0, issue: 30 });
  assert.equal(state.issues.size, 1);
  assert.equal(state.issues.get(30).comments.length, 2);
  assert.deepEqual(reportLate(burst, gh), { created: false, added: 0, duplicates: 3, issue: 30 });
  assert.equal(state.issues.get(30).comments.length, 2);
});

test('a dropped run costs nothing: the surviving run records every comment, in one issue', () => {
  const { gh, state } = fakeGh();
  // The first run saw only comment 11. Runs for 12 and 13 were dropped by GitHub; the run
  // for 13 survives and lists every late comment on the PR.
  reportLate([finding(11)], gh);
  const listed = [comment(11), comment(12), comment(13)];
  const result = reportLate([finding(13), ...lateFindings(PR, listed, 'owner')], gh);
  assert.deepEqual(result, { created: false, added: 2, duplicates: 1, issue: 30 });
  assert.equal(state.issues.size, 1, 'no second issue');
  assert.equal(state.calls.filter((c) => c[0] === 'issue' && c[1] === 'list').length, 0);
});

test('an issue the owner closed is not reused: a later finding opens a new one', () => {
  const { gh, state } = fakeGh();
  reportLate([finding(11)], gh);
  state.issues.get(30).state = 'CLOSED';
  const result = reportLate([finding(12)], gh);
  assert.equal(result.created, true);
  assert.equal(result.issue, 31);
  assert.equal(state.prComments.length, 2);
  assert.deepEqual(reportLate([finding(13)], gh), {
    created: false,
    added: 1,
    duplicates: 0,
    issue: 31,
  });
});

test('an @mention inside a quoted comment cannot notify anyone', () => {
  const { gh, state } = fakeGh();
  const f = lateFinding(
    COMMENT,
    event({ comment: comment(11, { body: 'ping @someone and @org/team' }) }),
    'owner',
  );
  reportLate([f], gh);
  const { body } = state.issues.get(30);
  assert.doesNotMatch(body, /@someone|@org/);
  assert.match(body, /@owner/, 'the owner is still mentioned on purpose');
});

test('the router sends a finding on a merged PR to the late-comment job, no Claude run', () => {
  const { route } = createRouter({
    owner: 'owner',
    labels: { change_prefix: 'factory:', ready: 'factory-ready', needs_human: 'needs-human' },
    change_id_max_length: 42,
  });
  const result = route(COMMENT, event(), {});
  assert.equal(result.mode, 'late-comment');
  assert.equal(result.pr, 7);
  assert.equal(
    route(COMMENT, event({ comment: comment(11, { user: { login: 'owner' } }) }), {}).mode,
    'none',
  );
});

test('the router uses the configured owner on an organisation repository', () => {
  const { route } = createRouter({
    owner: 'jatwell93',
    labels: { change_prefix: 'factory:', ready: 'factory-ready', needs_human: 'needs-human' },
    change_id_max_length: 42,
  });
  const org = { repository: { owner: { login: 'my-org' } } };
  const byOwner = event({ ...org, comment: comment(11, { user: { login: 'jatwell93' } }) });
  assert.equal(route(COMMENT, byOwner, {}).mode, 'none');
  assert.equal(route(COMMENT, event({ ...org, comment: comment(12) }), {}).mode, 'late-comment');
});

test('the script records the triggering comment and every other late one on the PR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));
  try {
    const file = path.join(dir, 'event.json');
    const env = { GITHUB_EVENT_NAME: COMMENT, GITHUB_EVENT_PATH: file };
    const { gh, state } = fakeGh({ inline: [comment(11), comment(12), comment(13)] });
    const lines = [];
    const run = () => main(env, { gh, config: { owner: 'owner' }, log: (m) => lines.push(m) });
    fs.writeFileSync(file, JSON.stringify(event({ comment: comment(13) })));
    run();
    assert.match(lines.at(-1), /PR #7: opened #30, 3 recorded, 0 already there/);
    assert.equal(state.issues.size, 1);
    run();
    assert.match(lines.at(-1), /PR #7: updated #30, 0 recorded, 3 already there/);
    fs.writeFileSync(file, JSON.stringify(event({ pull_request: { ...PR, merged_at: null } })));
    run();
    assert.match(lines.at(-1), /not a late finding/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
