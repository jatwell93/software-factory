'use strict';

/**
 * What one agent run cost and how long it took, for the daily digest.
 *
 * The agent action writes an execution log: a JSON array of messages whose last
 * `result` message carries `total_cost_usd`, `duration_ms` and `num_turns`. The
 * log is missing when a run dies early or hits its turn limit, and a field can
 * be missing from it, so every value here may be null: the digest then says
 * "unknown" rather than a made-up number.
 */

const RECORD_VERSION = 1;
// The run job uploads the record under this artifact name and file name; the digest
// downloads them. One place, so the two cannot drift apart.
const RECORD_ARTIFACT = 'factory-run-record';
const RECORD_FILE = 'factory-run-record.json';

/** The messages of an execution log, from a JSON array or JSON lines; [] when unreadable. */
function messagesOf(text) {
  const source = (text || '').trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return source
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

// Number.isFinite is false for a string, null or undefined: it does not coerce.
const numberOrNull = (value) => (Number.isFinite(value) ? value : null);

/** Cost, duration and turns from an execution log's final result message. */
function parseExecution(text) {
  const result = messagesOf(text)
    .filter((m) => m && m.type === 'result')
    .at(-1);
  return {
    cost_usd: numberOrNull(result?.total_cost_usd),
    duration_ms: numberOrNull(result?.duration_ms),
    turns: numberOrNull(result?.num_turns),
  };
}

/** The record a run uploads: what ran, on which change and PR, and what it cost. */
function buildRecord({ executionText, mode, changeId, pr }) {
  return {
    version: RECORD_VERSION,
    mode,
    change_id: changeId,
    pr: pr ? Number(pr) : null,
    ...parseExecution(executionText),
  };
}

/** `$0.42`, or `cost unknown`. */
const formatCost = (usd) =>
  usd === null || usd === undefined ? 'cost unknown' : `$${usd.toFixed(2)}`;

/** `6m12s`, `45s`, or `duration unknown`. */
function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return 'duration unknown';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

module.exports = {
  RECORD_ARTIFACT,
  RECORD_FILE,
  RECORD_VERSION,
  buildRecord,
  formatCost,
  formatDuration,
  messagesOf,
  parseExecution,
};
