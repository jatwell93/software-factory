'use strict';

/**
 * Source files that exist in the working tree but that git ignores, in a folder git
 * already tracks. `git add` skips them without a word, so a pull request misses a file the
 * code needs and the default branch breaks once it is merged (review-radar #23, fixed in #26).
 *
 * Only files in a folder that has tracked content count: a folder that is ignored whole
 * (node_modules, a build folder) is on purpose and is listed as one entry, which is skipped.
 * Only source extensions count: .env, logs and caches are meant to be ignored.
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
  const files = listed
    .split('\0')
    .filter((entry) => entry && !entry.endsWith('/') && SOURCE.has(extension(entry)));
  const rules = rulesFor(git, files);
  return files.map((file) => ({ file, rule: rules.get(file) || 'an ignore rule' }));
}

module.exports = { SOURCE, ignoredSource };
