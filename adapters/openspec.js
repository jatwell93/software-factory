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
const { parseNoGo, changeFolders, changesDir } = require('../lib/openspec-reads.js');

const NAME = 'openspec';
const TASK_NUMBER = /^[0-9][0-9A-Za-z.]{0,19}$/;
const TASK_LINE = /^(\s*)- \[([ xX])\] (\S+)\s+(.*)$/;

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

/** The numbered tasks of a tasks.md. Unnumbered checkboxes (notes) are skipped. */
function parseTasks(tasksMd) {
  const lines = (tasksMd || '').split(/\r?\n/);
  const known = new Set(
    lines
      .map((line) => TASK_LINE.exec(line))
      .filter((m) => m && TASK_NUMBER.test(m[3]))
      .map((m) => m[3]),
  );
  const tasks = [];
  lines.forEach((line, i) => {
    const m = TASK_LINE.exec(line);
    if (!m || !TASK_NUMBER.test(m[3])) return;
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

/**
 * @param {object} [options]
 * @param {string} [options.root] The project root, the folder that holds openspec/.
 * @param {(args: string[], opts: {cwd: string}) => void} [options.run] Runs the openspec CLI; injected by tests.
 * @param {string} [options.tools] The agent tools `openspec init` configures (default claude).
 * @param {number} [options.maxIdLength] The longest id scaffold accepts.
 * @param {() => Date} [options.now]
 */
function createOpenSpecAdapter({
  root = process.cwd(),
  run = defaultRun,
  tools = 'claude',
  maxIdLength = 42,
  now = () => new Date(),
} = {}) {
  const dirOf = (changeId) => {
    // A folder name, never a path: nothing here may walk out of changes/.
    if (!/^[^/\\]+$/.test(changeId) || changeId === '.' || changeId === '..') {
      throw new Error(`not a change id: ${changeId}`);
    }
    return path.join(changesDir(root), changeId);
  };
  const need = (changeId) => {
    const dir = dirOf(changeId);
    if (changeId === 'archive' || !fs.existsSync(path.join(dir, 'proposal.md'))) {
      throw new Error(`no active change ${changeId}`);
    }
    return dir;
  };
  const read = (changeId, file) => {
    const target = path.join(need(changeId), file);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  };

  return {
    name: NAME,

    listChanges() {
      return changeFolders(root)
        .filter((id) => fs.existsSync(path.join(dirOf(id), 'proposal.md')))
        .map((id) => ({ id }));
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
      const file = path.join(need(changeId), 'tasks.md');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      let found = false;
      // Split on the line ending but keep it, so a CRLF file stays CRLF.
      const out = text
        .split(/(?<=\n)/)
        .map((line) => {
          const m = TASK_LINE.exec(line.replace(/\r?\n$/, ''));
          if (!m || m[3] !== taskId || !TASK_NUMBER.test(m[3])) return line;
          found = true;
          return m[2] === ' ' ? line.replace('- [ ] ', '- [x] ') : line;
        })
        .join('');
      if (!found) throw new Error(`no task ${taskId} in ${changeId}`);
      if (out !== text) fs.writeFileSync(file, out);
    },

    archive(changeId) {
      need(changeId);
      // The id reaches a command line: only a plain id, which has no shell characters.
      if (!ID_PATTERN.test(changeId)) {
        throw new Error(`cannot archive ${changeId}: rename the folder to a valid change id first`);
      }
      run(['archive', '-y', changeId], { cwd: root });
    },

    scaffold(changeId, { title } = {}) {
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
      if (fs.existsSync(path.join(projectRoot, 'openspec', 'config.yaml')))
        return { changed: false };
      run(['init', '--tools', tools, '--no-animation', projectRoot], { cwd: projectRoot });
      return { changed: true };
    },
  };
}

module.exports = {
  NAME,
  createOpenSpecAdapter,
  cmdArgs,
  parseTasks,
  autonomyBlock,
  issueFromProposal,
  perChangeFromProposal,
};
