---
name: to-tickets
description: >-
  Slice a spec change (OpenSpec) into tracer-bullet tasks the factory can build one
  per run, quiz the owner on the breakdown, then write them into the change's
  tasks.md and publish them as GitHub sub-issues of the change's tracking issue
  with native blocking links. Use when the user says "/to-tickets <change-id>",
  "break this change into tickets", "slice the tasks", or has just written a
  proposal that the factory should build. Do NOT use for a change that fits one
  run (write a one-task tasks.md instead), or for work outside a spec change.
disable-model-invocation: true
---

# To tickets

Turn a spec change into **tasks**: tracer-bullet vertical slices, each
declaring the tasks that **block** it. `tasks.md` stays the source of truth: the
factory router, `(owner)` escalation, per-change ticking and `no_go` all read
it. The GitHub issues are a published copy that shows the plan and its blocking
edges, and each one closes when the PR that lands its task merges.

## Settings

Read `factory.config.yml`: `labels.change_prefix` (default `factory:`; a change's
label is `<prefix><id>`, written `<change-label>` below), `labels.ready` (default
`factory-ready`), `change_id_max_length` and `default_branch`.

The factory's scripts are in `$FACTORY_DIR/scripts`. The runner sets
`$FACTORY_DIR`; locally, set it to a checkout of the factory first.

## 1. Read the change

Read `openspec/changes/<id>/proposal.md` (including its `## Autonomy` block),
`design.md` if present, every `specs/*/spec.md` delta, and any existing
`tasks.md`. Read the code the change touches, using the repository's own names.
Look for prefactoring: "make the change easy, then make the easy change".

Run `node "$FACTORY_DIR/scripts/check-change-ids.js"`. It fails when the change's id
is one the factory cannot run (a bad character, or longer than
`change_id_max_length`). Rename the change folder before you go on, because a
change the factory cannot run never starts.

## 2. Draft vertical slices

- Each task cuts a narrow but **complete** path through every layer it needs
  (schema, API route, UI, tests), not one layer of the change.
- Each task is **demoable** on its own: name what you can show when it lands.
  A task with no demo is a horizontal slice; rework it.
- Each task fits **one factory run**: one fresh context window that has never
  seen this conversation, about 30 to 60 minutes of work, inside the runner's
  `timeout_minutes`. Prefactoring goes first.
- A task that needs a `no_go` path (the factory's baseline, the config's
  `protected_paths` and the proposal's `no_go` list), a vendor console or
  production access is an `(owner)` task, or the change is not for the factory
  at all.
- **Wide refactors** (one mechanical change whose blast radius spans the
  codebase) use expand-migrate-contract instead: expand (new form beside the
  old), migrate in batches sized by blast radius, each blocked by the expand,
  then contract, blocked by every batch.

Give each task its blocking edges: the tasks that must land before it can start.
Number tasks so that **file order is a valid build order**, blockers first: the
router always takes the first unchecked task in `tasks.md`, top to bottom.

## 3. Quiz the owner

Show the breakdown as a numbered list. For each task: title, **Demo**,
**Blocked by**, and `(owner)` if it applies. Ask:

- Is the granularity right (too coarse, too fine)? Should any task merge or split?
- Is each blocking edge real?
- Does every task have a demo?

Iterate until the owner approves. **Write nothing and create no issue before
the approval.**

## 4. Write tasks.md

Rewrite `openspec/changes/<id>/tasks.md` in the repository's format:

```markdown
## 1. <group>

- [ ] 1.1 <title>: <what it delivers, end to end>.
      Demo: <what you can show when it lands>.
      Acceptance: <the tests that prove it>.
- [ ] 1.2 (owner) <title> ...
      Blocked by: 1.1.
```

Keep file paths and code out of task text, except where a prototype pinned a
decision (a schema, a state machine) more exactly than prose can.

## 5. Publish the tickets

1. Tracking issue: `n=$(node "$FACTORY_DIR/scripts/factory-issue.js" <id>)` (it finds, adopts
   or creates the one labelled `<change-label>`).
2. For each task in file order (blockers first, so their numbers exist):

   ```bash
   gh issue create --title "<id> <task number>: <title>" --body-file <file> \
     --parent "$n" [--blocked-by <issue>,<issue>]
   ```

   Body: `## What to build` (end-to-end behaviour), `## Demo`, `## Acceptance
criteria` as a checklist, and the line `Task <number> of spec change
<id>; tasks.md is the source of truth.` The blocking edges are native, so
   the body has no `Blocked by` section.

   **Never label a ticket `<change-label>`.** That label marks the tracking
   issue; `factory-issue.js` and the router take the first open issue
   carrying it.

3. Append each ticket's number to its task line as soon as the issue exists,
   before creating the next one: `- [ ] 1.2 <title> (#812): ...`. `run-spec`
   writes `Closes #812` into the PR that lands the task. Keep this exact
   `(#<n>):` form: `factory-ticket.js` reads only the first `(#<n>):` on
   the line, so an issue cited in the title as `(#734)` is never closed.

If a run stops partway, re-run this step: skip every task whose line already
carries `(#<n>):`, and pass those numbers to `--blocked-by` for the tasks still
to publish. Never create a second issue for a task.

Do not close or edit the tracking issue.

## 6. Hand the plan to the owner

Commit the change folder on a feature branch
(`docs(openspec): tickets for <id>`) and push. Make sure the `ready` label exists
(`gh label create <ready label> --color 0e8a16 --description "Owner approved: the factory may start this change" --force`;
`factory-issue.js` already made `<change-label>`), then open the PR labelled
`<change-label>` and with the `ready` label and run `babysit-pr`. The owner
merging it is the approval that starts the build: the factory picks up the first
task once the plan is on the default branch. Report the PR, the tracking issue
and the ticket numbers.

---

Adapted from `to-tickets` in [mattpocock/skills](https://github.com/mattpocock/skills)
(`skills/engineering/to-tickets/SKILL.md`), MIT License, Copyright (c) 2026 Matt
Pocock. Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: The above copyright
notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.
