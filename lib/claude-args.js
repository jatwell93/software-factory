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
  // Read-only helpers the agent chains with its real commands (`cat x; echo ---`).
  // A chained command is allowed only when every part of it is, so one missing
  // helper denies the whole line: the first live run lost its task that way.
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(echo:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
];

// What an adapter's own tool needs, for the spec source the project names.
const ADAPTER_ALLOWED = { openspec: ['Bash(npx openspec:*)', 'Bash(openspec:*)'] };

/**
 * Commands the agent is told never to run, whatever the config says: merging,
 * approving, the raw API, a forced push.
 *
 * This is a guardrail against the model typing these commands, not a hard
 * guarantee. A prefix list cannot see a reordered form (`git -c x=y push
 * --force`) or a wrapped one (`node -e "...child_process..."`), and the allowed
 * list has to contain `git` and `node`. What actually stops a merge or a push to
 * the default branch is outside the agent's reach: the branch ruleset (a review
 * the Claude app cannot give), the no-go guard, and the token's permissions.
 */
const GENERIC_DENIED = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr review:*)',
  'Bash(gh api:*)',
  'Bash(git push --force:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --force-if-includes:*)',
  'Bash(git push -f:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

// Characters that make up a command prefix. No quote, `$`, backtick or control
// character: the prefix goes inside a double-quoted argument.
const PREFIX = /^[A-Za-z0-9_./:@=+-]+(?: [A-Za-z0-9_./:@=+-]+)*$/;

/**
 * The command prefixes a shell command line runs, one per command: the program
 * and its subcommand (`npm run`, `pnpm install`), or just the program when the
 * next word is a flag or the program is `cd`. Commands are separated by `&&`,
 * `||`, `;`, `&`, a pipe or a line break, so a gate written as a multi-line YAML
 * block (`run: |`) gets a prefix for every line. A backslash before a line break
 * continues the command, and a `#` comment line is not a command.
 */
function prefixesOf(command) {
  return command
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|\r\n]/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^\(+|\)+$/g, '')
        .trim(),
    )
    .filter((segment) => segment && !segment.startsWith('#'))
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
