# nightfoundry on-disk state layout

Where nightfoundry persists state, so you can read raw files to understand a run. All paths are relative to the project root. `.harness/`, `queue/`, and `archives/` are the three top-level state trees.

## Contents
- [Directory map](#directory-map)
- [state.json](#statejson)
- [mission state files](#mission-state-files)
- [globalStatus vocabulary](#globalstatus-vocabulary)
- [queue entry + statuses](#queue-entry--statuses)
- [archives](#archives)
- [parks](#parks)
- [brainstorm drafts](#brainstorm-drafts)
- [What to read for what](#what-to-read-for-what)

## Directory map

`.harness/` is run-scoped: each run gets its own subdirectory under `.harness/`, named by its runId, and an active-run pointer file at `.harness/active-run` records which one is current. Everything that used to live directly under `.harness/` (`state.json`, `state/`, `plan/`, etc.) now lives under `.harness/<runId>/` for the currently active run. The flat, directly-under-`.harness/` layout still exists on disk, but only as a fallback for when there is no valid active-run pointer (e.g. no run has ever been claimed, or the pointer is stale/unreadable).

```
<projectRoot>/
  .harness/                        ← harness root (created by init or first run)
    active-run                     ← pointer file: {runId, slug, kind, startedAt} for the claimed active run
    <runId>/                       ← per-run harness dir, one per run (e.g. run-20260719T120000-my-slug-a1b2)
      state.json                  ← master state for this run (globalStatus, milestones → missions)
      state/                      ← one mission file per mission: mission-NNN-NNN.json
      plan/                       ← global planner output
      verify/                     ← per-task verification sidecars
      progress/                   ← per-task execution progress
      verification/               ← verifier outputs
      analysis/                   ← analyzer reports
      snapshots/                  ← baseline snapshots for regression
      learning/                   ← user-curated cross-run baselines (nightfoundry never writes)
      dry-run/                    ← dry-run plan output (separate lifecycle)
      logs/
        token-usage.json          ← session token/cost tracking (JSONL, one session/line)
      brainstorm/<slug>/          ← brainstorm drafts (spec.json, spec.md, state.json, history.jsonl, digest.json)
    state.json                    ← flat-root fallback ONLY (no valid active-run pointer): same shape as above
    state/ plan/ verify/ ...      ← ...and the same subtrees, directly under .harness/, in that fallback case
  queue/<slug>/              ← one dir per queued spec (spec.md, spec.json, plan.json, status, validatedAt)
  archives/<id>/             ← completed runs (manifest.json, state.json, report.html, CHANGELOG, RUNS, ...)
  refs/park/<slug>/          ← parked-run scene + metadata (scene.json, park.json)
  <slug>.spec.md             ← approved brainstorm spec output (root level)
  <slug>.spec.json           ← its sibling verification criteria
```

## state.json

The master state file lives inside the **active run's** per-run harness dir: `.harness/<runId>/state.json`, where `<runId>` is read from the active-run pointer at `.harness/active-run`. It only falls back to the flat root, `.harness/state.json`, when there is no valid active-run pointer (missing, unreadable, or pointing at a runId whose per-run dir has no `state.json`). The shape is identical either way:

- `projectMeta.prdPath` — absolute path to the active spec (`.md` or `.json`).
- `projectMeta.currentPhase` — `planning` | `execution` | `verification` | `review` | `complete`.
- `projectMeta.gateFlags` — `{ allowIncompleteScope, skipCoverageGate }` (which gate relaxations were in effect).
- `globalStatus` — the macro run state (see vocabulary below).
- `milestones` — map of milestone id → `{ id, description, status, missions }`; each mission → `{ id, description, status, stateFile }` where `stateFile` points at the mission file under `state/` (in the same active-run dir, or the flat root in the fallback case).

Milestone/mission `status`: `pending` | `in-progress` | `complete` | `archived`.

## mission state files

`.harness/state/mission-<missionId>.json` — the task decomposition for one mission:

- `subMissions` → map of submission id → `{ id, description, status, tasks }`.
- Each task → `{ id, description, status, targetFiles, dependencies, testCases, tracesScenario, patternReferences, dataSchemas, invalidationReason? }`.
- Task `status`: `pending` | `in-progress` | `complete` | `verified` | `invalidated`.
- `invalidationReason` (when invalidated): `replaced` (superseded by a replan) or `redundant` (a no-op caught by the phantom-write probe).

## globalStatus vocabulary

| value | meaning |
|---|---|
| `active` | run in progress, or crashed mid-run |
| `complete` | finished, awaiting archive |
| `archived` | already archived |
| `halted-review` | waiting for human diff review of a milestone |
| `halted-analyzer` | escalated to the analyzer after repeated task failures |
| `parked` | a queue entry paused at an operator gate |

## queue entry + statuses

`queue/<slug>/` holds `spec.md`, its `spec.json` sibling, `plan.json` (the dry-run plan), a one-line `status` file, and `validatedAt`.

Queue `status` values:

| value | meaning |
|---|---|
| `pending` | not yet processed |
| `validated` | dry-run passed; ready for batch |
| `in-progress` | the batch processor is working on it |
| `complete` | batch run succeeded |
| `failed` | batch run failed (a forensic archive was created) |
| `parked` | halted at an operator gate |
| `halted-review` | halted awaiting human review |
| `halted-analyzer` | halted awaiting analyzer escalation |

## archives

`archives/<id>/` is an immutable record of a finished run. Key files:

- `manifest.json` — metadata: `id`, `name`, `seq`, `spec`, `specSnapshot`, `archivedAt`, `gitHead`, `gitStatus`, `milestones[]`, `totalCost`, `totalSessions`, `headline`, `bugs[]`, `summary`, `changelog[]`.
- `state.json` — the final run state.
- `report.html` — generated report (open via `nightfoundry archive show <id> --report`).
- `dispersion-fingerprint.json` — structural/verification fingerprint.
- `CHANGELOG`, `RUNS` — auto-generated changelog + run list.
- `archives/warnings.jsonl` — the reviewer-warning ledger (one JSON object per line), at the `archives/` root.

Archive ids prefixed `failed-` are forensic records of failed runs (spec + state preserved for post-mortem).

## parks

`refs/park/<slug>/`:
- `scene.json` — the snapshot at halt time (spec/plan/state), so `park show` can reconstruct why it stopped.
- `park.json` — park metadata + operator notes.

## brainstorm drafts

`.harness/brainstorm/<slug>/`:
- `spec.json` / `spec.md` — the draft spec.
- `state.json` — draft session status.
- `history.jsonl` — per-turn interaction log (incl. elicitation telemetry).
- `digest.json` — the understanding-playback digest (scope-out / assumptions / risks), transient — never fed to the planner.

On approval, the spec is copied to the project root as `<slug>.spec.md` + `<slug>.spec.json`.

## What to read for what

| Question | Read |
|---|---|
| What's the overall progress? | `.harness/state.json` (milestones) + `state/mission-*.json` (tasks) |
| Why did it stop? | `.harness/state.json` `globalStatus`; if `parked`/`halted-analyzer`, `refs/park/<slug>/scene.json` |
| What's in the batch queue? | each `queue/<slug>/status` |
| What did a past run cost / produce? | `archives/<id>/manifest.json` |
| What failed, and on what spec? | `archives/failed-<id>/` (manifest + preserved spec/state) |
| Live cost so far? | `.harness/logs/token-usage.json` |
| Outstanding reviewer warnings? | `archives/warnings.jsonl` |
