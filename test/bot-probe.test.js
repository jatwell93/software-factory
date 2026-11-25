const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { probeBots, botFinding, probeChecks, checkMapFinding } = require('../lib/bot-probe.js');
const { runInit } = require('../lib/init.js');
const { runDoctor } = require('../lib/doctor.js');

/**
 * A fake gh over merged PRs: `authors[i]` lists who reviewed or commented on PR i+1,
 * the first as a review and the rest as comments, as `gh pr list --json` gives them.
 */
function fakeGh(authors) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(
        authors.map((who, i) => ({
          number: i + 1,
          reviews: who.slice(0, 1).map((login) => ({ author: { login } })),
          comments: who.slice(1).map((login) => ({ author: { login } })),
        })),
      );
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

test('asks for the last 30 merged PRs with reviews and comments, in one call', () => {
  const { gh, calls } = fakeGh(prs(4, () => ['sentry']));
  probeBots(['sentry'], gh);
  assert.deepEqual(calls, ['pr list --state merged --limit 30 --json number,reviews,comments']);
});

test('a bot that comments only on findings is reported, not warned about', () => {
  // 6 of 40 is the measured rate of a real findings-only bot.
  const probe = { sampled: 40, bots: [{ bot: 'sentry', posted: 6 }] };
  const f = botFinding(probe, { timeoutMinutes: 30 });
  assert.equal(f.status, 'ok');
  assert.match(f.detail, /sentry on 6 of 40/);
  assert.match(f.detail, /only on findings/);
  assert.match(f.detail, /30 minutes/);
});

test('a bot with no post in a large sample warns, with both ways out', () => {
  const probe = {
    sampled: 30,
    bots: [
      { bot: 'cursor', posted: 9 },
      { bot: 'sentry', posted: 0 },
    ],
  };
  const f = botFinding(probe, { timeoutMinutes: 30 });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /sentry posted on none of the last 30/);
  assert.doesNotMatch(f.detail, /cursor posted on none/);
  assert.match(f.fix, /installed on this repository/);
  assert.match(f.fix, /remove it from review_bots/);
  assert.match(f.fix, /lower reviews_timeout_minutes/);
});

test('a bot with a mapped check is not called silent for posting nothing', () => {
  const probe = { sampled: 30, bots: [{ bot: 'sentry', posted: 0 }] };
  const via = botFinding(probe, { mapped: ['Sentry'] });
  assert.equal(via.status, 'ok');
  assert.match(via.detail, /settles on its mapped check, so no PR waits for a post/);
  assert.doesNotMatch(via.detail, /waits up to/);
  const mixed = botFinding(
    {
      sampled: 30,
      bots: [
        { bot: 'sentry', posted: 2 },
        { bot: 'cursor', posted: 3 },
      ],
    },
    { mapped: ['sentry'] },
  );
  assert.match(mixed.detail, /waits up to 30 minutes for cursor$/);
  assert.equal(botFinding(probe, { mapped: ['cursor'] }).status, 'warn');
});

test('no post in a short sample is not enough to call a bot silent', () => {
  const f = botFinding({ sampled: 10, bots: [{ bot: 'sentry', posted: 0 }] });
  assert.equal(f.status, 'ok');
  assert.match(f.detail, /sentry on 0 of 10/);
});

test('too few merged PRs says nothing', () => {
  assert.equal(botFinding({ sampled: 4, bots: [{ bot: 'sentry', posted: 0 }] }), undefined);
});

/** A project init set up, with `review_bots` set. */
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

const botsResult = (results) => results.find((r) => r.name === 'review bots');

test('doctor warns about a configured bot that never posted in 30 merged PRs', () => {
  const { root, git, ref } = project(['sentry', 'cursor']);
  const { gh } = fakeGh(prs(30, (i) => (i < 5 ? ['cursor'] : [])));
  const result = botsResult(runDoctor(root, { git, gh: doctorGh(ref, gh) }));
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /sentry posted on none of the last 30/);
});

test('doctor reports, without warning, a bot that posts on a minority of PRs', () => {
  const { root, git, ref } = project(['sentry']);
  const { gh } = fakeGh(prs(30, (i) => (i < 5 ? ['sentry'] : ['copilot'])));
  const result = botsResult(runDoctor(root, { git, gh: doctorGh(ref, gh) }));
  assert.equal(result.status, 'ok');
  assert.match(result.detail, /sentry on 5 of 30/);
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
  assert.equal(botsResult(results), undefined);
  assert.deepEqual(asked, []);
});

/** A fake gh over merged PRs: `names[i]` lists the check runs (or statuses) on PR i+1. */
function checksGh(names) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    return JSON.stringify(
      names.map((list, i) => ({
        number: i + 1,
        statusCheckRollup: list.map((n) =>
          n.startsWith('ctx:') ? { context: n.slice(4) } : { name: n },
        ),
      })),
    );
  };
  return { gh, calls };
}

