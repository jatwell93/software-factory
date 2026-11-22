'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { SKILLS, skillsFor, skillText } = require('../lib/skills.js');
const { runInit } = require('../lib/init.js');
const { runDoctor } = require('../lib/doctor.js');
const { runUpgrade } = require('../lib/upgrade.js');

const REF = 'a'.repeat(40);
const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

/** A git checkout of a small Node project with one CI workflow. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paul-skills-'));
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'https://github.com/octo/app.git']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
  fs.mkdirSync(path.join(root, '.paul'));
  fs.writeFileSync(path.join(root, '.paul', 'ROADMAP.md'), '# Roadmap\n');
  return { root, git };
}

const io = (git) => ({ git, gh: () => '', setup: () => {} });

test('a PAUL project gets run-spec (its own text) and babysit-pr, not the OpenSpec-only three', () => {
  assert.deepEqual(skillsFor('paul'), ['run-spec', 'babysit-pr']);
  assert.deepEqual(skillsFor('openspec'), SKILLS);
  assert.deepEqual(skillsFor('anything-else'), SKILLS);
  assert.notEqual(skillText('run-spec', 'paul'), skillText('run-spec', 'openspec'));
  assert.equal(skillText('babysit-pr', 'paul'), skillText('babysit-pr', 'openspec'));
  assert.match(skillText('run-spec', 'paul'), /\.paul\/ROADMAP\.md/);
  assert.doesNotMatch(skillText('run-spec', 'paul'), /openspec/i);
});

test('init for spec_source paul writes the two skills and no other', () => {
  const { root, git } = project();
  const result = runInit(
    { root, ref: REF, specSource: 'paul', labels: false, adapterSetup: false },
    io(git),
  );
  const skills = fs.readdirSync(path.join(root, '.claude', 'skills')).sort();
  assert.deepEqual(skills, ['babysit-pr', 'run-spec']);
  assert.equal(
    read(root, '.claude', 'skills', 'run-spec', 'SKILL.md'),
    read(ROOT, 'skills', 'paul', 'run-spec', 'SKILL.md'),
  );
  assert.equal(
    result.files.find((f) => f.path === '.claude/skills/run-spec/SKILL.md').status,
    'created',
  );
  assert.equal(
    result.files.some((f) => f.path.includes('to-tickets')),
    false,
  );
});

test('doctor checks a PAUL project against its own skill set, and asks for a local PAUL install', () => {
  const { root, git } = project();
  runInit({ root, ref: REF, specSource: 'paul', labels: false, adapterSetup: false }, io(git));
  const gh = (args) => {
    throw new Error(`gh ${args.join(' ')}`);
  };
  const find = (results, name) => results.find((r) => r.name === name);

  const before = runDoctor(root, { git, gh });
  assert.equal(find(before, 'skills').status, 'ok', 'two skills are the whole set');
  assert.equal(find(before, 'adapter').status, 'ok');
  assert.equal(find(before, 'paul install').status, 'fail');
  assert.match(find(before, 'paul install').detail, /apply\.md, unify\.md/);

  for (const name of ['apply.md', 'unify.md']) {
    fs.mkdirSync(path.join(root, '.claude', 'commands', 'paul'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'commands', 'paul', name), 'x');
  }
  assert.equal(find(runDoctor(root, { git, gh }), 'paul install').status, 'ok');
});

test('upgrade refreshes a PAUL project to its own run-spec and adds no other skill', () => {
  const { root, git } = project();
  runInit({ root, ref: REF, specSource: 'paul', labels: false, adapterSetup: false }, io(git));
  const installed = path.join(root, '.claude', 'skills', 'run-spec', 'SKILL.md');
  fs.writeFileSync(installed, 'an older run-spec\n');
  const NEW = 'b'.repeat(40);
  const result = runUpgrade({ root, ref: NEW, checkoutCommit: NEW }, { gh: () => NEW });
  assert.equal(read(installed), skillText('run-spec', 'paul'));
  assert.deepEqual(
    result.files.filter((f) => f.path.startsWith('.claude/skills/')).map((f) => [f.path, f.status]),
    [
      ['.claude/skills/run-spec/SKILL.md', 'updated'],
      ['.claude/skills/babysit-pr/SKILL.md', 'unchanged'],
    ],
  );
});

test('an OpenSpec project is not asked for PAUL', () => {
  const { root, git } = project();
  runInit({ root, ref: REF, labels: false, adapterSetup: false }, io(git));
  const results = runDoctor(root, {
    git,
    gh: () => {
      throw new Error('gh');
    },
  });
  assert.equal(
    results.some((r) => r.name === 'paul install'),
    false,
  );
});
