'use strict';

const { ConfigError } = require('./config.js');

/**
 * Runs a script's `main` and sets the exit code. A bad config or a malformed spec
 * file is the project's to fix: it prints the message and exits 2. Any other
 * failure is a bug or an outage and is thrown, so the job goes red.
 */
function runCli(main, err = console.error) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof ConfigError) && !error.userError) throw error;
    err(error.message);
    process.exitCode = 2;
  }
}

module.exports = { runCli };
