'use strict';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why a change id cannot run through the factory, or ''. Every factory PR and
 * tracking issue carries the label <prefix><id> and GitHub caps a label at 50
 * characters, so the limit is passed in (see maxIdLength in config.js).
 */
function idProblem(id, max = 42) {
  if (typeof id !== 'string' || id === '') return 'a change id is empty';
  if (!ID_PATTERN.test(id)) {
    return `"${id}" must be lowercase letters, digits and hyphens, starting with a letter or digit`;
  }
  if (id.length > max) {
    return `"${id}" is ${id.length} characters; the limit is ${max}. Rename the change`;
  }
  return '';
}

// Every character a regex with the `m` flag, a line split or an editor reads as a line
// break or a control: \n, \r, the rest of C0 and C1, U+2028 and U+2029.
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Why a title cannot be a change's proposal heading, or ''. The heading is written
 * into proposal.md, whose `## Autonomy` block is found with multiline regexes: a
 * line break in the title would let it write that block (`pr:`, `issue:`).
 */
function titleProblem(title) {
  if (typeof title !== 'string') return 'a title must be text';
  return LINE_BREAK_OR_CONTROL.test(title) ? 'a title cannot contain a line break' : '';
}

module.exports = { ID_PATTERN, idProblem, titleProblem };
