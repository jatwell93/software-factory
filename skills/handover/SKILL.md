---
name: handover
description: >-
  Write or update the handover file for a spec change (OpenSpec)
  (openspec/changes/<id>/handover.md) so the next session can pick the work up with
  /resume-change instead of a pasted prompt. Use when the user asks for "a handover", "a
  prompt for the next agent", "write up where we are", before /compact or ending a
  long session, and after each task of a change merges. Do NOT use for work that is
  not tracked in a spec change.
---

# Write the handover

The handover lives in the repository, next to the change it describes:
`openspec/changes/<change-id>/handover.md`. It replaces the prose prompt the user
used to copy between sessions. The next session reads it with `/resume-change`.

The factory's scripts are in `$FACTORY_DIR/scripts`. The runner sets
`$FACTORY_DIR`; locally, set it to a checkout of the factory first. The
runner denies a command that contains a shell variable, so there the prompt
gives the literal path: write it in place of `$FACTORY_DIR`.

## Steps

1. Find the change: the argument, else the change named by the branch, else the one
   active change in `openspec list`. Ask only if several are plausible.
2. Collect the facts. Do not write from memory alone:
   - `git log --oneline -10` and `git status -sb`
   - open PRs for the change: `gh pr list --state open --json number,title,headRefName`
   - for each open PR: `node "$FACTORY_DIR/scripts/pr-feedback.js" <n>` (checks and unresolved items)
   - the first unchecked task in `tasks.md`
3. Rewrite `handover.md` in full with the template below. It is a snapshot, not a log:
   replace stale content, do not append. History is in git.
4. **Optional, only if the project keeps a memory store** (the working guide
   names one, or the repo has a script that writes to it): log one entry
   pointing at the handover, on the feature branch and before the commit in
   step 5, so the store goes into that commit. A project without a store skips
   this step; a run with no way to write to the store skips it too.
5. Commit it on the current feature branch with the work it describes
   (`docs(openspec): update <change-id> handover`), or in its own small PR if the
   branch has already merged.

## Template

```markdown
# Handover: <change-id>

Updated: <YYYY-MM-DD> · <default branch> at <short sha>

## State

<2-4 sentences: what is done, what is merged, what is in flight.>

## Next

<The next task id from tasks.md and the first concrete step. One task.>

## Open PRs

- #<n> <title>: <checks state>, <open review items or "clean">

## Waiting on the user

- <decision or manual step, with the options and your recommendation>
  (or "Nothing.")

## Learnings

- <non-obvious fact the next agent would otherwise rediscover, with path:line>
```

## Rules

- Every claim must be checkable: cite `path:line`, PR numbers, task ids, SHAs.
- No secrets, customer data or production hostnames: the repository may be public.
- Keep it under about 60 lines. Detail belongs in `tasks.md`, the PR bodies, or memory.
- "Waiting on the user" holds only things the agent cannot decide. Anything the
  agent can decide, it decides and records under State.
