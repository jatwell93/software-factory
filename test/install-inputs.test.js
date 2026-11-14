const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installInputs } = require('../lib/detect.js');
const { runInit } = require('../lib/init.js');
const { loadConfig } = require('../lib/config.js');

const REF = 'a'.repeat(40);

/** A directory holding the given files (a name ending in / is an empty directory). */
function dir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-inputs-'));
  for (const name of files) {
    const full = path.join(root, name);
    if (name.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
  }
  return root;
}

test('Node: the manifest, lockfiles and registry config that exist', () => {
  const root = dir(['package.json', 'package-lock.json', '.npmrc', 'README.md']);
  assert.deepEqual(installInputs(root, 'node'), ['package.json', 'package-lock.json', '.npmrc']);
});

test('Python: the build backend, requirement files and lockfiles that exist', () => {
  const root = dir([
    'pyproject.toml',
    'setup.py',
    'uv.lock',
    'requirements.txt',
    'requirements-dev.txt',
    'constraints.in',
    'app.py',
    'notes.txt',
  ]);
  assert.deepEqual(installInputs(root, 'python'), [
    'pyproject.toml',
    'setup.py',
    'uv.lock',
    'constraints.in',
    'requirements-dev.txt',
    'requirements.txt',
  ]);
});

test('requirement files are listed in a fixed order whatever order the filesystem returns', (t) => {
  const root = dir(['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt']);
  t.mock.method(fs, 'readdirSync', () => [
    'requirements-test.txt',
    'requirements.txt',
    'requirements-dev.txt',
  ]);
  assert.deepEqual(installInputs(root, 'python'), [
    'requirements-dev.txt',
    'requirements-test.txt',
    'requirements.txt',
  ]);
});

test('Go: go.mod, go.sum and workspace files that exist', () => {
  const root = dir(['go.mod', 'go.sum', 'main.go']);
  assert.deepEqual(installInputs(root, 'go'), ['go.mod', 'go.sum']);
});

test('Rust: manifest, lockfile, build script, toolchain and the .cargo directory', () => {
  const root = dir(['Cargo.toml', 'Cargo.lock', 'build.rs', '.cargo/config.toml', 'src/main.rs']);
  assert.deepEqual(installInputs(root, 'rust'), [
    'Cargo.toml',
    'Cargo.lock',
    'build.rs',
    '.cargo/**',
  ]);
});

test('a stack the factory does not know, or one with none of the files, lists nothing', () => {
  assert.deepEqual(installInputs(dir(['package.json']), 'unknown'), []);
  assert.deepEqual(installInputs(dir([]), 'python'), []);
  assert.deepEqual(installInputs(dir(['package.json']), 'python'), []);
});

test('a Node project does not protect Python files, and the reverse', () => {
  const root = dir(['package.json', 'pyproject.toml']);
  assert.deepEqual(installInputs(root, 'node'), ['package.json']);
  assert.deepEqual(installInputs(root, 'python'), ['pyproject.toml']);
});

test('init writes a Python project install inputs into protected_paths', () => {
  const root = dir(['pyproject.toml', 'requirements.txt', 'app.py']);
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.ruff]\n[tool.pytest]\n');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  const git = (args) => {
    if (args[0] === 'remote') return 'https://github.com/octo/app.git';
    throw new Error('not available');
  };
  runInit(
    { root, ref: REF, labels: false, adapterSetup: false },
    { git, gh: () => '', setup: () => {} },
  );
  const config = loadConfig(root);
  assert.deepEqual(config.protected_paths, ['pyproject.toml', 'requirements.txt']);
  assert.deepEqual(config.gates, [{ run: 'ruff check .' }, { run: 'pytest' }]);
});
