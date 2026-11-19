# Owner setup

What only the repository's owner can do after `init`, in the order to do it. `init` prints the short form of these steps; `doctor` checks them and prints the matching part of this page for each gap.

The order matters, mainly for the ruleset: see [the branch ruleset](#the-branch-ruleset).

## The secret

The factory's runner logs in to Claude with a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`.

```
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

The first command prints a token; the second asks you to paste it. It must be a **repository** secret on this repository (an organisation secret works too, but `doctor` only lists repository secrets and will report it missing).

## The Claude GitHub App

The agent action authenticates to GitHub through the Claude GitHub App, so the app must be installed on every repository the factory runs in. Install it from <https://github.com/apps/claude> if you have not, then check its access at **GitHub > Settings > Applications > Installed GitHub Apps > Claude > Configure**, under **Repository access**:

- **All repositories**: nothing more to do, the new repository is covered.
- **Only select repositories**: add this repository.

`doctor` cannot see installations, so it always reports this step as skipped. If it is missing, a factory run fails at the Claude step.

## The branch ruleset

The factory needs `main` (your default branch) to refuse unchecked changes. This is a **branch ruleset**, not a tag ruleset and not a classic "branch protection rule": `doctor` reads rulesets only.

**Do these in order**, because the factory's two checks, `factory/no-go-guard` and `factory/change-ids`, only exist once they have run on a pull request. They run from the workflow files on the default branch (they use `pull_request_target`), so they cannot run on the pull request that adds them, and GitHub's check picker only offers checks that have run in the repository.

1. Merge the pull request `init` produced.
2. Open any other pull request, even a one-line README edit, and let its checks finish. Both factory statuses and your CI check should appear on it. You can merge it.
3. Create the ruleset: **Settings > Rules > Rulesets > New ruleset > New branch ruleset**.
   - **Name:** anything, for example `main`. **Enforcement status:** Active.
   - **Bypass list:** leave it empty.
   - **Target branches:** Add target > **Include default branch**.
   - **Rules:** keep **Restrict deletions** and tick **Block force pushes**. Tick **Require status checks to pass**, then use **Add checks** to add these three:
     - `factory/no-go-guard`
     - `factory/change-ids`
     - your CI job's check name: the name shown in the pull request's checks list (for a job `check` in a workflow `CI`, it is `check`).
   - **Create.**
4. Run `doctor`: `ruleset checks`, `ruleset gate` and `force pushes` should read `ok`.

If **Add checks** shows nothing for `factory/...`, the checks have not run yet (go back to step 2) or GitHub has not refreshed its list, which can take a few minutes after the first run.

Do not tick **Require a pull request before merging** for this: you cannot approve your own pull request, and the factory's checks already run on every pull request.

## The approval policy

**Settings > Actions > General** sets whether workflow runs started by a bot wait for you. Under the default policy a later push by `github-actions[bot]` to a factory pull request can run as `action_required` until you click **Approve and run workflows**. The factory does not depend on the setting; decide it after you have seen whether your repository shows the prompt (a private repository may not).

On a private repository the first factory push needs that click: GitHub holds the run until you approve it, and the factory cannot approve it for you. Open the pull request's **Checks** tab and click **Approve and run workflows**.

## Owner tasks that edit a protected path

A task marked `(owner)` that edits a protected path (the factory's baseline, your `protected_paths`, or the change's `no_go`) cannot ride on the factory's pull request. `factory/no-go-guard` treats any pull request from `claude[bot]` or with a `factory:*` label as a factory pull request and has no exemption for the owner, by design: a label is editable, so the guard cannot tell your edit from an agent's.

Do the edit on its own pull request:

1. Branch from `main` (not from the factory branch) and make the edit, for example adding a bot to `review_bots` in `factory.config.yml`. Do not add a `factory:*` label.
2. Merge that pull request. Wait for the guard and your CI to pass first.
3. Tick the task in the change's `tasks.md` on the factory's pull request (or on `main` before it continues), then remove `needs-human` from the issue so the factory resumes. Update the factory branch from `main` if the edit affects its checks.

Do not make the edit on the factory branch: the guard fails and, if you then push a revert, its status may stay stale (close and reopen the pull request to re-run it).

## FACTORY_DIR

To run the factory's scripts and skills from your own machine (`factory-new-change.js`, `pr-feedback.js`, `cleanup-merged.js`, `factory-doctor.js`, `factory-upgrade.js`), set the environment variable `FACTORY_DIR` to a checkout of <https://github.com/jatwell93/software-factory>, then call `node "$FACTORY_DIR/scripts/<name>.js"`.
