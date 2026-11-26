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

### One command

Merge the pull request `init` produced, then run `init` again with the name of each CI check that must pass (the name shown in a pull request's checks list; for a job `check` in a workflow `CI`, it is `check`):

```
factory init --apply-ruleset --ci-check check
```

It creates one ruleset named `software-factory` through the GitHub API: `factory/no-go-guard`, `factory/change-ids` and your checks required, force pushes and deletion blocked, no bypass. A second run changes nothing; if the ruleset is there but lacks a check, it updates it. You need admin rights on the repository. Run `doctor` after: `ruleset checks`, `ruleset gate` and `force pushes` should read `ok`.

It refuses until the factory's check workflows are on the default branch. Required earlier, a check could never report and the `init` pull request could not merge. The API takes a check name that has not run yet, so you do not need a throwaway pull request first.

### By hand

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

## The CI audit

The agent and the review bots do not decide what may merge: the required CI checks do. They run on GitHub's runners, outside the agent's environment, with the tests and policy you chose, and the agent cannot change which of them run (the workflow that judges a factory pull request comes from the default branch). A project whose CI is one lint job passes the same green tick as one with tests and scans, so `init` and `doctor` report which kinds of audit your CI has. It reads the workflow files and your dependency-update config, runs nothing, and only warns.

| Kind               | Found when a workflow contains                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| tests              | `npm test`, `pytest`, `go test`, `cargo test`, `make test`, vitest, jest, rspec  |
| lint or type check | eslint, `tsc`, ruff, mypy, clippy, `go vet`, golangci-lint, `npm run lint`       |
| security scan      | the CodeQL action, `npm audit`, Trivy, Semgrep, Bandit, `cargo audit`, pip-audit |
| secrets scan       | gitleaks, trufflehog, detect-secrets                                             |
| dependency updates | `.github/dependabot.yml` or a Renovate config; a cooldown is noted when missing  |

A scan that runs from GitHub's settings (CodeQL's default setup) leaves no file, so it shows as missing: ignore that line.

What to do about a gap depends on the project. `doctor` says which it thinks yours is: **greenfield** with no CI workflow of its own or fewer than 20 commits, **brownfield** otherwise.

**Greenfield.** Require every check from the first commit; there is nothing to clear.

1. Write the tests and their CI job before the first factory task. A gate that cannot fail makes every change look good, and `init` has no CI workflow to name until one exists (it asks for `--ci-workflow`).
2. Add a job per kind above, using the tools for your stack: Node `npm test`, `npm run lint`, CodeQL (javascript-typescript), gitleaks; Python `pytest`, `ruff check .`, `mypy .`, CodeQL (python), `pip-audit`; Go `go test ./...`, `go vet ./...`, CodeQL (go); Rust `cargo test`, `cargo clippy`, `cargo audit`.
3. Require each job: `init --apply-ruleset --ci-check <job>` for every job name in a pull request's checks list.
4. Add a Dependabot config with a cooldown (below).

**Brownfield.** Keep the CI jobs you have and add only what is missing, as separate jobs.

1. Add each new scan as a check that is **not** required. It will report findings your code already has, and a required check would block every factory pull request.
2. Clear the findings, or record them as the baseline (CodeQL and Semgrep can both baseline). Then require the job with `init --apply-ruleset --ci-check <job>`.
3. A slow test suite is not a reason to leave it out: the factory waits for CI, and `gates` in `factory.config.yml` can run a fast subset before each push while CI runs the whole suite.

**Dependency updates, both.** Configure Dependabot or Renovate to wait a few days after a release before proposing it: a compromised release is usually caught and pulled in that time. Dependabot: `cooldown: default-days: 7` under each `updates` entry; Renovate: `minimumReleaseAge: "7 days"`. Group routine minor and patch bumps so they arrive as a few pull requests, keep major bumps separate, and merge them yourself: the factory does not auto-merge. Dependabot's own pull requests are not factory pull requests (the factory acts only on the Claude app's), so the guard and your required checks judge them like any other.

## The approval policy

**Settings > Actions > General** sets whether workflow runs started by a bot wait for you. Under the default policy a later push by `github-actions[bot]` to a factory pull request can run as `action_required` until you click **Approve and run workflows**. The factory does not depend on the setting; decide it after you have seen whether your repository shows the prompt (a private repository may not).

On a private repository the first factory push needs that click: GitHub holds the run until you approve it, and the factory cannot approve it for you. Open the pull request's **Checks** tab and click **Approve and run workflows**.

