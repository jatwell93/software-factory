'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { CALLERS, renderCaller } = require('./callers.js');
const { CONFIG_FILE, parseConfig } = require('./config.js');
const { ciWorkflowNames, detectStack, ownerFromRemote } = require('./detect.js');
const { HOOKS_DIR, foreignHooks, renderHooks } = require('./hooks.js');
const { ensureLabel } = require('./labels.js');

const FACTORY_ROOT = path.join(__dirname, '..');
const BEGIN = '<!-- software-factory:begin -->';
const END = '<!-- software-factory:end -->';
const SKILLS = ['run-spec', 'to-tickets', 'babysit-pr', 'handover', 'resume-change'];

// What `npm ci` and its kin run on the PR branch: a PR that edited them would run its own code.
const INSTALL_INPUTS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.npmrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
];

const CONFIG_HEADER = [
  '# Written by software-factory init. Edit freely: init never overwrites this file.',
  '# Gates are what the agent must run before it pushes; review_bots lists the bots',
  '# whose reviews should start a run (logins without [bot]). protected_paths adds to',
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
  if (stack.install) runner.install = stack.install;
  const doc = {
    spec_source: options.specSource || 'openspec',
    owner,
    default_branch: defaultBranch,
    gates,
    protected_paths: INSTALL_INPUTS.filter((f) => fs.existsSync(path.join(root, f))),
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
  if (current === text) return { path: rel, status: 'unchanged' };
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
    if (options.adapterSetup !== false) setUpAdapter(root, config, io, warnings);
    if (options.labels !== false) files.push(...ensureLabels(config, io, warnings));
  }
  return { files, warnings, steps: ownerSteps(config, root) };
}

/** Writes the hooks (unless the project's own are there) and reports what changed. */
function installHooks(root, config, options, io, warnings) {
  const before = hookTexts(root);
  if (options.adoptHooks) {
    for (const name of foreignHooks(root)) fs.rmSync(path.join(root, HOOKS_DIR, name));
  }
  const { main } = require('../scripts/install-git-hooks.js');
  const message = main(config, { root, git: io.git });
  const installed = /^git hooks installed/.test(message);
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

function hookTexts(root) {
  const out = {};
  for (const name of ['pre-commit', 'pre-push']) {
    const text = readOrNull(path.join(root, HOOKS_DIR, name));
    if (text !== null) out[name] = text;
  }
  return out;
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
    warnings.push(
      `labels not created (${error.message.split('\n')[0]}): run init again with gh logged in`,
    );
    return [];
  }
  return labelSet(config).map(([name, color, description]) => {
    if (have.has(name)) return { path: `label ${name}`, status: 'unchanged' };
    ensureLabel(io.gh, name, color, description);
    return { path: `label ${name}`, status: 'created' };
  });
}

/** The steps only the owner can do, printed after init. */
function ownerSteps(config, root) {
  const repo = path.basename(root);
  return [
    `Add the repository secret CLAUDE_CODE_OAUTH_TOKEN (claude setup-token, then gh secret set CLAUDE_CODE_OAUTH_TOKEN) and install the Claude GitHub App on ${repo}.`,
    `Add a ruleset on ${config.default_branch} that requires the checks factory/no-go-guard, factory/change-ids and your CI gate, and enable "Block force pushes".`,
    'Settings > Actions > General: allow GitHub Actions to create pull requests. Decide the approval policy for workflow runs started by bots.',
    'Commit these files in one PR, merge it, then run: gh workflow run factory.yml -f change_id=<id> (or merge a plan PR from /to-tickets).',
    'To run the factory scripts and skills locally, set FACTORY_DIR to a checkout of jatwell93/software-factory.',
  ];
}

module.exports = { SKILLS, labelSet, ownerSteps, runInit, usage, withAgentsBlock };
