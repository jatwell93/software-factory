'use strict';

/**
 * True when two texts are the same apart from line endings. A checkout with
 * `core.autocrlf` (the Windows default) turns the LF files the factory wrote into CRLF
 * in the working tree, so a byte comparison reports every installed file as changed.
 */
const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

module.exports = { sameText };
