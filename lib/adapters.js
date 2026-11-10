'use strict';

const { assertAdapter } = require('../adapters/contract.js');
const { createOpenSpecAdapter } = require('../adapters/openspec.js');
const { maxIdLength } = require('./config.js');

/** The adapters this install ships, by the name `spec_source` gives. */
const ADAPTERS = { openspec: createOpenSpecAdapter };

/**
 * The spec-source adapter the project's config names. `options.source` makes it
 * read another place than the project's disk (and so read-only). An unknown name
 * fails here, with the names that exist, rather than inside a run.
 */
function loadAdapter(config, { root = process.cwd(), source = null } = {}) {
  const create = ADAPTERS[config.spec_source];
  if (!create) {
    const known = Object.keys(ADAPTERS).join(', ');
    throw new Error(
      `spec_source "${config.spec_source}" has no adapter installed (have: ${known})`,
    );
  }
  const adapter = create({ root, source, maxIdLength: maxIdLength(config) });
  assertAdapter(adapter);
  return adapter;
}

module.exports = { ADAPTERS, loadAdapter };
