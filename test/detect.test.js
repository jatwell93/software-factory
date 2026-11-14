const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ciWorkflowNames, detectStack, ownerFromRemote } = require('../lib/detect.js');

function dir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-detect-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

const pkg = (scripts, extra = {}) => JSON.stringify({ scripts, ...extra });

test('Node: gates are the lint, typecheck and test scripts that exist, in that order', () => {
  const root = dir({
    'package.json': pkg({ test: 't', build: 'b', lint: 'l', typecheck: 'c' }),
    'package-lock.json': '{}',
  });
  const stack = detectStack(root);
  assert.equal(stack.stack, 'node');
  assert.equal(stack.install, 'npm ci');
  assert.deepEqual(
    stack.gates.map((g) => g.run),
    ['npm run lint', 'npm run typecheck', 'npm run test'],
  );
});

test('Node: the lockfile picks the package manager', () => {
  const pnpm = detectStack(dir({ 'package.json': pkg({ test: 't' }), 'pnpm-lock.yaml': '' }));
  assert.equal(pnpm.install, 'pnpm install --frozen-lockfile');
  assert.deepEqual(pnpm.gates, [{ run: 'pnpm run test' }]);
  const yarn = detectStack(dir({ 'package.json': pkg({ test: 't' }), 'yarn.lock': '' }));
  assert.equal(yarn.install, 'yarn install --frozen-lockfile');
  const none = detectStack(dir({ 'package.json': pkg({ test: 't' }) }));
  assert.equal(none.install, 'npm install');
});

test('Node: a script that only echoes or exits is not a gate', () => {
  const root = dir({
    'package.json': pkg({ test: 'echo "no root test" && exit 1', lint: 'exit 1' }),
  });
  assert.deepEqual(detectStack(root).gates, []);
});

test('Node: the version comes from .nvmrc, then engines', () => {
  const nvm = dir({ 'package.json': pkg({}), '.nvmrc': 'v20.11.0\n' });
  assert.equal(detectStack(nvm).nodeVersion, '20.11.0');
  const engines = dir({ 'package.json': pkg({}, { engines: { node: '>=22' } }) });
  assert.equal(detectStack(engines).nodeVersion, '22');
  assert.equal(detectStack(dir({ 'package.json': pkg({}) })).nodeVersion, undefined);
});

test('Node: a package.json that is not JSON is not a Node project', () => {
  assert.equal(detectStack(dir({ 'package.json': '{ nope' })).stack, 'unknown');
});

test('Python, Go and Rust get their usual gates', () => {
  const py = detectStack(dir({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest]\n' }));
  assert.deepEqual(
    py.gates.map((g) => g.run),
    ['ruff check .', 'pytest'],
  );
  assert.equal(py.install, 'pip install .');
  const reqs = detectStack(dir({ 'requirements.txt': 'pytest\n' }));
  assert.equal(reqs.install, 'pip install -r requirements.txt');
  assert.deepEqual(
    detectStack(dir({ 'go.mod': 'module x' })).gates.map((g) => g.run),
    ['go vet ./...', 'go test ./...'],
  );
  assert.deepEqual(
    detectStack(dir({ 'Cargo.toml': '' })).gates.map((g) => g.run),
    ['cargo clippy', 'cargo test'],
  );
});

test('an unrecognised project has no gates', () => {
  assert.deepEqual(detectStack(dir({ 'README.md': '' })), {
    stack: 'unknown',
    install: '',
    gates: [],
  });
});

test('ciWorkflowNames reads each workflow name once and skips the listed files', () => {
  const root = dir({
    '.github/workflows/ci.yml': 'name: CI\non: push\n',
    '.github/workflows/lint.yaml': "name: 'Lint code'\non: push\n",
    '.github/workflows/dup.yml': 'name: CI\n',
    '.github/workflows/noname.yml': 'on: push\n',
    '.github/workflows/factory.yml': 'name: Factory\n',
    '.github/workflows/notes.txt': 'name: Not a workflow\n',
  });
  assert.deepEqual(ciWorkflowNames(root, ['factory.yml']), ['CI', 'Lint code']);
  assert.deepEqual(ciWorkflowNames(dir({})), []);
});

test('ownerFromRemote reads https and ssh remotes', () => {
  assert.equal(ownerFromRemote('https://github.com/octo/app.git'), 'octo');
  assert.equal(ownerFromRemote('git@github.com:octo-cat/app.git'), 'octo-cat');
  assert.equal(ownerFromRemote('https://example.com/octo/app'), '');
  assert.equal(ownerFromRemote(''), '');
});
