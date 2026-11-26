'use strict';

/**
 * Source files that exist in the working tree but that git ignores, in a folder git
 * already tracks. `git add` skips them without a word, so a pull request misses a file the
 * code needs and the default branch breaks once it is merged (review-radar #23, fixed in #26).
 *
 * A folder git lists as one entry (every file in it is ignored and untracked) is opened,
 * so a new subfolder of an ignored folder is not missed. Dependency, build and dot folders
 * are skipped: they are ignored on purpose. Only source extensions count: .env, logs and
 * caches are meant to be ignored.
 */

const SOURCE = new Set(
  '.py .js .jsx .ts .tsx .mjs .cjs .go .rs .java .kt .rb .php .cs .swift .sql .sh .c .h .cpp'.split(
    ' ',
  ),
);

const extension = (file) => {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
};

// Folders ignored whole on purpose: dependencies, build output, caches. They can hold
// thousands of source files, and none of them is meant for the repository.
const NOISE = new Set(
  'node_modules dist build out target vendor venv env coverage __pycache__ site-packages bower_components obj bin'.split(
    ' ',
  ),
);

/** A folder entry (trailing slash) the check skips: a noise folder, or a dot folder (.venv, .cache, .agents). */
function isNoise(entry) {
  return entry
    .split('/')
    .filter(Boolean)
    .some((part) => part.startsWith('.') || NOISE.has(part));
}

/** The rule that ignores each file, as "<source>:<line> <pattern>", from `git check-ignore -v`. */
function rulesFor(git, files) {
  const rules = new Map();
  for (let i = 0; i < files.length; i += 100) {
    let out = '';
    try {
      out = git(['check-ignore', '-v', '--no-index', '--', ...files.slice(i, i + 100)]);
    } catch {
      continue; // exit 1: nothing in this chunk is ignored by a rule (should not happen)
    }
    // One "<source>:<line>:<pattern><TAB><path>" per line. (-z needs --stdin, which the
    // git callers here cannot feed.) A path git had to quote is left without a rule.
    for (const row of out.split(/\r?\n/)) {
      const tab = row.indexOf('\t');
      const meta = /^(.*?):(\d+):(.*)$/.exec(row.slice(0, tab));
      if (tab !== -1 && meta) rules.set(row.slice(tab + 1), `${meta[1]}:${meta[2]} ${meta[3]}`);
    }
  }
  return rules;
}

/**
 * @param {Function} git Takes an args array, returns stdout or throws. Runs in the project root.
 * @returns {{file: string, rule: string}[]}
 */
function ignoredSource(git) {
  const listed = git(['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']);
  const entries = listed.split('\0').filter(Boolean);
  const files = [];
  for (const entry of entries) {
    if (!entry.endsWith('/')) {
      if (SOURCE.has(extension(entry))) files.push(entry);
    } else if (!isNoise(entry)) {
      // `--directory` shows an ignored folder with no tracked file as one entry, however many
      // new files and subfolders it holds (backend/routers/v2/): open it.
      const inside = git(['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', entry]);
      files.push(...inside.split('\0').filter((f) => f && SOURCE.has(extension(f))));
    }
  }
  const rules = rulesFor(git, files);
  return files.map((file) => ({ file, rule: rules.get(file) || 'an ignore rule' }));
}

module.exports = { SOURCE, ignoredSource };
