'use strict';

/**
 * The paths the factory may never edit in any project. A project's
 * factory.config.yml and a change can add to this list and cannot remove from
 * it. Everything else a project protects (migrations, lint gates, ...) is its own
 * `protected_paths`.
 *
 * The factory's own scripts are not listed: they run from a pinned checkout
 * outside the project's working tree, so an agent has nothing to edit.
 */
const BASELINE = [
  '.github/**',
  '.claude/**',
  // The git hooks that refuse commits and pushes to the default branch.
  '.githooks/**',
  'AGENTS.md',
  'CLAUDE.md',
  'factory.config.yml',
];

module.exports = { BASELINE };
