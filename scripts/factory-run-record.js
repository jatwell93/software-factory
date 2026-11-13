#!/usr/bin/env node
/**
 * Write the record of one agent run (cost, duration, turns) as JSON, for the run
 * job to upload and the daily digest to read.
 *
 * Usage: node scripts/factory-run-record.js <out-file> <mode> <change-id> [<pr>] [--execution <file>]
 *   --execution is the agent action's execution log; without it, or when the log
 *   is missing or unreadable, the record has null for cost, duration and turns.
 * Exit codes: 0 written, 2 usage error. It never fails because the log is
 * missing: that is the usual case after a crash, and the record is still useful.
 */
const fs = require('node:fs');
const { runCli } = require('../lib/cli.js');
const { buildRecord, denialLines } = require('../lib/run-record.js');

const MODES = ['task', 'archive', 'babysit'];

/** The log's text, or '' when the file is not there. */
function readLog(file, read) {
  if (!file) return '';
  try {
    return read(file);
  } catch {
    return '';
  }
}

function main(argv = process.argv.slice(2), io = {}) {
  const args = [...argv];
  const flag = args.indexOf('--execution');
  let executionFile = '';
  if (flag !== -1) {
    executionFile = args[flag + 1] || '';
    args.splice(flag, 2);
  }
  const [outFile, mode, changeId, pr = ''] = args;
  const valid =
    outFile &&
    MODES.includes(mode) &&
    /^[a-z0-9][a-z0-9-]*$/.test(changeId || '') &&
    /^([1-9][0-9]*)?$/.test(pr) &&
    args.length <= 4;
  if (!valid) {
    (io.error || console.error)(
      'usage: factory-run-record.js <out-file> <mode> <change-id> [<pr>] [--execution <file>]',
    );
    return 2;
  }
  const read = io.read || ((file) => fs.readFileSync(file, 'utf8'));
  const executionText = readLog(executionFile, read);
  for (const line of denialLines(executionText)) (io.log || console.log)(line);
  const record = buildRecord({
    executionText,
    mode,
    changeId,
    pr,
  });
  (io.write || ((file, text) => fs.writeFileSync(file, text)))(
    outFile,
    `${JSON.stringify(record)}\n`,
  );
  return 0;
}

if (require.main === module) runCli(() => main());

module.exports = { main };
