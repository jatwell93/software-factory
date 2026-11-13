const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../lib/config.js');
const { allowedTools, deniedTools } = require('../lib/claude-args.js');
const { tempRoot } = require('./helpers.js');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'factory.yml'),
  'utf8',
);

test('the agent may run the read-only helpers it chains with its real commands', () => {
  const tools = allowedTools(loadConfig(tempRoot()));
  for (const helper of ['ls', 'cat', 'echo', 'head', 'tail', 'wc']) {
    assert.ok(tools.includes(`Bash(${helper}:*)`), helper);
  }
});

test('no helper that can change files, reach the network or print the environment is allowed', () => {
  const tools = allowedTools(loadConfig(tempRoot())).join(' ');
  for (const risky of ['rm', 'mv', 'cp', 'chmod', 'sed', 'tee', 'printenv', 'env', 'bash', 'sh']) {
    assert.ok(!tools.includes(`Bash(${risky}:`), `${risky} stays out`);
  }
  assert.ok(deniedTools(loadConfig(tempRoot())).includes('Bash(curl:*)'));
});

test('the prompt tells the agent to run one command per call and not to chain or cd', () => {
  assert.match(workflow, /Run one command per Bash call/);
  assert.match(workflow, /no `;`, `&&` or `cd` chains/);
  assert.match(workflow, /do not print the variable/);
  assert.match(workflow, /If a command is denied, do not retry it/);
});

test('the prompt rules sit in the prompt block, not in a YAML comment', () => {
  const line = workflow.split('\n').find((l) => l.includes('Run one command per Bash call'));
  assert.ok(line.startsWith('            Run one command'), 'indented as prompt text');
  assert.ok(!line.trim().startsWith('#'));
});
