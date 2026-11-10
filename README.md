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
- `lib/cli.js`: runs a script and turns a bad config or malformed spec file into exit code 2.
- `lib/adapters.js`: loads the adapter the config's `spec_source` names.
- `scripts/check-change-ids.js`: fails on a change folder whose id the factory cannot run.

```
npm ci
npm test
```
