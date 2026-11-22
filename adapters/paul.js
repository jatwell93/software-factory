'use strict';

/**
 * The PAUL spec-source adapter. A PAUL project keeps its plan under `.paul/`:
 *
 *   .paul/ROADMAP.md                          `### Phase N: Name`, then plan lines
 *                                             `- [ ] 01-02: description`
 *   .paul/phases/<NN-slug>/<NN-NN>-PLAN.md    one per plan, YAML frontmatter
 *   .paul/milestones/*.md                     archives of shipped milestones
 *
 * A change is a phase directory (its id is the slug without the number), a task
 * is a plan (its id is the plan id in dotted form: `01-02` is `1.2`, `02.1-01` is
 * `2.1.1`). PAUL has no field for the factory's settings or for archiving one
 * phase, so two files of the factory's own sit in the phase directory:
 *
 *   factory.yml   merge / pr / no_go / issue / owner (see readAutonomy)
 *   ARCHIVED      written by archive(); PAUL ignores it
 *
 * The adapter never runs PAUL, and ticking a task edits the roadmap line only:
 * PAUL's own close step (UNIFY) writes the SUMMARY and STATE.md. The decisions are
 * in openspec/changes/add-paul-adapter/design.md of the project that planned them.
 */

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { idProblem, titleProblem } = require('../lib/change-id.js');
const { fsSource } = require('./openspec.js');

const NAME = 'paul';
const PAUL = '.paul';
const PHASES = `${PAUL}/phases`;
const MILESTONES = `${PAUL}/milestones`;
const ROADMAP = `${PAUL}/ROADMAP.md`;
const MARKER = 'ARCHIVED';
const SIDECAR = 'factory.yml';

const PHASE_DIR = /^(\d+(?:\.\d+)?)-([a-z0-9][a-z0-9-]*)$/;
const PHASE_HEADING = /^#{2,4}\s+Phase\s+(\d+(?:\.\d+)?):\s*(.*?)\s*(?:\[INSERTED\])?\s*$/;
const PLAN_LINE = /^(\s*)- \[([ xX])\] (\d+(?:\.\d+)?-\d+):\s*(.*)$/;
const SIDECAR_KEYS = new Set(['merge', 'pr', 'no_go', 'issue', 'owner']);

class PaulFormatError extends Error {
  /** A file of the project is wrong, not the run: callers report it instead of crashing. */
  userError = true;
}

/** "02.1" to "2.1": leading zeros drop in each number. */
const normalNumber = (num) => num.split('.').map(Number).join('.');

/** A plan id to its task id: "01-02" is "1.2", "02.1-01" is "2.1.1". */
function taskIdOf(planId) {
  const m = /^(\d+(?:\.\d+)?)-(\d+)$/.exec(planId);
  if (!m) throw new PaulFormatError(`not a plan id: ${planId}`);
  return `${normalNumber(m[1])}.${Number(m[2])}`;
}

/** A plan id ("01-03") or a task id ("1.3") to a task id; anything else is a format error. */
function toTaskId(value, where) {
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?-\d+$/.test(text)) return taskIdOf(text);
  if (/^\d+(?:\.\d+)+$/.test(text)) return text;
  throw new PaulFormatError(`${where}: "${text}" is not a plan id such as 01-03`);
}

/**
 * The phases of a roadmap: number, name and plan lines, in file order.
 * @returns {{num: string, name: string, plans: {line: number, done: boolean, planId: string, title: string}[]}[]}
 */
