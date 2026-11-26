const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');

const root = path.join(__dirname, '..');
const SKILLS = ['run-spec', 'to-tickets', 'babysit-pr', 'handover', 'resume-change'];
const schema = require('../schema/factory.config.schema.json');

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
// A name is a skill, or <spec source>/<skill> for a source's own version of one.
const body = (name) => read('skills', ...name.split('/'), 'SKILL.md');
const lines = (name) => body(name).split(/\r?\n/);

const VARIANTS = ['paul/run-spec'];

test('the skills folder holds the five skills and the folders of spec-source variants', () => {
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'skills')).sort(),
    [...SKILLS, ...new Set(VARIANTS.map((v) => v.split('/')[0]))].sort(),
  );
});

for (const name of [...SKILLS, ...VARIANTS]) {
  test(`${name}: frontmatter names the skill and describes when to use it`, () => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(body(name));
    assert.ok(match, 'frontmatter present');
    const meta = parse(match[1]);
    assert.equal(meta.name, name.split('/').pop());
    assert.ok(meta.description.length > 80, 'a description the model can match on');
  });

  test(`${name}: reaches factory scripts only through $FACTORY_DIR, and they exist`, () => {
    const text = body(name);
    assert.doesNotMatch(text, /node (?:\.\/)?scripts\//, 'a bare scripts/ path');
    const used = [...text.matchAll(/\$FACTORY_DIR\/scripts\/([a-z-]+\.js)/g)].map((m) => m[1]);
    for (const script of used) {
      assert.ok(fs.existsSync(path.join(root, 'scripts', script)), `${script} exists`);
    }
  });

  test(`${name}: no command of it holds a shell variable of its own or a command substitution`, () => {
    // The runner denies any command containing a shell variable, so $FACTORY_DIR is the
    // one variable a skill may name, and the prompt gives its literal path.
    const text = body(name).replaceAll('$FACTORY_DIR', '');
    assert.doesNotMatch(text, /\$\(/, 'a command substitution');
    assert.doesNotMatch(text, /\$[A-Za-z_{]/, 'a shell variable');
  });

  test(`${name}: says the runner's prompt gives the literal factory path`, () => {
    assert.match(body(name), /the prompt\s+gives the literal path/);
  });

  test(`${name}: names no project, owner, label or branch of one repository`, () => {
    const text = body(name);
    assert.doesNotMatch(text, /jatwell93|date-management/i);
    assert.doesNotMatch(text, /npm run|workers\/|frontend\/|doppler|AGENTS\.md §/i);
    assert.doesNotMatch(text, /factory:<id>/, 'the change label comes from labels.change_prefix');
    assert.doesNotMatch(text, /\bmain\b/, 'the default branch comes from default_branch');
    for (const line of lines(name)) {
      if (/needs-human|factory-ready/.test(line)) {
        assert.match(line, /default/, `a label name only as a stated default: ${line}`);
      }
    }
  });

  test(`${name}: repeats no word, even across a line break`, () => {
    assert.doesNotMatch(body(name), /\b(\w+)\s+\1\b/i);
  });

  test(`${name}: needs no memory store`, () => {
    assert.doesNotMatch(body(name), /mem-log|mem-recall|memory\.jsonl/);
  });

  test(`${name}: every config key it names is in the schema`, () => {
    const known = [...Object.keys(schema.properties.labels.properties).map((k) => `labels.${k}`)];
    for (const m of body(name).matchAll(/`(labels\.[a-z_]+)`/g)) {
      assert.ok(known.includes(m[1]), `${m[1]} is a config key`);
    }
  });
}

test('the settings the skills read are config keys that exist', () => {
  const used = {
    'run-spec': [
      'owner',
      'default_branch',
      'branch_prefix',
      'labels.change_prefix',
      'labels.needs_human',
      'gates',
    ],
    'babysit-pr': [
      'owner',
      'default_branch',
      'labels.needs_human',
      'review_bots',
      'ci_workflows',
      'max_babysit_rounds',
    ],
    'to-tickets': [
      'labels.change_prefix',
      'labels.ready',
      'change_id_max_length',
      'default_branch',
    ],
  };
  for (const [name, keys] of Object.entries(used)) {
    for (const key of keys) {
      const [group, sub] = key.split('.');
      const exists = sub ? schema.properties[group]?.properties?.[sub] : schema.properties[group];
      assert.ok(exists, `${key} is in the schema`);
      assert.ok(body(name).includes(`\`${key}\``), `${name} names ${key}`);
    }
  }
});

test('the flags a skill passes to a script are ones the script reads', () => {
  const flags = {
    'pr-feedback.js': ['--summary', 'reply', 'resolve'],
    'check-no-go.js': ['--change'],
  };
  for (const [script, wanted] of Object.entries(flags)) {
    const source = read('scripts', script);
    for (const flag of wanted) assert.ok(source.includes(flag), `${script} reads ${flag}`);
  }
  assert.match(body('babysit-pr'), /--summary/);
  assert.match(body('run-spec'), /--change/);
});

test('babysit-pr starts itself for the owner’s own PR and stops at ready or safe', () => {
  const text = body('babysit-pr');
  assert.match(text, /## Your own pull request/);
  // The description is matched before the body: it must not forbid what the body allows.
  const description = text.split('---')[0] + text.split('---')[1];
  assert.doesNotMatch(description, /Do NOT use[^.]*PRs\s+on branches you did not create/);
  assert.match(description, /names such a PR with "\/babysit-pr <n>"/);
  assert.match(text, /right after\s+`gh pr create`/);
  assert.match(text, /factory-status\.js" <n>/);
  assert.match(text, /On `safe`[\s\S]*do not wait out the quiet window/);
  assert.match(text, /gh pr checkout <n>[\s\S]*clean working\s+tree/);
  // The script it relies on exists and exits 0 for ready and safe.
  assert.match(read('scripts', 'factory-status.js'), /ready.*safe|safe.*ready/s);
  assert.match(read('templates', 'agents-block.md'), /Your own pull requests[^\n]*babysit-pr <n>/);
});

test('both run-spec skills check for ignored source files before the push', () => {
  for (const name of ['run-spec', 'paul/run-spec']) {
    const text = body(name);
    const push = text.indexOf('## 4. Check, push, open the PR');
    const step = text.slice(push, text.indexOf('2. `git push -u origin HEAD`.', push));
    assert.match(step, /scripts\/check-ignored\.js/, name);
    assert.match(step, /do not push, and\s+do not `git add -f` it/, name);
  }
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'check-ignored.js')));
});

test('the runner prompt points at skills that this repo ships', () => {
  const workflow = read('.github', 'workflows', 'factory.yml');
  for (const [, name] of workflow.matchAll(/\.claude\/skills\/([a-z-]+)\/SKILL\.md/g)) {
    assert.ok(SKILLS.includes(name), `${name} is shipped`);
  }
});

test('run-spec keeps the per-task rules the router and babysit-round depend on', () => {
  const text = body('run-spec');
  assert.match(text, /Factory-Task: <task-number>/);
  assert.match(text, /Factory-Task: archive/);
  assert.match(text, /babysit-round\.js/);
});

test('to-tickets keeps its licence notice and the exact ticket-number form', () => {
  const text = body('to-tickets');
  assert.match(text, /MIT License, Copyright \(c\) 2026 Matt/);
  assert.match(text, /\(#<n>\):/);
  assert.match(text, /check-change-ids\.js/);
});
