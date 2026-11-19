'use strict';

/** The workflow file `init` writes into a project; the sweep dispatches it, the digest lists its runs. */
const FACTORY_WORKFLOW = 'factory.yml';

/**
 * The required statuses a factory PR's head must carry, with the caller workflow that
 * posts each. GitHub sometimes starts no `pull_request_target` run for a push, so the
 * reviews-settled run dispatches the caller for a head that still lacks one.
 */
const REQUIRED_STATUSES = [
  { context: 'factory/no-go-guard', workflow: 'no-go-guard.yml' },
  { context: 'factory/change-ids', workflow: 'check-change-ids.yml' },
];

module.exports = { FACTORY_WORKFLOW, REQUIRED_STATUSES };
