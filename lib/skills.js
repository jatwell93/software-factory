'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FACTORY_ROOT = path.join(__dirname, '..');

/** The five skills of an OpenSpec project: the factory's default set. */
const SKILLS = ['run-spec', 'to-tickets', 'babysit-pr', 'handover', 'resume-change'];

/**
 * The skills a project installs when its spec source is not OpenSpec. `to-tickets`,
 * `handover` and `resume-change` are written for OpenSpec's files, so a PAUL project
 * plans and resumes with PAUL's own commands and does not get them.
 */
const SKILLS_BY_SOURCE = { paul: ['run-spec', 'babysit-pr'] };

/** The skills a project with this spec source installs, in install order. */
const skillsFor = (specSource) => SKILLS_BY_SOURCE[specSource] || SKILLS;

/**
 * The factory's text of a skill for a spec source: `skills/<source>/<skill>/SKILL.md`
 * when the source has its own version, else the shared `skills/<skill>/SKILL.md`.
 */
function skillText(skill, specSource) {
  const own = path.join(FACTORY_ROOT, 'skills', specSource || '', skill, 'SKILL.md');
  const shared = path.join(FACTORY_ROOT, 'skills', skill, 'SKILL.md');
  const file = specSource && SKILLS_BY_SOURCE[specSource] && fs.existsSync(own) ? own : shared;
  return fs.readFileSync(file, 'utf8');
}

module.exports = { SKILLS, SKILLS_BY_SOURCE, skillsFor, skillText };
