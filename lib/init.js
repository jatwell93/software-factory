'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { CALLERS, renderCaller } = require('./callers.js');
const { CONFIG_FILE, parseConfig } = require('./config.js');
const { ciWorkflowNames, detectStack, installInputs, ownerFromRemote } = require('./detect.js');
const { HOOKS_DIR, foreignHooks, renderHooks } = require('./hooks.js');
const { ghReason } = require('./gh-error.js');
const { ownerDoc } = require('./owner-docs.js');
const { sameText } = require('./text.js');
const { ensureLabel } = require('./labels.js');

const FACTORY_ROOT = path.join(__dirname, '..');
const BEGIN = '<!-- software-factory:begin -->';
const END = '<!-- software-factory:end -->';
const SKILLS = ['run-spec', 'to-tickets', 'babysit-pr', 'handover', 'resume-change'];

const CONFIG_HEADER = [
  '# Written by software-factory init. Edit freely: init never overwrites this file.',
  '# Gates are what the agent must run before it pushes; review_bots lists the bots',
  '# the PR waits for before it is ready (logins without [bot]; any bot may comment).',
  '# protected_paths adds to',
  '# the factory baseline: the files the install step runs are listed because they',
  '# execute on the PR branch, so a task that needs a new dependency is an owner task.',
  '',
].join('\n');

/** A usage error: the message is for the person running init, so it exits 2 and prints no stack. */
function usage(message) {
  return Object.assign(new Error(message), { userError: true });
}

/** The label set the factory uses, with the colour and description it creates each with. */
function labelSet(config) {
  const l = config.labels;
  return [
    [l.ready, '0E8A16', 'Owner approved the plan: the factory starts the change'],
    [l.needs_human, 'D93F0B', 'Factory is waiting for the owner'],
    [l.retry, 'FBCA04', 'A factory run failed; one retry is queued'],
    [l.retrying, 'FBCA04', 'A factory retry is running'],
    [l.digest, 'C5DEF5', 'The factory daily digest'],
  ];
}

const tryGit = (git, args) => {
  try {
    return git(args);
  } catch {
    return '';
  }
};

