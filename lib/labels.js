'use strict';

/**
 * Creates a label if it is missing (and refreshes its colour and description).
 * `gh issue edit --add-label` fails on a label the repository does not have, so
 * every script that adds a label calls this first: a fresh project has none of
 * the factory's labels until something creates them.
 */
function ensureLabel(gh, name, color, description) {
  gh(['label', 'create', name, '--force', '--color', color, '--description', description]);
}

/** Creates the label that parks a change until the owner answers. */
function ensureNeedsHuman(gh, { labels }) {
  ensureLabel(gh, labels.needs_human, 'D93F0B', 'Factory is waiting for the owner');
}

module.exports = { ensureLabel, ensureNeedsHuman };
