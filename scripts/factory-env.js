#!/usr/bin/env node
/**
 * Print the config values a workflow needs before it can set up the runner, as
 * lines for $GITHUB_OUTPUT:
 *
 *   node_version=<n>  install=<command>  default_branch=<name>
 *
 * With `--run`, also what the agent's run needs:
 *
 *   rules=<paths>  allowed_bots=<logins>  step_timeout=<min>  job_timeout=<min>
 *   claude_args (several lines, written as a heredoc output)
 *
 * A workflow cannot read factory.config.yml itself, and the Node version has to
 * be known before `setup-node` runs. Run it from the project's root, on the
 * default branch's checkout. A single-line value with a line break is refused,
 * because it would write a second output line.
 *
 * Usage: node scripts/factory-env.js [--run]
 */
const { RULES } = require('../lib/baseline.js');
const { allowedBots, claudeArgs } = require('../lib/claude-args.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');

// The job's limit sits this far above the agent step's, so a step timeout fails the
// job (which the report job records for a retry) before a job timeout can cancel it.
const JOB_MARGIN_MINUTES = 10;
const DELIMITER = 'FACTORY_OUTPUT_EOF';

/** `key=value` lines; a value with a line break is refused. */
function singleLines(values) {
  return Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/.test(String(value))) throw new Error(`${key} cannot contain a line break`);
    return `${key}=${value}`;
  });
}

/** A multi-line output in the heredoc form $GITHUB_OUTPUT takes. */
function multiline(key, value) {
  if (value.split('\n').includes(DELIMITER)) throw new Error(`${key} contains ${DELIMITER}`);
  return `${key}<<${DELIMITER}\n${value}\n${DELIMITER}`;
}

/** The output lines for a config. */
function envLines(config, { run = false } = {}) {
  const lines = singleLines({
    node_version: config.runner.node_version,
    install: config.runner.install,
    default_branch: config.default_branch,
  });
  if (!run) return lines;
  return [
    ...lines,
    ...singleLines({
      rules: RULES.join(' '),
      allowed_bots: allowedBots(config),
      step_timeout: config.timeout_minutes,
      job_timeout: config.timeout_minutes + JOB_MARGIN_MINUTES,
    }),
    multiline('claude_args', claudeArgs(config)),
  ];
}

function main(argv = process.argv.slice(2), root = process.cwd(), log = console.log) {
  log(envLines(loadConfig(root), { run: argv.includes('--run') }).join('\n'));
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { DELIMITER, JOB_MARGIN_MINUTES, envLines, multiline, main };
