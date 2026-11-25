'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Each front-door command and the script it runs. Same flags, same exit codes. */
const COMMANDS = {
  init: { script: 'factory-init.js', help: 'set a project up for the factory' },
  doctor: { script: 'factory-doctor.js', help: 'check the project and print the fix for each gap' },
  upgrade: { script: 'factory-upgrade.js', help: 'move the project to a newer factory pin' },
  'new-change': { script: 'factory-new-change.js', help: 'create an empty change with a valid id' },
  'pin-sync': {
    script: 'factory-pin-sync.js',
    help: 'open a pin-bump PR in each consumer repo (~/.factory-consumers)',
  },
  status: {
    script: 'factory-status.js',
    help: 'can I merge yet? one line per open PR: ready, safe now, waiting or blocked',
  },
  'post-merge': {
    script: 'factory-post-merge.js',
    help: 'after you merge a PR: pull main, delete the branch, show what is next',
  },
  cleanup: {
    script: 'cleanup-merged.js',
    help: 'delete merged local branches and stale worktrees',
  },
};

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, { help }]) => `  ${name.padEnd(width)}  ${help}`,
  );
  return ['usage: factory <command> [args]', '', 'commands:', ...lines].join('\n');
}

/**
 * Run `factory <command> [args]`. Returns the exit code: the script's own, or 2 for
 * no command, an unknown command or `help`-less misuse (usage errors are 2 everywhere).
 */
function runFrontDoor(argv, { cwd = process.cwd(), log = console.log, err = console.error } = {}) {
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    (name === undefined ? err : log)(helpText());
    return name === undefined ? 2 : 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    err(`factory: unknown command "${name}"\n\n${helpText()}`);
    return 2;
  }
  const result = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, command.script), ...rest], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

module.exports = { COMMANDS, SCRIPTS_DIR, helpText, runFrontDoor };
