'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { CALLERS } = require('./callers.js');
const { loadConfig } = require('./config.js');
const { FACTORY_REPO, readPins, refKind } = require('./pin.js');
const { globToRegExp } = require('./glob.js');
const { HOOKS_DIR } = require('./hooks.js');
const { labelSet } = require('./init.js');
const { skillsFor, skillText } = require('./skills.js');
const { loadAdapter } = require('./adapters.js');
const { ghReason, isNoSuchRef } = require('./gh-error.js');
const { ownerDoc } = require('./owner-docs.js');
const { RULES, missingRules } = require('./allowlist.js');
const { ignoredSource } = require('./ignored-source.js');
const { sameText } = require('./text.js');
const { probeBots, botFinding, probeChecks, checkMapFinding } = require('./bot-probe.js');
const { missingPermissions } = require('./permissions.js');
const { missingDispatch } = require('./triggers.js');

const SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';
const REQUIRED_CHECKS = ['factory/no-go-guard', 'factory/change-ids'];

const ok = (name, detail = '') => ({ name, status: 'ok', detail });
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix });
const skip = (name, detail) => ({ name, status: 'skip', detail });

const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const lines = (text) => text.split(/\r?\n/).filter(Boolean);

/** Runs a check that asks GitHub: a failed call is a skip, never a verdict on the project. */
function asking(name, run) {
  try {
    return run();
  } catch (error) {
    return skip(name, `could not ask GitHub (${ghReason(error)})`);
  }
}

function checkConfig(root) {
  try {
    const config = loadConfig(root);
    return { result: ok('config', 'factory.config.yml is valid'), config };
  } catch (error) {
    return {
      result: fail('config', error.message, 'node $FACTORY_DIR/scripts/factory-init.js'),
    };
  }
}

function checkAdapter(config, root) {
  try {
    loadAdapter(config, { root });
    return ok('adapter', `spec_source ${config.spec_source} is installed`);
  } catch (error) {
    return fail('adapter', error.message, 'use a spec_source this factory ships');
  }
}

/** Callers present, one ref across all of them, and a ref that cannot move. */
function checkCallers(root) {
  const results = [];
  const refs = new Set();
  const missing = [];
  for (const name of CALLERS) {
    const text = readOrNull(path.join(root, '.github', 'workflows', name));
    if (text === null) {
      missing.push(name);
      continue;
    }
    const pins = readPins(text);
    if (pins.uses.length === 0) {
      results.push(
        fail(
          `caller ${name}`,
          'does not call the factory',
          'node $FACTORY_DIR/scripts/factory-init.js --force',
        ),
      );
      continue;
    }
    pins.uses.forEach((ref) => refs.add(ref));
    pins.inputs.forEach((ref) => refs.add(ref));
    if (pins.inputs.some((ref) => !pins.uses.includes(ref))) {
      results.push(
        fail(
          `caller ${name}`,
          'its uses: ref and factory_ref differ',
          'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <sha>',
        ),
      );
    }
    // reviews-settled dispatches this caller when GitHub never started its run for a head.
    if (missingDispatch(text, name)) {
      results.push(
        fail(
          `caller ${name}`,
          'has no workflow_dispatch trigger, so a status GitHub never started a run for cannot be recovered',
          'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <sha>, from a factory checkout at that commit',
        ),
      );
    }
    // A reusable workflow cannot ask for more than its caller grants: the run fails at startup.
    const short = missingPermissions(text, name);
    if (short.length) {
      results.push(
        fail(
          `caller ${name}`,
          `grants less than this factory checkout's version needs (${short.map(([scope, level]) => `${scope}: ${level}`).join(', ')})`,
          'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <sha>, from a factory checkout at that commit',
        ),
      );
    }
  }
  if (missing.length) {
    results.push(
      fail('callers', `missing ${missing.join(', ')}`, 'node $FACTORY_DIR/scripts/factory-init.js'),
    );
  }
  return { results, refs: [...refs] };
}

/** Whether a ruleset list protects the tag from being moved and from being deleted. */
function tagProtected(rulesets, tag) {
  const ref = `refs/tags/${tag}`;
  const matches = (list) => (list || []).some((p) => p === '~ALL' || globToRegExp(p).test(ref));
  return rulesets.some((set) => {
    if (set.target !== 'tag' || set.enforcement !== 'active') return false;
    const names = (set.conditions && set.conditions.ref_name) || {};
    if (!matches(names.include) || matches(names.exclude)) return false;
    const types = (set.rules || []).map((r) => r.type);
    return types.includes('update') && types.includes('deletion');
  });
}

// Commits the pin may trail the factory's main by before doctor warns. Most are docs or
// internal, so a small gap is normal; a large one means fixes the project has not taken.
const PIN_DRIFT_WARN = 5;

