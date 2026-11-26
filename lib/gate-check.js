'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Catches a gate that cannot pass before the first factory run finds out (#78).
 *
 * `staticGateProblems` is cheap and has no side effects: it reads the gate, the project's
 * package.json scripts and the file system, and runs nothing. `tryGates` runs each gate
 * once; the owner opts in (`doctor --try-gates`) because a gate may be slow, write files
 * or need a service.
 */

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const WRAPPERS = ['npx', 'pnpx', 'bunx'];
const SHELL_WORDS = new Set(['cd', 'echo', 'exit', 'test', 'export', 'set', 'source', '.', 'true']);
const TSC_PROJECT_FLAGS = ['-p', '--project', '-b', '--build', '--version', '-v', '--help', '-h'];
const MAX_EXPANSION = 3;

const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** A gate cut into the commands it chains, each as a list of words, env assignments dropped. */
function commandsOf(run) {
  return run
    .split(/&&|\|\||;/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((words) => {
      let start = 0;
      while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++;
      return words.slice(start);
    })
    .filter((words) => words.length > 0);
}

function packageScripts(root) {
  const text = readOrNull(path.join(root, 'package.json'));
  if (text === null) return {};
  try {
    return JSON.parse(text).scripts || {};
  } catch {
    return {};
  }
}

/** The package script a `npm run x` / `npm test` / `yarn x` command runs, or null. */
function scriptName(words) {
  const [manager, first, second] = words;
  if (!PACKAGE_MANAGERS.includes(manager)) return null;
  if (first === 'test' || first === 't') return 'test';
  if (first === 'run' || first === 'run-script') return second || null;
  if (manager === 'yarn' && first && !first.startsWith('-')) return first;
  return null;
}

/** Whether a command picks another folder (--prefix, -C, --cwd, --workspace): not checked. */
const movesFolder = (words) =>
  words.some((w) =>
    /^(--prefix|--cwd|--dir|-C|--workspace|-w|--filter|--workspaces|-ws)(=|$)/.test(w),
  );

function onPath(program, root) {
  if (SHELL_WORDS.has(program)) return true;
  if (program.includes('/') || program.includes('\\'))
    return fs.existsSync(path.resolve(root, program));
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  const folders = [
    path.join(root, 'node_modules', '.bin'),
    ...(process.env.PATH || '').split(path.delimiter),
  ];
  return folders.some((folder) =>
    extensions.some((ext) => folder && fs.existsSync(path.join(folder, program + ext))),
  );
}

/** First-level folders holding a tsconfig.json, to name in the fix. */
function tsconfigFolders(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter((e) => fs.existsSync(path.join(root, e.name, 'tsconfig.json')))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function tscProblem(words, root) {
  const at = words.indexOf('tsc');
  if (at === -1) return null;
  // `npx tsc`, `pnpm exec tsc`, `yarn tsc`: the word before is a wrapper, anything else is a path.
  const args = words.slice(at + 1);
  if (args.some((a) => TSC_PROJECT_FLAGS.includes(a) || /^--project=/.test(a))) return null;
  if (args.some((a) => /\.(ts|tsx|mts|cts)$/.test(a))) return null; // type-checks named files
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) return null;
  const folders = tsconfigFolders(root);
  const hint = folders.length
    ? `add -p <dir>, for example \`tsc -p ${folders[0]}\``
    : 'add -p <dir> to point at the TypeScript project';
  return `\`tsc\` runs from the repository root, which has no tsconfig.json: ${hint}`;
}

function problemsInCommand(words, root, scripts, depth) {
  if (words.length === 0 || movesFolder(words)) return [];
  const name = scriptName(words);
  if (name !== null) {
    if (!(name in scripts)) {
      return [`package.json has no script "${name}", so \`${words.join(' ')}\` cannot run`];
    }
    if (depth >= MAX_EXPANSION) return [];
    return commandsOf(scripts[name]).flatMap((inner) =>
      problemsInCommand(inner, root, scripts, depth + 1),
    );
  }
  const tsc = tscProblem(words, root);
  if (tsc) return [tsc];
  const [program] = words;
  if (WRAPPERS.includes(program) || PACKAGE_MANAGERS.includes(program)) return [];
  // A tool a package script names lives in node_modules/.bin: until the project is installed
  // here, its absence says nothing.
  const uninstalled = depth > 0 && !fs.existsSync(path.join(root, 'node_modules'));
  if (!uninstalled && !onPath(program, root)) {
    return [`\`${program}\` is not on PATH here or in node_modules/.bin`];
  }
  return [];
}

/**
 * Problems a gate has no need to run to show.
 * @param {string} root The project's root, where the gate runs.
 * @param {{run: string}[]} gates
 * @returns {{gate: string, problem: string}[]}
 */
function staticGateProblems(root, gates) {
  const scripts = packageScripts(root);
  const found = [];
  for (const { run } of gates) {
    const seen = new Set();
    for (const words of commandsOf(run)) {
      for (const problem of problemsInCommand(words, root, scripts, 0)) {
        if (!seen.has(problem)) found.push({ gate: run, problem });
        seen.add(problem);
      }
    }
  }
  return found;
}

/** The line of a gate's output that says why it failed: the first error line, else the last. */
function firstError(output) {
  const rows = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = rows.find((l) => /\b(error|failed|fail|not found|cannot|ERR!)/i.test(l));
  return (hit || rows.at(-1) || '').slice(0, 200);
}

const defaultRunGate = (run, root, timeoutMs) => {
  const result = spawnSync(run, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: 'pipe',
  });
  return {
    code: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT',
    output: `${result.stderr || ''}\n${result.stdout || ''}`,
  };
};

/**
 * Runs each gate once, from the project's root.
 * @returns {{gate: string, ok: boolean, code: number|null, timedOut: boolean, error: string}[]}
 */
function tryGates(root, gates, { runGate = defaultRunGate, timeoutMs = 120000 } = {}) {
  return gates.map(({ run }) => {
    const { code, timedOut, output } = runGate(run, root, timeoutMs);
    return {
      gate: run,
      ok: code === 0 && !timedOut,
      code,
      timedOut: Boolean(timedOut),
      error: code === 0 && !timedOut ? '' : firstError(output || ''),
    };
  });
}

module.exports = { staticGateProblems, tryGates, commandsOf };
