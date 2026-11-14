'use strict';

const fs = require('node:fs');
const path = require('node:path');

const read = (root, name) => {
  try {
    return fs.readFileSync(path.join(root, name), 'utf8');
  } catch {
    return null;
  }
};
const has = (root, name) => fs.existsSync(path.join(root, name));

/** The Node package manager the lockfile names, with its install and run commands. */
function nodeManager(root) {
  if (has(root, 'pnpm-lock.yaml')) {
    return { install: 'pnpm install --frozen-lockfile', run: (s) => `pnpm run ${s}` };
  }
  if (has(root, 'yarn.lock')) {
    return { install: 'yarn install --frozen-lockfile', run: (s) => `yarn run ${s}` };
  }
  if (has(root, 'package-lock.json')) {
    return { install: 'npm ci', run: (s) => `npm run ${s}` };
  }
  return { install: 'npm install', run: (s) => `npm run ${s}` };
}

// Script names worth running before a push, in the order a developer would.
const NODE_GATES = ['lint', 'typecheck', 'test'];

function detectNode(root) {
  const text = read(root, 'package.json');
  if (text === null) return null;
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  const manager = nodeManager(root);
  const scripts = pkg.scripts || {};
  // A script that only errors on purpose (a monorepo root) is not a gate.
  const gates = NODE_GATES.filter(
    (name) => scripts[name] && !/^\s*(echo|exit)\b/.test(scripts[name]),
  );
  const nvmrc = (read(root, '.nvmrc') || '').trim().replace(/^v/, '');
  const engines = ((pkg.engines && pkg.engines.node) || '').match(/(\d+)/);
  const version = /^\d+(\.\d+)*$/.test(nvmrc) ? nvmrc : engines ? engines[1] : undefined;
  return {
    stack: 'node',
    install: manager.install,
    nodeVersion: version,
    gates: gates.map((name) => ({ run: manager.run(name) })),
  };
}

function detectPython(root) {
  const text = [read(root, 'pyproject.toml'), read(root, 'requirements.txt')].filter(Boolean);
  if (text.length === 0) return null;
  const all = text.join('\n');
  const gates = [];
  if (/\bruff\b/.test(all)) gates.push({ run: 'ruff check .' });
  if (/\bpytest\b/.test(all)) gates.push({ run: 'pytest' });
  const install = has(root, 'requirements.txt')
    ? 'pip install -r requirements.txt'
    : 'pip install .';
  return { stack: 'python', install, gates };
}

function detectGo(root) {
  if (!has(root, 'go.mod')) return null;
  return {
    stack: 'go',
    install: 'go mod download',
    gates: [{ run: 'go vet ./...' }, { run: 'go test ./...' }],
  };
}

function detectRust(root) {
  if (!has(root, 'Cargo.toml')) return null;
  return {
    stack: 'rust',
    install: 'cargo fetch',
    gates: [{ run: 'cargo clippy' }, { run: 'cargo test' }],
  };
}

/**
 * What the project's files say about how to build and check it. The first stack
 * found wins, Node first. `gates` can be empty: the caller must then ask for one,
 * because a factory with no gate would call every change good.
 *
 * @returns {{stack: string, install: string, nodeVersion?: string, gates: {run: string}[]}}
 */
function detectStack(root) {
  return (
    detectNode(root) ||
    detectPython(root) ||
    detectGo(root) ||
    detectRust(root) || { stack: 'unknown', install: '', gates: [] }
  );
}

/** The `name:` of each workflow file in .github/workflows, minus the factory's own callers. */
function ciWorkflowNames(root, skipFiles = []) {
  const dir = path.join(root, '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  const names = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file) || skipFiles.includes(file)) continue;
    const match = fs.readFileSync(path.join(dir, file), 'utf8').match(/^name:\s*(.+?)\s*$/m);
    if (!match) continue;
    const name = match[1].replace(/^(['"])(.*)\1$/, '$2');
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The GitHub login in an origin URL (https or ssh form), or ''. */
function ownerFromRemote(url) {
  const match = /github\.com[:/]([A-Za-z0-9-]+)\//.exec(url || '');
  return match ? match[1] : '';
}

module.exports = { ciWorkflowNames, detectStack, ownerFromRemote };
