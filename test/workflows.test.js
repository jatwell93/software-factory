// Static checks on the reusable workflows and the caller templates. They cannot
// run a workflow, so they pin the properties that keep the factory safe and the
// callers wired to what they call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { loadConfig } = require('../lib/config.js');
const { CALLERS, FACTORY_REF, renderCaller } = require('../lib/callers.js');
const { tempRoot } = require('./helpers.js');

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');
const REF = 'a'.repeat(40);
const REUSABLE = CALLERS;
const ciConfig = (...names) =>
  loadConfig(
    tempRoot(
      {},
      { extraConfig: ['ci_workflows:', ...names.map((n) => `  - ${JSON.stringify(n)}`)] },
    ),
  );
const config = ciConfig('Workers Test', 'Frontend Test & Coverage', "It's (real)");

const readReusable = (name) =>
  YAML.parse(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n'));
const caller = (name) => YAML.parse(renderCaller(name, { factoryRef: REF, config }));
const steps = (workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps || []);

test('every caller template has a reusable workflow of the same name', () => {
  for (const name of CALLERS) {
    assert.ok(fs.existsSync(path.join(WORKFLOWS, name)), name);
    assert.deepEqual(
      Object.keys(readReusable(name).on),
      ['workflow_call'],
      `${name} only callable`,
    );
  }
});

test('a caller uses its reusable workflow at the pin and passes what it asks for', () => {
  for (const name of CALLERS) {
    const [job] = Object.values(caller(name).jobs);
    assert.equal(job.uses, `jatwell93/software-factory/.github/workflows/${name}@${REF}`);
    const inputs = readReusable(name).on.workflow_call.inputs || {};
    const given = Object.keys(job.with || {});
    for (const key of given) assert.ok(key in inputs, `${name}: ${key} is a declared input`);
    for (const [key, spec] of Object.entries(inputs)) {
      if (spec.required) assert.ok(given.includes(key), `${name}: required ${key} is passed`);
    }
    if ('factory_ref' in inputs) assert.equal(job.with.factory_ref, REF);
  }
});

test('a caller grants at least the permissions its reusable workflow declares', () => {
  const rank = { none: 0, read: 1, write: 2 };
  for (const name of CALLERS) {
    const granted = caller(name).permissions;
    for (const [scope, level] of Object.entries(readReusable(name).permissions)) {
      assert.ok(rank[granted[scope]] >= rank[level], `${name}: ${scope}: ${level}`);
    }
  }
});

test('no workflow uses a secret but the job token', () => {
  for (const name of REUSABLE) {
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    const used = [...new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
    assert.deepEqual(used, ['GITHUB_TOKEN'], name);
  }
});

test('no run script has a ${{ }} expression: event data goes through env', () => {
  for (const name of REUSABLE) {
    for (const step of steps(readReusable(name))) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, `${name}: ${step.name}`);
    }
  }
});

test('every checkout takes the default branch or the factory at its pin, never the PR head', () => {
  for (const name of REUSABLE) {
    const checkouts = steps(readReusable(name)).filter((s) => /^actions\/checkout@/.test(s.uses));
    // The relay checks nothing out at all (its own test pins that).
    if (name !== 'factory-ci-relay.yml') assert.ok(checkouts.length >= 1, name);
    for (const step of checkouts) {
      const ref = step.with.ref;
      const own = ref === '${{ github.event.repository.default_branch }}';
      const factory = step.with.repository === 'jatwell93/software-factory';
      assert.ok(own || factory, `${name}: ${step.name}`);
      if (factory) {
        assert.equal(ref, '${{ inputs.factory_ref }}', `${name}: pinned`);
        assert.equal(step.with.path, '.software-factory');
      }
      assert.equal(step.with['persist-credentials'], false, `${name}: ${step.name}`);
      assert.doesNotMatch(JSON.stringify(step), /head_ref|head\.sha|head\.ref/, name);
    }
  }
});

