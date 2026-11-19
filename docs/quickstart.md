# Quickstart

From an empty checkout to your first factory pull request. Allow about an hour, most of it waiting for GitHub. When the factory is running, read the [guide](factory-guide.md) for how a change flows.

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

Open `factory.config.yml` and read it before you commit. The gates are what the agent must pass before it pushes.

## 3. Do the owner steps

`init` prints them; [owner-setup.md](owner-setup.md) has the detail. In order:

1. Add the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.
2. Check the Claude GitHub App covers the repository.
3. Commit what `init` wrote in one pull request and merge it.
4. Open any other pull request (a README edit is enough) and let its checks finish. The factory's two required checks, `factory/no-go-guard` and `factory/change-ids`, only exist after they have run once. On a private repository you may have to click **Approve and run workflows** on that pull request.
5. Add a branch ruleset on `main` that requires those two checks, your CI check and "Block force pushes".

Then run `doctor` from the project's root:

```
node "$FACTORY_DIR/scripts/factory-doctor.js"
```

Each line reads `ok`, `warn`, `FAIL` or `skip`, and each gap prints the command that fixes it. `skip` for the Claude GitHub App is normal: a script cannot see installations. Carry on when nothing says `FAIL`.

If you use a review bot (Copilot, CodeScene, Cursor Bugbot, CodeRabbit, Sentry), list its login under `review_bots` now. See [review bots](owner-setup.md#review-bots).

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

## 5. Watch it build

The factory opens a pull request for the first task, waits for CI and the review bots, fixes what they raise, then marks the pull request ready. You merge each one (or the single per-change pull request, once `WIP:` is gone from its title). When no task is left, the factory archives the change and asks you to merge the last pull request.

If nothing happens for a while, see [When it stops](factory-guide.md#when-it-stops).

## If it fails

- **A run ends `success` but there is no pull request.** Read the run log for lines that start `denied:`: the agent was refused a tool call. Usually a gate command is missing from `gates`.
- **A required check stays "Waiting for status".** Close and reopen the pull request. The factory also re-posts the two statuses after ten minutes.
- **`needs-human` appears on the tracking issue.** The factory asked you a question or reached an owner task. Do it, then remove the label.
- **The first push of a private repository stays "Waiting for approval".** Click **Approve and run workflows** on the pull request's Checks tab.

## Next

- [The guide](factory-guide.md): the whole flow, the Autonomy block, owner tasks and what the factory will not do.
- [Owner setup](owner-setup.md): secret, app, ruleset, approval policy, review bots.
- `factory-upgrade.js --ref <sha|v*>` moves your pin when the factory has a new release; `doctor` tells you when the pin is a branch or an unprotected tag.
