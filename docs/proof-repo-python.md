# Proof repo for task 5.1: a Python time planner

The factory has been proven on one repo, a Node/npm monorepo that was converted by hand. Task 5.1 proves it on a second repo that is none of that: a fresh, private, single-package **Python** project set up with `init`. This file is the checklist for the first half, building the **skeleton** the factory will then work on. It is written so that a session with no other context can follow it.

## Paste this into the new session

> Read `C:\Users\josha\software-factory\docs\proof-repo-python.md`, including its "Context for the agent" section, and do its checklist, in order, in a new empty directory. Stop at the line that says STOP. Do not run `init`, add any factory file, or add anything the "Do not" list forbids. Keep the log at `C:\Users\josha\proof-5-1-log.md` as that section says. Report the repo URL, the output of each check, and the log entries you added.

## Context for the agent

You are building the **skeleton** of a small Python web app, a weekly time-allocation planner with habit tracking, for its owner's own use. That is the visible job. It is also the first half of a test of a tool the owner is building, **software-factory** (`https://github.com/jatwell93/software-factory`, checked out at `C:\Users\josha\software-factory`): a way to plan a change with Claude, have GitHub Actions build it task by task as pull requests, and have the owner only review and merge. The factory has been proven on one Node monorepo. This new repo is its **second-repo proof** (task 5.1 of the `extract-software-factory` change in `date-management-app`): can someone set a fresh, different-stack repo up with a few commands and have the factory build real changes in it?

A second session, with the factory's context, will run the next steps on this repo while you are, or after you are, done: `init`, `doctor`, creating a change, and watching one run to a merged PR. Your skeleton is its starting point. For the test to mean anything, the skeleton must be exactly what this checklist says and nothing more, and anything that goes wrong must be recorded rather than quietly worked around.

How to behave:

- **Follow the checklist literally.** Do not substitute a different stack, layout, library or tool, add features, or "improve" a file. If something in it cannot work as written, make the smallest change that lets you continue and log it as `checklist-error`.
- **Keep the log.** `C:\Users\josha\proof-5-1-log.md` is shared with the factory session. Read its rules first. Append an entry for every failure, warning, wrong or stale instruction, version difference and guess, with the exact error text. Do not rewrite earlier entries.
- **Do not touch the factory.** Do not edit `C:\Users\josha\software-factory` or `date-management-app`, and do not fix a factory problem if you see one: log it as `factory-bug` or `factory-gap` and tell the owner.
- **Do not go past STOP.** No `init`, no factory files, no ruleset, secret or label, no bots, no deploy.
- **Report, do not assume.** If a gate fails or CI is red, say so with the output. A green base matters more than finishing fast.
- The owner merges; you never push to a default branch of anything but this new repo's first commit, as the checklist says.

## Why these choices

- **Python, not Node:** the Node path is already proven. This exercises stack detection, a non-npm install step, `runner.python_version` (the runner sets up Python only when the config names a version) and the Python install-input protection, none of which have run live.
- **Single package, flat layout:** one gate set, no workspace tooling, nothing for the factory to trip on that is not the factory's.
- **`requirements.txt` for installs, `pyproject.toml` for tool config:** `init` detects `pip install -r requirements.txt` from the file. Both are in `protected_paths`, so a factory task cannot edit them (`pip install` runs code from them). A task that needs a new dependency is an owner task. That is why `python-multipart` (needed for HTML form posts) is in the skeleton now.
- **Standard library SQLite (later):** the first changes add storage with `sqlite3`, which needs no new dependency.
- **No bots, no deploy:** the first change runs with `review_bots: []`, a path that has not run live. Sentry is added for the second change. Hosting comes after the proof, as an owner step.

## Checklist

Prerequisites: Python 3.12, `git`, `gh` logged in (`gh auth status`). If `py -3.12 --version` finds no Python (the machine this was drafted on had none), install one: `uv python install 3.12` then `uv venv --python 3.12 .venv` replaces the `python -m venv` line in step 3, with `uv pip install -r requirements.txt` for the install; or use the python.org installer.

### 1. Create the directory and repo skeleton

```
mkdir time-planner
cd time-planner
git init -b main
```

Use another name if you prefer; the rest of this file says `time-planner`.

### 2. Files

**`.python-version`**

```
3.12
```

**`.gitignore`**

```
.venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.db
```

**`pyproject.toml`** (tool configuration only; no dependencies here)