/** How far the pin trails the factory's main branch. A skip when GitHub cannot say. */
function checkPinDrift(ref, gh) {
  return asking('pin drift', () => {
    const behind = Number(
      gh(['api', `repos/${FACTORY_REPO}/compare/${ref}...main`, '--jq', '.ahead_by']).trim(),
    );
    if (!Number.isInteger(behind))
      return skip('pin drift', 'could not tell how far the pin trails');
    if (behind < PIN_DRIFT_WARN) {
      return ok(
        'pin drift',
        behind === 0
          ? 'the pin is the factory main'
          : `${behind} commit(s) behind the factory main`,
      );
    }
    return warn(
      'pin drift',
      `${behind} commits behind the factory main: fixes the project has not taken`,
      'factory upgrade --ref <factory main sha>, or `factory pin-sync` to open the pin PR in every consumer listed in ~/.factory-consumers',
    );
  });
}

/** The pin's kind and whether GitHub knows it (and protects it, for a tag). */
function checkPin(refs, gh) {
  if (refs.length === 0) return [];
  if (refs.length > 1) {
    return [
      fail(
        'pin',
        `callers pin different refs (${refs.join(', ')})`,
        'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <sha>',
      ),
    ];
  }
  const [ref] = refs;
  const kind = refKind(ref);
  if (kind === 'other') {
    return [
      fail(
        'pin',
        `"${ref}" is not a commit or a v* tag, so it can move under the project`,
        'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <sha>',
      ),
    ];
  }
  const found = asking('pin', () => {
    try {
      gh(['api', `repos/${FACTORY_REPO}/commits/${ref}`, '--jq', '.sha']);
    } catch (error) {
      // "No such ref" is an answer: GitHub does not have it, so every workflow fails.
      if (!isNoSuchRef(error)) throw error;
      return fail(
        'pin',
        `${ref} is not in ${FACTORY_REPO}`,
        'node $FACTORY_DIR/scripts/factory-upgrade.js --ref <pushed sha>',
      );
    }
    return ok('pin', kind === 'sha' ? `${ref} (a commit: it cannot move)` : `${ref} exists`);
  });
  if (found.status !== 'ok') return [found];
  const drift = checkPinDrift(ref, gh);
  if (kind === 'sha') return [found, drift];
  return [
    found,
    drift,
    asking('pin protection', () => {
      const ids = JSON.parse(gh(['api', `repos/${FACTORY_REPO}/rulesets`, '--jq', '[.[].id]']));
      const sets = ids.map((id) => JSON.parse(gh(['api', `repos/${FACTORY_REPO}/rulesets/${id}`])));
      return tagProtected(sets, ref)
        ? ok('pin protection', `${ref} cannot be moved or deleted`)
        : warn(
            'pin protection',
            `${ref} is a tag nothing protects: it can be moved to other code`,
            'add a tag ruleset on the factory repo that blocks update and deletion of v* tags, or pin a commit',
          );
    }),
  ];
}

/** The relay's trigger list against ci_workflows: a trigger cannot read config. */
function checkRelay(root, config) {
  const text = readOrNull(path.join(root, '.github', 'workflows', 'factory-ci-relay.yml'));
  if (text === null) return null;
  let listed;
  try {
    listed = YAML.parse(text).on.workflow_run.workflows;
  } catch {
    return fail(
      'ci relay',
      'factory-ci-relay.yml has no workflow_run.workflows list',
      'node $FACTORY_DIR/scripts/factory-init.js --force',
    );
  }
  const want = new Set(config.ci_workflows);
  const have = new Set(listed);
  const missing = [...want].filter((n) => !have.has(n));
  const extra = [...have].filter((n) => !want.has(n));
  if (missing.length === 0 && extra.length === 0)
    return ok('ci relay', 'its trigger matches ci_workflows');
  const parts = [];
  if (missing.length) parts.push(`not watched: ${missing.join(', ')}`);
  if (extra.length) parts.push(`not in ci_workflows: ${extra.join(', ')}`);
  return fail('ci relay', parts.join('; '), 'node $FACTORY_DIR/scripts/factory-init.js --force');
}

/** PAUL's commands the factory's run-spec follows must be in the project, not only in a home folder. */
function checkPaulInstall(root) {
  const missing = ['apply.md', 'unify.md'].filter(
    (name) => !fs.existsSync(path.join(root, '.claude', 'commands', 'paul', name)),
  );
  if (missing.length === 0) return ok('paul install', 'PAUL commands are in .claude/commands/paul');
  return fail(
    'paul install',
    `missing .claude/commands/paul/${missing.join(', ')}: a runner sees the project's files, not your home folder`,
    'npx paul-framework --local (then commit .claude/)',
  );
}

