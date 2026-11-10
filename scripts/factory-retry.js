#!/usr/bin/env node
/**
 * Record a factory run's outcome for the retry-once rule. Run by the `report` job
 * of the factory workflow after every Claude run that failed or succeeded (a
 * cancelled run does nothing).
 *
 *   fail <id> <run-url>   first failure: label the tracking issue with the retry
 *                         label and comment the run link; the hourly scheduled
 *                         route retries it once the label is an hour old.
 *                         Failure while the issue has the retrying label (the
 *                         retry failed too): remove that label, add needs-human
 *                         and comment both run links.
 *   ok <id>               a run succeeded: remove the retrying label, if present,
 *                         so a later failure gets its own retry.
 *
 * The label names and the owner are the project's factory.config.yml.
 *
 * Usage: node scripts/factory-retry.js fail <change-id> <run-url>
 *        node scripts/factory-retry.js ok <change-id>
 * Exit codes: 0 done, 2 usage error.
 */
const { execFileSync } = require('node:child_process');
const { loadAdapter } = require('../lib/adapters.js');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { ensureLabel, ensureNeedsHuman } = require('../lib/labels.js');
const { createRouter } = require('../lib/router.js');
const { trackingIssue } = require('../lib/tracking-issue.js');

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/[0-9]+$/;
// The first failure's comment carries its run link, so a failed retry can cite both.
const MARKER = /<!-- factory-retry run: (\S+) -->/;

const labelNames = (issue) => (issue.labels || []).map((l) => l.name);

/** Run link from the newest marker comment on the issue, or ''. */
function firstRunLink(issue) {
  const marked = (issue.comments || []).map((c) => MARKER.exec(c.body || '')).filter(Boolean);
  return marked.length ? marked.at(-1)[1] : '';
}

function ensureLabels({ labels }, gh) {
  for (const [name, description] of [
    [labels.retry, 'Factory run failed; retried once an hour later'],
    [labels.retrying, 'Factory retry in progress; another failure escalates'],
  ]) {
    ensureLabel(gh, name, 'FBCA04', description);
  }
}

function fail(id, url, ctx, log) {
  const { config, gh } = ctx;
  const { labels } = config;
  const number = String(trackingIssue(id, ctx));
  const issue = JSON.parse(gh(['issue', 'view', number, '--json', 'labels,comments']));
  if (labelNames(issue).includes(labels.retrying)) {
    const first = firstRunLink(issue) || '(link not found)';
    ensureNeedsHuman(gh, config);
    gh([
      'issue',
      'edit',
      number,
      '--remove-label',
      labels.retrying,
      '--add-label',
      labels.needs_human,
    ]);
    gh([
      'issue',
      'comment',
      number,
      '--body',
      [
        `@${config.owner} A run of \`${id}\` failed, and so did its retry:`,
        '',
        `- first: ${first}`,
        `- retry: ${url}`,
        '',
        `The factory will not retry again. Look at the runs, fix the cause, then remove \`${labels.needs_human}\` to resume.`,
      ].join('\n'),
    ]);
    log(`Retry of ${id} failed; escalated on #${number}.`);
    return 0;
  }
  ensureLabels(config, gh);
  gh(['issue', 'edit', number, '--add-label', labels.retry]);
  gh([
    'issue',
    'comment',
    number,
    '--body',
    `A factory run of \`${id}\` failed: ${url}\n\nIt is retried once, an hour after this label was added.\n\n<!-- factory-retry run: ${url} -->`,
  ]);
  log(`Run of ${id} failed; #${number} labelled ${labels.retry}.`);
  return 0;
}

function ok(id, { config, gh }, log) {
  const { labels } = config;
  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--label',
    `${labels.change_prefix}${id}`,
    '--label',
    labels.retrying,
    '--json',
    'number',
  ];
  for (const { number } of JSON.parse(gh(args))) {
    gh(['issue', 'edit', String(number), '--remove-label', labels.retrying]);
    log(`Run of ${id} succeeded; removed ${labels.retrying} from #${number}.`);
  }
  return 0;
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const { factoryIdProblem } = createRouter(config);
  const [command, id, url] = [...argv, '', '', ''];
  let problem = '';
  if (command !== 'fail' && command !== 'ok') problem = 'command must be fail or ok';
  else if (factoryIdProblem(id)) problem = factoryIdProblem(id);
  else if (command === 'fail' && !RUN_URL.test(url)) problem = 'invalid run url';
  if (problem) {
    (io.error || console.error)(
      `usage: factory-retry.js fail <change-id> <run-url> | ok <change-id>: ${problem}`,
    );
    return 2;
  }
  const ctx = { config, adapter: io.adapter || loadAdapter(config), gh: io.gh || defaultGh };
  const log = io.log || console.log;
  return command === 'fail' ? fail(id, url, ctx, log) : ok(id, ctx, log);
}

if (require.main === module) runCli(main);

module.exports = { main };
