'use strict';

/**
 * The OpenSpec spec-source adapter: changes are folders under
 * openspec/changes/<id>/ with a proposal.md (its `## Autonomy` block holds the
 * factory's settings) and a tasks.md (numbered checkboxes).
 *
 *   - [ ] 2.3 (owner) Title (#812): more text
 *         Blocked by: 2.1, 2.2.
 *
 * `(owner)` marks a task only the owner can do, `(#812):` is the task's ticket,
 * and a `Blocked by:` line under a task names the tasks that come first.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ID_PATTERN, idProblem } = require('../lib/change-id.js');

const NAME = 'openspec';
const TASK_NUMBER = /^[0-9][0-9A-Za-z.]{0,19}$/;
const TASK_LINE = /^(\s*)- \[([ xX])\] (\S+)\s+(.*)$/;

/** Lines of the first yaml fence under `## Autonomy`, or []. */
function autonomyYaml(lines) {
  const heading = lines.findIndex((l) => /^##\s+Autonomy\s*$/.test(l));
  const fence = lines.findIndex((l, i) => heading !== -1 && i > heading && /^```ya?ml\s*$/.test(l));
  if (fence === -1) return [];
  const body = lines.slice(fence + 1);
  const end = body.findIndex((l) => /^```/.test(l));
  return end === -1 ? body : body.slice(0, end);
}

/** A yaml scalar without its comment and quotes. */
function scalar(text) {
  return text
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

const isFiller = (line) => /^\s*(#.*)?$/.test(line);

class NoGoFormatError extends Error {
  /** The spec file is wrong, not the run: callers report it instead of crashing. */
  userError = true;
}

/**
 * The `no_go` list from the first yaml fence under `## Autonomy`, or [].
 * Reads a block list (`  - path`, with blank and comment lines between items)
 * or a one-line flow list (`no_go: [a, b]`). Any other shape throws
 * NoGoFormatError instead of being read partly: a misread list would silently
 * drop protected paths, so an unrecognised one fails the check.
 */
function parseNoGo(proposal) {
  const yaml = autonomyYaml(proposal.split(/\r?\n/));
  const key = yaml.findIndex((l) => /^no_go:/.test(l));
  if (key === -1) return [];
  const inline = scalar(yaml[key].slice('no_go:'.length));
  if (inline) return flowList(inline, yaml[key]);
  return blockList(yaml.slice(key + 1));
}

/** `[a, b]` to its items; any other inline value is unrecognised. */
function flowList(inline, line) {
  const flow = inline.match(/^\[(.*)\]$/);
  if (!flow) throw new NoGoFormatError(`unrecognised no_go value: ${line.trim()}`);
  return flow[1].split(',').map(scalar).filter(Boolean);
}

/** `- item` lines up to the next top-level key; an indented non-item is unrecognised. */
function blockList(rest) {
  // Items may be indented or not: YAML allows `- path` at the key's own column.
  const end = rest.findIndex((l) => !isFiller(l) && !/^\s*-\s/.test(l));
  if (end !== -1 && /^\s/.test(rest[end])) {
    throw new NoGoFormatError(`unrecognised line in no_go list: ${rest[end].trim()}`);
  }
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((l) => !isFiller(l))
    .map((l) => scalar(l.replace(/^\s*-\s+/, '')))
    .filter(Boolean);
}

/**
 * Folder names under changes/ that a list of changed paths touches, the archive
 * excluded. Pure: it reads no file, so a deleted or renamed change still counts.
 */
function changeFoldersIn(paths) {
  const names = paths
    .map((p) => p.trim().match(/^openspec\/changes\/([^/]+)\//))
    .filter((m) => m && m[1] !== 'archive')
    .map((m) => m[1]);
  return [...new Set(names)];
}

/** The body of the proposal's `## Autonomy` block, or ''. */
function autonomyBlock(text) {
  const autonomy = (text || '').split(/^## Autonomy[ \t]*$/m)[1] || '';
  return autonomy.split(/^## /m)[0];
}

/**
 * The `issue: N` key of the Autonomy block, or 0. Only this explicit key counts:
 * a proposal cites other issues in passing, and adopting one of those would post
 * the factory's escalations on an unrelated issue.
 */
function issueFromProposal(text) {
  const m = /^issue:[ \t]*#?([1-9][0-9]*)[ \t]*(#.*)?$/m.exec(autonomyBlock(text));
  return m ? Number(m[1]) : 0;
}

/** True when the Autonomy block says `pr: per-change`. Without the key each task gets its own PR. */
function perChangeFromProposal(text) {
  return /^pr:[ \t]*per-change[ \t]*(#.*)?$/m.test(autonomyBlock(text));
}

/**
 * Task ids named on a `Blocked by:` line, in order. Only ids of tasks in the
 * same file count: the line often ends in prose ("... on 2 hosts"), and a number
 * in it is not a blocker.
 */
function blockedIds(text, known) {
  return (text.match(/[0-9]+(?:\.[0-9A-Za-z]+)*/g) || []).filter((id) => known.has(id));
}

/**
 * The line index of each task id's own line. A numbered sub-item repeating a
 * task's number (an indented `- [ ] 1.3`) never stands for the task: the
 * least-indented line wins, the first among equals.
 */
function taskLineIndexes(lines) {
  const best = new Map();
  lines.forEach((line, i) => {
    const m = TASK_LINE.exec(line);
    if (!m || !TASK_NUMBER.test(m[3])) return;
    const held = best.get(m[3]);
    if (!held || m[1].length < held.indent) best.set(m[3], { indent: m[1].length, index: i });
  });
  return new Set([...best.values()].map((b) => b.index));
}

/** The numbered tasks of a tasks.md. Unnumbered checkboxes (notes) are skipped. */
function parseTasks(tasksMd) {
  const lines = (tasksMd || '').split(/\r?\n/);
  const known = new Set(
    lines
      .map((line) => TASK_LINE.exec(line))
      .filter((m) => m && TASK_NUMBER.test(m[3]))
      .map((m) => m[3]),
  );
  const own = taskLineIndexes(lines);
  const tasks = [];
  lines.forEach((line, i) => {
    const m = TASK_LINE.exec(line);
    if (!m || !TASK_NUMBER.test(m[3]) || !own.has(i)) return;
    const owner = /^\(owner\)(\s|$)/.test(m[4]);
    const text = m[4].replace(/^\(owner\)\s*/, '');
    const ticket = /\(#([1-9][0-9]*)\):/.exec(text);
    const blockedBy = [];
    for (const next of lines.slice(i + 1)) {
      if (TASK_LINE.test(next) || /^#/.test(next)) break;
      const blocked = /^\s*Blocked by:\s*(.*)$/.exec(next);
      if (blocked) blockedBy.push(...blockedIds(blocked[1], known));
    }
    const task = {
      id: m[3],
      title: (ticket ? text.slice(0, ticket.index) : text).trim(),
      done: m[2] !== ' ',
      owner,
      blockedBy,
    };
    if (ticket) task.issue = Number(ticket[1]);
    tasks.push(task);
  });
  return tasks;
}

// Characters cmd.exe acts on even inside double quotes.
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/**
 * Arguments for a command run through cmd.exe, which Windows needs to start the
 * openspec .cmd shim (Node refuses to spawn a .cmd without a shell). Each is
 * wrapped in double quotes; one with a character cmd.exe would still act on is
 * refused, because a folder named `a&calc` must never become a second command.
 */
function cmdArgs(args) {
  return args.map((arg) => {
    if (CMD_UNSAFE.test(arg))
      throw new Error(`argument cannot be passed to cmd.exe safely: ${arg}`);
    // A backslash before the closing quote would escape it, so double any at the end.
    return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
  });
}

const defaultRun = (args, { cwd }) =>
  process.platform === 'win32'
    ? execFileSync('openspec', cmdArgs(args), { cwd, stdio: 'pipe', shell: true })
    : execFileSync('openspec', args, { cwd, stdio: 'pipe' });

const CHANGES = 'openspec/changes';

/** Reads the project files straight from disk. */
function fsSource(root) {
  return {
    read(rel) {
      const file = path.join(root, rel);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
    list(rel) {
      const dir = path.join(root, rel);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
    },
  };
}

/** True when an archive folder name is change `id`'s: `<YYYY-MM-DD>-<id>`. */
const isArchiveOf = (name, id) =>
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name) && name.slice(11) === id;

/** A proposal's title: its first heading without a "Proposal:" prefix, or ''. */
function titleOf(proposal) {
  const heading = /^# (.+)$/m.exec(proposal || '');
  return heading ? heading[1].replace(/^Proposal:/i, '').trim() : '';
}

/**
 * @param {object} [options]
 * @param {string} [options.root] The project root, the folder that holds openspec/.
 * @param {{read: (rel: string) => string|null, list: (rel: string) => {name: string, dir: boolean}[]}} [options.source]
 *   Where files are read from, instead of the project's disk: the router passes a
 *   GitHub-contents source to read a branch it has not checked out. An adapter
 *   with a source is read-only.
 * @param {(args: string[], opts: {cwd: string}) => void} [options.run] Runs the openspec CLI; injected by tests.
 * @param {string} [options.tools] The agent tools `openspec init` configures (default claude).
 * @param {number} [options.maxIdLength] The longest id scaffold accepts.
 * @param {() => Date} [options.now]
 */
function createOpenSpecAdapter({
  root = process.cwd(),
  source = null,
  run = defaultRun,
  tools = 'claude',
  maxIdLength = 42,
  now = () => new Date(),
} = {}) {
  const src = source || fsSource(root);
  // A change id is a folder name, never a path: nothing here may walk out of changes/.
  const isName = (changeId) => /^[^/\\]+$/.test(changeId) && changeId !== '.' && changeId !== '..';
  const checkName = (changeId) => {
    if (!isName(changeId)) throw new Error(`not a change id: ${changeId}`);
  };
  const dirOf = (changeId) => {
    checkName(changeId);
    return path.join(root, 'openspec', 'changes', changeId);
  };
  // Writes go to the project's disk, so an adapter reading another source cannot make them.
  const writable = () => {
    if (source) throw new Error('this adapter reads a branch and is read-only');
  };
  const hasProposal = (changeId) => src.read(`${CHANGES}/${changeId}/proposal.md`) !== null;
  const need = (changeId) => {
    checkName(changeId);
    if (changeId === 'archive' || !hasProposal(changeId)) {
      throw new Error(`no active change ${changeId}`);
    }
  };
  const read = (changeId, file) => {
    need(changeId);
    return src.read(`${CHANGES}/${changeId}/${file}`) ?? '';
  };
  /**
   * The archive folder name of a change, or ''. An id that is not a folder name
   * matches no entry (a folder name has no slash), so it needs no guard and
   * never rejects.
   */
  const archiveDirOf = (changeId) => {
    const entry = src
      .list(`${CHANGES}/archive`)
      .find((e) => e.dir && isArchiveOf(e.name, changeId));
    return entry ? entry.name : '';
  };

  return {
    name: NAME,

    listChanges() {
      return src
        .list(CHANGES)
        .filter((e) => e.dir && e.name !== 'archive' && hasProposal(e.name))
        .map((e) => ({ id: e.name }));
    },

    listTasks: (changeId) => parseTasks(read(changeId, 'tasks.md')),

    readAutonomy(changeId) {
      const proposal = read(changeId, 'proposal.md');
      const autonomy = {
        merge: 'human',
        pr: perChangeFromProposal(proposal) ? 'per-change' : 'per-task',
        noGo: parseNoGo(proposal),
      };
      const issue = issueFromProposal(proposal);
      if (issue) autonomy.issue = issue;
      return autonomy;
    },

    tickTask(changeId, taskId) {
      writable();
      need(changeId);
      const file = path.join(dirOf(changeId), 'tasks.md');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      let found = false;
      // Split on the line ending but keep it, so a CRLF file stays CRLF.
      const rows = text.split(/(?<=\n)/);
      const own = taskLineIndexes(rows.map((row) => row.replace(/\r?\n$/, '')));
      const out = rows
        .map((line, i) => {
          const m = TASK_LINE.exec(line.replace(/\r?\n$/, ''));
          if (!m || m[3] !== taskId || !TASK_NUMBER.test(m[3]) || !own.has(i)) return line;
          found = true;
          return m[2] === ' ' ? line.replace('- [ ] ', '- [x] ') : line;
        })
        .join('');
      if (!found) throw new Error(`no task ${taskId} in ${changeId}`);
      if (out !== text) fs.writeFileSync(file, out);
    },

    archive(changeId) {
      writable();
      need(changeId);
      // The id reaches a command line: only a plain id, which has no shell characters.
      if (!ID_PATTERN.test(changeId)) {
        throw new Error(`cannot archive ${changeId}: rename the folder to a valid change id first`);
      }
      run(['archive', '-y', changeId], { cwd: root });
    },

    scaffold(changeId, { title } = {}) {
      writable();
      const problem = idProblem(changeId, maxIdLength);
      if (problem) throw new Error(problem);
      if (changeId === 'archive') throw new Error('archive is reserved for finished changes');
      const dir = dirOf(changeId);
      if (fs.existsSync(dir)) throw new Error(`change ${changeId} exists`);
      fs.mkdirSync(dir, { recursive: true });
      const created = now().toISOString().slice(0, 10);
      const heading = title || changeId;
      fs.writeFileSync(
        path.join(dir, '.openspec.yaml'),
        `schema: spec-driven\ncreated: ${created}\n`,
      );
      fs.writeFileSync(
        path.join(dir, 'proposal.md'),
        `# Proposal: ${heading}\n\n## Why\n\n## What changes\n\n## Autonomy\n\n\`\`\`yaml\nmerge: human\n\`\`\`\n`,
      );
      fs.writeFileSync(path.join(dir, 'tasks.md'), `# Tasks: ${heading}\n`);
      return { path: path.relative(root, dir).split(path.sep).join('/') };
    },

    setup(projectRoot) {
      writable();
      if (fs.existsSync(path.join(projectRoot, 'openspec', 'config.yaml')))
        return { changed: false };
      run(['init', '--tools', tools, '--no-animation', projectRoot], { cwd: projectRoot });
      return { changed: true };
    },

    isArchived: (changeId) => archiveDirOf(changeId) !== '',

    archivedTitle(changeId) {
      const dir = archiveDirOf(changeId);
      if (!dir) return '';
      return titleOf(src.read(`${CHANGES}/archive/${dir}/proposal.md`));
    },

    changesIn: (paths) => changeFoldersIn(paths),
  };
}

module.exports = {
  NAME,
  createOpenSpecAdapter,
  cmdArgs,
  fsSource,
  isArchiveOf,
  titleOf,
  parseNoGo,
  NoGoFormatError,
  changeFoldersIn,
  parseTasks,
  autonomyBlock,
  issueFromProposal,
  perChangeFromProposal,
};
