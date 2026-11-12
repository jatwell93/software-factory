// Static checks on the reusable runner workflow and its caller. The runner is the
// one workflow that checks out a PR branch and holds a secret, so these pin what
// keeps that safe: where the settings come from, what the agent can reach, and
// which jobs may write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { loadConfig } = require('../lib/config.js');
const { renderCaller } = require('../lib/callers.js');
const { tempRoot } = require('./helpers.js');

const FILE = path.join(__dirname, '..', '.github', 'workflows', 'factory.yml');
const TEXT = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = YAML.parse(TEXT);
const REF = 'b'.repeat(40);
const config = loadConfig(tempRoot());
const CALLER = YAML.parse(renderCaller('factory.yml', { factoryRef: REF, config }));
const { route, sweep, run, escalate, report } = WORKFLOW.jobs;

const stepNames = (job) => job.steps.map((s) => s.name);
const indexOfStep = (job, text) => job.steps.findIndex((s) => (s.name || '').includes(text));
const runText = (job) => job.steps.map((s) => s.run || '').join('\n');

test('the only secrets are the Claude token and the job token, declared and passed by name', () => {
  const used = [...new Set([...TEXT.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
  assert.deepEqual(used.sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN']);
  assert.deepEqual(Object.keys(WORKFLOW.on.workflow_call.secrets), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.equal(WORKFLOW.on.workflow_call.secrets.CLAUDE_CODE_OAUTH_TOKEN.required, true);
  const job = CALLER.jobs.factory;
  assert.deepEqual(Object.keys(job.secrets), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.notEqual(job.secrets, 'inherit');
  assert.doesNotMatch(TEXT, /PROD_|NEON_|DOPPLER|STRIPE_|CLOUDFLARE_/);
});

test('the Claude token reaches only the one step that runs the agent', () => {
  const holders = Object.values(WORKFLOW.jobs)
    .flatMap((job) => job.steps)
    .filter((s) => JSON.stringify(s).includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(holders.length, 1);
  assert.match(holders[0].uses, /^anthropics\/claude-code-action@/);
});

test('top-level permissions are exactly what the run needs, and only the sweep raises its own', () => {
  assert.deepEqual(WORKFLOW.permissions, {
    contents: 'write',
    'pull-requests': 'write',
    issues: 'write',
    'id-token': 'write',
    actions: 'read',
    checks: 'read',
    statuses: 'read',
  });
  const own = Object.entries(WORKFLOW.jobs).filter(([, job]) => job.permissions);
  assert.deepEqual(
    own.map(([name]) => name),
    ['sweep'],
  );
  assert.deepEqual(sweep.permissions, {
    contents: 'read',
    'pull-requests': 'write',
    issues: 'read',
    actions: 'write',
    checks: 'read',
    statuses: 'read',
  });
});

test('the caller grants the most any job needs, and no more', () => {
  assert.deepEqual(CALLER.permissions, {
    contents: 'write',
    'pull-requests': 'write',
    issues: 'write',
    'id-token': 'write',
    actions: 'write',
    checks: 'read',
    statuses: 'read',
  });
});

test('the caller carries every trigger the router handles', () => {
  const on = CALLER.on;
  assert.deepEqual(Object.keys(on).sort(), [
    'issues',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'schedule',
    'workflow_dispatch',
  ]);
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ['change_id', 'pr']);
  assert.deepEqual(on.pull_request.types, ['closed']);
  assert.deepEqual(on.issues.types, ['labeled', 'unlabeled']);
  assert.equal(on.schedule.length, 1);
});

test('the route job reads the settings once, from the default branch, and the others take them', () => {
  assert.equal(
    route.steps.find((s) => s.id === 'env').run,
    'node .software-factory/scripts/factory-env.js --run >> "$GITHUB_OUTPUT"',
  );
  for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
    if (name !== 'route') assert.doesNotMatch(runText(job), /factory-env/, name);
  }
  const first = route.steps[0];
  assert.equal(first.with.ref, '${{ github.event.repository.default_branch }}');
  for (const key of [
    'node_version',
    'install',
    'default_branch',
    'rules',
    'allowed_bots',
    'step_timeout',
    'job_timeout',
    'claude_args',
  ]) {
    assert.equal(route.outputs[key], `\${{ steps.env.outputs.${key} }}`, key);
  }
});

test('the agent step takes its arguments, bots and timeout from the route job, not the PR branch', () => {
  const claude = run.steps.find((s) => /claude-code-action/.test(s.uses));
  assert.equal(claude.with.claude_args, '${{ needs.route.outputs.claude_args }}');
  assert.equal(claude.with.allowed_bots, '${{ needs.route.outputs.allowed_bots }}');
  assert.equal(claude['timeout-minutes'], '${{ fromJSON(needs.route.outputs.step_timeout) }}');
  assert.equal(run['timeout-minutes'], '${{ fromJSON(needs.route.outputs.job_timeout) }}');
  assert.equal(claude.env.CLAUDE_CODE_RETRY_WATCHDOG, '1');
  assert.equal(claude.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, '600000');
  assert.doesNotMatch(TEXT, /--max-budget-usd|--allowedTools|--disallowedTools/);
});

test('in the run job the rules and config are restored before anything reads them', () => {
  const restore = indexOfStep(run, "default branch's copy of the project's rules");
  const merge = indexOfStep(run, 'Merge the default branch');
  const factory = indexOfStep(run, 'Checkout the factory');
  const check = indexOfStep(run, 'Check the change exists');
  const install = indexOfStep(run, "Install the project's dependencies");
  const agent = run.steps.findIndex((s) => /claude-code-action/.test(s.uses));
  assert.deepEqual(
    [0, merge, restore, factory, check, install, agent].every((v, i, a) => i === 0 || v > a[i - 1]),
    true,
    stepNames(run).join(' | '),
  );
  const step = run.steps[restore];
  assert.equal(step.env.RULES, '${{ needs.route.outputs.rules }}');
  assert.match(step.run, /git ls-tree --name-only "origin\/\$DEFAULT_BRANCH" -- \$RULES/);
  assert.match(step.run, /update-index --skip-worktree/);
  assert.match(step.run, /\.git\/info\/exclude/);
});

test('the factory runs from outside the working tree in the run job, inside it in the others', () => {
  const move = run.steps[indexOfStep(run, 'move it out of the working tree')];
  assert.match(move.run, /mv \.software-factory "\$RUNNER_TEMP\/software-factory"/);
  assert.match(move.run, /echo "FACTORY_DIR=\$RUNNER_TEMP\/software-factory" >> "\$GITHUB_ENV"/);
  assert.match(runText(run), /node "\$FACTORY_DIR\/scripts\/factory-check-change\.js"/);
  assert.doesNotMatch(runText(run), /node \.software-factory/, 'no copy the agent could edit');
  assert.match(runText(run), /npm ci --omit=dev --prefix \.software-factory/);
  for (const job of [route, sweep, escalate, report]) {
    for (const m of runText(job).matchAll(/node (\S+)/g)) {
      assert.match(m[1], /^\.software-factory\/scripts\//, m[1]);
    }
  }
});

test('every factory checkout is at the pin, into .software-factory, without credentials', () => {
  const checkouts = Object.values(WORKFLOW.jobs)
    .flatMap((job) => job.steps)
    .filter((s) => /^actions\/checkout@/.test(s.uses) && s.with.repository);
  assert.equal(checkouts.length, 5);
  for (const step of checkouts) {
    assert.equal(step.with.repository, 'jatwell93/software-factory');
    assert.equal(step.with.ref, '${{ inputs.factory_ref }}');
    assert.equal(step.with.path, '.software-factory');
    assert.equal(step.with['persist-credentials'], false);
  }
});

test('the jobs that run no agent check out the default branch, never the PR', () => {
  for (const job of [route, sweep, escalate, report]) {
    const own = job.steps.find((s) => /^actions\/checkout@/.test(s.uses) && !s.with.repository);
    assert.match(own.with.ref, /default_branch/);
    assert.equal(own.with['persist-credentials'], false);
  }
  const code = run.steps[0];
  assert.equal(code.with.ref, '${{ needs.route.outputs.ref }}');
  assert.equal(code.with['fetch-depth'], 0);
});

test('the sweep is its own job after the router, so its failure skips no run', () => {
  assert.equal(sweep.needs, 'route');
  assert.equal(sweep.if, "github.event_name == 'schedule'");
  assert.match(runText(sweep), /factory-sweep\.js/);
  assert.doesNotMatch(JSON.stringify(sweep), /claude-code-action|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.doesNotMatch(runText(route), /factory-sweep/, 'not a step of the route job');
  assert.doesNotMatch(JSON.stringify(run.needs), /sweep/, 'run never waits on it');
});

test('a task or archive run on a per-change PR merges the default branch first, unless it changed .github', () => {
  const merge = run.steps[indexOfStep(run, 'Merge the default branch')];
  assert.match(
    merge.if,
    /\(needs\.route\.outputs\.mode == 'task' \|\| needs\.route\.outputs\.mode == 'archive'\) && needs\.route\.outputs\.pr != ''/,
  );
  assert.match(
    merge.run,
    /git diff --name-only "HEAD\.\.\.origin\/\$DEFAULT_BRANCH" \| grep -q '\^\[\.\]github\/'/,
  );
  assert.match(merge.run, /merge --no-edit "origin\/\$DEFAULT_BRANCH"; then\n\s+git merge --abort/);
  assert.match(TEXT, /steps\.base\.outputs\.note/, 'the prompt says when the base is older');
});

test('the first task of a per-change change is told to open the PR', () => {
  assert.match(
    TEXT,
    /needs\.route\.outputs\.per_change == 'true' && needs\.route\.outputs\.pr == '' && 'The change runs as one PR/,
  );
});

test('an owner task on a per-change PR is escalated from its branch, a per-task one from the default', () => {
  const step = escalate.steps.at(-1);
  assert.equal(
    step.env.REF,
    "${{ needs.route.outputs.per_change == 'true' && needs.route.outputs.ref || '' }}",
  );
  assert.match(step.run, /factory-escalate\.js "\$CHANGE_ID" "\$TASK" \$\{REF:\+"\$REF"\}/);
  assert.equal(escalate.if, "needs.route.outputs.mode == 'escalate'");
});

test('the report job records only a finished run, and only the retry clears the retrying label', () => {
  assert.equal(
    report.if,
    "always() && (needs.run.result == 'failure' || needs.run.result == 'success')",
  );
  assert.deepEqual(report.needs, ['route', 'run']);
  const step = report.steps.at(-1);
  assert.equal(step.env.RETRY, '${{ needs.route.outputs.retry }}');
  assert.match(step.run, /if \[ "\$RESULT" = failure \]/);
  assert.match(step.run, /elif \[ -n "\$RETRY" \]/);
});

test('no project, product or branch name is wired into the runner', () => {
  assert.doesNotMatch(
    TEXT,
    /origin\/main|refs\/heads\/main|--ref main|openspec|Doppler|Neon|Cloudflare/i,
  );
  assert.doesNotMatch(TEXT, /jatwell93\/(?!software-factory)/);
});

test('no run script has a ${{ }} expression: values reach scripts through env', () => {
  for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
    for (const step of job.steps) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${name}: ${step.name}`);
    }
  }
});

test('the project install command runs through bash from an env var, not the script text', () => {
  const step = run.steps[indexOfStep(run, "Install the project's dependencies")];
  assert.equal(step.env.INSTALL, '${{ needs.route.outputs.install }}');
  assert.equal(step.run, 'bash -c "$INSTALL"');
});

test('the caller passes the pin as the ref and the input, and only the Claude secret', () => {
  const job = CALLER.jobs.factory;
  assert.equal(job.uses, `jatwell93/software-factory/.github/workflows/factory.yml@${REF}`);
  assert.deepEqual(job.with, { factory_ref: REF });
});
