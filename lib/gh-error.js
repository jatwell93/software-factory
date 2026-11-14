'use strict';

/**
 * What a failed `gh` call said. The error's `message` starts with the command that
 * ran ("Command failed: gh api repos/.../commits/<sha>"), so matching on it would
 * read the command, not the answer: a SHA that happens to contain "404" would look
 * like a 404. The answer is on stderr; the message is the fallback for errors that
 * carry none.
 */
const ghText = (error) => String(error.stderr || error.message);

/** The first line of the answer, for a message to the person running the script. */
const ghReason = (error) =>
  ghText(error)
    .split(/\r?\n/)
    .find((line) => line.trim()) || 'no output';

/**
 * True when GitHub answered that the ref does not exist. The commits endpoint says
 * 404 for some unknown refs and 422 ("No commit found for SHA") for others, so both
 * count; any other status (a 502, a 401, a missing gh) says nothing about the ref.
 */
const isNoSuchRef = (error) => /\bHTTP (?:404|422)\b/.test(ghText(error));

module.exports = { ghReason, ghText, isNoSuchRef };
