'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'workflows');
const LEVEL = { none: 0, read: 1, write: 2 };

/** The `permissions` mapping a workflow file declares at the top level, or null. */
function topLevelPermissions(text) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch {
    return null;
  }
  const permissions = doc && doc.permissions;
  return permissions && typeof permissions === 'object' ? permissions : null;
}

/**
 * The scopes a caller workflow grants less of than the factory's own template for it,
 * as [scope, level] pairs. A reusable workflow cannot ask for more than its caller
 * grants, so a caller short of the template fails at startup. A caller with no
 * permissions mapping gets the repository default and is not judged here.
 */
function missingPermissions(callerText, name) {
  const wanted = topLevelPermissions(fs.readFileSync(path.join(TEMPLATES, name), 'utf8')) || {};
  const have = topLevelPermissions(callerText);
  if (have === null) return [];
  return Object.entries(wanted).filter(
    ([scope, level]) => (LEVEL[have[scope] ?? 'none'] ?? 0) < LEVEL[level],
  );
}

/**
 * The caller text with each missing scope raised to its level, in the top-level
 * `permissions:` block, leaving the rest of the file (and its line endings) alone.
 */
function grantPermissions(text, missing) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^permissions:\s*(#.*)?$/.test(line));
  if (start === -1) throw new Error('no top-level permissions block to edit');
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  for (const [scope, level] of missing) {
    const at = lines.findIndex(
      (line, i) => i > start && i < end && new RegExp(`^\\s+${scope}:`).test(line),
    );
    if (at === -1) {
      lines.splice(end, 0, `  ${scope}: ${level}`);
      end += 1;
    } else {
      lines[at] = lines[at].replace(/:\s*\w+/, `: ${level}`);
    }
  }
  return lines.join(eol);
}

module.exports = { grantPermissions, missingPermissions };
