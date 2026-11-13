'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'workflows');
// A commit SHA or a release tag: a branch name would let the pin move under the project.
const FACTORY_REF = /^(?:[0-9a-f]{40}|v[0-9][0-9A-Za-z.+-]*)$/;

/** The caller workflows a project gets, by file name. */
const CALLERS = [
  'no-go-guard.yml',
  'factory-ci-relay.yml',
  'factory-digest.yml',
  'check-change-ids.yml',
  'factory.yml',
  'reviews-settled.yml',
];

/** A YAML single-quoted scalar. */
const quote = (text) => `'${text.replace(/'/g, "''")}'`;

/** The relay's `workflow_run.workflows` list, one indented item per CI workflow. */
function ciList(names) {
  if (names.length === 0) {
    throw new Error('ci_workflows is empty: the CI relay needs at least one workflow to watch');
  }
  for (const name of names) {
    if (/[\r\n]/.test(name)) throw new Error(`a ci_workflows name has a line break: ${name}`);
  }
  return names.map((name) => `      - ${quote(name)}`).join('\n');
}

// The template holds one placeholder item, so the file is valid YAML before it is rendered.
const CI_PLACEHOLDER = /^ *- __CI_WORKFLOWS__$/m;

/**
 * The text of one caller workflow, with the pinned ref and, for the relay, the
 * project's CI workflow names filled in.
 */
function renderCaller(name, { factoryRef, config }) {
  if (!CALLERS.includes(name)) throw new Error(`no caller workflow named ${name}`);
  if (!FACTORY_REF.test(factoryRef)) {
    throw new Error(`factory ref "${factoryRef}" must be a 40-character commit SHA or a v* tag`);
  }
  const template = fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
  return template
    .replace(CI_PLACEHOLDER, () => ciList(config.ci_workflows))
    .replaceAll('__FACTORY_REF__', factoryRef);
}

module.exports = { CALLERS, FACTORY_REF, renderCaller };
