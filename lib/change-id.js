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

module.exports = { ID_PATTERN, idProblem };
