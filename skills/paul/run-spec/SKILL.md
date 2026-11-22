---
name: run-spec
description: >-
  Build exactly one unchecked plan of a PAUL phase (the spec change), unattended, and
  open a PR for it: check nothing is already in flight, read STATE.md and the plan,
  run PAUL's APPLY then UNIFY for it, run the gates and the no_go check, tick the plan
  line, push and open a PR labelled with the change. Escalate with the needs_human
  label instead of guessing. Used by the factory runner as "/run-spec <change-id>";
  also usable locally to dry-run the factory. For projects whose spec_source is paul.
---

# Run one PAUL plan

You are running without a human at the keyboard. Nobody will answer a question.
When you would normally ask, escalate (below) and stop. Never merge: the owner's
merge is the only gate before production.

## How a PAUL project maps onto the factory

- A **change** is a phase directory: change `<id>` is `.paul/phases/<NN>-<id>/`
  (find it with `ls .paul/phases`). Written `<phase-dir>` below.
- A **task** is a plan. Task `1.2` is the roadmap line `- [ ] 01-02: ...` under
  `### Phase 1:` in `.paul/ROADMAP.md`, and its plan file is
  `<phase-dir>/01-02-PLAN.md`. A decimal phase works the same: task `2.1.1` is
  `02.1-01`. The prompt and the branch name use the dotted task number, written
  `<task-number>` below.
- The factory's own settings for the phase are `<phase-dir>/factory.yml`
  (`pr`, `no_go`, `issue`, `owner`). You never edit that file.
- There is no `handover.md`: PAUL's `.paul/STATE.md` is the session record, and
  UNIFY updates it.
- PAUL is installed in the project (`.claude/commands/paul/` and the framework
  files beside it). Its commands are instructions you follow by reading them;
  do not run its installer, and do not edit anything under `.claude/`.

## Settings

Read `factory.config.yml` first. This skill names these keys:

- `owner`: the GitHub login to ask. Written `<owner>` below.
- `default_branch`: written `<default>` below.
- `branch_prefix` (default `feature/factory-`).
- `labels.change_prefix` (default `factory:`): the change's label is `<prefix><id>`,
  written `<change-label>` below. `labels.needs_human` (default `needs-human`).
- `gates`: the commands to run before a push (section 3).

The factory's scripts are in `$FACTORY_DIR/scripts`. The runner sets
`$FACTORY_DIR`; locally, set it to a checkout of the factory first. The
runner denies a command that contains a shell variable, so there the prompt
gives the literal path: write it in place of `$FACTORY_DIR`.

## 1. Check nothing is in flight

- `gh pr list --state open --label "<change-label>" --json number,url`. If any PR is
  listed, print "<change-label> PR already open: <url>" and stop. One task per change
  at a time. Exception: a per-change run (below) continues the PR it names.
- Read `.paul/STATE.md`: "Blockers/Concerns" and "Session Continuity". If a blocker
  stops the next plan, and the tracking issue (below) has no answer to it, stop and
  say which.
- Read the tracking issue: `node "$FACTORY_DIR/scripts/factory-issue.js" <id>` (it prints the issue number, `<n>`), then
  `gh issue view <n> --comments`. If it still has the `needs_human` label, stop: the
  owner has not answered. If the owner commented after the factory's last
  escalation, that comment is the decision. Follow it for this plan, and record it
  in `.paul/STATE.md` under "Decisions" (the question, the answer, and a link to
  the comment) in this plan's PR.

## 2. Pick the plan

- Read the first unchecked plan line (`- [ ]`) in the phase's section of
  `.paul/ROADMAP.md`, its plan file, and the project's working guide (`AGENTS.md`
  or `CLAUDE.md`, whichever exists).
- **No unchecked plan left:** archive the change ("Archive a finished change",
  below) instead.
- **A plan with no plan file is not yours.** PAUL's PLAN step is a conversation with
  the owner, and an unattended run does not do it. Escalate: ask the owner to run
  `/paul:plan` for it.
- **Owner plans are not yours.** A plan with `autonomous: false` in its frontmatter
  (a checkpoint needs the user), or listed under `owner` in `<phase-dir>/factory.yml`,
  is the owner's: escalate without reading further. So is a plan for a vendor
  console, a production migration, a deploy, or anything needing production
  credentials. The router normally escalates these itself and never starts a run for
  them.
