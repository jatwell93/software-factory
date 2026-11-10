#!/usr/bin/env node
/**
 * Decide what one GitHub event means for the factory. Run by the `route` job of
 * the factory workflow from a checkout of the default branch; prints
 * $GITHUB_OUTPUT lines:
 *
 *   mode=task|babysit|archive|escalate|none  change_id=<id>  pr=<n>  ref=<branch>
 *   task=<n>  retry=<issue>  per_change=true|  reason=<text>
 *
 * The rules are in lib/router.js; the labels, owner and id limit are the
 * project's factory.config.yml.
 *
 * Usage: node scripts/factory-route.js   (reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH)
 */
const fs = require('node:fs');
const { loadConfig, ConfigError } = require('../lib/config.js');
const { createRouter, toOutput } = require('../lib/router.js');
const { createDeps } = require('../lib/router-deps.js');

function main(env = process.env, { root = process.cwd(), log = console.log, deps } = {}) {
  const config = loadConfig(root);
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const { route } = createRouter(config);
  log(toOutput(route(env.GITHUB_EVENT_NAME, event, deps || createDeps(config))));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { main };
