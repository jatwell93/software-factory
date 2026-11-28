# software-factory

Plan a change with an agent, then let it build the change task by task as pull requests you only merge. Built on GitHub Actions and Claude Code.

## Where to go

| You want to                                     | Read                                   |
| ----------------------------------------------- | -------------------------------------- |
| Set a project up and ship a first change        | [Quickstart](docs/quickstart.md)       |
| Run the factory day to day, and keep it healthy | [Owner guide](docs/owner-guide.md)     |
| Understand how a change flows and when it stops | [Factory guide](docs/factory-guide.md) |
| Do the steps only the repository owner can do   | [Owner setup](docs/owner-setup.md)     |
| Look up what a script, workflow or skill does   | [Reference](docs/reference.md)         |

## Spec frameworks

You plan changes in a spec framework, and `init` wires the project to one (`--spec-source`).

| Framework                                          | Status                               |
| -------------------------------------------------- | ------------------------------------ |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | Wired, the default                   |
| [PAUL](https://github.com/ChristopherKahler/paul)  | Wired, not yet run on a real project |
| [GSD](https://github.com/open-gsd/gsd-core)        | Being considered for a future change |
| [fspec](https://github.com/sengac/fspec)           | Being considered for a future change |

## The idea in four lines

1. You write a change and slice it into tasks (`/to-tickets`). Merging the plan pull request is the go.
2. The factory builds one task per run in GitHub Actions and opens a pull request. It handles CI and bot reviews.
3. You merge each pull request when `factory status` says it is ready.
4. The factory never merges, never touches production and never edits protected paths. It asks you instead (`needs-human`).

## Develop the factory itself

```
npm ci
npm test
```
