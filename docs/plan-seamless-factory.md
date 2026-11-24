# Plan: a seamless factory

Goal: the owner plans and merges; the factory does everything else. This plan comes from a retro of the last five sessions (8 to 24 Nov 2026) and from three comparable systems. Each item is a GitHub issue labelled `owner-friction`.

## What cost the owner time

About 195 owner messages over three sessions. Roughly 80 said "merged and pulled to main", 35 pasted a bot comment, 20 asked to move a pin, and 19 were `/compact` or a continuation. The owner also pasted `doctor` output and could not remember the script path (`$FACTORY_DIR/scripts/factory-doctor.js`).

## What the three comparable systems show

### Ona automations (`gitpod-io/memo/.ona/automations`)

17 YAML automations, each a cron, webhook or manual trigger plus one agent prompt, with `limits: {maxParallel: 1, maxTotal: N}`.

- `pr-shepherd` (every 2 hours) finds stalled PRs, rebases conflicting ones, resolves additive conflicts, closes duplicates, and adds `needs-human` when a rebase fails its checks. Idea for us: a scheduled sweep for stalled factory PRs. It is a script-first version, not another agent.
- `post-merge-verifier` runs on a merged PR, skips `chore:`, `docs:` and `refactor:` titles, waits for the deploy, then smoke-tests. Idea for us: an optional post-merge step that also does the local clean-up the owner types today.
- `needs-human-requeue` removes `needs-human` when a human comments after the label. We already ask the owner to remove the label by hand. This removes that touch.
- `pr-reviewer` merges when CI is green, threads are resolved and nothing is conflicting; it counts `[ci-fix]` commits and stops at 3. That matches our `Babysit-Round` cap. Merging by an agent stays out of scope here (production deploys on merge).
- `automation-auditor` (weekly) reviews how the other automations did. Idea for us: a weekly digest of friction signals.
- Every automation starts with an environment health check and files an issue instead of exiting silently.

### loop-engineering (`cobusgreyling/loop-engineering`)

- One front-door binary: `loop init`, `loop doctor`, `loop status`, `loop cost`. `doctor` has exit codes 0 healthy, 1 warnings, 2 blocked, and `--json`. This is the model for a single `factory` command.
- "Week one is report only": a new project starts with the factory reporting, not acting. We already have per-change opt-in; a report-only first week is worth documenting.
- A circuit breaker (`loop-ledger.json`) stops a loop that repeats the same failure. We have the babysit round cap; the ledger idea adds "same failure twice, escalate".
- `doctor` prints the top three next actions, not every check. Cheaper to read than our full list.

### Warp Factories (`warp.dev/factories`)

- Factories as code: one `factory.yaml` for repositories, secrets, integrations, agents, automations, runners, skills, scorers. Ours is `factory.config.yml`; the lesson is that onboarding is one definition plus one command.
- Scorers: an LLM classifies a sample of finished runs (efficiency, compliance, quality) against a rubric. Failures go in batches to a self-improvement agent that proposes changes to skills and configuration, a few times a day.
- Idea for us: the digest already records cost and duration per run. Add a weekly "friction" pass that reads denied tool calls, escalations and retries and opens one issue with proposed skill or config changes.
- Blueprints with gates between stages: our task, babysit and ready stages already work like this.

## What we copy, and what we do not

Copy: one front-door command with `--json` and exit codes (Ona and loop agree on health checks); scheduled stalled-PR sweep; needs-human requeue; weekly self-audit; environment health check at the start of a run.

Do not copy: agent merging (production deploys on merge); a hosted control plane; one agent per cron tick with no script (our scripts decide, the agent only fixes).

## The issues

1. `factory` front-door CLI.
2. Pin sync: a bump PR in each consumer when the factory releases.
3. Post-merge helper and merge detection.
4. Faster "ready" signal: owner PRs, slow bots, early merge.
5. `doctor --json`, `init` hygiene, ruleset through `gh api`.
6. Safe allowlist for factory commands.
7. Agent guide for software-factory; separate it from date-management.
8. Open an issue for every known gap in the handover.
9. Owner's guide: the daily loop and session hygiene.
10. `needs-human` requeue on owner comment.
11. Stalled-PR sweep.
12. Weekly friction audit (scorer-style, later).

Order: 1, 7, 2, 3, 4, 5, 6, 8, 9, then 10 to 12.
