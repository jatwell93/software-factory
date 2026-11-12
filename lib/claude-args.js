'use strict';

/**
 * The agent's command line, built from the project's config: the spend and turn
 * caps, the tools it may use and the commands it may not. The allowed list is the
 * factory's fixed tools plus the commands the project's gates and install step
 * run, so a project's own test command works without a hand-written allowlist.
 */

const GENERIC_ALLOWED = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Skill',
  'TodoWrite',
  'Bash(git:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh issue:*)',
  'Bash(gh label create:*)',
  'Bash(gh label list:*)',
  'Bash(gh run view:*)',
  'Bash(node:*)',
  'Bash(cd:*)',
];

// What an adapter's own tool needs, for the spec source the project names.
const ADAPTER_ALLOWED = { openspec: ['Bash(npx openspec:*)', 'Bash(openspec:*)'] };

/** The agent never merges, approves, calls the raw API or forces a push, whatever the config says. */
const GENERIC_DENIED = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh api:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

// Characters that make up a command prefix. No quote, `$`, backtick or control
// character: the prefix goes inside a double-quoted argument.
const PREFIX = /^[A-Za-z0-9_./:@=+-]+(?: [A-Za-z0-9_./:@=+-]+)*$/;

/**
 * The command prefixes a shell command line runs, one per `&&`, `||` or `;`
 * segment: the program and its subcommand (`npm run`, `pnpm install`), or just
 * the program when the next word is a flag or the program is `cd`.
 */
function prefixesOf(command) {
  return command
    .split(/&&|\|\||;/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^\(+|\)+$/g, '')
        .trim(),
    )
    .filter(Boolean)
    .map((segment) => {
      const words = segment.split(/\s+/);
      if (words[0] === 'cd' || words.length === 1 || words[1].startsWith('-')) return words[0];
      return words.slice(0, 2).join(' ');
    });
}

function checkPrefix(prefix, where) {
  if (!PREFIX.test(prefix)) {
    throw new Error(`${where} has a command the agent's tool list cannot hold safely: ${prefix}`);
  }
  return prefix;
}

const tool = (prefix) => `Bash(${prefix}:*)`;

/** Allowed tools: the fixed ones, the adapter's, and the gates' and install command's. */
function allowedTools(config) {
  const commands = [
    ...config.gates.map((gate) => ['a gate', gate.run]),
    ['runner.install', config.runner.install],
  ];
  const derived = commands.flatMap(([where, run]) =>
    prefixesOf(run).map((prefix) => tool(checkPrefix(prefix, where))),
  );
  const adapter = ADAPTER_ALLOWED[config.spec_source] || [];
  return [...new Set([...GENERIC_ALLOWED, ...adapter, ...derived])];
}

/** Denied tools: the fixed ones and the config's `forbidden_commands`. */
function deniedTools(config) {
  const own = config.forbidden_commands.map((c) => tool(checkPrefix(c, 'forbidden_commands')));
  return [...new Set([...GENERIC_DENIED, ...own])];
}

/** The `claude_args` string: one option per line, the tool lists comma-joined and quoted. */
function claudeArgs(config) {
  return [
    `--max-turns ${config.max_turns}`,
    `--max-budget-usd ${config.spend_cap_usd}`,
    `--allowedTools "${allowedTools(config).join(',')}"`,
    `--disallowedTools "${deniedTools(config).join(',')}"`,
  ].join('\n');
}

/**
 * The bots whose review events may start a run: the configured review bots plus
 * the factory's own two actors, which no config can remove.
 */
function allowedBots(config) {
  return [
    ...new Set([
      ...config.review_bots.map((b) => `${b}[bot]`),
      'claude[bot]',
      'github-actions[bot]',
    ]),
  ].join(',');
}

module.exports = { allowedBots, allowedTools, claudeArgs, deniedTools, prefixesOf };
