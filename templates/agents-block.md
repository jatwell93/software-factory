<!-- software-factory:begin -->

### Factory (unattended runs)

Written by `software-factory init`; rerun it to refresh this block (edits between the markers are replaced).

Changes are built by [jatwell93/software-factory](https://github.com/jatwell93/software-factory): its workflows, scripts and skills. This repo calls it through thin workflows in `.github/workflows/` pinned to one commit, and tells it about this repo in `factory.config.yml` (gates, protected paths, review bots, CI workflows, spend cap).

- **New change:** `node "$FACTORY_DIR/scripts/factory-new-change.js" <id> --title "<title>"` creates it with an id the factory can run and refuses a bad, taken or archived id.
- **Start a change:** plan it with `/to-tickets <id>`, then merge the plan PR. The factory builds one task per run, opens a PR, babysits it and archives the change. You merge.
- **Change id:** lowercase letters, digits and hyphens, at most 42 characters: every PR and tracking issue carries the label `factory:<id>` and GitHub caps a label at 50.
- **Protected paths:** the factory never edits its fixed baseline (workflows, `.claude/**`, `.githooks/**`, `AGENTS.md`, `CLAUDE.md`, `factory.config.yml`), `protected_paths` in `factory.config.yml`, or a change's own `no_go` list. A task that needs one is an owner task: write it `- [ ] 2.3 (owner) ...`.
- **Upgrade the pin:** change the 40-character commit in each caller workflow (`uses: ...@<sha>` and `factory_ref:`) in one PR.
- **Run the factory's scripts yourself** (`pr-feedback.js`, `cleanup-merged.js`, `check-no-go.js`): set `FACTORY_DIR` to a checkout of that repo and call `node "$FACTORY_DIR/scripts/<name>.js"`. The five skills in `.claude/skills/` are copies of the factory's; edit them there, not here.

<!-- software-factory:end -->
