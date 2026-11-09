#!/usr/bin/env node
/**
 * Read the babysit round count of the current branch, so the cap of 5 fix
 * rounds per PR holds across separate workflow runs (OpenSpec change
 * add-spec-factory-runner, task 2.2).
 *
 * Every babysit commit carries a `Babysit-Round: N` trailer. This prints the
 * highest N on the branch (commits not on the base) and the next round:
 *
 *   round=<highest> next=<highest + 1> capped=<true|false>
 *
 * On a per-change PR (factory-per-change-pr, task 1.2) each task commit carries a
 * `Factory-Task: <n>` trailer, and rounds count only after the newest one: every
 * task gets its own 5 rounds.
 *
 * Usage: node babysit-round.js [--base <ref>] [--max <n>]
 * Exit codes: 0 another round is allowed, 3 the cap is reached, 2 usage error.
 */
const { execFileSync } = require('node:child_process');
const { ConfigError, loadConfig } = require('../lib/config.js');

const USAGE = 'usage: babysit-round.js [--base <ref>] [--max <n>]';

/** Highest round in `git log` trailer output (one value per line), or 0. */
function highestRound(trailerOutput) {
  const rounds = trailerOutput
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter((v) => /^\d+$/.test(v))
    .map(Number);
  return rounds.length ? Math.max(...rounds) : 0;
}

function parseArgs(argv) {
  // Empty until main fills them from factory.config.yml: a flag overrides the config.
  const opts = { base: '', max: null };
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === '--base' && value) opts.base = value;
    else if (key === '--max' && /^\d+$/.test(value || '')) opts.max = Number(value);
    else return null;
  }
  return opts;
}

const defaultGit = (args) => execFileSync('git', args, { encoding: 'utf8' });

/** The newest `Factory-Task` commit on the branch, else `base`. */
function roundsBase(base, git) {
  const sha = git([
    'log',
    '-1',
    '--format=%H',
    '--extended-regexp',
    '--grep=^Factory-Task: ',
    `${base}..HEAD`,
  ]).trim();
  return sha || base;
}

function main(
  argv,
  { git = defaultGit, log = console.log, error = console.error, root = process.cwd() } = {},
) {
  const opts = parseArgs(argv);
  if (!opts) {
    error(USAGE);
    return 2;
  }
  let config;
  try {
    config = loadConfig(root);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    error(`babysit-round: ${err.message}`);
    return 2;
  }
  const base = opts.base || `origin/${config.default_branch}`;
  const max = opts.max ?? config.max_babysit_rounds;
  const trailers = git([
    'log',
    `${roundsBase(base, git)}..HEAD`,
    '--format=%(trailers:key=Babysit-Round,valueonly)',
  ]);
  const round = highestRound(trailers);
  const capped = round >= max;
  log(`round=${round} next=${round + 1} capped=${capped}`);
  return capped ? 3 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { highestRound, parseArgs, main };
