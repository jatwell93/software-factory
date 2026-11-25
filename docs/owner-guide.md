# Owner guide

The daily routine, in one page. You plan and merge; the factory does the rest. Not set up yet? Do the [quickstart](quickstart.md) first. Want to know why it works this way? Read the [factory guide](factory-guide.md).

## One-time: a short command

Every command below is `factory <command>`. Add this to your shell profile once:

```
export FACTORY_DIR=/path/to/software-factory
alias factory='node "$FACTORY_DIR/bin/factory.js"'
```

Run `factory` from your project's root, logged in to `gh`.

## The loop

| Step | You                                                     | The factory                                     |
| ---- | ------------------------------------------------------- | ----------------------------------------------- |
| 1    | `factory new-change <id>`, then write the proposal      |                                                 |
| 2    | `/to-tickets <id>` in a Claude session; answer the quiz | Writes `tasks.md`, tickets, a plan pull request |
| 3    | Merge the plan pull request. That is the go             | Starts task 1                                   |
| 4    | Walk away                                               | Builds, fixes CI and bot comments, marks ready  |
| 5    | `factory status`, then merge what is ready              | Starts the next task                            |
| 6    | `factory post-merge`                                    | Nothing. It tidies your checkout                |
| 7    | Answer anything under `needs-human`                     | Waits for you                                   |

First time through? The [quickstart](quickstart.md#4-plan-a-first-change) walks steps 1 to 3 with a real change.

## Can I merge?

```
factory status          # every open pull request, one line each
factory status 42       # one pull request; exit 0 when you can merge
```

| Word      | Meaning                                                     | You                                                                    |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ready`   | Checks pass, nothing unresolved, quiet window over          | Merge                                                                  |
| `safe`    | Same, but a quiet window or a slow bot is still outstanding | Merge now. A late comment opens an issue                               |
| `wait`    | Checks are still running                                    | Wait                                                                   |
| `blocked` | A check failed or a review item is unresolved               | Usually the factory fixes it. If not, see [stuck](#something-is-stuck) |
| `done`    | Merged or closed                                            | Nothing                                                                |

The list ends with **waiting on you (needs-human)**: issues and pull requests that need your answer.

Merging early is safe when the word is `safe`. The factory opens a follow-up issue for a comment that lands after the merge ([details](factory-guide.md#a-review-comment-after-you-merge)).

## After you merge

```
factory post-merge      # pulls main, deletes the merged branch, shows what is next
```

Then start a **fresh Claude session** for the next piece of work. Do not `/compact` a long one. The plan lives in the repository, so a new session loses nothing:

```
/resume-change <id>     # reads handover.md and tasks.md, reports state, carries on
```

If a session ran long and you want to stop mid-change, ask Claude to write the handover first (`handover` skill).

## Needs-human

The factory stops and mentions you when it hits a question, an owner task, or two failed runs. Do the owner task if there is one, then **reply on the tracking issue**. Within the hour the factory removes `needs-human` itself and carries on (to go at once, remove the label yourself). Only your comments count, and only on the tracking issue. If you replied but the owner task is still unticked, the factory asks again. [More cases](factory-guide.md#when-it-stops).

An owner task that edits a protected path (`.github/**`, `factory.config.yml`, and so on) goes on [its own pull request](owner-setup.md#owner-tasks-that-edit-a-protected-path).

## The daily digest

Each day the factory posts one comment on its digest issue: what waits on you, the open factory pull requests and their state, and the last day's runs with cost and duration. Read it instead of opening each pull request. "Cost unknown" means the run died before it recorded a figure; it is never a guess.

## Weekly upkeep

Five minutes, from each project's root:

```
factory doctor          # config, workflows, labels, secret, ruleset, review bots, pin
```

Every gap prints the command that fixes it. `FAIL` needs action; `warn` can wait a little; `skip` is normal when GitHub could not be asked.

**Pin drift.** `doctor` warns when your pinned factory version is 5 or more commits behind. To move one project:

```
factory upgrade --ref <sha|v*>
```

To move all of them, list each project's path in `~/.factory-consumers` (one per line) and run:

```
factory pin-sync --dry-run     # shows the plan
factory pin-sync               # opens one pin pull request per project; you merge each
```

**Local clutter.** `factory cleanup` deletes merged local branches and stale worktrees.

## Swapping a review bot

A bot runs out, or you change tools. In each project:

1. Edit `factory.config.yml` (its own pull request, because it is a protected path):
   - `review_bots`: the bot's login.
   - `review_bot_checks`: the check run that bot finishes, for a bot that only comments on findings. Cursor's is `Cursor Bugbot`; Sentry's is `Seer Code Review`.
2. Merge it, then run `factory doctor`. It tells you whether the bot has posted on recent pull requests and whether the mapped check really appears.

Details: [review bots](owner-setup.md#review-bots).

## Something is stuck

| Symptom                                    | Do                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Nothing has happened for hours             | Wait; the hourly check is late. Then `factory status <pr>`          |
| A required check says "Waiting for status" | Wait ten minutes, or close and reopen the pull request              |
| A run is `success` but there is no PR      | Read the `denied:` lines in the run log; add the command to `gates` |
| "Branch is out of date"                    | **Update branch** on the pull request, then merge                   |
| `doctor` says `FAIL`                       | Run the command it prints                                           |

The full table is in the [factory guide](factory-guide.md#when-it-stops).

## Next

- [Factory guide](factory-guide.md): the funnel, the Autonomy block, what the factory will not do.
- [Owner setup](owner-setup.md): secret, app, ruleset, approval policy.
- [Reference](reference.md): every script and workflow.
