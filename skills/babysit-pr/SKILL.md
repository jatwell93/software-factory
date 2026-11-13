---
name: babysit-pr
description: >-
  Drive an open pull request to a clean state without the user relaying anything:
  wait for CI, fetch unresolved review-bot and human review threads, judge each one,
  fix and push or reply and resolve, and repeat until CI is green and the reviews
  have gone quiet. Use after opening or pushing to a PR, when the user says
  "babysit", "check the bot comments", "check the PR comments", "is CI green",
  "/babysit-pr <n>", or pastes a bot review comment. Do NOT use to merge, or for PRs
  on branches you did not create in this session or change.
---

# Babysit a PR

Goal: the user never pastes a bot comment or a CI failure into the session again.

## Settings

Read `factory.config.yml`: `owner` (written `<owner>`), `default_branch`,
`labels.needs_human` (default `needs-human`), `review_bots` (the bots whose reviews
count), `ci_workflows` and `max_babysit_rounds` (default 5, written `<cap>`).

The factory's scripts are in `$FACTORY_DIR/scripts`. The runner sets
`$FACTORY_DIR`; locally, set it to a checkout of the factory first.

## The loop

1. **Wait for CI** in the background, never with `sleep`:
   `gh pr checks <n> --watch --fail-fast` with `run_in_background: true`. You are
   woken when it exits.
2. **Read the feedback:** `node "$FACTORY_DIR/scripts/pr-feedback.js" <n>`. It prints JSON:
   `checks` (pass / fail / pending), `unresolvedThreads`, the latest `reviews` per
   author, issue `comments`, `actionable` (a count), `settled`, and when not
   settled, `waitingOn` (why) and `quietUntil` (when the quiet window ends).
3. **Act on each item** (rules below). Commit fixes with conventional messages,
   one logical fix per commit, run the gates for the files you changed
   (`gates` in the config), push.
4. **Repeat from 1** after every push. Review bots post minutes after a push, so
   green checks do not mean the reviews are in.
5. **Stop when** `settled` is `true` and `actionable` is `0`. If `waitingOn` is only
   `["quiet window"]`, schedule one check-back for just after `quietUntil`
   (`ScheduleWakeup`, or a background `sleep <seconds> && node "$FACTORY_DIR/scripts/pr-feedback.js" <n>`)
   instead of polling.

Cap: **`<cap>` fix rounds per PR.** After that, stop and report what is still open.

Log the one-line state at each step with `node "$FACTORY_DIR/scripts/pr-feedback.js" <n> --summary`.

## One-shot mode (factory runner)

The factory runner starts one pass per review or CI event on a change's PR, and
each workflow run ends after its pass. In that mode:

- **Never wait.** No `--watch`, no background jobs, no scheduled check-backs.
  Ignore the quiet window: every late bot review starts its own pass.
- **Exit without changes** while `checks.pendingActions` in the report is not
  empty. Those GitHub Actions checks end with a `workflow_run` event, which
  starts the next pass. Pending checks from other apps do not hold the pass;
  their results arrive as reviews.
- **Round cap across runs.** Run `node "$FACTORY_DIR/scripts/babysit-round.js"` first. On exit 3
  (the cap is used), add the `needs_human` label to the PR, comment `@<owner>` with
  what is still open, and stop. Otherwise end every fix commit message with the
  trailer `Babysit-Round: <next>` from its output, one round per pass.
- **Check before pushing.** Run `node "$FACTORY_DIR/scripts/check-no-go.js" --change <id>`. On
  any non-zero exit, do not push: add the `needs_human` label and comment with the paths.
- Act on every actionable item in this one pass, push once, and stop.
- **A pass that pushes nothing parks the PR.** If you end without a push while
  something is still open (a human thread you answered but may not resolve, a
  check you cannot fix, a decision), add the `needs_human` label and comment `@<owner>`
  with the open items. The router counts a thread whose last reply is yours as
  handled, and a review older than the head commit as seen; anything else would
  start another pass on the next event, and the next, without end.
- **On a per-change PR** (the prompt says `pr: per-change`), every `needs_human`
  label above goes on the change's tracking issue
  (`node "$FACTORY_DIR/scripts/factory-issue.js" <id>`), never on the PR, and the
  comment goes there too. The owner's one removal from the issue then resumes the
  change. Do not start the next task: the router does that once the PR has settled.

## Judging an item

Bots are often right about the diagnosis and wrong about the remedy. Judge them
separately.

- **Re-derive the issue from the code.** Read the cited lines and their callers.
  Do not trust the bot's description of what the code does.
- **Valid:** fix it at the narrowest responsible layer, with a test that fails
  without the fix. Then check the rest of the diff for the same class of bug, not
  just the cited line.
- **Valid diagnosis, poor remedy:** fix it your way and say why in the reply.
- **Not valid:** reply in the thread with one or two sentences of evidence
  (`path:line`, the guard that already covers it), then resolve it.
- **Already fixed by a later commit:** a bot usually resolves its own thread
  ("Resolved in `<sha>`"). If it did not, reply with the commit SHA and resolve.
- **Needs a product decision** (behavior, pricing, copy the owner owns): do not
  guess. Reply "Needs a decision from the owner", leave it unresolved, add the
  `needs_human` label (`gh pr edit <n> --add-label <label>`), and list it in
  your report.

Reply and resolve with the script, so the thread ids stay exact:

```bash
node "$FACTORY_DIR/scripts/pr-feedback.js" reply <threadId> "Not a bug: amount is clamped at src/x.ts:42."
node "$FACTORY_DIR/scripts/pr-feedback.js" resolve <threadId>
```

## Per-source notes

- **Code-health bots** (CodeScene and similar) post a review per push; only the
  latest one counts. A failed gate arrives as a `COMMENTED` review whose body
  says the gate failed, plus one inline thread per smell. Act on duplication and
  complexity flags when the change makes the real code better, not to satisfy
  the score. A smell you decide to keep gets a reply saying why.
- **A bot that cannot review** (a quota or "unable to review" notice) has given no
  feedback. Report it once: a ruleset that requires that bot's review will block
  the merge.
- **Failing checks:** read the log with `gh run view <run-id> --log-failed`, fix
  the cause, never re-run a red check hoping it passes. A flaky test is a finding:
  say so in the report.

## Report

End with a short report: PR, final check state, each item and what you did
(fixed in `<sha>` / replied / needs decision), and anything still open. If the
PR body no longer matches the change, update it with `gh pr edit <n> --body-file`.

## Never

- Merge, enable auto-merge, or approve. Merging follows the change's autonomy
  setting in `openspec/changes/<id>/proposal.md`, handled outside this skill.
- Push to the default branch, force-push, or rewrite already-pushed commits.
- Resolve a human reviewer's thread. Reply and let them resolve it.
