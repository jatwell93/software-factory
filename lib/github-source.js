'use strict';

const { execFileSync } = require('node:child_process');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

/** True for the error `gh api` raises when the path is not on the branch. */
const isMissing = (error) => /HTTP 404\b/.test(String(error.stderr || error.message));

/**
 * A file source for a branch the job has not checked out, read through the
 * GitHub contents API. The route job checks out only the default branch, so
 * `git show origin/<branch>:<path>` has nothing to read. Run from a checkout of
 * the repository: `{owner}` and `{repo}` are filled in by `gh`.
 *
 * `read` gives the file's text, or null when it is not there. `list` gives the
 * folder's entries as `{ name, dir }`, or [] when it is not there. Any other
 * error is thrown, so a rate limit or a bad token is never read as "missing".
 */
function githubSource(ref, gh = defaultGh) {
  const url = (rel) => `repos/{owner}/{repo}/contents/${rel}?ref=${encodeURIComponent(ref)}`;
  return {
    read(rel) {
      try {
        return gh(['api', '-H', 'Accept: application/vnd.github.raw', url(rel)]);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    list(rel) {
      try {
        // "<type>:<name>" per entry; the type never contains a colon, so split on the first.
        const out = gh(['api', url(rel), '--jq', '.[] | .type + ":" + .name']);
        return out
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const colon = line.indexOf(':');
            return { name: line.slice(colon + 1), dir: line.slice(0, colon) === 'dir' };
          });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

module.exports = { githubSource, isMissing };
