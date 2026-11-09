'use strict';

/**
 * Glob to an anchored RegExp: `**` spans directories (and `**` plus a slash
 * also matches zero directories), `*` and `?` stay inside one segment, and a
 * trailing `/` means everything under that directory.
 */
function globToRegExp(glob) {
  const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const segment = (s) =>
    s
      .split('*')
      .map((part) => part.split('?').map(escape).join('[^/]'))
      .join('[^/]*');
  const spans = (s) => s.split('**').map(segment).join('.*');
  const full = glob.endsWith('/') ? `${glob}**` : glob;
  // `s`: a path may contain a newline, and `.*` must still span it.
  return new RegExp(`^${full.split('**/').map(spans).join('(?:.*/)?')}$`, 's');
}

module.exports = { globToRegExp };