function parseRoadmap(text) {
  const phases = [];
  let current = null;
  (text || '').split(/\r?\n/).forEach((line, i) => {
    const heading = PHASE_HEADING.exec(line);
    if (heading) {
      current = { num: normalNumber(heading[1]), name: heading[2], plans: [] };
      phases.push(current);
      return;
    }
    if (/^#{1,3}\s/.test(line)) current = null;
    const plan = current && PLAN_LINE.exec(line);
    if (plan) {
      current.plans.push({
        line: i,
        done: plan[2] !== ' ',
        planId: plan[3],
        title: plan[4].trim(),
      });
    }
  });
  return phases;
}

/** The `factory.yml` sidecar as autonomy settings plus the owner task ids. */
function parseSidecar(text) {
  let doc;
  try {
    doc = YAML.parse(text || '');
  } catch (error) {
    throw new PaulFormatError(`${SIDECAR} is not valid YAML: ${error.message.split('\n')[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PaulFormatError(`${SIDECAR} must be a mapping of keys`);
  }
  for (const key of Object.keys(doc)) {
    if (!SIDECAR_KEYS.has(key)) throw new PaulFormatError(`${SIDECAR}: unknown key ${key}`);
  }
  if (doc.merge !== undefined && doc.merge !== 'human') {
    throw new PaulFormatError(`${SIDECAR}: merge must be human`);
  }
  if (doc.pr !== undefined && doc.pr !== 'per-task' && doc.pr !== 'per-change') {
    throw new PaulFormatError(`${SIDECAR}: pr must be per-task or per-change`);
  }
  const list = (key) => {
    const value = doc[key] ?? [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new PaulFormatError(`${SIDECAR}: ${key} must be a list of text`);
    }
    return value.map((item) => item.trim());
  };
  if (doc.issue !== undefined && !(Number.isInteger(doc.issue) && doc.issue > 0)) {
    throw new PaulFormatError(`${SIDECAR}: issue must be a positive number`);
  }
  const autonomy = {
    merge: 'human',
    pr: doc.pr === 'per-change' ? 'per-change' : 'per-task',
    noGo: list('no_go'),
  };
  if (doc.issue) autonomy.issue = doc.issue;
  return { autonomy, owner: new Set(list('owner').map((id) => toTaskId(id, `${SIDECAR}: owner`))) };
}

/** A plan file's frontmatter, as `{owner, blockedBy}`; no file means neither. */
function parsePlan(text) {
  if (text === null) return { owner: false, blockedBy: [] };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { owner: false, blockedBy: [] };
  let front;
  try {
    front = YAML.parse(m[1]) || {};
  } catch (error) {
    throw new PaulFormatError(
      `a PLAN.md frontmatter is not valid YAML: ${error.message.split('\n')[0]}`,
    );
  }
  const depends = front.depends_on ?? [];
  if (!Array.isArray(depends)) throw new PaulFormatError('PLAN.md: depends_on must be a list');
  return {
    // A plan that needs the user at a checkpoint cannot run unattended.
    owner: front.autonomous === false,
    blockedBy: depends.map((id) => toTaskId(id, 'PLAN.md depends_on')),
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.root] The project root, the folder that holds .paul/.
 * @param {{read: Function, list: Function}} [options.source] Read another place than the
 *   disk (a branch, through the GitHub contents API); an adapter with one is read-only.
 * @param {number} [options.maxIdLength] The longest id scaffold accepts.
 * @param {() => Date} [options.now]
 */
function createPaulAdapter({
  root = process.cwd(),
  source = null,
  maxIdLength = 42,
  now = () => new Date(),
} = {}) {
  const src = source || fsSource(root);
  const writable = () => {
    if (source) throw new Error('this adapter reads a branch and is read-only');
  };

  /** Phase directories as {dir, num, slug}, in name order. Names that are not NN-slug are skipped. */
  const phaseDirs = () =>
    src
      .list(PHASES)
      .filter((e) => e.dir)
      .map((e) => ({ dir: e.name, match: PHASE_DIR.exec(e.name) }))
      .filter((e) => e.match)
      .map((e) => ({ dir: e.dir, num: normalNumber(e.match[1]), slug: e.match[2] }))
      .sort((a, b) => a.dir.localeCompare(b.dir, 'en', { numeric: true }));

  /** The phase directory of a change id, or null: unknown, and also a slug two phases share. */
  const phaseOf = (changeId) => {
    if (typeof changeId !== 'string') return null;
    const found = phaseDirs().filter((p) => p.slug === changeId);
    return found.length === 1 ? found[0] : null;
  };

  /** Phase numbers a shipped milestone's archive lists, with the first name given for each. */
  const milestonePhases = () => {
    const found = new Map();
    for (const entry of src.list(MILESTONES).filter((e) => !e.dir && /\.md$/i.test(e.name))) {
      for (const phase of parseRoadmap(src.read(`${MILESTONES}/${entry.name}`) || '')) {
        if (!found.has(phase.num)) found.set(phase.num, phase.name);
      }
    }
    return found;
  };

  const markedArchived = (phase) => src.read(`${PHASES}/${phase.dir}/${MARKER}`) !== null;
  const archived = (phase) => markedArchived(phase) || milestonePhases().has(phase.num);

  const need = (changeId) => {
    const phase = phaseOf(changeId);
    if (!phase || archived(phase)) throw new Error(`no active change ${changeId}`);
    return phase;
  };

  const roadmapPhase = (phase) =>
    parseRoadmap(src.read(ROADMAP) || '').find((p) => p.num === phase.num) || null;

  const sidecarOf = (phase) => parseSidecar(src.read(`${PHASES}/${phase.dir}/${SIDECAR}`));

  return {
    name: NAME,

    listChanges() {
      const bySlug = new Map();
      for (const phase of phaseDirs())
        bySlug.set(phase.slug, [...(bySlug.get(phase.slug) || []), phase]);
      return [...bySlug.values()]
        .filter((same) => same.length === 1 && !archived(same[0]))
        .map(([phase]) => ({ id: phase.slug }));
    },

    listTasks(changeId) {
      const phase = need(changeId);
      const section = roadmapPhase(phase);
      if (!section) return [];
      const { owner } = sidecarOf(phase);
      return section.plans.map((plan) => {
        const id = taskIdOf(plan.planId);
        const file = parsePlan(src.read(`${PHASES}/${phase.dir}/${plan.planId}-PLAN.md`));
        return {
          id,
          title: plan.title,
          done: plan.done,
          owner: file.owner || owner.has(id),
          blockedBy: file.blockedBy,
        };
      });
    },

    readAutonomy: (changeId) => sidecarOf(need(changeId)).autonomy,

    tickTask(changeId, taskId) {
      writable();
      const phase = need(changeId);
      const section = roadmapPhase(phase);
      const plan = section && section.plans.find((p) => taskIdOf(p.planId) === taskId);
      if (!plan) throw new Error(`no task ${taskId} in ${changeId}`);
      if (plan.done) return;
      const file = path.join(root, ROADMAP);
      // Split on the line ending but keep it, so a CRLF file stays CRLF.
      const rows = fs.readFileSync(file, 'utf8').split(/(?<=\n)/);
      rows[plan.line] = rows[plan.line].replace('- [ ] ', '- [x] ');
      fs.writeFileSync(file, rows.join(''));
    },

    archive(changeId) {
      writable();
      const phase = need(changeId);
      const date = now().toISOString().slice(0, 10);
      fs.writeFileSync(path.join(root, PHASES, phase.dir, MARKER), `archived: ${date}\n`);
    },

    scaffold(changeId, { title } = {}) {
      writable();
      const problem = idProblem(changeId, maxIdLength);
      if (problem) throw new Error(problem);
      if (title !== undefined) {
        const titleIssue = titleProblem(title);
        if (titleIssue) throw new Error(titleIssue);
      }
      if (phaseDirs().some((p) => p.slug === changeId))
        throw new Error(`change ${changeId} exists`);
      const roadmapFile = path.join(root, ROADMAP);
      if (!fs.existsSync(roadmapFile)) {
        throw new Error(`no ${ROADMAP}: run PAUL's own init in the project first`);
      }
      const text = fs.readFileSync(roadmapFile, 'utf8');
      // Phase numbers are never reused, so the next is above every one seen anywhere.
      const seen = [
        ...phaseDirs().map((p) => p.num),
        ...parseRoadmap(text).map((p) => p.num),
        ...milestonePhases().keys(),
      ].map((num) => Number(num.split('.')[0]));
      const number = String(Math.max(0, ...seen) + 1);
      const dir = `${number.padStart(2, '0')}-${changeId}`;
      const full = path.join(root, PHASES, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, SIDECAR), 'merge: human\n');
      const nl = text.includes('\r\n') ? '\r\n' : '\n';
      const section = [`### Phase ${number}: ${title || changeId}`, '', '**Plans:**', ''].join(nl);
      fs.writeFileSync(roadmapFile, `${text.replace(/\s*$/, '')}${nl}${nl}${section}`);
      return { path: `${PHASES}/${dir}` };
    },

    setup(projectRoot) {
      writable();
      // PAUL's installer is not run from here: a project is set up with PAUL itself.
      if (!fs.existsSync(path.join(projectRoot, ROADMAP))) {
        throw new Error(`no ${ROADMAP}: run PAUL's own init in the project first`);
      }
      return { changed: false };
    },

    isArchived(changeId) {
      const phase = phaseOf(changeId);
      return Boolean(phase) && archived(phase);
    },

    archivedTitle(changeId) {
      const phase = phaseOf(changeId);
      if (!phase || !archived(phase)) return '';
      return roadmapPhase(phase)?.name || milestonePhases().get(phase.num) || '';
    },

    /** Pure: it reads no file, so a phase a PR deletes still counts. */
    changesIn(paths) {
      const slugs = paths
        .map((p) => /^\.paul\/phases\/([^/]+)\//.exec(p.trim()))
        .map((m) => m && PHASE_DIR.exec(m[1]))
        .filter(Boolean)
        .map((m) => m[2]);
      return [...new Set(slugs)];
    },
  };
}

module.exports = {
  NAME,
  PaulFormatError,
  createPaulAdapter,
  normalNumber,
  parsePlan,
  parseRoadmap,
  parseSidecar,
  taskIdOf,
};
