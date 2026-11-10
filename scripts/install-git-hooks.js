#!/usr/bin/env node
/**
 * Write the factory's git hooks into the project's .githooks/ and point git at
 * them: pre-commit refuses a commit on the default branch and pre-push refuses a
 * push to it (`default_branch` of factory.config.yml), and `hooks.chain` lists
 * the project's own hook commands that pre-commit runs afterwards. Outside a git
 * checkout (a tarball install) it does nothing, and it never fails an install.
 *
 * It never replaces hooks someone set up already: when `core.hooksPath` points
 * elsewhere, or the default hooks directory holds a real (non-sample) hook, it
 * leaves git alone and says how to chain the factory's hooks instead.
 *
 * Usage: node scripts/install-git-hooks.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { loadConfig } = require('../lib/config.js');
const { HOOKS_DIR, writeHooks } = require('../lib/hooks.js');

const defaultDeps = {
  git: (args) => execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim(),
  list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
};

/** The configured core.hooksPath, or ''. */
function configuredPath(git) {
  try {
    return git(['config', '--get', 'core.hooksPath']);
  } catch {
    return '';
  }
}

/** Why installing would replace someone's hooks, or ''. */
function existingHooks(deps) {
  const current = configuredPath(deps.git);
  if (current === HOOKS_DIR) return '';
  if (current) return `core.hooksPath is already ${current}`;
  const dir = deps.git(['rev-parse', '--git-path', 'hooks']);
  const real = deps.list(dir).filter((name) => !name.endsWith('.sample'));
  return real.length ? `${dir} already has hooks (${real.join(', ')})` : '';
}

/**
 * @param {object} config A loaded factory.config.yml.
 * @param {{root?: string, git?: Function, list?: Function, write?: Function}} [io]
 * @returns {string} What happened, for the installer's output.
 */
function main(config, { root = process.cwd(), write = writeHooks, ...deps } = {}) {
  const d = { ...defaultDeps, ...deps };
  try {
    d.git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return 'not a git checkout: hooks not installed';
  }
  const existing = existingHooks(d);
  if (existing) {
    return `git hooks not installed: ${existing}. Call ${HOOKS_DIR}/pre-commit and ${HOOKS_DIR}/pre-push from your own hooks.`;
  }
  write(root, config);
  d.git(['config', 'core.hooksPath', HOOKS_DIR]);
  return `git hooks installed (core.hooksPath=${HOOKS_DIR})`;
}

if (require.main === module) {
  try {
    console.log(main(loadConfig(process.cwd())));
  } catch (error) {
    console.warn(`git hooks not installed: ${error.message}`);
  }
}

module.exports = { main };
