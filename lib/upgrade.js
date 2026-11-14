'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CALLERS } = require('./callers.js');
const { FACTORY_REPO, readPins, setPins } = require('./pin.js');
const { ghReason } = require('./gh-error.js');
const { SKILLS, usage } = require('./init.js');

const FACTORY_ROOT = path.join(__dirname, '..');

/**
 * Moves a project's pin to `ref`: the `uses:` ref and the `factory_ref` input in
 * each caller workflow, and the five skills when this checkout is that commit.
 * Only the pin is rewritten, so a project's own edits to a caller's triggers stay.
 * Nothing is written when the ref is not on GitHub: every workflow would break.
 *
 * @param {object} options root, ref (40-character SHA or v* tag), checkoutCommit
 *   (the commit this factory checkout is on), skills (false leaves them), dryRun.
 * @param {{gh: Function}} io Runs in the project root.
 * @returns {{files: object[], warnings: string[], commit: string}}
 */
function runUpgrade(options, io) {
  const { root, ref } = options;
  setPins('', ref); // a ref that is not a SHA or v* tag throws before anything else
  let commit;
  try {
    commit = io.gh(['api', `repos/${FACTORY_REPO}/commits/${ref}`, '--jq', '.sha']);
  } catch (error) {
    throw usage(
      `cannot confirm ${ref} exists in ${FACTORY_REPO} (${ghReason(error)}): push it first`,
    );
  }
  const warnings = [];
  const plan = [];
  for (const name of CALLERS) {
    const rel = `.github/workflows/${name}`;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      warnings.push(`${rel} is missing: run factory-init.js to write it`);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const pins = readPins(text);
    if (pins.uses.length === 0) {
      plan.push({ path: rel, status: 'skipped', note: 'does not call the factory' });
      continue;
    }
    const from = [...new Set([...pins.uses, ...pins.inputs])].join(', ');
    const next = setPins(text, ref);
    plan.push(
      next.changed === 0
        ? { path: rel, status: 'unchanged' }
        : { path: rel, status: 'updated', note: `${from} -> ${ref}`, text: next.text },
    );
  }
  if (options.skills !== false) {
    if (options.checkoutCommit === commit) {
      for (const skill of SKILLS) {
        const rel = `.claude/skills/${skill}/SKILL.md`;
        const file = path.join(root, rel);
        const text = fs.readFileSync(path.join(FACTORY_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
        const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (have === text) plan.push({ path: rel, status: 'unchanged' });
        else plan.push({ path: rel, status: have === null ? 'created' : 'updated', text });
      }
    } else {
      warnings.push(
        `skills not updated: this factory checkout is at ${options.checkoutCommit.slice(0, 7)}, not ${commit.slice(0, 7)}. Check out ${ref} in the factory repo and run upgrade again.`,
      );
    }
  }
  if (!options.dryRun) {
    for (const item of plan) {
      if (!item.text) continue;
      const file = path.join(root, item.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, item.text);
    }
  }
  return { files: plan.map(({ text, ...rest }) => rest), warnings, commit };
}

module.exports = { runUpgrade };
