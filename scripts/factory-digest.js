#!/usr/bin/env node
/**
 * Post the factory's daily digest as one comment on the digest issue: what waits
 * on the owner (needs-human), the open factory PRs with their pr-feedback
 * verdict, and the factory runs of the last day with what each cost and how long
 * it took (a run that failed is listed even without a record). Run by the digest
 * workflow; posts nothing when all three are empty.
 *
 * Cost and duration come from the record each agent run uploads as the
 * `factory-run-record` artifact (scripts/factory-run-record.js). A run with no
 * record (it died before the agent, or its log was missing) says "cost unknown".
 *
 * Usage: node scripts/factory-digest.js [--dry-run]   (--dry-run prints the body)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCli } = require('../lib/cli.js');
const { loadConfig } = require('../lib/config.js');
const { createRouter } = require('../lib/router.js');
const {
  RECORD_ARTIFACT,
  RECORD_FILE,
  formatCost,
  formatDuration,
} = require('../lib/run-record.js');
const { FACTORY_WORKFLOW } = require('../lib/workflow.js');

const PR_FEEDBACK = path.join(__dirname, 'pr-feedback.js');
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultGh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const defaultSummary = (n) =>
  execFileSync('node', [PR_FEEDBACK, String(n), '--summary'], { encoding: 'utf8' }).trim();

/**
 * The record a run uploaded, or null when it has none: `gh run download` fails
 * for a run without the artifact, which is every run that started no agent.
 */
function defaultRecord(id, exec = execFileSync) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-'));
  try {
    exec('gh', ['run', 'download', String(id), '-n', RECORD_ARTIFACT, '-D', dir], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8'));
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Runs that ended without a verdict (still running, skipped) have nothing to report yet.
const FINISHED = new Set(['success', 'failure', 'cancelled', 'timed_out']);

const json = (deps, args) => JSON.parse(deps.gh(args));
const isEmpty = (d) => !d.parked.length && !d.prs.length && !d.runs.length;

/** A run's wall-clock time in ms, or null when GitHub gave no times. */
function wallClock(run) {
  const ms = Date.parse(run.updatedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** One line of the runs section. */
function runLine(run) {
  const agent = run.record?.duration_ms ?? null;
  const time = agent === null ? wallClock(run) : agent;
  const duration =
    agent === null && time !== null ? `${formatDuration(time)} wall` : formatDuration(time);
  const turns = run.record?.turns ? `, ${run.record.turns} turns` : '';
  return `- ${run.displayTitle} (${run.conclusion}): ${formatCost(run.record?.cost_usd ?? null)}, ${duration}${turns}: ${run.url}`;
}

/** The total of the costs that are known, and how many runs have none. */
function totalLine(runs) {
  const known = runs.filter((r) => typeof r.record?.cost_usd === 'number');
  const total = known.reduce((sum, r) => sum + r.record.cost_usd, 0);
  const unknown = runs.length - known.length;
  const note = unknown ? ` (${unknown} run(s) with unknown cost)` : '';
  return `Total: ${formatCost(total)} over ${known.length} run(s)${note}`;
}

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
    ...section('Factory runs, last 24 hours', digest.runs, runLine),
    ...(digest.runs.length ? [totalLine(digest.runs), ''] : []),
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

  /**
   * The factory runs of the last day worth a line: those that ran an agent (they
   * uploaded a record) and those that failed, each with its record when it has one.
   */
  function recentRuns() {
    const since = new Date(now - DAY_MS).toISOString();
    const fields = 'databaseId,displayTitle,conclusion,url,startedAt,updatedAt';
    const args = ['run', 'list', '--workflow', FACTORY_WORKFLOW, '--limit', '200'];
    const runs = json(deps, [...args, '--created', `>=${since}`, '--json', fields]);
    return runs
      .filter((run) => FINISHED.has(run.conclusion))
      .map((run) => ({ ...run, record: deps.record(run.databaseId) }))
      .filter((run) => run.record !== null || run.conclusion === 'failure');
  }

  return { parked: parked(), prs: factoryPrs(), runs: recentRuns() };
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
  const deps = {
    gh: io.gh || defaultGh,
    summary: io.summary || defaultSummary,
    record: io.record || defaultRecord,
  };
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

module.exports = { defaultRecord, format, isEmpty, main, runLine, totalLine };