/** The config init proposes: detected values, overridden by what the person passed. */
function proposeConfig(root, options, git) {
  const stack = detectStack(root);
  const gates = options.gates?.length ? options.gates.map((run) => ({ run })) : stack.gates;
  if (gates.length === 0) {
    throw usage(
      `no gate found for this project (${stack.stack}): pass the commands that must pass before a push, for example --gate "npm test"`,
    );
  }
  const owner = options.owner || ownerFromRemote(tryGit(git, ['remote', 'get-url', 'origin']));
  if (!owner)
    throw usage('cannot tell the owner from the origin remote: pass --owner <github login>');
  const head = tryGit(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = options.defaultBranch || head.replace(/^origin\//, '') || 'main';
  const ci = options.ciWorkflows?.length ? options.ciWorkflows : ciWorkflowNames(root, CALLERS);
  if (ci.length === 0) {
    throw usage(
      'no CI workflow found in .github/workflows: pass the name of each workflow a PR must pass with --ci-workflow "<name>"',
    );
  }
  const runner = { ...(stack.nodeVersion ? { node_version: stack.nodeVersion } : {}) };
  if (stack.pythonVersion) runner.python_version = stack.pythonVersion;
  if (stack.install) runner.install = stack.install;
  const doc = {
    spec_source: options.specSource || 'openspec',
    owner,
    default_branch: defaultBranch,
    gates,
    protected_paths: installInputs(root, stack.stack),
    review_bots: [],
    ci_workflows: ci,
    runner,
  };
  if (doc.protected_paths.length === 0) delete doc.protected_paths;
  if (Object.keys(runner).length === 0) delete doc.runner;
  const text = CONFIG_HEADER + YAML.stringify(doc);
  // Validate what we are about to write: a config init made must always load.
  return { text, config: parseConfig(text) };
}

/** The AGENTS.md text with the factory block added, or replaced in place. */
function withAgentsBlock(existing, block) {
  if (existing === null) return block;
  const from = existing.indexOf(BEGIN);
  const to = existing.indexOf(END);
  if (from !== -1 && to > from) {
    return existing.slice(0, from) + block.trimEnd() + existing.slice(to + END.length);
  }
  return `${existing.replace(/\s*$/, '')}\n\n${block}`;
}

const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/**
 * Plan one file: created when absent, unchanged when identical, updated when it
 * may be replaced, skipped when it differs and may not be.
 */
function planFile(root, rel, text, { replace, note = '' }) {
  const current = readOrNull(path.join(root, rel));
  if (current === null) return { path: rel, text, status: 'created' };
  if (sameText(current, text)) return { path: rel, status: 'unchanged' };
  if (replace) return { path: rel, text, status: 'updated' };
  return { path: rel, status: 'skipped', note };
}

/**
 * Sets a project up for the factory: config, caller workflows, skills, the
 * AGENTS.md block, git hooks, the spec source's own setup and the labels. It
 * decides and validates everything before it writes, so a usage error leaves the
 * project untouched, and a second run changes nothing.
 *
 * @param {object} options root, ref (40-character SHA or v* tag), owner,
 *   defaultBranch, gates[], ciWorkflows[], specSource, force, adoptHooks,
 *   dryRun, labels (false skips), adapterSetup (false skips).
 * @param {{git: Function, gh: Function, setup: Function}} io Run in the project root.
 * @returns {{files: object[], warnings: string[], steps: string[]}}
 */
function runInit(options, io) {
  const root = options.root;
  const warnings = [];
  const existingConfig = readOrNull(path.join(root, CONFIG_FILE));
  let config;
  let plan = [];
  if (existingConfig === null) {
    const proposed = proposeConfig(root, options, io.git);
    config = proposed.config;
    plan.push({ path: CONFIG_FILE, text: proposed.text, status: 'created' });
  } else {
    config = parseConfig(existingConfig);
    plan.push({ path: CONFIG_FILE, status: 'unchanged' });
  }

  const differs = 'differs from the factory copy: rerun with --force to replace it';
  for (const name of CALLERS) {
    const text = renderCaller(name, { factoryRef: options.ref, config });
    plan.push(
      planFile(root, `.github/workflows/${name}`, text, { replace: options.force, note: differs }),
    );
  }
  for (const skill of SKILLS) {
    const text = fs.readFileSync(path.join(FACTORY_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    plan.push(
      planFile(root, `.claude/skills/${skill}/SKILL.md`, text, {
        replace: options.force,
        note: differs,
      }),
    );
  }
  const block = fs.readFileSync(path.join(FACTORY_ROOT, 'templates', 'agents-block.md'), 'utf8');
  plan.push(
    planFile(root, 'AGENTS.md', withAgentsBlock(readOrNull(path.join(root, 'AGENTS.md')), block), {
      replace: true,
    }),
  );

  const foreign = foreignHooks(root);
  if (foreign.length && !options.adoptHooks) {
    warnings.push(
      `${HOOKS_DIR}/${foreign.join(', ')} not written by the factory, so left alone. Move what they do into hooks.chain in ${CONFIG_FILE}, then rerun with --adopt-hooks to replace them.`,
    );
  }

  const files = plan.map(({ text, ...rest }) => rest);
  if (!options.dryRun) {
    for (const item of plan) {
      if (!item.text) continue;
      const file = path.join(root, item.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, item.text);
    }
    files.push(...installHooks(root, config, options, io, warnings));
    if (options.adapterSetup !== false) {
      const before = untracked(io);
      setUpAdapter(root, config, io, warnings);
      // Files the spec source's own setup wrote: listed, so the owner sees them in the diff.
      for (const file of untracked(io)) {
        if (!before.has(file)) files.push({ path: file, status: 'created', note: 'adapter setup' });
      }
    }
    if (options.labels !== false) files.push(...ensureLabels(config, io, warnings));
  }
  return { files, warnings, steps: ownerSteps(config, root) };
}

/** Writes the hooks (unless the project's own are there) and reports what changed. */
function installHooks(root, config, options, io, warnings) {
  const before = hookTexts(root);
  // The installer refuses to run beside a project's own hooks, so adopting them means
  // removing them first. They go back if it then declines or fails: never lose a hook
  // without replacing it.
  const removed = options.adoptHooks ? foreignHooks(root).map((name) => takeHook(root, name)) : [];
  const { main } = require('../scripts/install-git-hooks.js');
  let message;
  try {
    message = main(config, { root, git: io.git });
  } catch (error) {
    removed.forEach(restoreHook);
    throw error;
  }
  const installed = /^git hooks installed/.test(message);
  if (!installed) removed.forEach(restoreHook);
  // A project's own hooks already got their warning, with the way to adopt them.
  if (!installed && warnings.length === 0) warnings.push(message);
  const after = hookTexts(root);
  return Object.keys(renderHooks(config)).map((name) => {
    const rel = `${HOOKS_DIR}/${name}`;
    if (!installed) return { path: rel, status: 'skipped', note: 'git hooks not installed' };
    if (before[name] === undefined) return { path: rel, status: 'created' };
    return { path: rel, status: before[name] === after[name] ? 'unchanged' : 'updated' };
  });
}

/** Removes a hook file and returns what is needed to put it back. */
function takeHook(root, name) {
  const file = path.join(root, HOOKS_DIR, name);
  const saved = { file, text: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode };
  fs.rmSync(file);
  return saved;
}

function restoreHook({ file, text, mode }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

function hookTexts(root) {
  const out = {};
  for (const name of ['pre-commit', 'pre-push']) {
    const text = readOrNull(path.join(root, HOOKS_DIR, name));
    if (text !== null) out[name] = text;
  }
  return out;
}

/** Untracked, not-ignored files (one path each, files inside new folders listed one by one). */
function untracked(io) {
  try {
    const out = io.git(['ls-files', '--others', '--exclude-standard']);
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch {
    return new Set();
  }
}

function setUpAdapter(root, config, io, warnings) {
  try {
    io.setup(config, root);
  } catch (error) {
    warnings.push(
      `the ${config.spec_source} setup did not run (${error.message}): run it yourself in the project`,
    );
  }
}

/** Creates the labels the project lacks; an existing one is left as it is. */
function ensureLabels(config, io, warnings) {
  let have;
  try {
    have = new Set(
      io
        .gh(['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'])
        .split(/\r?\n/),
    );
  } catch (error) {
    warnings.push(`labels not created (${ghReason(error)}): run init again with gh logged in`);
    return [];
  }
  return labelSet(config).map(([name, color, description]) => {
    if (have.has(name)) return { path: `label ${name}`, status: 'unchanged' };
    ensureLabel(io.gh, name, color, description);
    return { path: `label ${name}`, status: 'created' };
  });
}

/** The steps only the owner can do, printed after init. */
function ownerSteps(config) {
  return [
    `Add the repository secret CLAUDE_CODE_OAUTH_TOKEN: run claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN. Details: ${ownerDoc('secret')}`,
    `Install the Claude GitHub App and give it access to this repository (an installation on all repositories already covers it). Details: ${ownerDoc('app')}`,
    `Commit these files in one PR and merge it. Then open any other PR (a README edit is enough) and let its checks finish: the factory's two required checks only exist once they have run. Then add a branch ruleset (not a tag ruleset) on ${config.default_branch} that requires factory/no-go-guard, factory/change-ids and your CI job's check, with "Block force pushes". Details: ${ownerDoc('ruleset')}`,
    `Settings > Actions > General: decide the approval policy for workflow runs started by bots. Details: ${ownerDoc('approval')}`,
    `Start a change: node "$FACTORY_DIR/scripts/factory-new-change.js" <id>, then /to-tickets <id>. To run the factory scripts and skills from your machine, set FACTORY_DIR to a checkout of jatwell93/software-factory. Details: ${ownerDoc('factoryDir')}`,
  ];
}

module.exports = { SKILLS, labelSet, ownerSteps, runInit, usage, withAgentsBlock };
