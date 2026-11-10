'use strict';

/**
 * Runtime half of the spec-source adapter contract (the types are in
 * contract.d.ts). Anything that loads an adapter calls assertAdapter first, so a
 * missing operation fails with its name instead of deep inside a run.
 */

const OPERATIONS = [
  'listChanges',
  'listTasks',
  'readAutonomy',
  'tickTask',
  'archive',
  'scaffold',
  'setup',
  'isArchived',
  'archivedTitle',
];

/** The operations the adapter does not implement as functions. */
function missingOperations(adapter) {
  if (!adapter || typeof adapter !== 'object') return [...OPERATIONS];
  return OPERATIONS.filter((op) => typeof adapter[op] !== 'function');
}

/** Throw when the adapter has no usable name or lacks an operation. */
function assertAdapter(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.name)) {
    throw new Error('adapter needs a name of lowercase letters, digits and hyphens');
  }
  const missing = missingOperations(adapter);
  if (missing.length > 0) {
    throw new Error(`adapter ${adapter.name} lacks: ${missing.join(', ')}`);
  }
  return adapter;
}

module.exports = { OPERATIONS, missingOperations, assertAdapter };
