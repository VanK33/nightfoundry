# nightfoundry gotchas, preconditions & footguns

Real preconditions and sharp edges from the code. Read before non-obvious operations, or when a command appears to run but do nothing.

## Contents
- [Preconditions](#preconditions)
- [Silent no-ops](#silent-no-ops)
- [Footguns](#footguns)

## Preconditions

- **Git required for `run` / `dry-run`.** They look for `.git/` (up to 5 parent levels) and require a clean working tree (`git status --porcelain` empty). Override the dirty check with `--allow-dirty`; skip git entirely with `--no-git-required`. Other commands do not enforce this.
- **`.harness/state.json` required for run-state commands.** `status`, `usage` (without `--all`/`--include-failed`), `review`, `archive` (the verb), `clean`, and `resume` (without `--batch`) all need it. If it's missing, run `nightfoundry run <spec>` (or `init`) first. See the precondition matrix in `commands.md`.
- **Unresumable state.** If `resume` finds `globalStatus = active` + `currentPhase = planning` + no milestones, planning crashed before any decomposition existed — `resume` exits with an "unresumable" code and tells you to `nightfoundry run <spec.md>` fresh instead.
- **Batch needs `validated` entries.** `resume --batch` processes queue entries that reached `validated` (via `dry-run`). Entries in `parked` / `halted-review` / `halted-analyzer` must be cleared with `park resolve` first.
- **Archive needs a complete run.** `archive` (the verb) expects `globalStatus = complete`.

## Silent no-ops

- **`usage --include-failed` without `--all` is ignored.** The include-failed filter only exists in the cross-archive path. Use `usage --all --include-failed`.
- **`--no-review` is deprecated and ignored.** The parser accepts it but the review gate always runs (it auto-accepts under `--auto` when the milestone passes). Don't rely on it to skip review.
- **The final `test:all` gate is skipped silently when:** `--skip-test-gate` is passed; `--include-failed` is in play (cross-archive mode); the project's `test:all` command was overridden from the default; or the project has no `test:all` script. So a passing archive does not always mean tests ran — check whether the gate applied.
- **`park show` only warns on spec divergence.** If `spec.md` was edited after parking but `spec.json` wasn't, it prints a warning but never blocks.

## Footguns

- **`dry-run` rejects a non-`.md` spec path.** A non-`.md` path would make the tool treat the project-root `spec.json` as the sibling and unlink it — so it refuses with an explanation. Always pass a `.md` spec.
- **Batch force-reinits `.harness` between entries.** Each queue entry runs against a fresh `.harness` (the `state`, `plan`, `verify`, `progress`, `verification`, `analysis`, `snapshots` subdirs are wiped and recreated; `learning/` and `dry-run/` are preserved). Don't expect one entry's mission state to survive into the next.
- **Token usage resets after archive.** `token-usage.json` is wiped on archive, so calling `nightfoundry usage` immediately after archiving shows ~zero — the run's cost is emitted *before* cleanup. For historical cost use `usage --all`.
- **`task` writes and then removes a temp spec.** It creates a synthetic spec under `.harness/`, copies it to an archived name for resume auditability, and deletes the temp in a `finally` block. Expected behavior, not a leak.
- **`clean` can archive-first.** With active milestones, `clean` offers to archive before deleting (that archive uses `--skip-test-gate`, since cleaning is housekeeping, not a release). Declining still asks for confirmation before deleting unarchived state.
- **`gitHead`/`gitStatus` in a manifest may be `unknown`.** If git fails at archive time (not a repo, or a git error), those fields are stored as `unknown` rather than failing the archive.
- **A scoped acceptance command's path tokens must all belong to ONE mission.** plan-scope-lint runs per mission, and its coverage check builds `allEmitted` from only that mission's task `targetFiles`. So an acceptance-criterion `command` whose path tokens name files owned by *different* missions hard-throws `scoped acceptance command "…" references "…" not covered by any task's targetFiles` at plan time — zero spend, the plan is dead. A check instead becomes a milestone-close gate (not scoped to any one mission) only when `isMilestoneOnlyCheck` holds: it is a whole-suite command, has no path-like tokens, or none of its tokens match a declared `target_files` entry (a token that matches a declared target IS deliverable-scoped and pulled into the owning mission). Fix: split a cross-mission command into per-mission commands, or phrase a suite-wide check with no mission-owned path token so it classifies milestone-only.
- **Spec edits after a plan is persisted don't reach the implementer.** Mission descriptions are written to `state/mission-*.json` at plan time and frozen there; `resume` executes from those persisted descriptions. A constraint or acceptance command you add to the spec *after* the plan already exists is invisible to the executor on resume — the new check can then pass or fail against an implementation that never saw its intent. (Some gates do re-read the spec — scope-coverage, verifier context — but the executor's mission description does not refresh.) After editing a spec that already has a persisted plan, decide explicitly: re-run from scratch so the plan re-derives from the new spec, or accept that the added constraint won't drive the implementation.
