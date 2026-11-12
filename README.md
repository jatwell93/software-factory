# software-factory

Plan a change with an agent, then let it build the change task by task as pull requests you only merge. Built on GitHub Actions and Claude Code.

**Status: being extracted from a working setup.** The workflows, scripts and skills are not here yet. What exists so far is the contract the rest is built to:

- `schema/factory.config.schema.json`: every setting a project makes in its `factory.config.yml`.
- `adapters/contract.d.ts`, `contract.js` and `contract-suite.js`: the interface a spec framework implements, and the shared tests every adapter must pass. OpenSpec comes first; others can follow.
- `adapters/openspec.js`: the OpenSpec adapter (changes under `openspec/changes/<id>/`). It runs the shared contract suite, and its `setup` is also tested against the real `openspec` CLI when that is installed.
- `lib/github-source.js`: reads files of a branch that is not checked out, through the GitHub contents API. An adapter given it as its `source` reads that branch and is read-only.
- `examples/`: a sample config.
- `scripts/check-no-go.js`: fails when a factory branch or PR touches a protected path (the factory's baseline in `lib/baseline.js`, the project's `protected_paths`, and the change's own list).
- `scripts/pr-feedback.js`: one report of a PR's checks, unresolved threads and reviews, and when it has settled; also replies to and resolves threads. Which CI workflows it waits for is the config's `ci_workflows`.
- `scripts/babysit-round.js`: counts the fix rounds already pushed to a branch, so the cap (`max_babysit_rounds`) holds across separate runs.
- `scripts/factory-route.js`, `lib/router.js`, `lib/router-deps.js`: decide what one GitHub event means (run a task, babysit a PR, archive, escalate, or nothing). The rules are pure and take their label names, owner and id limit from the config; the GitHub and project reads go through the spec-source adapter and `lib/github-source.js`.
- `scripts/factory-issue.js`, `scripts/factory-ticket.js`, `scripts/factory-retry.js`, `lib/tracking-issue.js`: find or create a change's tracking issue; print the `Closes #n` line for a task's ticket; record a failed or successful run for the retry-once rule. Labels and owner come from the config, task and issue reads from the adapter.
- `scripts/factory-escalate.js`, `scripts/factory-sweep.js`, `scripts/factory-digest.js`: ask the owner to do an `(owner)` task; advance every open per-change PR the router would move (run hourly); post the daily digest. They take labels, owner and default branch from the config and read tasks through the adapter.
- `scripts/cleanup-merged.js`: tidies a local checkout after PRs merge (deletes branches whose remote is gone and whose tip is on GitHub, removes clean worktrees, returns to the default branch). Never deletes the config's `default_branch`.
- `lib/hooks.js`, `scripts/install-git-hooks.js`: write `.githooks/pre-commit` (refuse a commit on the default branch, then run `hooks.chain`) and `pre-push` (refuse a push to it), then point git at them unless the project already has hooks. Secret scanning is the project's own: list it under `hooks.chain`.
- `.github/workflows/no-go-guard.yml`, `factory-ci-relay.yml`, `factory-digest.yml`, `check-change-ids.yml`: reusable workflows (`workflow_call`) a project calls at a pinned ref. Scripts run from a checkout of the factory at that ref, never from the PR. `scripts/factory-env.js` hands them the config's Node version and install command.
- `.github/workflows/factory.yml`: the runner (route, sweep, run, escalate, report). The route job reads `factory.config.yml` once, from the default branch, and every other job takes its settings from the route job's outputs, so a PR branch cannot change the settings its own run uses. In the run job the project's rules and config are restored from the default branch, and the factory's code is moved outside the working tree, reached through `$FACTORY_DIR`. `lib/claude-args.js` builds the agent's caps and tool lists from `max_turns`, `spend_cap_usd`, `gates`, `runner.install` and `forbidden_commands`; `scripts/factory-check-change.js` fails a run early when its change is missing.
- `templates/workflows/*`, `lib/callers.js`: the thin caller workflows `init` writes into a project (triggers, permissions, the pin). The relay's `workflow_run` list is rendered from `ci_workflows`. A pin must be a commit SHA or a `v*` tag.
- `lib/cli.js`: runs a script and turns a bad config or malformed spec file into exit code 2.
- `lib/adapters.js`: loads the adapter the config's `spec_source` names.
- `scripts/check-change-ids.js`: fails on a change folder whose id the factory cannot run.

```
npm ci
npm test
```