function checkSkills(root, specSource) {
  const missing = [];
  const stale = [];
  for (const skill of skillsFor(specSource)) {
    const have = readOrNull(path.join(root, '.claude', 'skills', skill, 'SKILL.md'));
    if (have === null) missing.push(skill);
    else if (!sameText(have, skillText(skill, specSource))) stale.push(skill);
  }
  if (missing.length)
    return fail(
      'skills',
      `missing ${missing.join(', ')}`,
      'node $FACTORY_DIR/scripts/factory-init.js',
    );
  if (stale.length) {
    return warn(
      'skills',
      `differ from this factory checkout: ${stale.join(', ')}`,
      'node $FACTORY_DIR/scripts/factory-upgrade.js (replaces them), or keep a local edit on purpose',
    );
  }
  return ok('skills', 'match this factory checkout');
}

/** The read-only command rules in .claude/settings.json (lib/allowlist.js): without them the agent asks before each. */
function checkAllowlist(root) {
  let missing;
  try {
    missing = missingRules(readOrNull(path.join(root, '.claude', 'settings.json')));
  } catch (error) {
    // init leaves such a file alone, so rerunning it would not help: say what to fix by hand.
    return warn(
      'allowlist',
      `.claude/settings.json cannot be read (${error.message}): init leaves it alone`,
      `Fix the file, then run node $FACTORY_DIR/scripts/factory-init.js, or add the rules by hand.\nDetails: ${ownerDoc('allowlist')}`,
    );
  }
  if (missing.length === 0)
    return ok('allowlist', `${RULES.length} read-only command rules in place`);
  return warn(
    'allowlist',
    `${missing.length} of ${RULES.length} read-only command rules missing from .claude/settings.json: the agent asks before each factory command`,
    `node $FACTORY_DIR/scripts/factory-init.js (adds only what is missing; --no-permissions skips it)\nDetails: ${ownerDoc('allowlist')}`,
  );
}

/** Source files git ignores in a folder it tracks: `git add` drops them without a word. */
function checkIgnoredSource(git) {
  let found;
  try {
    found = ignoredSource(git);
  } catch (error) {
    return skip('ignored source', `could not ask git (${ghReason(error)})`);
  }
  if (found.length === 0) return ok('ignored source', 'no source file is hidden by an ignore rule');
  const shown = found.slice(0, 5).map(({ file, rule }) => `${file} (${rule})`);
  const more = found.length > shown.length ? ` and ${found.length - shown.length} more` : '';
  return warn(
    'ignored source',
    `git add skips ${found.length} source file(s): ${shown.join('; ')}${more}`,
    'Narrow the rule so it stops matching source, or git add -f the file if it must be committed. Run node $FACTORY_DIR/scripts/check-ignored.js for the full list.',
  );
}

function checkHooks(git) {
  let path_ = '';
  try {
    path_ = git(['config', '--get', 'core.hooksPath']);
  } catch {
    // unset
  }
  return path_ === HOOKS_DIR
    ? ok('git hooks', `core.hooksPath is ${HOOKS_DIR}`)
    : warn(
        'git hooks',
        `core.hooksPath is ${path_ || 'unset'}: commits on the default branch are not refused locally`,
        'node $FACTORY_DIR/scripts/factory-init.js',
      );
}

function checkLabels(config, gh) {
  return asking('labels', () => {
    const have = new Set(
      lines(gh(['label', 'list', '--limit', '200', '--json', 'name', '--jq', '.[].name'])),
    );
    const missing = labelSet(config).filter(([name]) => !have.has(name));
    if (missing.length === 0) return ok('labels', 'all five exist');
    const fix = missing
      .map(([n, color, d]) => `gh label create "${n}" --color ${color} --description "${d}"`)
      .join('\n');
    return fail('labels', `missing ${missing.map(([n]) => n).join(', ')}`, fix);
  });
}

function checkSecret(gh) {
  return asking('secret', () => {
    const names = lines(gh(['secret', 'list', '--json', 'name', '--jq', '.[].name']));
    return names.includes(SECRET)
      ? ok('secret', `${SECRET} is set`)
      : fail(
          'secret',
          `${SECRET} is not a repository secret (an organisation secret is not shown here)`,
          `claude setup-token, then: gh secret set ${SECRET}\nDetails: ${ownerDoc('secret')}`,
        );
  });
}

/**
 * Whether each `review_bot_checks` entry belongs to a listed bot and names a check that
 * really appears on merged PRs. Nothing to check with no mapping; a skip when too few
 * PRs have merged to judge by, or when GitHub cannot be asked.
 */
function checkBotChecks(config, gh) {
  const map = config.review_bot_checks || {};
  if (Object.keys(map).length === 0) return null;
  return asking('review bot checks', () => {
    const probe = probeChecks(map, gh);
    const finding = checkMapFinding(probe, config.review_bots || [], {
      timeoutMinutes: config.reviews_timeout_minutes,
    });
    if (!finding) return skip('review bot checks', 'too few merged PRs to tell yet');
    return finding.status === 'ok'
      ? ok('review bot checks', finding.detail)
      : warn('review bot checks', finding.detail, finding.fix);
  });
}