```toml
[project]
name = "time-planner"
version = "0.1.0"
requires-python = ">=3.12"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.mypy]
strict = true
exclude = ['^\.venv/']

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

**`requirements.txt`**: create it with these names, then **pin each to the version `pip` resolves** (`pip install` them in a venv and write `name==version` for these eight only, not their dependencies):

```
fastapi
uvicorn
jinja2
python-multipart
httpx2
pytest
ruff
mypy
```

(`httpx2` is what the FastAPI/Starlette test client now asks for; plain `httpx` still works but prints a deprecation warning on every test run. If a newer Starlette wants something else, follow its message.) Keep the names `ruff`, `mypy` and `pytest` in this file or in `pyproject.toml`: `init` proposes gates from them.

**`planner/__init__.py`**: empty file.

**`planner/main.py`**

```python
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(title="Time planner")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html", {"title": "Time planner"})
```

If the installed Starlette's `TemplateResponse` signature differs, adapt the call; the requirement is only that the three gates below pass.

**`planner/templates/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{{ title }}</title>
  </head>
  <body>
    <h1>{{ title }}</h1>
  </body>
</html>
```

**`tests/test_health.py`**

```python
from fastapi.testclient import TestClient

from planner.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_is_json() -> None:
    assert client.get("/health").headers["content-type"] == "application/json"


def test_index_renders_the_title() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "Time planner" in response.text


def test_unknown_route_is_404() -> None:
    assert client.get("/nope").status_code == 404
```

**`.github/workflows/ci.yml`**: the workflow name must be exactly `CI`; `init` reads it for `ci_workflows`.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: check
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-python@v7
        with:
          python-version-file: .python-version
          cache: pip
      - run: pip install -r requirements.txt
      - run: ruff check .
      - run: mypy .
      - run: pytest
```

**`README.md`**: a title and one sentence: a weekly time-allocation planner with habit tracking.

### 3. Check it locally

```
python -m venv .venv
.venv\Scripts\Activate.ps1        # PowerShell; on bash: source .venv/bin/activate
pip install -r requirements.txt
ruff check .
mypy .
pytest
```

All three must pass with no warnings you are ignoring.

### 4. Prove each gate can fail

A gate that cannot fail proves nothing. For each, make one deliberate break, see the gate fail, then revert it (`git checkout -- .` or undo):

- lint: add `import os` (unused) to `planner/main.py` and run `ruff check .`;
- types: change `-> dict[str, str]` to `-> int` on `health` and run `mypy .`;
- tests: change `"ok"` to `"bad"` in the health route and run `pytest`.

### 5. Commit, create the private repo, push

```
git add -A
git commit -m "chore: project skeleton with lint, type and test gates"
gh repo create time-planner --private --source . --remote origin --push
```

Wait for the `CI` workflow on `main` to go green (`gh run watch` or the Actions tab). If it fails, fix it before going on: the factory needs a green base.

### STOP

Do not run `init`, create `AGENTS.md`, `CLAUDE.md`, `.claude/`, `openspec/`, `factory.config.yml` or a hook, and do not set a ruleset, secret or label. The 5.1 run starts from exactly this state, so the first thing to count is what `init` does to it.

## Do not

- Add a deploy workflow, a secret, a database file or any dependency beyond the eight above.
- Add a second CI workflow, a pre-commit config or a Dockerfile.
- Add review bots yet.
- Write application code beyond the health route and the index page. The planner itself is built through the factory.

## After the skeleton: the 5.1 run

The skeleton is done when `main` is green on a private repo. The rest follows the run sheet in `openspec/changes/extract-software-factory/handover.md` of date-management-app, with these expectations for `init` on this repo, so a difference is a gap to record:

| Expected from `factory-init.js` | Value                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `gates`                         | `ruff check .`, `mypy .`, `pytest`                                                      |
| `ci_workflows`                  | `CI`                                                                                    |
| `runner.python_version`         | `3.12`                                                                                  |
| `runner.install`                | `pip install -r requirements.txt`                                                       |
| `protected_paths`               | `pyproject.toml`, `requirements.txt`                                                    |
| `review_bots`                   | empty                                                                                   |
| owner                           | your GitHub login, from `origin`                                                        |
| `spec_source`                   | `openspec`, and `openspec init` runs from `init` (the `openspec` CLI must be installed) |

Things that have never run live and are worth watching: the `Setup Python` step in the factory's run job, `pip install -r requirements.txt` on the hosted runner, the `factory/reviews-settled` status with no bots, whether the Actions approval gate appears on a private repo, and whether `doctor` flags anything that is not true.

### Candidate first changes

Each is two small tasks that touch code and tests, with `pr: per-change`. Use `factory-new-change.js <id> --title "<title>"` to create one, then `/to-tickets <id>`.

1. **`weekly-plan-model`**: task 1, storage with `sqlite3` (a `planned_allocation` table: category, planned minutes, week start) and a small data module, with tests; task 2, `POST /plan` and `GET /plan/{week}` JSON endpoints, with tests. This is the proof change: no new dependency is needed.
2. **`habit-ticks`** (after the proof): habits and daily ticks, with endpoints and tests. Add the Sentry bot to `review_bots` before this one. Optionally add an `(owner)` task such as "add a dependency to `requirements.txt`" to watch the factory escalate a protected path instead of editing it.