- **no_go paths are not yours.** If the plan can only be done by editing a path
  that `node "$FACTORY_DIR/scripts/check-no-go.js" --change <id>` protects (the
  factory's baseline, the config's `protected_paths` and the phase's `no_go`),
  escalate before writing code.
- If the plan is ambiguous enough that two reasonable readings give different
  behavior, escalate with both readings.

## 3. Build it with PAUL's APPLY, then UNIFY

- `git switch -c <branch_prefix><id>-<task-number>` from an up-to-date `<default>`.
- **APPLY.** Read `.claude/commands/paul/apply.md` and follow it for this one plan,
  through to its last task. Do exactly this plan. Reuse existing code; add or adjust
  tests for what you touch, and make sure each new test fails without your change.
  - APPLY stops at a checkpoint that needs a person (a `checkpoint:human-verify`,
    `human-action` or `decision` task). You cannot continue: push nothing,
    escalate with what the checkpoint asks. This should not happen for a plan that
    is not `autonomous: false`; if it does, the plan's frontmatter is wrong.
  - Keep functions small and flat. Review tools that gate on complexity fail on
    deeply nested functions, and you may not be able to run them here. Aim for
    single-purpose functions with one level of nesting, and early returns over
    nested branches.
  - Parse with an existing parser (a language's own compiler API, `JSON.parse`,
    `URL`) instead of writing a tokenizer or a regex-driven parser.
- Run the gates (`gates` in the config). A gate with no `when` always runs. A gate
  with `when` runs when a changed file (`git diff --name-only <default>...HEAD`
  plus uncommitted files) matches one of its globs. Fix failures; do not skip or
  weaken a test to pass. PAUL's own acceptance criteria in the plan are in addition
  to the gates, not instead of them.
- **UNIFY.** Read `.claude/commands/paul/unify.md` and follow it: it writes
  `<phase-dir>/<plan>-SUMMARY.md`, updates `.paul/STATE.md`, and updates the
  roadmap when the phase completes. Where it would ask the user, record the
  question under "Deferred Issues" in STATE.md instead and carry on.
- **Tick the plan line** if UNIFY did not: in `.paul/ROADMAP.md` change `- [ ]` to
  `- [x]` on the one line of this plan, and nothing else on it or elsewhere.
- Commit with conventional messages.

## 4. Check, push, open the PR

1. `node "$FACTORY_DIR/scripts/check-no-go.js" --change <id>`. On any non-zero exit, do not
   push. Escalate with the listed paths (exit 1) or the error (exit 2, for
   example an unreadable `factory.yml`).
2. `git push -u origin HEAD`.
3. Create the label if it is missing:
   `gh label create "<change-label>" --color 5319E7 --description "Factory task for <id>"`
   (ignore "already exists").
4. `gh pr create --base <default> --label "<change-label>" --title "<conventional title>" --body-file <file>`,
   with the body written in the project's PR template (a `pr` skill, or
   `.github/pull_request_template.md`, if it has one). Say in the body that this
   is a factory PR for task `<task-number>` (plan `<plan-id>`) of `<id>` and that it
   waits for the owner's merge. Add the line that
   `node "$FACTORY_DIR/scripts/factory-ticket.js" <id> <task-number>` prints
   (`Closes #<n>`, or nothing when the task has no ticket), so the merge closes
   the task's ticket.
5. Print the PR URL and stop. Review handling runs as separate `babysit-pr`
   passes started by review and CI events; do not wait for CI here.

## One PR per change (`pr: per-change`)

A change whose `factory.yml` says `pr: per-change` keeps every plan on one
PR, which the owner merges once. The prompt says when a run is one of these, and
names the PR, its branch and the task.

- **First task** (no PR named): as above, but title the PR `WIP: <conventional
title>` and say in the body that later plans land on this PR. Not a draft:
  review bots often skip drafts. The router drops `WIP:` when the last plan is
  done and reviews have settled.
- **Later task** (PR named): re-check the state first, because the run may have
  waited in the queue. The PR must still be open, and the task named in the
  prompt must still be the first unchecked plan in the branch's roadmap. If
  not, print why and stop. Work on the checked-out PR branch; do not create a
  branch or a new PR. The workflow has already merged `<default>` into it when it
  could; if the prompt says the base is older, say so in the PR body.