/**
 * Whether each configured review bot posts often enough not to hold every PR for the
 * whole timeout. Nothing to check with no bots listed; a skip when too few PRs have
 * merged to judge by, or when GitHub cannot be asked.
 */
function checkBots(config, gh) {
  const bots = config.review_bots || [];
  if (bots.length === 0) return null;
  return asking('review bots', () => {
    const finding = botFinding(probeBots(bots, gh), {
      timeoutMinutes: config.reviews_timeout_minutes,
      mapped: Object.keys(config.review_bot_checks || {}),
    });
    if (!finding) return skip('review bots', 'too few merged PRs to tell yet');
    return finding.status === 'ok'
      ? ok('review bots', finding.detail)
      : warn('review bots', finding.detail, finding.fix);
  });
}

/** The default branch's ruleset: the factory's statuses required, force pushes blocked. */
function checkRuleset(repo, branch, gh) {
  return asking('ruleset', () => {
    const rules = JSON.parse(gh(['api', `repos/${repo}/rules/branches/${branch}`]));
    const contexts = rules
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context));
    const out = [];
    const note = ' (rulesets only: classic branch protection is not read)';
    const missing = REQUIRED_CHECKS.filter((c) => !contexts.includes(c));
    out.push(
      missing.length
        ? fail(
            'ruleset checks',
            `${branch} does not require ${missing.join(', ')}${note}`,
            [
              `Settings > Rules > Rulesets > New ruleset > New branch ruleset (not a tag ruleset), target ${branch}, tick "Require status checks to pass" and add ${missing.join(' and ')}.`,
              'A check is only offered once it has run on a pull request: merge the init PR, open any other PR, let its checks finish, then add them.',
              `Details: ${ownerDoc('ruleset')}`,
            ].join('\n'),
          )
        : ok('ruleset checks', `${branch} requires ${REQUIRED_CHECKS.join(' and ')}`),
    );
    out.push(
      contexts.some((c) => !c.startsWith('factory/'))
        ? ok('ruleset gate', `${branch} also requires your own CI checks`)
        : warn(
            'ruleset gate',
            `${branch} requires no CI check of your own`,
            `In the same ruleset, add your CI job's check, the name shown in a pull request's checks list.\nDetails: ${ownerDoc('ruleset')}`,
          ),
    );
    out.push(
      rules.some((r) => r.type === 'non_fast_forward')
        ? ok('force pushes', `blocked on ${branch}`)
        : warn(
            'force pushes',
            `not blocked on ${branch}`,
            `In the same ruleset, tick "Block force pushes".\nDetails: ${ownerDoc('ruleset')}`,
          ),
    );
    return out;
  });
}

/**
 * Checks a project against what the factory needs and returns one result per
 * check: {name, status: ok|warn|fail|skip, detail, fix?}. A GitHub call that
 * fails is a skip, so doctor runs offline (the file checks still run).
 *
 * @param {string} root The project's root.
 * @param {{git: Function, gh: Function}} io Both run in the project root.
 */
function runDoctor(root, io) {
  const results = [];
  const { result, config } = checkConfig(root);
  results.push(result);
  if (!config) return results;
  results.push(checkAdapter(config, root));
  const callers = checkCallers(root);
  results.push(...callers.results);
  if (callers.results.length === 0) results.push(ok('callers', 'all six present'));
  results.push(...checkPin(callers.refs, io.gh));
  const relay = checkRelay(root, config);
  if (relay) results.push(relay);
  results.push(
    checkSkills(root, config?.spec_source),
    checkHooks(io.git),
    checkIgnoredSource(io.git),
    checkAllowlist(root),
  );
  if (config?.spec_source === 'paul') results.push(checkPaulInstall(root));
  results.push(checkLabels(config, io.gh), checkSecret(io.gh));
  const bots = checkBots(config, io.gh);
  if (bots) results.push(bots);
  const botChecks = checkBotChecks(config, io.gh);
  if (botChecks) results.push(botChecks);
  const repo = asking('repository', () =>
    ok('repository', io.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])),
  );
  if (repo.status === 'ok') {
    const ruleset = checkRuleset(repo.detail, config.default_branch, io.gh);
    results.push(...(Array.isArray(ruleset) ? ruleset : [ruleset]));
  } else {
    results.push(repo);
  }
  results.push(
    skip(
      'claude app',
      `cannot be checked from here: install the Claude GitHub App and give it access to this repository (${ownerDoc('app')})`,
    ),
  );
  return results;
}

module.exports = { REQUIRED_CHECKS, runDoctor, tagProtected };
