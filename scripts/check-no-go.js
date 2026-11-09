#!/usr/bin/env node
/**
 * Fail when a factory branch or PR touches a path the factory must never edit.
 *
 * The patterns are the factory's BASELINE (lib/baseline.js), the project's
 * `protected_paths` from factory.config.yml, and the change's own `no_go`
 * entries. A project or a change can add patterns but never remove a baseline
 * one, so no config can unprotect the workflows or the agent's own rules.
 *
 * Two callers:
 *   * run-spec and babysit-pr, before every push (diff mode). The diff is taken
 *     against the merge base (`origin/<default_branch>...HEAD`), so files that
 *     changed only on the default branch never count, and with --no-renames, so
 *     a renamed file is listed under both its old and its new path.
 *   * the no-go-guard workflow (list mode). It runs the default branch's copy of
 *     the project's config and the pinned factory script on the PR's file list
 *     from the pulls files API, including each file's previous_filename, with
 *     `--change all`: every active change's list. So a PR can neither edit the
 *     check, shrink a list, nor pick which list applies (labels are editable by
 *     the factory).
 *
 * Usage:
 *   node check-no-go.js [--change <id|all>] [--base <ref>]   # diff mode
 *   node check-no-go.js [--change <id|all>] --files <path|->  # list mode, one path per line
 *   node check-no-go.js scope   # guard: is $AUTHOR/$LABELS a factory PR
 *
 * Run it from the project's root: it reads factory.config.yml there.
 *
 * Exit codes: 0 no match, 1 matches (printed one per line), 2 usage error, an
 * unreadable config or an unreadable no_go list. Callers must treat any non-zero
 * exit as a failure.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { BASELINE } = require('../lib/baseline.js');
const { globToRegExp } = require('../lib/glob.js');
const { ConfigError, loadConfig } = require('../lib/config.js');
const { ID_PATTERN } = require('../lib/change-id.js');
const { NoGoFormatError, changeNoGo, changeFolders } = require('../lib/openspec-reads.js');

const USAGE = 'usage: check-no-go.js [--change <id|all>] [--base <ref>] [--files <path|->]';
const FACTORY_AUTHOR = 'claude[bot]';
const ALL_CHANGES = 'all';
const DEFAULT_LABEL_PREFIX = 'factory:';

/**
 * Whether a PR is a factory PR: authored by the Claude GitHub App, or labelled
 * `<prefix>*`. A line for $GITHUB_OUTPUT. Labels only widen the check (they can
 * mark a PR as a factory PR, never unmark one) and never choose which change's
 * list applies: the factory can edit its own PR's labels.
 */
function factoryScope(labels, author, prefix = DEFAULT_LABEL_PREFIX) {
  const factory = author === FACTORY_AUTHOR || labels.some((l) => l.startsWith(prefix));
  return `factory=${factory}\n`;
}

/**
 * BASELINE, the project's protected_paths and one change's no_go list, or with
 * `--change all` every active change's list (the guard's mode: the PR cannot
 * pick a narrower list). A folder under changes/ counts even when its name is
 * not a valid change id, so a badly named change never has its list skipped.
 */
function patternsFor(changeId, root, config = { protected_paths: [] }) {
  let ids = [];
  if (changeId === ALL_CHANGES) ids = changeFolders(root);
  else if (ID_PATTERN.test(changeId)) ids = [changeId];
  const own = config.protected_paths || [];
  return [...new Set([...BASELINE, ...own, ...ids.flatMap((id) => changeNoGo(id, root))])];
}

/** Paths that match any pattern, each with the first pattern it matched. */
function findMatches(paths, patterns) {
  const compiled = patterns.map((p) => [p, globToRegExp(p)]);
  const matches = [];
  for (const p of new Set(paths.map((x) => x.trim()).filter(Boolean))) {
    const hit = compiled.find(([, re]) => re.test(p));
    if (hit) matches.push({ path: p, pattern: hit[0] });
  }
  return matches;
}

const FLAGS = ['--change', '--base', '--files'];

/** Flag/value pairs to options, or null on an unknown flag or a missing value. */
function parseArgs(argv) {
  const opts = { change: '', base: '', files: null };
  const pairs = argv.length % 2 === 0 ? argv.filter((_, i) => i % 2 === 0) : null;
  if (!pairs || !pairs.every((k) => FLAGS.includes(k))) return null;
  pairs.forEach((key, i) => {
    opts[key.slice(2)] = argv[i * 2 + 1];
  });
  return opts;
}

function changedPaths(opts, io) {
  if (opts.files !== null) {
    return io.readFile(opts.files === '-' ? 0 : opts.files).split(/\r?\n/);
  }
  // -z: git would otherwise quote a path with non-ASCII or special characters
  // ("\"caf\\303\\251\""), and a quoted path matches no pattern.
  return io.git(['diff', '--name-only', '--no-renames', '-z', `${opts.base}...HEAD`]).split('\0');
}

const defaultIo = {
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  git: (args) => execFileSync('git', args, { encoding: 'utf8' }),
  log: (s) => console.log(s),
  error: (s) => console.error(s),
};

/** The label prefix for scope mode. A broken config falls back to the default: scope only widens. */
function scopePrefix(root) {
  try {
    return loadConfig(root).labels.change_prefix;
  } catch {
    return DEFAULT_LABEL_PREFIX;
  }
}

function main(argv, io = defaultIo, root = process.cwd(), env = process.env) {
  if (argv[0] === 'scope') {
    const labels = JSON.parse(env.LABELS || '[]');
    io.log(factoryScope(labels, env.AUTHOR || '', scopePrefix(root)).trimEnd());
    return 0;
  }
  const opts = parseArgs(argv);
  if (!opts) {
    io.error(USAGE);
    return 2;
  }
  let patterns;
  let config;
  try {
    config = loadConfig(root);
    patterns = patternsFor(opts.change, root, config);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.error(`no_go: ${err.message}`);
      return 2;
    }
    if (!(err instanceof NoGoFormatError)) throw err;
    io.error(`no_go: ${err.message}; use a block list of "  - path" lines`);
    return 2;
  }
  if (!opts.base) opts.base = `origin/${config.default_branch}`;
  const matches = findMatches(changedPaths(opts, io), patterns);
  if (matches.length === 0) {
    io.log('no_go: no protected path touched');
    return 0;
  }
  io.error(`no_go: ${matches.length} protected path(s) touched`);
  for (const m of matches) io.log(`${m.path}\t(${m.pattern})`);
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  BASELINE,
  factoryScope,
  globToRegExp,
  parseNoGo: require('../lib/openspec-reads.js').parseNoGo,
  patternsFor,
  findMatches,
  parseArgs,
  main,
};