test('a workflow that runs factory scripts checks out the project first, then the factory', () => {
  for (const name of ['no-go-guard.yml', 'factory-digest.yml', 'check-change-ids.yml']) {
    const uses = steps(readReusable(name)).filter((s) => /^actions\/checkout@/.test(s.uses));
    assert.equal(uses[0].with.repository, undefined, `${name}: the project first`);
    assert.equal(uses[1].with.repository, 'jatwell93/software-factory', name);
    const install = steps(readReusable(name)).find((s) => /npm ci/.test(s.run || ''));
    assert.match(install.run, /--omit=dev --prefix \.software-factory/, name);
    for (const step of steps(readReusable(name))) {
      for (const m of (step.run || '').matchAll(/node (\S+)/g)) {
        assert.match(m[1], /^\.software-factory\/scripts\//, `${name}: ${m[1]}`);
      }
    }
  }
});

test('the guard runs only for PR events or from the default branch, and posts the fixed status', () => {
  const guard = readReusable('no-go-guard.yml');
  const job = guard.jobs.guard;
  assert.match(job.if, /github\.event_name == 'pull_request_target'/);
  assert.match(job.if, /refs\/heads\/\{0\}', github\.event\.repository\.default_branch/);
  const text = fs.readFileSync(path.join(WORKFLOWS, 'no-go-guard.yml'), 'utf8');
  assert.match(text, /context=factory\/no-go-guard/);
  assert.match(text, /--change all --files/);
  assert.deepEqual(guard.permissions, {
    contents: 'read',
    'pull-requests': 'read',
    statuses: 'write',
  });
});

test('the guard and change-id callers trigger on pull_request_target, never pull_request', () => {
  for (const name of ['no-go-guard.yml', 'check-change-ids.yml']) {
    const on = caller(name).on;
    assert.ok('pull_request_target' in on, name);
    assert.ok(!('pull_request' in on), name);
  }
});

test("the relay dispatches the factory and guard workflows the caller names, defaulting to init's", () => {
  const relay = readReusable('factory-ci-relay.yml');
  const { inputs } = relay.on.workflow_call;
  assert.equal(inputs.factory_workflow.default, 'factory.yml');
  assert.equal(inputs.guard_workflow.default, 'no-go-guard.yml');
  const env = relay.jobs.relay.env;
  assert.equal(env.FACTORY_WORKFLOW, '${{ inputs.factory_workflow }}');
  assert.equal(env.GUARD_WORKFLOW, '${{ inputs.guard_workflow }}');
  const text = fs.readFileSync(path.join(WORKFLOWS, 'factory-ci-relay.yml'), 'utf8');
  assert.match(text, /--ref "\$DEFAULT_BRANCH"/);
  assert.doesNotMatch(text, /--ref main|actions\/checkout/);
});

test('the relay caller watches exactly the config ci_workflows, quoting each name', () => {
  assert.deepEqual(caller('factory-ci-relay.yml').on.workflow_run.workflows, [
    'Workers Test',
    'Frontend Test & Coverage',
    "It's (real)",
  ]);
  assert.deepEqual(caller('factory-ci-relay.yml').on.workflow_run.types, ['completed']);
});

test('the relay caller needs at least one CI workflow and no line break in a name', () => {
  assert.throws(
    () =>
      renderCaller('factory-ci-relay.yml', {
        factoryRef: REF,
        config: { ...config, ci_workflows: [] },
      }),
    /ci_workflows is empty/,
  );
  const odd = { ...config, ci_workflows: ['a\nb'] };
  assert.throws(
    () => renderCaller('factory-ci-relay.yml', { factoryRef: REF, config: odd }),
    /line break/,
  );
});

test('the digest reads Node settings from the config before it sets up Node', () => {
  const digest = readReusable('factory-digest.yml');
  const all = steps(digest);
  const read = all.findIndex((s) => s.id === 'env');
  const setup = all.findIndex((s) => /setup-node/.test(s.uses || ''));
  assert.ok(read !== -1 && read < setup);
  assert.equal(all[setup].with['node-version'], '${{ steps.env.outputs.node_version }}');
});

test('a pin must be a commit SHA or a v* tag, never a branch', () => {
  for (const ref of [REF, 'v1', 'v1.2.3', 'v2.0.0-rc.1']) {
    assert.ok(FACTORY_REF.test(ref), ref);
  }
  for (const ref of ['main', 'feature/x', 'a'.repeat(39), 'A'.repeat(40), 'v', 'v1 x', '']) {
    assert.ok(!FACTORY_REF.test(ref), ref);
    assert.throws(
      () => renderCaller('no-go-guard.yml', { factoryRef: ref, config }),
      /SHA or a v\* tag/,
    );
  }
});

test('an unknown caller name is refused, and no placeholder is left in a rendered caller', () => {
  assert.throws(() => renderCaller('nope.yml', { factoryRef: REF, config }), /no caller/);
  for (const name of CALLERS) {
    assert.doesNotMatch(renderCaller(name, { factoryRef: REF, config }), /__[A-Z_]+__/, name);
  }
});

test('each reusable workflow declares exactly the permissions it needs', () => {
  const expected = {
    'no-go-guard.yml': { contents: 'read', 'pull-requests': 'read', statuses: 'write' },
    'factory-ci-relay.yml': { actions: 'write', 'pull-requests': 'read', statuses: 'read' },
    'factory-digest.yml': {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'read',
      actions: 'read',
      checks: 'read',
      statuses: 'read',
    },
    'check-change-ids.yml': { contents: 'read', 'pull-requests': 'read', statuses: 'write' },
  };
  assert.deepEqual(Object.keys(expected).sort(), [...CALLERS].sort());
  for (const [name, permissions] of Object.entries(expected)) {
    assert.deepEqual(readReusable(name).permissions, permissions, name);
  }
});

test('a workflow that runs factory scripts requires the pin, so it cannot run an unpinned copy', () => {
  for (const name of ['no-go-guard.yml', 'factory-digest.yml', 'check-change-ids.yml']) {
    const input = readReusable(name).on.workflow_call.inputs.factory_ref;
    assert.equal(input.required, true, name);
    assert.equal(input.type, 'string', name);
  }
});

test('a pull_request_target workflow reports its result as a commit status on the PR head', () => {
  // A pull_request_target job's own check run attaches to the base commit, where
  // a required check is never looked up, so the PR would wait forever.
  for (const [name, context] of [
    ['no-go-guard.yml', 'factory/no-go-guard'],
    ['check-change-ids.yml', 'factory/change-ids'],
  ]) {
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    assert.ok(text.includes('repos/$REPO/statuses/$HEAD_SHA" -f state=success'), name);
    assert.ok(text.includes(`context=${context}`), name);
    assert.match(text, /-f state=failure/, name);
    assert.equal(
      readReusable(name).jobs[Object.keys(readReusable(name).jobs)[0]].env.HEAD_SHA,
      '${{ github.event.pull_request.head.sha }}',
      name,
    );
    assert.equal(readReusable(name).permissions.statuses, 'write', name);
  }
});
