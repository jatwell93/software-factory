# Quickstart

From an empty checkout to your first factory pull request. Allow about an hour, most of it waiting for GitHub. When the factory is running, the [owner guide](owner-guide.md) is your daily routine and the [factory guide](factory-guide.md) explains how a change flows.

## What you need

- A GitHub repository you own, with a default branch (`main`) and a CI workflow that runs your tests, or a test command you can pass to `init`.
- A Claude subscription (the factory logs in with a token) and the [Claude GitHub App](owner-setup.md#the-claude-github-app) installed on the repository.
- On your machine: Node 22 or later, `git`, and the [`gh` CLI](https://cli.github.com) logged in (`gh auth login`). For a project with no `package.json`, the OpenSpec CLI is installed for you when needed.

Everything the factory does to your repository runs in GitHub Actions. Your machine runs three commands (`init`, `doctor`, `new-change`) and your own Claude sessions.

## 1. Get the factory

```
git clone https://github.com/jatwell93/software-factory
cd software-factory && npm ci
export FACTORY_DIR="$PWD"
```

Pin to a release tag (`v*`) or a full 40-character commit SHA, never a branch. `init` uses the commit your checkout is on, so check out the tag you want first and make sure it is pushed.

## 2. Run `init`

From the root of your project, on a branch (not `main`):

```
node "$FACTORY_DIR/scripts/factory-init.js"
```

It detects your stack, your owner and default branch, and your CI workflow names, then writes `factory.config.yml`, six caller workflows pinned to the factory commit, five agent skills, a block in `AGENTS.md` and the git hooks; runs the spec source's own setup (OpenSpec); and creates the labels. It lists every file it wrote, including the ones the OpenSpec setup created.

If it cannot find a gate it stops and asks for one: pass `--gate "<test command>"` or `--ci-workflow "<workflow name>"`. `--dry-run` shows the plan and writes nothing. A second run changes nothing.

A project with no root `package.json` (frontend and backend in subfolders, say) gets no detected gate: pass each with `--gate`, and set `runner.install` and the runtime versions in the config. `--ci-workflow` must name a workflow that really runs on pull requests: check its name under the repository's Actions tab. A workflow file GitHub cannot parse never shows up there, so the factory would wait for a CI run that never comes. `--spec-source paul` selects the [PAUL adapter](reference.md); without it you get OpenSpec.

Open `factory.config.yml` and read it before you commit. The gates are what the agent must pass before it pushes.

## 3. Do the owner steps

`init` prints them; [owner-setup.md](owner-setup.md) has the detail. In order:

1. Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.
2. Check the Claude GitHub App covers the repository.
3. Commit what `init` wrote in one pull request and merge it. Only the files `init` listed: check `git status` first, so a stray folder or compiled file does not ride along. The factory's checks that run from the default branch do not exist yet, so only `factory/reviews-settled` runs on this pull request, and it ends green with "nothing to settle". On a pin older than the fix it fails with "cannot read factory.config.yml": ignore it, it is not a required check.
4. Add the branch ruleset on `main` (the factory's two checks, your CI check, no force pushes) with one command, from the project's root: `factory init --apply-ruleset --ci-check <your CI check name>`. The name is the one in a pull request's checks list. It refuses until step 3 is merged. By hand instead: [owner setup](owner-setup.md#by-hand).

Then run `doctor` from the project's root:

```
node "$FACTORY_DIR/scripts/factory-doctor.js"
```

Each line reads `ok`, `warn`, `FAIL` or `skip`, and each gap prints the command that fixes it. `skip` for the Claude GitHub App is normal: a script cannot see installations. Carry on when nothing says `FAIL`.

If you use a review bot (Copilot, CodeScene, Cursor Bugbot, CodeRabbit, Sentry), list its login under `review_bots` now (or pass `--review-bot <login>` to `init`). Any bot or person can comment either way; the list only sets what the pull request waits for. See [review bots](owner-setup.md#review-bots).

## 4. Plan a first change

Pick something small: one or two tasks, no new dependency, nothing in a protected path.

```
node "$FACTORY_DIR/scripts/factory-new-change.js" add-health-check --title "Add a health check"
```

This creates `openspec/changes/add-health-check/` with a `proposal.md` and an empty `tasks.md`. The id is lowercase letters, digits and hyphens, at most 42 characters; the command refuses anything else and writes nothing.

In a Claude session in your project:

1. Write the proposal (why, what changes) and any spec deltas. Run `openspec validate add-health-check --strict`.
2. Run `/to-tickets add-health-check`. Answer the quiz on the slices. It writes `tasks.md`, opens a tracking issue and a plan pull request.
3. Merge the plan pull request. That merge is the go.

With `--spec-source paul` there is no `/to-tickets`: plan the phase with `/paul:plan` (one plan per task, `autonomous: true` unless it is an owner task) and commit the roadmap and plans on a branch. The change id is the phase name without its number (phase `05-security-alerts` is change `security-alerts`). The agent that pushes the plan pull request labels it, and you check the labels before you merge:

```
gh label create factory:security-alerts --force
gh pr create --label factory:security-alerts --label factory-ready
```

Merging a plan pull request without both labels starts nothing (the Factory run logs `not a factory PR`). If that happens, start the change by hand with `gh workflow run Factory -f change_id=security-alerts`. `init` writes the same rule into your `AGENTS.md`, so the agent that opens the plan pull request has it.

## 5. Watch it build

The factory opens a pull request for the first task, waits for CI and the review bots, fixes what they raise, then marks the pull request ready. You merge each one (or the single per-change pull request, once `WIP:` is gone from its title). When no task is left, the factory archives the change and asks you to merge the last pull request.

If nothing happens for a while, see [When it stops](factory-guide.md#when-it-stops).

## If it fails

- **A run ends `success` but there is no pull request.** Read the run log for lines that start `denied:`: the agent was refused a tool call. Usually a gate command is missing from `gates`.
- **A required check stays "Waiting for status".** Close and reopen the pull request. The factory also re-posts the two statuses after ten minutes.
- **`needs-human` appears on the tracking issue.** The factory asked you a question or reached an owner task. Do it, then remove the label.
- **The first push of a private repository stays "Waiting for approval".** Click **Approve and run workflows** on the pull request's Checks tab.

## Next

- [Owner guide](owner-guide.md): the daily loop, `factory status`, weekly upkeep, swapping a review bot.
- [The guide](factory-guide.md): the whole flow, the Autonomy block, owner tasks and what the factory will not do.
- [Owner setup](owner-setup.md): secret, app, ruleset, approval policy, review bots.
- `factory-upgrade.js --ref <sha|v*>` moves your pin when the factory has a new release; `doctor` tells you when the pin is a branch or an unprotected tag.
