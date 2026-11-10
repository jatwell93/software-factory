const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../lib/config.js');
const { changeTitle, createRouter, firstOpenTask, toOutput } = require('../lib/router.js');
const { parseTasks } = require('../adapters/openspec.js');
const { tempRoot } = require('./helpers.js');

const config = loadConfig(tempRoot());
const { route, changeFromLabels, factoryIdProblem } = createRouter(config);
const nextTask = (md) => firstOpenTask(parseTasks(md));

const LABEL = { name: 'factory:add-x' };
const APP = { login: 'claude[bot]' };

function deps({
  pr = {},
  report = {},
  parked = 0,
  retry = 0,
  tasks = '- [ ] 1.1 Do it\n',
  candidates = [],
  openPr = 0,
  perChange = false,
  branchTasks = '- [x] 1.1 Do it\n- [ ] 1.2 Next\n',
  archived = false,
  exists = true,
} = {}) {
  const calls = {
    feedback: 0,
    startRetry: [],
    dropRetry: [],
    branchTask: [],
    markReady: [],
    readyIds: [],
  };
  return {
    calls,
    perChange: () => perChange,
    branchTask: (id, ref) => {
      calls.branchTask.push([id, ref]);
      return nextTask(branchTasks);
    },
    branchArchived: () => archived,
    markReady: (p, n, id) => {
      calls.markReady.push(n);
      calls.readyIds.push(id);
    },
    changeExists: (id) => exists && id !== 'gone',
    parkedIssue: () => parked,
    retryIssue: () => retry,
    retryCandidates: () => candidates,
    startRetry: (n) => calls.startRetry.push(n),
    dropRetry: (n) => calls.dropRetry.push(n),
    openFactoryPr: () => openPr,
    now: () => Date.parse('2026-10-26T12:00:00Z'),
    nextTask: () => nextTask(tasks),
    prView: () => ({
      state: 'OPEN',
      labels: [LABEL],
      author: { login: 'app/claude' },
      headRefName: 'feature/factory-add-x-1.1',
      ...pr,
    }),
    feedback: () => {
      calls.feedback += 1;
      return {
        headCommittedAt: '2026-10-23T01:00:00Z',
        unresolvedThreads: [{ author: 'sentry', replies: [] }],
        reviews: [],
        ...report,
        checks: { pendingActions: [], fail: [], ...report.checks },
      };
    },
  };
}

test('changeFromLabels takes factory:<id>, skipping factory:run and unsafe ids', () => {
  assert.equal(changeFromLabels([{ name: 'factory:run' }, LABEL]), 'add-x');
  assert.equal(changeFromLabels(['factory:../etc']), '');
  assert.equal(changeFromLabels([{ name: 'bug' }]), '');
});

test('workflow_dispatch starts a task on a valid change id only', () => {
  assert.deepEqual(route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, deps()), {
    mode: 'task',
    change_id: 'add-x',
    reason: 'dispatched',
  });
  assert.equal(route('workflow_dispatch', { inputs: { change_id: 'A b' } }, deps()).mode, 'none');
});

test('a change id longer than 42 characters cannot be dispatched (label limit)', () => {
  const at = (n) => route('workflow_dispatch', { inputs: { change_id: 'a'.repeat(n) } }, deps());
  assert.equal(at(42).mode, 'task');
  assert.equal(at(43).mode, 'none');
  assert.match(at(43).reason, /43 characters; the limit is 42/);
});

test('a task on an archived or missing change routes to none', () => {
  const r = route('workflow_dispatch', { inputs: { change_id: 'gone' } }, deps());
  assert.equal(r.mode, 'none');
  assert.match(r.reason, /archived or missing/);
});

test('a merged factory PR starts the next task of its change', () => {
  const event = {
    action: 'closed',
    pull_request: { number: 7, merged: true, labels: [LABEL], user: APP },
  };
  assert.deepEqual(route('pull_request', event, deps()), {
    mode: 'task',
    change_id: 'add-x',
    reason: '#7 merged',
  });
});

