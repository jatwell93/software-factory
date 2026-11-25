const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { probeBots, botFinding } = require('../lib/bot-probe.js');
const { runInit } = require('../lib/init.js');
const { runDoctor } = require('../lib/doctor.js');

/**
 * A fake gh over merged PRs: `authors[i]` lists who reviewed or commented on PR i+1.
 * A review's author comes as `{login}`, as `gh pr view --json reviews,comments` gives it.
 */
function fakeGh(authors) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(authors.map((_, i) => ({ number: i + 1 })));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const who = authors[Number(args[2]) - 1];
      return JSON.stringify({
        reviews: who.slice(0, 1).map((login) => ({ author: { login } })),
        comments: who.slice(1).map((login) => ({ author: { login } })),
      });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

const prs = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('counts, per bot, the merged PRs it posted on, ignoring case and the [bot] suffix', () => {
  const { gh } = fakeGh(prs(10, (i) => (i < 8 ? ['cursor', 'Sentry[bot]'] : ['human'])));
  assert.deepEqual(probeBots(['sentry', 'cursor', 'copilot'], gh), {
    sampled: 10,
    bots: [
      { bot: 'sentry', posted: 8 },
      { bot: 'cursor', posted: 8 },
      { bot: 'copilot', posted: 0 },
    ],
  });
});

test('asks for the last 10 merged PRs and reads each once', () => {
  const { gh, calls } = fakeGh(prs(4, () => ['sentry']));
  probeBots(['sentry'], gh);
  assert.match(calls[0], /^pr list --state merged --limit 10 --json number$/);
  assert.equal(calls.length, 5);
});

test('a bot that posts on at least half the sample is fine', () => {
  const probe = { sampled: 10, bots: [{ bot: 'sentry', posted: 5 }] };
  assert.equal(botFinding(probe).status, 'ok');
});

test('a bot that posts on fewer than half is named with the count and both ways out', () => {
  const probe = {
    sampled: 10,
    bots: [
      { bot: 'cursor', posted: 9 },
      { bot: 'sentry', posted: 2 },
    ],
  };
  const f = botFinding(probe, { timeoutMinutes: 30 });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /sentry on 2 of 10/);
  assert.doesNotMatch(f.detail, /cursor on/);
  assert.match(f.detail, /30 minutes/);
  assert.match(f.fix, /Remove it from review_bots/);
  assert.match(f.fix, /lower reviews_timeout_minutes/);
});

test('too few merged PRs is not judged', () => {
  assert.equal(botFinding({ sampled: 2, bots: [{ bot: 'sentry', posted: 0 }] }), undefined);
});

/** A project init set up, with `review_bots` added to its config. */
function project(bots) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-probe-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 't' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: Test\non: push\n');
  const ref = 'b'.repeat(40);
  runInit(
    { root, ref, labels: false, adapterSetup: false, reviewBots: bots },
    { git, gh: () => '', setup: () => {} },
  );
  return { root, git, ref };
}

/** The doctor's gh for a healthy repo plus the probe's calls. */
function doctorGh(ref, probeGh) {
  const replies = {
    [`api repos/jatwell93/software-factory/commits/${ref} --jq .sha`]: ref,
    'label list --limit 200 --json name --jq .[].name':
      'factory-ready\nneeds-human\nfactory-retry\nfactory-retrying\nfactory-digest',
    'secret list --json name --jq .[].name': 'CLAUDE_CODE_OAUTH_TOKEN',
    'repo view --json nameWithOwner --jq .nameWithOwner': 'octo/app',
    'api repos/octo/app/rules/branches/main': JSON.stringify([
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'factory/no-go-guard' },
            { context: 'factory/change-ids' },
            { context: 'Test' },
          ],
        },
      },
      { type: 'non_fast_forward' },
    ]),
  };
  return (args) => {
    const reply = replies[args.join(' ')];
    if (reply !== undefined) return reply;
    return probeGh(args);
  };
}

test('doctor warns about a configured bot that rarely posts', () => {
  const { root, git, ref } = project(['sentry', 'cursor']);
  const { gh } = fakeGh(prs(10, (i) => (i < 2 ? ['sentry', 'cursor'] : ['cursor'])));
  const result = runDoctor(root, { git, gh: doctorGh(ref, gh) }).find(
    (r) => r.name === 'review bots',
  );
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /sentry on 2 of 10/);
});

test('doctor is quiet about a project with no review bots, and asks GitHub nothing about them', () => {
  const { root, git, ref } = project([]);
  const asked = [];
  const results = runDoctor(root, {
    git,
    gh: doctorGh(ref, (args) => {
      asked.push(args.join(' '));
      throw new Error('should not be called');
    }),
  });
  assert.equal(
    results.find((r) => r.name === 'review bots'),
    undefined,
  );
  assert.deepEqual(asked, []);
});

test('doctor skips, never fails, when GitHub cannot be asked about the bots', () => {
  const { root, git, ref } = project(['sentry']);
  const result = runDoctor(root, {
    git,
    gh: doctorGh(ref, () => {
      throw new Error('HTTP 502');
    }),
  }).find((r) => r.name === 'review bots');
  assert.equal(result.status, 'skip');
});