test('counts the merged PRs each mapped check appeared on, as a run or a status, in one call', () => {
  const { gh, calls } = checksGh(
    prs(10, (i) => (i < 7 ? ['Seer Code Review', 'Test'] : ['ctx:Bugbot'])),
  );
  assert.deepEqual(probeChecks({ sentry: 'Seer Code Review', cursor: 'Bugbot', x: 'Nope' }, gh), {
    sampled: 10,
    checks: [
      { bot: 'sentry', check: 'Seer Code Review', seen: 7 },
      { bot: 'cursor', check: 'Bugbot', seen: 3 },
      { bot: 'x', check: 'Nope', seen: 0 },
    ],
  });
  assert.deepEqual(calls, ['pr list --state merged --limit 30 --json number,statusCheckRollup']);
});

const probeOf = (sampled, ...checks) => ({
  sampled,
  checks: checks.map(([bot, check, seen]) => ({ bot, check, seen })),
});

test('a mapped check that appears is ok, and names a listed bot with no mapping', () => {
  const f = checkMapFinding(probeOf(30, ['sentry', 'Seer Code Review', 28]), ['sentry', 'cursor']);
  assert.equal(f.status, 'ok');
  assert.match(f.detail, /Seer Code Review on 28 of 30/);
  assert.match(f.detail, /No check mapped for cursor/);
});

test('a mapped check that never appeared warns with the name, the bot and the fix', () => {
  const f = checkMapFinding(probeOf(30, ['cursor', 'Cursor Bugbot', 0]), ['cursor'], {
    timeoutMinutes: 45,
  });
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /"Cursor Bugbot" \(cursor\) appeared on none of the last 30/);
  assert.match(f.detail, /45 minutes/);
  assert.match(f.fix, /exactly from a pull request's checks list/);
});

test('a mapping for a bot that is not listed warns, even with few merged PRs', () => {
  const f = checkMapFinding(probeOf(2, ['sentry', 'Seer Code Review', 0]), ['cursor']);
  assert.equal(f.status, 'warn');
  assert.match(f.detail, /sentry, which is not in review_bots/);
});

test('a bot is matched to its mapping without case or the [bot] suffix', () => {
  const f = checkMapFinding(probeOf(30, ['Sentry', 'Seer Code Review', 3]), ['sentry[bot]']);
  assert.equal(f.status, 'ok');
});

test('too few merged PRs says nothing about a mapped check', () => {
  assert.equal(
    checkMapFinding(probeOf(4, ['sentry', 'Seer Code Review', 0]), ['sentry']),
    undefined,
  );
});

/** Append mapping lines to the config init wrote. */
const mapChecks = (root, ...lines) =>
  fs.appendFileSync(
    path.join(root, 'factory.config.yml'),
    `review_bot_checks:\n${lines.join('\n')}\n`,
  );
const mapResult = (results) => results.find((r) => r.name === 'review bot checks');

test('doctor warns about a mapped check that never appears', () => {
  const { root, git, ref } = project(['sentry']);
  mapChecks(root, '  sentry: Seer Code Review');
  const { gh } = checksGh(prs(30, () => ['Test']));
  const both = (args) =>
    args.join(' ').includes('statusCheckRollup')
      ? gh(args)
      : fakeGh(prs(30, () => ['sentry'])).gh(args);
  const result = mapResult(runDoctor(root, { git, gh: doctorGh(ref, both) }));
  assert.equal(result.status, 'warn');
  assert.match(result.detail, /"Seer Code Review" \(sentry\) appeared on none/);
});

test('doctor is ok when the mapped check appears, and quiet with no mapping', () => {
  const { root, git, ref } = project(['sentry']);
  const { gh } = checksGh(prs(30, () => ['Seer Code Review']));
  const both = (args) =>
    args.join(' ').includes('statusCheckRollup')
      ? gh(args)
      : fakeGh(prs(30, () => ['sentry'])).gh(args);
  assert.equal(mapResult(runDoctor(root, { git, gh: doctorGh(ref, both) })), undefined);
  mapChecks(root, '  sentry: Seer Code Review');
  assert.equal(mapResult(runDoctor(root, { git, gh: doctorGh(ref, both) })).status, 'ok');
});

test('doctor skips, never fails, when GitHub cannot be asked about the mapped checks', () => {
  const { root, git, ref } = project(['sentry']);
  mapChecks(root, '  sentry: Seer Code Review');
  const result = mapResult(
    runDoctor(root, {
      git,
      gh: doctorGh(ref, (args) => {
        if (args.join(' ').includes('statusCheckRollup')) throw new Error('HTTP 502');
        return fakeGh(prs(30, () => ['sentry'])).gh(args);
      }),
    }),
  );
  assert.equal(result.status, 'skip');
});

test('doctor skips, never fails, when GitHub cannot be asked about the bots', () => {
  const { root, git, ref } = project(['sentry']);
  const result = botsResult(
    runDoctor(root, {
      git,
      gh: doctorGh(ref, () => {
        throw new Error('HTTP 502');
      }),
    }),
  );
  assert.equal(result.status, 'skip');
});