test('closed-unmerged, unlabelled or owner-authored PRs start nothing', () => {
  const base = { number: 7, merged: true, labels: [LABEL], user: APP };
  const cases = [
    { ...base, merged: false },
    { ...base, labels: [] },
    { ...base, user: { login: 'jatwell93' } },
  ];
  for (const pr of cases)
    assert.equal(
      route('pull_request', { action: 'closed', pull_request: pr }, deps()).mode,
      'none',
    );
});

const OWNER_LOGIN = { login: 'jatwell93' };
const READY = { name: 'factory-ready' };
const planMerge = ({ labels = [LABEL, READY], mergedBy = OWNER_LOGIN } = {}) => ({
  action: 'closed',
  repository: { owner: OWNER_LOGIN },
  pull_request: { number: 8, merged: true, labels, user: OWNER_LOGIN, merged_by: mergedBy },
});

test('the owner merging a plan PR labelled factory-ready starts its change', () => {
  assert.deepEqual(route('pull_request', planMerge(), deps()), {
    mode: 'task',
    change_id: 'add-x',
    reason: 'plan #8 merged by the owner',
  });
  const byApp = planMerge();
  byApp.pull_request.user = { login: 'someone-else' };
  assert.equal(route('pull_request', byApp, deps()).mode, 'task', 'any author');
});

