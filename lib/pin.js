'use strict';

const { FACTORY_REF } = require('./callers.js');

const FACTORY_REPO = 'jatwell93/software-factory';
const SLUG = FACTORY_REPO.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
// The ref after the `@` of the factory's reusable workflow, and the `factory_ref` input beside it.
const USES = new RegExp(`(uses:\\s*${SLUG}/\\.github/workflows/[\\w.-]+@)([^\\s#]+)`, 'g');
const INPUT = /(factory_ref:\s*)([^\s#]+)/g;

/** The refs a caller workflow pins: `uses` (one per factory job) and `factory_ref` inputs. */
function readPins(text) {
  return {
    uses: [...text.matchAll(USES)].map((m) => m[2]),
    inputs: [...text.matchAll(INPUT)].map((m) => m[2]),
  };
}

/** The workflow text with every pin set to `ref`, and how many pins that changed. */
function setPins(text, ref) {
  if (!FACTORY_REF.test(ref)) {
    throw new Error(`factory ref "${ref}" must be a 40-character commit SHA or a v* tag`);
  }
  let changed = 0;
  const swap = (match, head, old) => {
    if (old !== ref) changed += 1;
    return head + ref;
  };
  return { text: text.replace(USES, swap).replace(INPUT, swap), changed };
}

/** sha, tag, or other (a branch name or anything else that can move). */
function refKind(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return 'sha';
  return FACTORY_REF.test(ref) ? 'tag' : 'other';
}

module.exports = { FACTORY_REPO, readPins, refKind, setPins };
