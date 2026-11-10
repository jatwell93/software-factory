#!/usr/bin/env node
/**
 * Post the factory's daily digest as one comment on the digest issue: what waits
 * on the owner (needs-human), the open factory PRs with their pr-feedback
 * verdict, and factory runs that failed in the last day. Run by the digest
 * workflow; posts nothing when all three are empty.
 *
 * Usage: node scripts/factory-digest.js [--dry-run]   (--dry-run prints the body)
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const { FACTORY_WORKFLOW } = require('../lib/workflow.js');

const PR_FEEDBACK = path.join(__dirname, 'pr-feedback.js');
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const defaultSummary = (n) =>
  execFileSync('node', [PR_FEEDBACK, String(n), '--summary'], { encoding: 'utf8' }).trim();

const json = (deps, args) => JSON.parse(deps.gh(args));
const isEmpty = (d) => !d.parked.length && !d.prs.length && !d.failed.length;

function section(title, items, line) {
  if (!items.length) return [];
  return [`**${title}**`, '', ...items.map(line), ''];
}

/** Markdown body of the digest comment. */
function format(config, digest, now) {
  return [
    `Factory digest, ${new Date(now).toISOString().slice(0, 10)}. @${config.owner}`,
    '',
    ...section(
      `Waiting on you (${config.labels.needs_human})`,
      digest.parked,
      (i) => `- #${i.number} ${i.title}`,
    ),
    ...section(
      'Open factory PRs',
      digest.prs,
      (p) => `- #${p.number} ${p.title}: \`${p.summary}\``,
    ),
    ...section(
      'Failed factory runs, last 24 hours',
      digest.failed,
      (r) => `- ${r.displayTitle}: ${r.url}`,
    ),
  ].join('\n');
}

function collect(config, deps, now) {
  const { changeFromLabels } = createRouter(config);

  /** Open issues and PRs labelled needs-human. */
  function parked() {
    const args = ['list', '--state', 'open', '--label', config.labels.needs_human];
    const fields = ['--json', 'number,title,url'];
    return [
      ...json(deps, ['issue', ...args, ...fields]),
      ...json(deps, ['pr', ...args, ...fields]),
    ];
  }

  /** Open PRs the Claude GitHub App authored with a change label. */
  function factoryPrs() {
    const args = ['pr', 'list', '--state', 'open', '--author', 'app/claude'];
    const prs = json(deps, [...args, '--json', 'number,title,url,labels']);
    return prs
      .filter((pr) => changeFromLabels(pr.labels))
      .map((pr) => ({ ...pr, summary: deps.summary(pr.number) }));
  }

  function failedRuns() {
    const since = new Date(now - DAY_MS).toISOString();
    const args = ['run', 'list', '--workflow', FACTORY_WORKFLOW, '--status', 'failure'];
    return json(deps, [...args, '--created', `>=${since}`, '--json', 'url,displayTitle']);
  }

  return { parked: parked(), prs: factoryPrs(), failed: failedRuns() };
}

/** The open digest issue, created on first use. */
function digestIssue(config, deps) {
  const label = config.labels.digest;
  const args = ['issue', 'list', '--state', 'open', '--label', label, '--json', 'number'];
  const open = json(deps, args);
  if (open.length) return open[0].number;
  deps.gh([
    'label',
    'create',
    label,
    '--force',
    '--color',
    'BFD4F2',
    '--description',
    'Daily factory digest',
  ]);
  const url = deps.gh([
    'issue',
    'create',
    '--title',
    'Factory digest',
    '--label',
    label,
    '--body',
    'One comment a day from the factory digest workflow.',
  ]);
  return Number(url.trim().split('/').pop());
}

function main(argv = process.argv.slice(2), io = {}) {
  const config = io.config || loadConfig(process.cwd());
  const deps = { gh: io.gh || defaultGh, summary: io.summary || defaultSummary };
  const log = io.log || console.log;
  const now = io.now ?? Date.now();
  const digest = collect(config, deps, now);
  if (isEmpty(digest)) {
    log('Nothing open: no digest posted.');
    return 0;
  }
  const body = format(config, digest, now);
  if (argv.includes('--dry-run')) {
    log(body);
    return 0;
  }
  const issue = digestIssue(config, deps);
  deps.gh(['issue', 'comment', String(issue), '--body', body]);
  log(`Digest posted on #${issue}.`);
  return 0;
}

if (require.main === module) runCli(main);

module.exports = { format, isEmpty, main };
