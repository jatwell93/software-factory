'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'workflows');

/** The `on` mapping of a workflow file, or null when it is not a mapping. */
function triggersOf(text) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch {
    return null;
  }
  const on = doc && (doc.on ?? doc.true);
  return on && typeof on === 'object' && !Array.isArray(on) ? on : null;
}

/**
 * True when the factory's template for this caller can be dispatched by hand and the
 * project's copy cannot. The reviews-settled run dispatches a caller to recover a
 * status GitHub never started a run for, and a dispatch of a workflow with no
 * `workflow_dispatch` trigger is refused. Callers the template does not judge, or
 * whose trigger shape is not a mapping, are not reported.
 */
function missingDispatch(callerText, name) {
  const wanted = triggersOf(fs.readFileSync(path.join(TEMPLATES, name), 'utf8'));
  const have = triggersOf(callerText);
  return Boolean(wanted && 'workflow_dispatch' in wanted && have && !('workflow_dispatch' in have));
}

/** The lines of the template's top-level `workflow_dispatch:` block, indent kept. */
function dispatchBlock(name) {
  const lines = fs.readFileSync(path.join(TEMPLATES, name), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}workflow_dispatch:\s*$/.test(line));
  let end = start + 1;
  while (end < lines.length && /^ {3,}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

/**
 * The caller text made dispatchable like the template: the `workflow_dispatch` trigger
 * with its `pr` input at the end of the `on:` block, the PR number from `inputs.pr` in
 * the concurrency group, and `pr: ${{ inputs.pr }}` passed to the reusable workflow.
 * The rest of the file and its line endings are left alone. Returns null when the file
 * has no `on:` block of lines to add to, so the caller reports it instead of guessing.
 */
function addDispatch(text, name) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*(#.*)?$/.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  lines.splice(end, 0, ...dispatchBlock(name));
  const out = lines.map((line) =>
    /^\s+group:.*github\.event\.pull_request\.number \}\}/.test(line)
      ? line.replace(
          'github.event.pull_request.number }}',
          'github.event.pull_request.number || inputs.pr }}',
        )
      : line,
  );
  const ref = out.findIndex((line) => /^\s+factory_ref:/.test(line));
  const hasPr = out.some((line) => /^\s+pr:\s/.test(line));
  if (ref !== -1 && !hasPr) {
    const indent = out[ref].match(/^\s*/)[0];
    out.splice(ref + 1, 0, `${indent}pr: \${{ inputs.pr }}`);
  }
  return out.join(eol);
}

module.exports = { addDispatch, missingDispatch };
