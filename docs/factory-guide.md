# Factory guide

How a change goes from an idea to merged code, with you giving input only at the start and at each merge. Read this when you have not used the process for a while. New here? Start with the [quickstart](quickstart.md).

## The funnel

```
 PLAN  (you, in a session with Claude)
 ┌──────────────────────────────────────────────────────────────┐
 │ 1. Write the change       proposal.md + spec deltas          │
 │                           openspec validate <id> --strict    │
 │ 2. /to-tickets <id>       answer the quiz on the slices      │
 │                           -> tasks.md, a tracking issue,     │
 │                              one ticket per task, a plan PR  │
 │ 3. Merge the plan PR      this is the "go"                   │
 └──────────────────────────────────────────────────────────────┘
                              │
 BUILD  (the factory, in GitHub Actions; no session needed)
 ┌──────────────────────────────────────────────────────────────┐
 │ 4. Task 1 -> PR           CI and bot reviews are handled     │
 │ 5. Next task              you merge, or the PR carries on    │
 │ 6. No task left           the factory archives the change    │
 └──────────────────────────────────────────────────────────────┘
                              │
 FINISH  (you)
 ┌──────────────────────────────────────────────────────────────┐
 │ 7. Merge the last PR      the tickets and tracking issue     │
 │                           close by themselves                │
 └──────────────────────────────────────────────────────────────┘
```

## Your part, in order

1. **Plan.** Run `node "$FACTORY_DIR/scripts/factory-new-change.js" <id>` to create the change, then ask Claude to write it. It needs `proposal.md` with an `## Autonomy` block (see below), spec deltas in `specs/`, and a passing `openspec validate <id> --strict`. The change id is lowercase letters, digits and hyphens only (the router rejects capitals), and at most `change_id_max_length` characters (42 by default).
2. **Slice.** Run `/to-tickets <id>`. Claude proposes the tasks, each with a demo and what blocks it. Say whether the slices are too big or too small. Nothing is written until you approve.
3. **Go.** Merge the plan PR. It carries the labels `factory:<id>` and `factory-ready`; that merge starts task 1. You do not dispatch anything.
4. **Merge each factory PR** when it is green and reviewed. How many PRs there are depends on the `pr:` key:
   - **`pr: per-change`** (best for small, related tasks): one PR for the whole change. Its title starts with `WIP:` while tasks are still landing. **Do not merge it until `WIP:` is gone and the factory has mentioned you.** The factory archives the change on that PR before it asks.
   - **No key** (one PR per task): merge each PR; the merge starts the next task. When none is left, the factory opens one more PR that archives the change.
5. **Done** when the last PR is merged. The tickets and the tracking issue close with it.

## The Autonomy block

In `proposal.md`:

````markdown
## Autonomy

```yaml
merge: human
pr: per-change
no_go:
  - some/extra/path/**
```
````

`merge: human` is the only value in use: you always merge. `pr: per-change` is optional (a new change carries it as a commented line to switch on). `no_go` adds paths to the ones the factory may never edit.

## What the factory will not do

It never merges, never touches production, and never edits the protected paths. The list is three parts: the factory's fixed baseline (`.github/**`, `.claude/**`, `.githooks/**`, `AGENTS.md`, `CLAUDE.md`, `factory.config.yml`; `BASELINE` in `lib/baseline.js`), plus `protected_paths` in your `factory.config.yml` (for example lock files, migrations or a backup script), plus the `no_go` entries in the change's `proposal.md`. Run `node "$FACTORY_DIR/scripts/check-no-go.js" --change <id>` to check a branch's changes against all three; it names any protected path they touch and does not print the list itself.

A task that needs a protected path, a vendor console, or production access is an **owner task**: write it `- [ ] 2.3 (owner) ...`. The factory stops there and asks you. Billing, auth and production-data work is best planned as owner tasks. An owner task that edits a protected path goes on [its own pull request](owner-setup.md#owner-tasks-that-edit-a-protected-path), not on the factory's.

## When it stops

| What you see                                                                          | What it means                                           | What to do                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A comment from the factory that mentions you, and `needs-human` on the tracking issue | It hit a question it should not guess                   | Answer in a comment, then **remove the `needs-human` label**                                                                                                                                        |
| `factory-retry` on the tracking issue                                                 | A run failed; one retry is queued                       | Wait. A second failure escalates with both run links                                                                                                                                                |
| Nothing happens for hours                                                             | The hourly check (`schedule`) is late; GitHub delays it | Wait. Check state with `node "$FACTORY_DIR/scripts/pr-feedback.js" <pr>`. A per-change PR gets no event when its quiet window ends: `gh workflow run factory.yml -f pr=<pr> --ref main` moves it on |
| A run is `success` and there is no PR                                                 | The agent was refused a tool call                       | Read the `denied:` lines in the run log; add the missing command to `gates` (an owner edit)                                                                                                         |
| A required check says "Waiting for status"                                            | GitHub started no run for an agent push                 | Wait ten minutes (the factory re-posts it), or close and reopen the PR                                                                                                                              |
| An owner task is next                                                                 | The factory escalated it on purpose                     | Do it, tick it in `tasks.md`, remove `needs-human`                                                                                                                                                  |
| "Branch is out of date" on a PR                                                       | `main` moved on                                         | Use "Update branch", then merge                                                                                                                                                                     |

To pause a change on purpose, add `needs-human` to its tracking issue. To start one without the plan-PR merge, `gh workflow run factory.yml -f change_id=<id> --ref main`.

## Where things live

| Thing                             | Where                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Your settings                     | `factory.config.yml` (a protected path: change it on its own PR)                     |
| The plan and the tasks            | `openspec/changes/<id>/` (`proposal.md`, `tasks.md`, `handover.md`)                  |
| The tracking issue                | The open issue labelled `factory:<id>`                                               |
| One ticket per task               | Sub-issues of the tracking issue                                                     |
| What the factory is allowed to do | `.claude/skills/run-spec/SKILL.md` (a copy of the factory's; `upgrade` refreshes it) |
| Progress of a PR                  | `node "$FACTORY_DIR/scripts/pr-feedback.js" <pr> --summary`                          |
| Finished changes                  | `openspec/changes/archive/`                                                          |

## Related

- [Quickstart](quickstart.md) and [owner setup](owner-setup.md).
- `skills/to-tickets/SKILL.md`: how the slicing and the quiz work.
- The [README](../README.md): what each script and workflow does.

## A review comment after you merge

If a bot or reviewer comments on a PR after it merged, no babysit pass will read it. The factory opens one issue per merged PR, titled `Late review comments on #N: <title>`, and adds any later comment to it. It mentions the owner and quotes the comment (with `@names` defanged). Only a top-level inline comment, or a review that asks for changes, counts; the owner, the factory app and `github-actions[bot]` are ignored. No Claude run is spent: the `late-comment` job runs a script. Close the issue when you have dealt with it, or hand it to the factory as a change.
