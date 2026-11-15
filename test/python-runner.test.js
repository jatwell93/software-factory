const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const { detectStack } = require('../lib/detect.js');
const { loadConfig, parseConfig } = require('../lib/config.js');
const { envLines } = require('../scripts/factory-env.js');
const { runInit } = require('../lib/init.js');

const WORKFLOW = YAML.parse(
  fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'factory.yml'), 'utf8'),
);
const CONFIG = ['spec_source: openspec', 'owner: octo', 'gates:', '  - run: pytest'];

function dir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-py-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('runner.python_version is optional, a version string, and has no default', () => {
  assert.equal(parseConfig(CONFIG.join('\n')).runner.python_version, undefined);
  const set = parseConfig([...CONFIG, 'runner:', '  python_version: "3.12"'].join('\n'));
  assert.equal(set.runner.python_version, '3.12');
  assert.throws(
    () => parseConfig([...CONFIG, 'runner:', '  python_version: latest'].join('\n')),
    /python_version/,
  );
  assert.throws(
    () => parseConfig([...CONFIG, 'runner:', '  python_version: 3.12'].join('\n')),
    /python_version/,
  );
});

test('the env script prints python_version, empty when the project sets none', () => {
  const none = envLines(parseConfig(CONFIG.join('\n')));
  assert.ok(none.includes('python_version='));
  const set = envLines(parseConfig([...CONFIG, 'runner:', '  python_version: "3.11"'].join('\n')));
  assert.ok(set.includes('python_version=3.11'));
});

test('the run job sets Python up only when a version is set, before the install', () => {
  const route = WORKFLOW.jobs.route;
  assert.equal(route.outputs.python_version, '${{ steps.env.outputs.python_version }}');
  const steps = WORKFLOW.jobs.run.steps;
  const setup = steps.findIndex((s) => /actions\/setup-python@/.test(s.uses || ''));
  const install = steps.findIndex((s) => s.name === "Install the project's dependencies");
  assert.ok(setup !== -1, 'a setup-python step exists');
  assert.ok(setup < install, 'Python is set up before the install command runs');
  assert.equal(steps[setup].uses, 'actions/setup-python@v7');
  assert.equal(steps[setup].if, "needs.route.outputs.python_version != ''");
  assert.equal(steps[setup].with['python-version'], '${{ needs.route.outputs.python_version }}');
});

test('the Python version comes from the route job, never from the PR branch', () => {
  // Every job but route reads settings from route's outputs; only route runs factory-env.
  for (const [name, job] of Object.entries(WORKFLOW.jobs)) {
    for (const step of job.steps || []) {
      if (!/setup-python/.test(step.uses || '')) continue;
      assert.notEqual(name, 'route');
      assert.match(step.with['python-version'], /needs\.route\.outputs\.python_version/);
    }
  }
});

test('detection: a project that names ruff, mypy and pytest gets the three gates in order', () => {
  const root = dir({
    'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n',
    'requirements.txt': '',
  });
  const stack = detectStack(root);
  assert.deepEqual(
    stack.gates.map((g) => g.run),
    ['ruff check .', 'mypy .', 'pytest'],
  );
  assert.equal(stack.install, 'pip install -r requirements.txt');
});

test('detection: mypy is found in requirements as well, and not guessed when absent', () => {
  const root = dir({ 'requirements.txt': 'mypy==1.10\npytest\n' });
  assert.deepEqual(
    detectStack(root).gates.map((g) => g.run),
    ['mypy .', 'pytest'],
  );
  assert.deepEqual(detectStack(dir({ 'requirements.txt': 'pytest\n' })).gates, [{ run: 'pytest' }]);
});

test('detection: the Python version is .python-version, then requires-python, then 3.12', () => {
  const version = (files) =>
    detectStack(dir({ 'pyproject.toml': '[tool.pytest]\n', ...files })).pythonVersion;
  assert.equal(version({ '.python-version': '3.11\n' }), '3.11');
  assert.equal(version({ '.python-version': '3.12.4\n' }), '3.12.4');
  assert.equal(version({ '.python-version': 'my-pyenv-env\n' }), '3.12');
  assert.equal(version({ 'pyproject.toml': '[project]\nrequires-python = ">=3.11,<4"\n' }), '3.11');
  assert.equal(version({ 'pyproject.toml': "[project]\nrequires-python = '~=3.10'\n" }), '3.10');
  assert.equal(version({ 'pyproject.toml': '[project]\nname = "x"\n' }), '3.12');
  assert.equal(
    version({
      '.python-version': '3.13\n',
      'pyproject.toml': '[project]\nrequires-python = ">=3.9"\n',
    }),
    '3.13',
  );
});

test('detection: a Node project has no Python version', () => {
  const root = dir({ 'package.json': '{"scripts":{"test":"t"}}' });
  assert.equal(detectStack(root).pythonVersion, undefined);
});

test('init writes python_version and the mypy gate for a Python project', () => {
  const root = dir({
    'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n',
    'requirements.txt': '',
    '.python-version': '3.12\n',
    '.github/workflows/ci.yml': 'name: CI\non: push\n',
  });
  const git = (args) => {
    if (args[0] === 'remote') return 'https://github.com/octo/app.git';
    throw new Error('not available');
  };
  runInit(
    { root, ref: 'a'.repeat(40), labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  const config = loadConfig(root);
  assert.equal(config.runner.python_version, '3.12');
  assert.equal(config.runner.install, 'pip install -r requirements.txt');
  assert.deepEqual(
    config.gates.map((g) => g.run),
    ['ruff check .', 'mypy .', 'pytest'],
  );
});

test('init writes no python_version for a Node project', () => {
  const root = dir({
    'package.json': '{"scripts":{"test":"t"}}',
    'package-lock.json': '{}',
    '.github/workflows/ci.yml': 'name: CI\non: push\n',
  });
  const git = (args) => {
    if (args[0] === 'remote') return 'https://github.com/octo/app.git';
    throw new Error('not available');
  };
  runInit(
    { root, ref: 'a'.repeat(40), labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  assert.equal(loadConfig(root).runner.python_version, undefined);
});
