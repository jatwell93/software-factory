# AGENTS.md

This repo is the factory: reusable workflows, scripts, skills and the `factory` command. Projects (date-management-app, time-planner, review-radar) pin it by commit SHA or `v*` tag. Product code does not live here, and factory changes are not made in a project's repo.

## Layout

- `bin/factory.js`, `lib/front-door.js`: the `factory <command>` front door. Each command runs one script in `scripts/` with the same flags and exit codes.
- `scripts/*.js`: one script per job (init, doctor, upgrade, router, digest, sweep, retry, escalate, pr-feedback). Each exports `main` and runs `runCli(main)` when called directly.
- `lib/`: the logic the scripts and tests share. Put logic here, keep scripts thin.
- `.github/workflows/`: reusable workflows. `templates/workflows/`: the thin callers `init` writes into a project.
- `skills/`: the five agent skills copied into projects. `adapters/`: spec sources (OpenSpec, PAUL).
- `schema/`: the `factory.config.yml` schema. `docs/`: quickstart, guide, owner setup, plans.
- `test/`: one `*.test.js` per module, run with `node --test`.

## Workflow

- Branch `feature/*` or `fix/*`; never commit to `main`. Open the PR yourself once the gate passes, then run the `babysit-pr` skill. The owner merges.
- Gate before a commit: `npm test` and `npx prettier --check .`. Prettier is pinned in `package.json`; do not bump it in a feature PR.
- Add or adjust a test for what you touch. A test that cannot fail is not evidence: change the code, see it fail, change it back.
- A new command goes in `COMMANDS` in `lib/front-door.js`, with its script, a help line and a test. Keep the exit codes: 0 done, 1 a check failed, 2 usage or config error.
- A change to a reusable workflow, a template or a skill must be proven in a project at a new pin. Say which one in the PR.
- Files with backslashes are written with the Write or Edit tool, not through the shell.

## Rules that are easy to break

- Scripts run from a checkout of this repo, never from the PR's own tree. Do not make a workflow run code from the PR head.
- A reusable workflow cannot get more permissions than its caller grants. Change `templates/workflows/*` and `lib/permissions.js` together.
- A pin is a commit SHA or a `v*` tag, never a branch.
- Protected paths and the baseline are in `lib/baseline.js`. A project's config can add to them but never shrink them.

## Where the plan is

`docs/plan-seamless-factory.md` and the issues labelled `owner-friction`.