- **Every task commit** ends with the trailer `Factory-Task: <task-number>`
  (beside `Co-Authored-By`). `babysit-round.js` counts babysit rounds only after
  the newest one, so each task gets its own rounds.
- Push with `git push`, then update the PR body (`gh pr edit <n> --body-file`)
  to list the plans done so far. Keep each task's `Closes #<n>` line from
  `factory-ticket.js`: the PR closes every ticket it lands.

## Archive a finished change

The prompt says when a run is an archive run: every plan line of the phase is
ticked. PAUL archives a whole milestone, never one phase, so archiving here
means two small edits and no move: a marker file in the phase directory, and a
line in STATE.md. The phase directory stays where it is.

1. **Re-check.** The phase's section of `.paul/ROADMAP.md` must still have no
   unchecked plan line, and `<phase-dir>/ARCHIVED` must not exist. If not, print
   why and stop.
2. **Branch.** On a per-change PR (the prompt names it), work on the checked-out
   PR branch. Otherwise `git switch -c <branch_prefix><id>-archive` from an
   up-to-date `<default>`.
3. **Check `no_go` first:** `node "$FACTORY_DIR/scripts/check-no-go.js" --change <id>`. On any
   non-zero exit, escalate.
4. **Check the phase is closed the PAUL way.** Every plan needs its
   `<plan>-SUMMARY.md` beside it. A plan ticked without one was not UNIFYed:
   escalate and name it; do not write the summary yourself.
5. **Write the marker.** Create `<phase-dir>/ARCHIVED` with exactly one line,
   `archived: <YYYY-MM-DD>` (today, UTC). It is the factory's file; PAUL ignores it.
6. **Record it in STATE.md.** In `.paul/STATE.md` set the "Last activity" line to
   `<date> — phase <N> (<id>) archived by the factory` and add the same under
   "Session Continuity" ("Stopped at"). Change nothing else in that file.
7. **Check what changed:** `git status` shows only the marker and `.paul/STATE.md`.
   Anything else: undo it.
8. **Commit** `docs(paul): archive <id>`. On a per-change PR, add the
   trailer `Factory-Task: archive` (beside `Co-Authored-By`), so the archive
   gets its own babysit rounds.
9. **Push and PR.** Run `node "$FACTORY_DIR/scripts/check-no-go.js"` again (the baseline), then
   push.
   - Per-change PR: `git push`, then update the PR body with
     `gh pr edit <n> --body-file` to say the change is archived and add
     `Closes #<tracking issue>` (`node "$FACTORY_DIR/scripts/factory-issue.js" <id>`). Keep
     every task's `Closes` line. The router drops `WIP:` and mentions the owner
     once reviews settle.
   - Otherwise: `gh pr create --base <default> --label "<change-label>" --title "docs(paul): archive <id>" --body-file <file>`.
     The body says this is the factory's archive PR for `<id>`, lists the plans
     closed, and ends with `Closes #<tracking issue>`.
10. Print the PR URL and stop.

## Escalate

1. Find the change's tracking issue: `node "$FACTORY_DIR/scripts/factory-issue.js" <id>`.
   It prints the issue number, `<n>`. It reuses the issue labelled `<change-label>`, else adopts the issue the
   phase's `factory.yml` names (`issue: N`), else creates one.
2. `gh issue edit <n> --add-label <needs_human label>`, then comment: `@<owner>` and
   the task number, what blocks it, the options you see, and your
   recommendation. End with: "Answer here, then remove `<needs_human label>` to resume."
3. If a PR already exists for the task, add the label to it as well, except
   on a per-change PR: there the tracking issue's label alone holds the change,
   so the owner's one removal resumes it.
4. Stop. No task of this change starts while the issue has the label
   (`factory-route.js`); the owner removing it resumes the change, and the next
   run reads the answer (section 1).

## Never

- Merge, approve, or enable auto-merge; call `gh api`.
- Push to `<default>`, force-push, or rewrite pushed commits.
- Edit a `no_go` path, even to fix a failing check.
- Edit anything under `.claude/` or the phase's `factory.yml`, or run PAUL's installer.
- Read `.env` files or secrets, or run a command in the config's `forbidden_commands`.
