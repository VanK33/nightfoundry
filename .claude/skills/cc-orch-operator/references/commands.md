# cc-orch command surface

Authoritative command + flag reference, derived from `src/cli/index.js` (the router) and `src/cli/commands/*.js`. Invoke as `cc-orch <command>` (bin → `src/cli/index.js`); equivalently `node src/cli/index.js <command>` or `npx cc-orch <command>`.

## Contents
- [Global flags](#global-flags)
- [Run / plan / task](#run--plan--task)
- [Resume](#resume)
- [Brainstorm](#brainstorm)
- [Status & inspection](#status--inspection)
- [Usage / cost](#usage--cost)
- [Archive](#archive)
- [Queue](#queue)
- [Park](#park)
- [Warnings](#warnings)
- [Review](#review)
- [Dispersion](#dispersion)
- [Lifecycle: init / clean / health / ui / version / help](#lifecycle)
- [Precondition matrix](#precondition-matrix)

## Global flags

Parsed centrally; consumed only by the commands noted.

| Flag | Meaning | Applies to |
|---|---|---|
| `-a`, `--auto` | Auto-approve gates; unattended run | `run`, `dry-run`, `resume`, `task` |
| `--allow-dirty` | Skip the clean-working-tree check | `run`, `dry-run` |
| `--no-git-required` | Run without requiring a git repo | `run`, `dry-run` |
| `--allow-incomplete-scope` | Warn instead of error when the planner flags scope items that match no task | `run`, `dry-run`, `resume`, `task` |
| `-p`, `--project <path>` | Override project root (default: cwd) | all |
| `-j`, `--json` | JSON output (where supported) | many read commands |

Long flags that always consume the next arg as a value: `--role`, `--task`, `--project`, `--last`, `--since`, `--resume`, `--port`, `--note`.

## Run / plan / task

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch run <spec.md>` | spec `.md` path | `-a`, `--allow-dirty`, `--no-git-required`, `--allow-incomplete-scope` | Plan + execute the pipeline from a spec. Creates `.harness/` if missing. Requires a git repo + clean tree (unless overridden). |
| `cc-orch <spec.md>` | spec `.md` path | same as `run` | Shortcut for `run`. |
| `cc-orch dry-run <spec.md>` | spec `.md` path | `-a`, `--allow-dirty`, `--no-git-required`, `--allow-incomplete-scope` | Validate spec + build the plan **without executing**; queues the spec under `queue/<slug>/` as `validated` for a later batch. Same git preconditions as `run`. Rejects a non-`.md` spec path. |
| `cc-orch task "<description>"` | task description | `-a`, `--allow-incomplete-scope` | Wrap a one-off change in a synthetic minimal spec and run the pipeline. No spec file needed. |

## Resume

| Command | Flags | What it does |
|---|---|---|
| `cc-orch resume` | `-a`, `--allow-incomplete-scope` | Resume a halted single run from `.harness/state.json`. Requires that file to exist. |
| `cc-orch resume --batch` | `-a`, `--allow-incomplete-scope` | Process the `queue/` of `validated` specs sequentially, archiving each on completion. Does **not** require `.harness/state.json` (each entry gets a fresh init). |

## Brainstorm

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch brainstorm "<prose>"` | prose | `--no-tty` | Interactive spec authoring (frame-first restatement → clarifying questions → draft + digest). Produces `<slug>.spec.md` + `<slug>.spec.json`. `--no-tty` does a one-shot draft with no questions. |
| `cc-orch brainstorm --resume <slug>` | — | — | Resume an existing draft under `.harness/brainstorm/<slug>/`. |

## Status & inspection

| Command | Args | What it does |
|---|---|---|
| `cc-orch status` | optional `<mission-id>` (e.g. `001-001`) | Show the `.harness` milestone/mission/task tree. With a mission id, drill into that mission's tasks. Requires `.harness/state.json`. |

## Usage / cost

| Command | Flags | What it does |
|---|---|---|
| `cc-orch usage` | `-j`, `-d`/`--detailed`, `--role <R>` | Token/cost for the current run (reads `.harness/logs/token-usage.json`). Requires `.harness/state.json` unless `--all`/`--include-failed`. |
| `cc-orch usage --all` | `--last <N>`, `--since YYYY-MM-DD`, `--task <id>`, `--include-failed`, `-j`, `-d` | Cross-archive cost aggregation over `archives/`. `--include-failed` implies `--all`. |
| `cc-orch usage compare <a> <b>` | `-j` | Compare token usage between two archives. |

## Archive

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch archive [name]` | optional name | `-P`/`--preserve`, `--skip-test-gate` | Archive the current run into `archives/<id>/`. Runs the final `test:all` gate unless `--skip-test-gate`. `-P` keeps the spec files in the archive root. Requires a `complete` run. |
| `cc-orch archive list` | — | `-j` | List archives (id, date, cost, sessions, headline). |
| `cc-orch archive show <id>` | archive id | `-j`, `--report` | Show one archive's manifest. `--report` opens its `report.html`. |
| `cc-orch archive diff <a> <b>` | two ids | `-j` | Diff two archives. |

## Queue

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch queue list` | — | `-j` | List queue entries and their status. |
| `cc-orch queue remove <slug>` | slug | — | Remove a queue entry. |
| `cc-orch queue retry <slug>` | slug | — | Reset a non-pending entry's status to pending so `cc-orch resume --batch` picks it up again. |
| `cc-orch reset <taskId>` | task id | — | Reset a single failed **task** so it gets a fresh chance: clears its retryCount (status back to pending), the canonical `replanAttempts` entry, the analyzer history file, and the task's snapshot directory. Task-level and complementary to the entry-level `cc-orch queue retry <slug>` (which resets a whole queue entry, not one task). Only run this when no run process is live. |

## Park

A "park" is a queue entry paused at an operator gate (review reject / analyzer escalation / regression). Backed by `refs/park/<slug>/`.

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch park list` | — | `-j` | List parked/halted entries (statuses `parked`, `halted-review`, `halted-analyzer`). |
| `cc-orch park show <slug>` | slug | — | Show the parked entry's scene (spec/plan/state at halt) + any operator notes. |
| `cc-orch park resolve <slug>` | slug | exactly one of `--requeue` / `--waive` / `--reject`; optional `--note "<text>"` | Resolve the entry: `--requeue` re-runs it (reattaching preserved work), `--waive` skips it and continues, `--reject` drops it and stops. |

## Warnings

Reviewer-warning ledger (`archives/warnings.jsonl`).

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch warnings list` | — | `--all`, `-j` | List ledger entries (open + deferred by default; all with `--all`). |
| `cc-orch warnings show <id>` | id | — | Show one entry in full JSON. |
| `cc-orch warnings resolve <id...>` | one+ ids | exactly one of `--waive` / `--defer` / `--done`; optional `--note` | Change warning status. |
| `cc-orch warnings brainstorm <id...>` | one+ ids | `--no-tty` | Synthesize the selected warnings into one fix spec. |

## Review

| Command | What it does |
|---|---|
| `cc-orch review` | Interactive loop to display and accept/reject/edit staged candidates (used when `globalStatus = halted-review`). |

## Dispersion

| Command | Args | What it does |
|---|---|---|
| `cc-orch dispersion` | — | List archive structural/verification fingerprints. |
| `cc-orch dispersion <archive-id>` | id | Show one fingerprint (milestones, missions, tasks, verifier verdicts, reviewer findings). |
| `cc-orch dispersion compare <a> <b>` | two ids | Compare two fingerprints. |

## Lifecycle

| Command | Args | Flags | What it does |
|---|---|---|---|
| `cc-orch init [spec.md]` | optional spec | — | Bootstrap `.harness/` (and stamp `prdPath` if a spec is given). |
| `cc-orch clean` | — | `--force` | Remove `.harness/`. Offers archive-first if active milestones exist; `--force` skips prompts. |
| `cc-orch health` | — | — | Print a JSON health report (version, PID, Node version, uptime). |
| `cc-orch ui` | — | `--port <N>` | Start the web UI. Port: flag > `PORT` env > `3939`. |
| `cc-orch version` | — | — | Print `cc-orch v<version>`. |
| `cc-orch help` | — | — | Print usage. |

## Precondition matrix

| Need | Commands |
|---|---|
| **Requires `.harness/state.json`** | `status`, `usage` (without `--all`/`--include-failed`), `review`, `archive` (the verb, not `list`/`show`/`diff`), `clean`, `resume` (without `--batch`), `reset` (operates on the active run harness) |
| **Does NOT require it** | `init`, `brainstorm`, `dry-run`, `task`, `run` (creates it), `resume --batch`, `queue *`, `park *`, `warnings *`, `health`, `ui`, `version`, `help`, `dispersion`, `archive list/show/diff`, `usage --all` |
| **Requires a git repo + clean tree** | `run`, `dry-run` (override with `--no-git-required` / `--allow-dirty`) |