## The command allowlist

`init` adds read-only rules to the project's `.claude/settings.json` (under `permissions.allow`), so the agent stops asking before each factory command. Nothing else in the file changes, and a second run adds only what is missing. Skip it with `--no-permissions`. `doctor` warns when a rule is missing. The file is a protected path, so it goes in the same pull request as the rest of `init`.

The rules name `$FACTORY_DIR`, written as the skills write it, so the file holds no path of yours. Your shell must set `FACTORY_DIR` ([below](#factory_dir)).

| Allowed                                | Why it is safe                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `scripts/pr-feedback.js`               | Reads a pull request: checks, threads, reviews. Its reply and resolve commands only answer and close threads. |
| `scripts/factory-status.js`            | Reads every open pull request and prints one line each.                                                       |
| `scripts/factory-doctor.js`            | Reads the project and GitHub and prints each gap with its fix.                                                |
| `scripts/check-no-go.js`               | Reads a diff and fails when it touches a protected path.                                                      |
| `scripts/check-ignored.js`             | Reads git’s ignore rules and fails when a source file is hidden by one.                                       |
| `scripts/check-change-ids.js`          | Reads the change ids in a pull request and fails on a clash.                                                  |
| `scripts/babysit-round.js`             | Reads the commit trailers of the current branch and prints the round count.                                   |
| `scripts/factory-check-change.js`      | Reads the spec source and fails when a change is missing.                                                     |
| `bin/factory.js status and doctor`     | The front door, for the two read-only commands only. The rest (init, upgrade, cleanup) write and still ask.   |
| `gh pr view`, `list`, `checks`, `diff` | Read a pull request. They have no write verb.                                                                 |
| `gh run view`, `list`                  | Read workflow runs and their logs.                                                                            |
| `gh workflow view`, `list`             | Read workflows.                                                                                               |
| `gh issue view`, `list`                | Read issues.                                                                                                  |

Never allowed: `gh api` (it writes with any verb), `gh pr merge`, any delete, a force push. These factory scripts write to the project or to GitHub, so they still ask:

| Not allowed                        | Why                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `scripts/cleanup-merged.js`        | deletes local branches and worktrees                              |
| `scripts/factory-post-merge.js`    | pulls the default branch and deletes the merged branch            |
| `scripts/factory-init.js`          | writes the project and GitHub (labels, ruleset)                   |
| `scripts/factory-upgrade.js`       | rewrites the workflows and skills of the project                  |
| `scripts/factory-pin-sync.js`      | opens pull requests in other projects                             |
| `scripts/factory-issue.js`         | creates a tracking issue when there is none                       |
| `scripts/factory-ticket.js`        | creates issues on GitHub                                          |
| `scripts/factory-new-change.js`    | writes a change into the project                                  |
| the rest of `scripts/factory-*.js` | run inside the workflow runner: they label, comment or start runs |

## Review bots

Any reviewer can comment on a factory pull request: a bot you listed, a bot you did not, or a person. Every review or comment starts a babysit pass, which reads the unresolved threads, judges each one, fixes it or replies and closes it. The factory has no per-bot behaviour, and no bot name can halt a run.

`review_bots` in `factory.config.yml` has one job: it lists the bots `factory/reviews-settled` waits for before the factory marks the pull request ready. It is optional: with none, the factory waits only for CI and the quiet window. For each bot listed, `factory/reviews-settled` stays pending until the bot has posted on the pull request, or `reviews_timeout_minutes` (30 by default) have passed since the last push.

Switching bots is a config edit and nothing else: no workflow, secret or ruleset change.

To switch, say from Sentry to Cursor Bugbot or CodeRabbit:

1. Install the new bot on the repository and open a pull request it has reviewed.
2. Read its login: `gh api repos/OWNER/REPO/pulls/N/reviews --jq '.[].user.login'` and the same for `issues/N/comments`. Drop the `[bot]` suffix and use lowercase. The login is often not the product name (Copilot's is `copilot-pull-request-reviewer`, Sentry's `sentry`).
3. Replace the old login with the new one in `review_bots`, on [its own pull request](#owner-tasks-that-edit-a-protected-path) (`factory.config.yml` is protected). Keep the old one while its subscription runs if you want the factory to keep waiting for it.
4. If the old bot's checks were required by your ruleset, remove them there; if you want the new bot's check to gate merges, add it (the picker lists a check only after it has run once).

Two things to check for each bot:

- **Does it post when it finds nothing?** By default the factory counts a bot as done only when it leaves a review, a comment or a thread. A bot that comments only when it finds a problem then makes every clean pull request wait the full timeout. Name the check run it finishes on every pull request in `review_bot_checks` and the factory counts the bot as done when that check has finished (passed, failed or skipped):

  ```yaml
  review_bots: [sentry, cursor]
  review_bot_checks:
    sentry: Seer Code Review
    cursor: Cursor Bugbot
  ```

  Use the check name exactly as the pull request's checks list shows it. A bot with no entry is waited for as before. `factory doctor` checks every entry: it warns about a bot that is not in `review_bots`, and about a check name that appeared on none of the last 30 merged pull requests (a typo, or a bot not installed here). Run it after any bot change. If a bot has neither comments nor a check run, leave it out of `review_bots` or lower `reviews_timeout_minutes`: its findings still start a babysit pass.

- **Does it comment on every push?** A bot that reviews only the first push of a pull request leaves a later push waiting for a review that will not come. Same remedy.

`doctor` does not check the bot logins: a wrong login means a wait until the timeout and nothing worse.

### Choosing bots at `init`

Pass each bot you want the factory to wait for with `--review-bot` (repeat it; any login works, so this is also the write-in). `init` lowercases it, drops a `[bot]` suffix and writes `review_bots`:

```
node "$FACTORY_DIR/scripts/factory-init.js" --review-bot copilot-pull-request-reviewer --review-bot cursor
```

`init` never overwrites an existing `factory.config.yml`: on a project that has one, `--review-bot` is ignored with a warning, and you edit `review_bots` by hand as above.

Logins seen on real pull requests or in the vendor's documentation (confirm yours with the `gh api` command above before relying on one):

| Bot                   | Login                           | Source                                                                                                 |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub Copilot review | `copilot-pull-request-reviewer` | reviews on real pull requests                                                                          |
| CodeScene             | `codescene-delta-analysis`      | reviews on real pull requests                                                                          |
| Sentry (Seer)         | `sentry`                        | review on a real pull request; it reports mostly through a check, so see "posts when it finds nothing" |
| Cursor Bugbot         | `cursor`                        | Cursor's forum: the app's actions show as `cursor[bot]`                                                |

For CodeRabbit, Gemini Code Assist and others, read the login from a pull request they have reviewed. Bugbot decides whether to review from the Cursor account linked to the pull request's author, and factory pull requests are authored by `claude[bot]`, so check that it reviews the first one before you list it.

### Restricting who may start a run

By default any bot may start a babysit pass. To allow only named bots, set `allowed_bots` in `factory.config.yml` (logins as in `review_bots`; the factory's own two actors stay allowed):

```yaml
allowed_bots:
  - copilot-pull-request-reviewer
  - cursor
```

A bot outside the list then fails its run (the agent action refuses it) and queues a `factory-retry`, so a change stalls until the hourly retry. Set it only if you prefer that to a bot you did not name starting a pass. An empty list is refused.

## Owner tasks that edit a protected path

A task marked `(owner)` that edits a protected path (the factory's baseline, your `protected_paths`, or the change's `no_go`) cannot ride on the factory's pull request. `factory/no-go-guard` treats any pull request from `claude[bot]` or with a `factory:*` label as a factory pull request and has no exemption for the owner, by design: a label is editable, so the guard cannot tell your edit from an agent's.

Do the edit on its own pull request:

1. Branch from `main` (not from the factory branch) and make the edit, for example adding a bot to `review_bots` in `factory.config.yml`. Do not add a `factory:*` label.
2. Merge that pull request. Wait for the guard and your CI to pass first.
3. Tick the task in the change's `tasks.md` on the factory's pull request (or on `main` before it continues), then reply on the issue: within the hour the factory removes `needs-human` and resumes (or remove it yourself to resume at once). Update the factory branch from `main` if the edit affects its checks.

Do not make the edit on the factory branch: the guard fails, and it stays failed until the head changes (a close and reopen re-runs it on the same head and fails again). Pushing a revert re-runs the guard on the new head.

## FACTORY_DIR

To run the factory's scripts and skills from your own machine (`factory-new-change.js`, `pr-feedback.js`, `cleanup-merged.js`, `factory-doctor.js`, `factory-upgrade.js`), set the environment variable `FACTORY_DIR` to a checkout of <https://github.com/jatwell93/software-factory>, then call `node "$FACTORY_DIR/scripts/<name>.js"`.
