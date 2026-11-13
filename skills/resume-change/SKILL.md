---
name: resume-change
description: >-
  Start a session on a spec change (OpenSpec) from its committed handover instead of
  a pasted prompt: read openspec/changes/<id>/handover.md and tasks.md, check open PRs
  and the local checkout, then report the state and continue with the next task. Use
  when the user says "/resume-change <change-id>", "pick up <change>", "carry on with
  <change>", "where were we", or starts a session by naming a spec change.
---

# Resume a change

The factory's scripts are in `$FACTORY_DIR/scripts`. The runner sets
`$FACTORY_DIR`; locally, set it to a checkout of the factory first.

## Steps

1. Pick the change: the argument, else the one active change in `openspec list`.
   Ask only if several are plausible.
2. Read, in this order:
   - `openspec/changes/<id>/handover.md` (if missing, say so and rebuild the
     picture from `tasks.md` and git)
   - the first unchecked task in `openspec/changes/<id>/tasks.md`, and the
     `proposal.md` sections that task cites
   - if the project keeps a memory store (the working guide names one), its
     latest entry for the change. A project without one skips this.
3. Check the live state; the handover may be stale:
   - `git status -sb`, `git log --oneline -5`
   - if PRs from the last session have merged, run
     `node "$FACTORY_DIR/scripts/cleanup-merged.js"` to delete their branches and
     move onto an up-to-date default branch
   - for each open PR named in the handover: `node "$FACTORY_DIR/scripts/pr-feedback.js" <n>`,
     then hand any actionable items to the `babysit-pr` loop
4. Report in a few lines: state, open PRs, what is waiting on the user, and the
   task you are starting. Where the handover and the live state disagree, trust
   the live state and say what changed.
5. Continue with the next task unless the handover lists a decision that blocks
   it. A blocking decision is the only reason to stop and ask.

## When the task is done

Tick the task in `tasks.md` and update the handover with the `handover` skill on
the task's branch, in the task's commit. Then push, open the PR and run
`babysit-pr`. Then go on to the next task if it does not depend on an unmerged
PR. If it does, stop and say which PR has to merge first.