test('a plan PR starts nothing unless the owner merged it, labelled, with nothing running', () => {
  const byOther = route('pull_request', planMerge({ mergedBy: APP }), deps());
  assert.match(byOther.reason, /someone other than the owner/);
  const noMerger = route('pull_request', planMerge({ mergedBy: null }), deps());
  assert.match(noMerger.reason, /someone other than the owner/);
  const unready = route('pull_request', planMerge({ labels: [LABEL] }), deps());
  assert.match(unready.reason, /not a factory PR/);
  const noChange = route('pull_request', planMerge({ labels: [READY] }), deps());
  assert.match(noChange.reason, /not a factory PR/);
  const unmerged = planMerge();
  unmerged.pull_request.merged = false;
  assert.match(route('pull_request', unmerged, deps()).reason, /not a merge/);
  const running = route('pull_request', planMerge(), deps({ openPr: 9 }));
  assert.match(running.reason, /already running on #9/);
  assert.match(route('pull_request', planMerge(), deps({ parked: 703 })).reason, /waiting on/);
  const owner = route('pull_request', planMerge(), deps({ tasks: '- [ ] 1.1 (owner) Key\n' }));
  assert.equal(owner.mode, 'escalate');
});

test('a review on a factory PR with actionable items starts a babysit pass', () => {
  const d = deps();
  const r = route('pull_request_review', { pull_request: { number: 9 } }, d);
  assert.deepEqual(r, {
    mode: 'babysit',
    change_id: 'add-x',
    pr: 9,
    ref: 'feature/factory-add-x-1.1',
    reason: 'actionable',
  });
});

test('a dispatch relayed from a finished CI run babysits the PR it names', () => {
  const r = route('workflow_dispatch', { inputs: { pr: '11' } }, deps());
  assert.equal(r.mode, 'babysit');
  assert.equal(r.pr, 11);
  assert.equal(route('workflow_dispatch', { inputs: { pr: '11; x' } }, deps()).mode, 'none');
});

test('threads the factory already answered and reviews older than the head do not count', () => {
  const ev = { pull_request: { number: 9 } };
  const answered = deps({
    report: { unresolvedThreads: [{ author: 'jatwell93', replies: [{ author: 'claude' }] }] },
  });
  assert.equal(route('pull_request_review', ev, answered).reason, 'nothing actionable');
  const oldReview = deps({
    report: {
      unresolvedThreads: [],
      reviews: [{ actionable: true, submittedAt: '2026-10-23T00:30:00Z' }],
    },
  });
  assert.equal(route('pull_request_review', ev, oldReview).reason, 'nothing actionable');
  const freshReview = deps({
    report: {
      unresolvedThreads: [],
      reviews: [{ actionable: true, submittedAt: '2026-10-23T01:05:00Z' }],
    },
  });
  assert.equal(route('pull_request_review', ev, freshReview).mode, 'babysit');
  const failing = deps({ report: { unresolvedThreads: [], checks: { fail: ['Workers Tests'] } } });
  assert.equal(route('pull_request_review', ev, failing).mode, 'babysit');
});

test('babysit is skipped while Actions checks run, when nothing is actionable, or on needs-human', () => {
  const ev = { pull_request: { number: 9 } };
  assert.equal(
    route(
      'pull_request_review',
      ev,
      deps({ report: { checks: { pendingActions: ['Workers Tests'] } } }),
    ).reason,
    'Actions checks still running',
  );
  assert.equal(
    route('pull_request_review', ev, deps({ report: { unresolvedThreads: [] } })).reason,
    'nothing actionable',
  );
  const human = deps({ pr: { labels: [LABEL, { name: 'needs-human' }] } });
  assert.equal(route('pull_request_review', ev, human).reason, 'waiting on the owner');
  assert.equal(human.calls.feedback, 0, 'no feedback fetch once parked');
});

test('a label alone never routes the factory onto an owner PR', () => {
  const owner = deps({ pr: { author: { login: 'jatwell93' } } });
  assert.equal(route('pull_request_review', { pull_request: { number: 9 } }, owner).mode, 'none');
  const closed = deps({ pr: { state: 'MERGED' } });
  assert.equal(route('pull_request_review', { pull_request: { number: 9 } }, closed).mode, 'none');
});

test('toOutput prints one key=value line each, without newlines in values', () => {
  assert.equal(
    toOutput({ mode: 'none', reason: 'a\nb' }),
    'mode=none\nchange_id=\npr=\nref=\ntask=\nretry=\nper_change=\nreason=a b',
  );
});

const OWNER = { login: 'jatwell93' };
const unlabeled = ({ label = 'needs-human', sender = OWNER, labels = [LABEL] } = {}) => ({
  action: 'unlabeled',
  label: { name: label },
  sender,
  repository: { owner: OWNER },
  issue: { number: 703, labels },
});

test('every task route waits while the tracking issue has needs-human', () => {
  const parked = deps({ parked: 703 });
  const merged = {
    action: 'closed',
    pull_request: { number: 7, merged: true, labels: [LABEL], user: APP },
  };
  for (const [name, event] of [
    ['workflow_dispatch', { inputs: { change_id: 'add-x' } }],
    ['pull_request', merged],
  ]) {
    const r = route(name, event, parked);
    assert.equal(r.mode, 'none', name);
    assert.match(r.reason, /waiting on the owner: #703/);
  }
});

test('the owner removing needs-human from a tracking issue resumes the change', () => {
  assert.deepEqual(route('issues', unlabeled(), deps()), {
    mode: 'task',
    change_id: 'add-x',
    reason: '#703 resumed by the owner',
  });
});

test('only the owner can resume, and only by removing needs-human', () => {
  const byBot = route('issues', unlabeled({ sender: { login: 'claude[bot]' } }), deps());
  assert.equal(byBot.mode, 'none');
  assert.match(byBot.reason, /someone other than the owner/);
  assert.equal(route('issues', unlabeled({ label: 'bug' }), deps()).mode, 'none');
  assert.equal(route('issues', unlabeled({ labels: [{ name: 'bug' }] }), deps()).mode, 'none');
});

const labeled = ({ label = 'factory-ready', sender = OWNER, labels = [LABEL] } = {}) => ({
  ...unlabeled({ label, sender, labels }),
  action: 'labeled',
});

test('the owner adding factory-ready to a tracking issue starts the change', () => {
  assert.deepEqual(route('issues', labeled(), deps()), {
    mode: 'task',
    change_id: 'add-x',
    reason: '#703 marked ready by the owner',
  });
});

test('factory-ready starts nothing from anyone else, on another issue, or held', () => {
  const byBot = route('issues', labeled({ sender: { login: 'claude[bot]' } }), deps());
  assert.match(byBot.reason, /someone other than the owner/);
  assert.match(route('issues', labeled({ label: 'bug' }), deps()).reason, /not a factory-ready/);
  assert.match(
    route('issues', labeled({ labels: [{ name: 'bug' }] }), deps()).reason,
    /not a tracking issue/,
  );
  assert.match(route('issues', labeled(), deps({ parked: 703 })).reason, /waiting on the owner/);
  assert.match(route('issues', labeled(), deps({ retry: 703 })).reason, /waiting to retry/);
  assert.match(route('issues', labeled(), deps({ openPr: 9 })).reason, /already running on #9/);
  assert.equal(changeFromLabels([{ name: 'factory-ready' }, LABEL]), 'add-x');
});

test('factory-ready on an owner task escalates instead of starting Claude', () => {
  const r = route('issues', labeled(), deps({ tasks: '- [ ] 1.1 (owner) Rotate the key\n' }));
  assert.equal(r.mode, 'escalate');
});

test('a resume still waits if another needs-human issue holds the change', () => {
  assert.equal(route('issues', unlabeled(), deps({ parked: 704 })).mode, 'none');
});

test('changeTitle names a finished per-change PR after its change', () => {
  const name = 'Prove tickets to archive';
  const wip = 'WIP: docs(openspec): start the tickets proof file (factory-tickets-proof 1.1)';
  const id = 'factory-tickets-proof';
  assert.equal(
    changeTitle(wip, name, id),
    'docs(openspec): prove tickets to archive (factory-tickets-proof)',
  );
  assert.equal(
    changeTitle('feat: a', name, id),
    'feat: prove tickets to archive (factory-tickets-proof)',
  );
  assert.equal(
    changeTitle('feat(x)!: a', name, id),
    'feat(x)!: prove tickets to archive (factory-tickets-proof)',
  );
  assert.equal(changeTitle('WIP: feat: a', 'Add x', id), 'feat: add x (factory-tickets-proof)');
  assert.equal(changeTitle('feat: a', 'API keys', id), 'feat: API keys (factory-tickets-proof)');
});

test('changeTitle only drops WIP: without a prefix or a name', () => {
  assert.equal(changeTitle('WIP: Start the proof', 'Prove tickets', 'p'), 'Start the proof');
  assert.equal(changeTitle('WIP: docs(x): start', '', 'p'), 'docs(x): start');
});

test('firstOpenTask gives the first unchecked task and its (owner) marker', () => {
  const md = '- [x] 1.1 Done\n  - [ ] note\n- [ ] 1.2 (owner) Rotate the key\n- [ ] 1.3 Next\n';
  assert.deepEqual(nextTask(md), { number: '1.2', text: 'Rotate the key', owner: true });
  assert.deepEqual(nextTask('- [ ] 5.3a Check drafts\n'), {
    number: '5.3a',
    text: 'Check drafts',
    owner: false,
  });
  assert.equal(nextTask('- [ ] 5.1 `(owner)` marker\n').owner, false, 'a quoted marker is prose');
  assert.equal(nextTask('- [x] 1.1 Done\n'), null);
  assert.equal(nextTask('- [ ] ../x (owner) bad number\n'), null);
});

// A project that renames the labels, the prefix and the id limit.
const CUSTOM = loadConfig(
  tempRoot(
    {},
    {
      extraConfig: [
        'change_id_max_length: 20',
        'labels:',
        '  change_prefix: "bot-"',
        '  ready: go',
        '  needs_human: stuck',
        '  retry: again',
        '  retrying: again-now',
      ],
    },
  ),
);
const custom = createRouter(CUSTOM);

test('the project config sets the change prefix, and a state label is never a change id', () => {
  assert.equal(custom.changeFromLabels([{ name: 'bot-add-x' }]), 'add-x');
  assert.equal(custom.changeFromLabels([{ name: 'factory:add-x' }]), '');
  // With a prefix that every state label also starts with, they must not read as ids.
  const dash = createRouter({
    ...config,
    labels: { ...config.labels, change_prefix: 'factory-' },
  });
  for (const state of ['factory-ready', 'factory-retry', 'factory-retrying', 'factory-digest']) {
    assert.equal(dash.changeFromLabels([state]), '', state);
  }
  assert.equal(dash.changeFromLabels(['factory-run']), '');
  assert.equal(dash.changeFromLabels(['factory-add-x']), 'add-x');
});

test('the id limit is the config limit, within the label cap', () => {
  assert.match(custom.factoryIdProblem('a'.repeat(21)), /limit is 20/);
  assert.equal(custom.factoryIdProblem('a'.repeat(20)), '');
  // A long prefix leaves fewer than the configured 42.
  const long = createRouter({
    ...config,
    labels: { ...config.labels, change_prefix: 'x'.repeat(20) },
  });
  assert.match(long.factoryIdProblem('a'.repeat(31)), /limit is 30/);
});

test('renamed labels drive resume, ready, hold and retry', () => {
  const issue = (action, label, sender = OWNER) => ({
    action,
    label: { name: label },
    sender,
    repository: { owner: OWNER },
    issue: { number: 703, labels: [{ name: 'bot-add-x' }] },
  });
  assert.equal(custom.route('issues', issue('unlabeled', 'stuck'), deps()).mode, 'task');
  assert.equal(custom.route('issues', issue('unlabeled', 'needs-human'), deps()).mode, 'none');
  assert.equal(custom.route('issues', issue('labeled', 'go'), deps()).mode, 'task');
  assert.equal(custom.route('issues', issue('labeled', 'factory-ready'), deps()).mode, 'none');
  const held = custom.route(
    'workflow_dispatch',
    { inputs: { change_id: 'add-x' } },
    deps({ parked: 5 }),
  );
  assert.match(held.reason, /#5 has stuck/);
  const waiting = deps({ retry: 6 });
  const again = custom.route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, waiting);
  assert.match(again.reason, /#6 has again/);
  // A PR parked by hand carries the renamed label.
  const parkedPr = deps({ pr: { labels: [{ name: 'bot-add-x' }, { name: 'stuck' }] } });
  assert.equal(
    custom.route('pull_request_review', REVIEW, parkedPr).reason,
    'waiting on the owner',
  );
  // A retry candidate beside the renamed needs-human label is skipped.
  const candidate = {
    number: 9,
    labels: [{ name: 'bot-add-x' }, { name: 'again' }, { name: 'stuck' }],
    labelledAt: '2026-10-26T10:00:00Z',
  };
  assert.equal(
    custom.route('schedule', {}, deps({ candidates: [candidate] })).reason,
    'no retry due',
  );
});

test('a plan PR needs the renamed ready label', () => {
  const plan = (labelNames) => ({
    ...planMerge(),
    pull_request: { ...planMerge().pull_request, labels: labelNames.map((name) => ({ name })) },
  });
  assert.equal(custom.route('pull_request', plan(['bot-add-x', 'go']), deps()).mode, 'task');
  assert.match(
    custom.route('pull_request', plan(['bot-add-x', 'factory-ready']), deps()).reason,
    /not a factory PR/,
  );
});

const OWNER_NEXT = '- [x] 2.1 Add the API\n- [ ] 2.2 (owner) Rotate the vendor key\n';

test('an (owner) next task escalates from the router on dispatch, merge and resume', () => {
  const owner = deps({ tasks: OWNER_NEXT });
  const merged = {
    action: 'closed',
    pull_request: { number: 7, merged: true, labels: [LABEL], user: APP },
  };
  for (const [name, event] of [
    ['workflow_dispatch', { inputs: { change_id: 'add-x' } }],
    ['pull_request', merged],
    ['issues', unlabeled()],
  ]) {
    assert.deepEqual(route(name, event, owner), {
      mode: 'escalate',
      change_id: 'add-x',
      task: '2.2',
      reason: 'task 2.2 is an owner task',
    });
  }
});

test('once the owner ticks the owner task, a resume starts the next task', () => {
  const ticked = deps({
    tasks: OWNER_NEXT.replace('- [ ] 2.2', '- [x] 2.2') + '- [ ] 2.3 Use it\n',
  });
  assert.equal(route('issues', unlabeled(), ticked).mode, 'task');
});

test('a held change waits before its owner task is escalated again', () => {
  const held = deps({ tasks: OWNER_NEXT, parked: 703 });
  assert.equal(route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, held).mode, 'none');
});

const RETRY_ISSUE = (labelledAt, extra = []) => ({
  number: 714,
  labels: [LABEL, { name: 'factory-retry' }, ...extra],
  labelledAt,
});

test('the hourly schedule retries a failed task once its label is over an hour old', () => {
  const d = deps({ candidates: [RETRY_ISSUE('2026-10-26T10:30:00Z')] });
  assert.deepEqual(route('schedule', {}, d), {
    mode: 'task',
    change_id: 'add-x',
    reason: 'retry from #714',
    retry: 714,
  });
  assert.deepEqual(d.calls.startRetry, [714], 'factory-retry swapped for factory-retrying');
  const finished = '- [x] 1.1 Do it\n';
  const archive = deps({ candidates: [RETRY_ISSUE('2026-10-26T10:30:00Z')], tasks: finished });
  assert.equal(route('schedule', {}, archive).mode, 'archive', 'a failed archive run retries');
  assert.equal(route('schedule', {}, archive).retry, 714);
  assert.equal(
    route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, deps()).retry,
    undefined,
  );
});

test('a fresh retry label, or one beside needs-human, starts nothing', () => {
  for (const issue of [
    RETRY_ISSUE('2026-10-26T11:40:00Z'),
    RETRY_ISSUE('2026-10-26T10:00:00Z', [{ name: 'needs-human' }]),
  ]) {
    const d = deps({ candidates: [issue] });
    assert.equal(route('schedule', {}, d).reason, 'no retry due');
    assert.deepEqual(d.calls.startRetry, []);
  }
  assert.equal(route('schedule', {}, deps()).mode, 'none', 'no candidates');
});

test('labels change only after the retry route is decided', () => {
  const due = [RETRY_ISSUE('2026-10-26T10:30:00Z')];
  // The issue's own factory-retry label does not hold its retry.
  const held = deps({ candidates: due, retry: 714 });
  assert.equal(route('schedule', {}, held).mode, 'task');
  assert.deepEqual(held.calls.startRetry, [714]);

  // Checks still running: keep factory-retry, try again next hour.
  const pending = deps({
    candidates: due,
    openPr: 9,
    report: { checks: { pendingActions: ['Workers Tests'] } },
  });
  assert.match(route('schedule', {}, pending).reason, /retry from #714 waits/);
  assert.deepEqual([pending.calls.startRetry, pending.calls.dropRetry], [[], []]);

  // Nothing to retry: drop the label, never leave factory-retrying behind.
  const idle = deps({ candidates: due, openPr: 9, report: { unresolvedThreads: [] } });
  assert.match(route('schedule', {}, idle).reason, /not needed: nothing actionable/);
  assert.deepEqual([idle.calls.startRetry, idle.calls.dropRetry], [[], [714]]);

  // The next task is the owner's: drop the label and escalate.
  const owner = deps({ candidates: due, tasks: OWNER_NEXT });
  assert.equal(route('schedule', {}, owner).mode, 'escalate');
  assert.deepEqual([owner.calls.startRetry, owner.calls.dropRetry], [[], [714]]);
});

test('a retry on a change with an open factory PR is a babysit pass', () => {
  const d = deps({ candidates: [RETRY_ISSUE('2026-10-26T10:30:00Z')], openPr: 9 });
  const r = route('schedule', {}, d);
  assert.equal(r.mode, 'babysit');
  assert.equal(r.pr, 9);
});

test('no Claude run starts on any route while the tracking issue has factory-retry', () => {
  const waiting = deps({ retry: 714 });
  const merged = {
    action: 'closed',
    pull_request: { number: 7, merged: true, labels: [LABEL], user: APP },
  };
  for (const [name, event] of [
    ['workflow_dispatch', { inputs: { change_id: 'add-x' } }],
    ['pull_request', merged],
    ['pull_request_review', { pull_request: { number: 9 } }],
    ['pull_request_review_comment', { pull_request: { number: 9 } }],
    ['workflow_dispatch', { inputs: { pr: '9' } }],
  ]) {
    const r = route(name, event, waiting);
    assert.equal(r.mode, 'none', name);
    assert.match(r.reason, /waiting to retry: #714 has factory-retry/);
  }
  assert.equal(waiting.calls.feedback, 0, 'no feedback fetch while waiting');
});

test('a babysit route waits while the tracking issue has needs-human', () => {
  const r = route('pull_request_review', { pull_request: { number: 9 } }, deps({ parked: 703 }));
  assert.match(r.reason, /waiting on the owner: #703/);
});

// One PR per change (factory-per-change-pr, task 1.2).
const SETTLED = { settled: true, waitingOn: [], unresolvedThreads: [] };
const WIP = { title: 'WIP: feat(x): add x', headRefName: 'feature/factory-add-x' };
const perChange = (opts = {}) =>
  deps({ perChange: true, report: SETTLED, ...opts, pr: { ...WIP, ...opts.pr } });
const REVIEW = { pull_request: { number: 9 } };
const QUIET = { settled: false, waitingOn: ['quiet window'], unresolvedThreads: [] };
const DONE = '- [x] 1.1 Do it\n- [x] 1.2 (owner) Rotate the key\n';

const PER_CHANGE_MERGE = {
  action: 'closed',
  pull_request: { number: 7, merged: true, labels: [LABEL], user: APP },
};

test('a merged archive PR starts nothing: the change is archived on main', () => {
  const r = route('pull_request', PER_CHANGE_MERGE, perChange({ tasks: DONE, exists: false }));
  assert.equal(r.mode, 'none');
  assert.match(r.reason, /archived or missing/);
});

test('a per-change PR merged with every task done but not archived starts an archive PR', () => {
  const r = route('pull_request', PER_CHANGE_MERGE, perChange({ tasks: DONE }));
  assert.deepEqual(r, {
    mode: 'archive',
    change_id: 'add-x',
    reason: 'every task of add-x is done',
  });
});

test('a per-task change with every task done on main archives once, on one PR', () => {
  const merged = route('pull_request', PER_CHANGE_MERGE, deps({ tasks: DONE }));
  assert.deepEqual(merged, {
    mode: 'archive',
    change_id: 'add-x',
    reason: 'every task of add-x is done',
  });
  const dispatched = route(
    'workflow_dispatch',
    { inputs: { change_id: 'add-x' } },
    deps({ tasks: DONE }),
  );
  assert.equal(dispatched.mode, 'archive');
  const running = route('pull_request', PER_CHANGE_MERGE, deps({ tasks: DONE, openPr: 12 }));
  assert.match(running.reason, /already running on #12/);
  const held = route('pull_request', PER_CHANGE_MERGE, deps({ tasks: DONE, parked: 703 }));
  assert.match(held.reason, /waiting on the owner/);
  const archived = route('pull_request', PER_CHANGE_MERGE, deps({ tasks: DONE, exists: false }));
  assert.match(archived.reason, /archived or missing/);
});

test('a per-change PR merged with a task left opens a new per-change PR for it', () => {
  // #733: the owner merged a WIP: PR after 1.1; 1.2 must not stall.
  const r = route(
    'pull_request',
    PER_CHANGE_MERGE,
    perChange({ tasks: '- [x] 1.1 Do it\n- [ ] 1.2 Next\n' }),
  );
  assert.equal(r.mode, 'task');
  assert.equal(r.per_change, true);
  assert.match(r.reason, /#7 merged/);
});

test('an actionable per-change PR gets a babysit pass in the change group', () => {
  const thread = { author: 'sentry', replies: [] };
  const d = perChange({ report: { ...SETTLED, unresolvedThreads: [thread] } });
  assert.deepEqual(route('pull_request_review', REVIEW, d), {
    mode: 'babysit',
    change_id: 'add-x',
    pr: 9,
    ref: 'feature/factory-add-x',
    per_change: true,
    reason: 'actionable',
  });
  assert.deepEqual(d.calls.branchTask, [], 'babysit first, the next task waits');
});

test('a waiting per-change PR starts nothing and reads no task list', () => {
  const quiet = perChange({ report: QUIET });
  assert.equal(route('pull_request_review', REVIEW, quiet).reason, 'waiting on quiet window');
  const running = perChange({
    report: { ...SETTLED, checks: { pendingActions: ['Workers Test'] } },
  });
  assert.equal(
    route('pull_request_review', REVIEW, running).reason,
    'Actions checks still running',
  );
  assert.deepEqual([quiet.calls.branchTask, running.calls.branchTask], [[], []]);
});

test("a settled per-change PR gets the next task from its branch's tasks.md", () => {
  const d = perChange();
  assert.deepEqual(route('workflow_dispatch', { inputs: { pr: '9' } }, d), {
    mode: 'task',
    change_id: 'add-x',
    pr: 9,
    ref: 'feature/factory-add-x',
    per_change: true,
    task: '1.2',
    reason: 'task 1.2 on #9',
  });
  assert.deepEqual(d.calls.branchTask, [['add-x', 'feature/factory-add-x']]);
});

test("an (owner) next task on a per-change PR escalates with the PR's branch", () => {
  const d = perChange({ branchTasks: '- [x] 1.1 Do it\n- [ ] 1.2 (owner) Rotate the key\n' });
  assert.deepEqual(route('pull_request_review', REVIEW, d), {
    mode: 'escalate',
    change_id: 'add-x',
    task: '1.2',
    ref: 'feature/factory-add-x',
    per_change: true,
    reason: 'task 1.2 is an owner task',
  });
});

test('a per-change PR with no task left gets an archive run on the PR, not marked ready', () => {
  // The last task was an (owner) task the owner ticked on the branch.
  const d = perChange({ branchTasks: DONE });
  assert.deepEqual(route('pull_request_review', REVIEW, d), {
    mode: 'archive',
    change_id: 'add-x',
    pr: 9,
    ref: 'feature/factory-add-x',
    per_change: true,
    reason: 'archive add-x on #9',
  });
  assert.deepEqual(d.calls.markReady, []);
});

test('an archived per-change PR is marked ready once, then left for the merge', () => {
  // The archived branch has no openspec/changes/<id>/tasks.md: never read it.
  const archived = (opts = {}) => {
    const d = perChange({ archived: true, ...opts });
    d.branchTask = () => {
      throw new Error('HTTP 404: Not Found');
    };
    return d;
  };
  const wip = archived();
  assert.equal(route('pull_request_review', REVIEW, wip).reason, '#9 marked ready for the owner');
  assert.deepEqual(wip.calls.markReady, [9]);
  assert.deepEqual(wip.calls.readyIds, ['add-x'], 'the change id names the PR title');

  const draft = archived({ pr: { title: 'feat(x): add x', isDraft: true } });
  route('pull_request_review', REVIEW, draft);
  assert.deepEqual(draft.calls.markReady, [9], 'a draft counts as unfinished too');

  const ready = archived({ pr: { title: 'feat(x): add x' } });
  const r = route('pull_request_review', REVIEW, ready);
  assert.match(r.reason, /finished: waiting for the owner's merge/);
  assert.deepEqual(ready.calls.markReady, []);
});

test('dispatch and resume continue an open per-change PR; without one, the first task starts', () => {
  const open = perChange({ openPr: 9 });
  assert.equal(route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, open).task, '1.2');
  assert.equal(route('issues', unlabeled(), open).pr, 9);
  // The first task is marked per_change, so its prompt says to open the WIP: PR.
  assert.deepEqual(route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, perChange()), {
    mode: 'task',
    change_id: 'add-x',
    per_change: true,
    reason: 'dispatched',
  });
  assert.equal(route('issues', unlabeled(), perChange()).per_change, true);
  const ownerFirst = perChange({ tasks: '- [ ] 1.1 (owner) Rotate the key\n' });
  const r = route('workflow_dispatch', { inputs: { change_id: 'add-x' } }, ownerFirst);
  assert.deepEqual([r.mode, r.per_change], ['escalate', true]);
});

test('a per-change PR is held by its tracking issue and by a needs-human added to the PR', () => {
  const parked = perChange({ parked: 703 });
  assert.match(route('pull_request_review', REVIEW, parked).reason, /waiting on the owner: #703/);
  const retry = perChange({ retry: 714 });
  assert.match(route('pull_request_review', REVIEW, retry).reason, /factory-retry/);
  const byHand = perChange({ pr: { labels: [LABEL, { name: 'needs-human' }] } });
  assert.equal(route('pull_request_review', REVIEW, byHand).reason, 'waiting on the owner');
  for (const d of [parked, retry, byHand]) assert.equal(d.calls.feedback, 0);
});

test('a retry on a waiting per-change PR keeps factory-retry for the next hour', () => {
  const d = perChange({
    candidates: [RETRY_ISSUE('2026-10-26T10:30:00Z')],
    openPr: 9,
    report: QUIET,
  });
  assert.match(route('schedule', {}, d).reason, /retry from #714 waits/);
  assert.deepEqual([d.calls.startRetry, d.calls.dropRetry], [[], []]);
});
