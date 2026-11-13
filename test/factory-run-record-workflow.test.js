// The run job uploads a record and the digest downloads it. These pin the two
// ends to the same artifact and file name, and the steps to run whatever the agent did.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { RECORD_ARTIFACT, RECORD_FILE } = require('../lib/run-record.js');

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');
const read = (name) =>
  YAML.parse(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').replace(/\r\n/g, '\n'));
const run = read('factory.yml').jobs.run;
const step = (name) => run.steps.find((s) => (s.name || '').includes(name));

test('the agent step has an id so later steps can read its execution log', () => {
  const claude = run.steps.find((s) => /claude-code-action/.test(s.uses));
  assert.equal(claude.id, 'claude');
});

test('the record is written after the agent step, whatever it did, when the factory is set up', () => {
  const names = run.steps.map((s) => s.name);
  const agent = names.findIndex((n) => n === 'Run Claude');
  const record = names.findIndex((n) => (n || '').startsWith('Record the run'));
  const upload = names.findIndex((n) => (n || '').startsWith('Upload the run record'));
  assert.ok(agent < record && record < upload, names.join(' | '));
  for (const s of [run.steps[record], run.steps[upload]]) {
    assert.equal(s.if, "always() && env.FACTORY_DIR != ''");
  }
});

test('the record step passes the log, mode, change and PR through env, never into the script text', () => {
  const s = step('Record the run');
  assert.equal(s.env.EXECUTION_FILE, '${{ steps.claude.outputs.execution_file }}');
  assert.equal(s.env.MODE, '${{ needs.route.outputs.mode }}');
  assert.equal(s.env.CHANGE_ID, '${{ needs.route.outputs.change_id }}');
  assert.equal(s.env.PR, '${{ needs.route.outputs.pr }}');
  assert.doesNotMatch(s.run, /\$\{\{/);
  assert.match(s.run, /node "\$FACTORY_DIR\/scripts\/factory-run-record\.js"/);
  assert.match(s.run, new RegExp(`"\\$RUNNER_TEMP/${RECORD_FILE.replace('.', '\\.')}"`));
  assert.match(s.run, /\$\{PR:\+"\$PR"\} --execution "\$EXECUTION_FILE"/);
});

test('the upload uses the artifact name and file the digest downloads, and keeps it two weeks', () => {
  const s = step('Upload the run record');
  assert.match(s.uses, /^actions\/upload-artifact@/);
  assert.equal(s.with.name, RECORD_ARTIFACT);
  assert.equal(s.with.path, `\${{ runner.temp }}/${RECORD_FILE}`);
  assert.equal(s.with['retention-days'], 14);
  assert.equal(s.with['if-no-files-found'], 'ignore');
});

test('the digest workflow may read artifacts, which downloading a record needs', () => {
  assert.equal(read('factory-digest.yml').permissions.actions, 'read');
});

test('the digest downloads that artifact by name into a directory of its own', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'factory-digest.js'), 'utf8');
  assert.match(text, /'run', 'download', String\(id\), '-n', RECORD_ARTIFACT, '-D', dir/);
  assert.match(text, /path\.join\(dir, RECORD_FILE\)/);
  assert.match(text, /fs\.rmSync\(dir, \{ recursive: true, force: true \}\)/);
});
