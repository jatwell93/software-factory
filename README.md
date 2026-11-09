# software-factory

Plan a change with an agent, then let it build the change task by task as pull requests you only merge. Built on GitHub Actions and Claude Code.

**Status: being extracted from a working setup.** The workflows, scripts and skills are not here yet. What exists so far is the contract the rest is built to:

- `schema/factory.config.schema.json`: every setting a project makes in its `factory.config.yml`.
- `adapters/contract.d.ts`, `contract.js` and `contract-suite.js`: the interface a spec framework implements, and the shared tests every adapter must pass. OpenSpec comes first; others can follow.
- `examples/`: a sample config.
- `scripts/check-no-go.js`: fails when a factory branch or PR touches a protected path (the factory's baseline in `lib/baseline.js`, the project's `protected_paths`, and the change's own list).
- `scripts/check-change-ids.js`: fails on a change folder whose id the factory cannot run.

```
npm ci
npm test
```
