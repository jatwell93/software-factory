'use strict';

/**
 * The OpenSpec-specific reads that check-no-go and the id check still make
 * directly. Task 2.2 of extract-software-factory moves them behind the
 * spec-source adapter, and this file goes away with it.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Lines of the first yaml fence under `## Autonomy`, or []. */
function autonomyYaml(lines) {
  const heading = lines.findIndex((l) => /^##\s+Autonomy\s*$/.test(l));
  const fence = lines.findIndex((l, i) => heading !== -1 && i > heading && /^```ya?ml\s*$/.test(l));
  if (fence === -1) return [];
  const body = lines.slice(fence + 1);
  const end = body.findIndex((l) => /^```/.test(l));
  return end === -1 ? body : body.slice(0, end);
}

/** A yaml scalar without its comment and quotes. */
function scalar(text) {
  return text
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

const isFiller = (line) => /^\s*(#.*)?$/.test(line);

class NoGoFormatError extends Error {
  /** The spec file is wrong, not the run: callers report it instead of crashing. */
  userError = true;
}

/**
 * The `no_go` list from the first yaml fence under `## Autonomy`, or [].
 * Reads a block list (`  - path`, with blank and comment lines between items)
 * or a one-line flow list (`no_go: [a, b]`). Any other shape throws
 * NoGoFormatError instead of being read partly: a misread list would silently
 * drop protected paths, so an unrecognised one fails the check.
 */
function parseNoGo(proposal) {
  const yaml = autonomyYaml(proposal.split(/\r?\n/));
  const key = yaml.findIndex((l) => /^no_go:/.test(l));
  if (key === -1) return [];
  const inline = scalar(yaml[key].slice('no_go:'.length));
  if (inline) return flowList(inline, yaml[key]);
  return blockList(yaml.slice(key + 1));
}

/** `[a, b]` to its items; any other inline value is unrecognised. */
function flowList(inline, line) {
  const flow = inline.match(/^\[(.*)\]$/);
  if (!flow) throw new NoGoFormatError(`unrecognised no_go value: ${line.trim()}`);
  return flow[1].split(',').map(scalar).filter(Boolean);
}

/** `- item` lines up to the next top-level key; an indented non-item is unrecognised. */
function blockList(rest) {
  // Items may be indented or not: YAML allows `- path` at the key's own column.
  const end = rest.findIndex((l) => !isFiller(l) && !/^\s*-\s/.test(l));
  if (end !== -1 && /^\s/.test(rest[end])) {
    throw new NoGoFormatError(`unrecognised line in no_go list: ${rest[end].trim()}`);
  }
  return (end === -1 ? rest : rest.slice(0, end))
    .filter((l) => !isFiller(l))
    .map((l) => scalar(l.replace(/^\s*-\s+/, '')))
    .filter(Boolean);
}

const changesDir = (root) => path.join(root, 'openspec', 'changes');

/** One change's `no_go` list from its proposal.md, or [] when it has none. */
function changeNoGo(changeId, root) {
  const file = path.join(changesDir(root), changeId, 'proposal.md');
  return fs.existsSync(file) ? parseNoGo(fs.readFileSync(file, 'utf8')) : [];
}

/** Names of every active change folder (the archive excluded), valid ids or not. */
function changeFolders(root) {
  const dir = changesDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'archive')
    .map((d) => d.name);
}

/** Folder names under changes/ that a list of changed paths touches, the archive excluded. */
function foldersInPaths(paths) {
  const names = paths
    .map((p) => p.trim().match(/^openspec\/changes\/([^/]+)\//))
    .filter((m) => m && m[1] !== 'archive')
    .map((m) => m[1]);
  return [...new Set(names)];
}

module.exports = {
  NoGoFormatError,
  parseNoGo,
  changeNoGo,
  changeFolders,
  changesDir,
  foldersInPaths,
};
