# Stability Contract

This document mirrors `package.json#exports` and the entries enforced by `test/test-stability-contract.js`. Consumers should import only the symbols listed below from the bare specifier `nightfoundry`.

## Pipeline orchestration

- `Pipeline` — top-level run loop that walks the DAG and drives the full mission lifecycle.
- `SessionManager` — per-agent SDK session lifecycle: creates, tracks, and tears down agent sessions.
- `SessionHandle` — handle returned to callers for inspecting an in-flight session's state and output.

## Agents

- `Planner` — decomposes a mission into a structured set of tasks with dependencies and target files.
- `Executor` — performs a single task by writing or modifying code according to the task specification.
- `Verifier` — asserts that a completed task meets its scope and coding standards, producing PASSED or FAILED.
- `Analyzer` — on gate failure, performs root-cause analysis and recommends retry, re_plan, or human escalation.
- `Reviewer` — conducts milestone-level cross-file review and surfaces findings with severity ratings.
- `Summarizer` — produces the end-of-run headline, bugs list, prose summary, and changelog entries.
- `Brainstormer` — turns user prose into a structured spec.json + spec.md pair via initialize/revise methods, validating against `brainstormSpecSchema`.

## Infrastructure

- `Logger` — structured logging utility used throughout the pipeline for consistent, leveled output.
- `TokenTracker` — tracks token consumption per agent and per run for cost attribution and budget enforcement.
- `config` — resolved runtime configuration object (model names, limits, paths, and feature flags).

## Schemas

- `verifierSchema` — verifier session output: PASSED/FAILED plus hardChecks/taskScopeChecks/standardsChecks arrays.
- `analyzerSchema` — gate-failure root-cause analysis with recommendation enum (retry / re_plan / human).
- `executorSchema` — executor session output: COMPLETED/BLOCKED with affectedFiles list.
- `summarizerSchema` — end-of-run summary: headline, bugs, summary, changelog.
- `reviewerSchema` — milestone-level cross-file review: findings + scopeCompliance verdict.
- `assumptionRemediationSchema` — revised assumptions plus spec edit when a planner assumption is invalidated.
- `reviewRemediationSchema` — new tasks emitted when a reviewer flags critical findings.
- `taskReplanSchema` — replacement tasks (with dependencies) when the analyzer recommends re_plan.
- `brainstormSpecSchema` — 5-field v0 contract (goal, target_files, acceptance_criteria required; constraints, architecture_notes optional) the Brainstormer agent produces and `cc-orch run` consumes.
- `extractStructured` — helper that pulls `structured_output` from an SDK result with a documented null/undefined precedence and a tool_use fallback.
- `validateStructured` — lightweight schema validator (required keys + enum membership; not a full JSON Schema validator).

## Pro integration surface

The v0 bundle schema shape, verbatim: `{ schemaVersion, generatedBy, baseCommit, entries: [{ id, kind, text, evidence: [{ file, symbol? }], lastScannedCommit? }] }`.

- `schemaVersion` — version identifier for the bundle schema shape itself.
- `generatedBy` — provenance data only; it identifies what produced the bundle and is never dispatched on and never used for routing by the consumer.
- `baseCommit` — the commit the bundle was generated against.
- `entries` — the array of bundle entries, each shaped as `{ id, kind, text, evidence, lastScannedCommit? }`.
- `id` — unique identifier for a single entry.
- `kind` — the category/type of the entry.
- `text` — the human-readable content of the entry.
- `evidence` — array of supporting references for the entry, each shaped as `{ file, symbol? }`.
- `file` — the source file backing a piece of evidence.
- `symbol` — optional symbol name within `file` that the evidence points to.
- `lastScannedCommit` — optional commit at which the entry was last scanned/refreshed.

Bundle-filename derivation is pinned, verbatim: the consumed spec file's trailing `spec.json` becomes `bundle.json`. A project-root `<slug>.spec.json` yields `<slug>.bundle.json`, and a queue entry's fixed-name `spec.json` yields `bundle.json` inside that entry directory. This is also the name the dry-run finalize copy writes.

A project-root `memory/` directory survives every core cleanup operation. `memory/` is never removed by cleanup.

Fail-open rejection contract: a malformed, schema-invalid, or oversized bundle is rejected whole — it is never truncated. Rejection emits a `console.warn` on the run's console output, and the run continues on the no-bundle path. When no bundle file exists, prompts are byte-identical to pre-change output.

Pro-facing data outlets (existing, documented here): session `.jsonl` logs under `.harness/logs/`, `.harness/logs/token-usage.json`, `archives/<id>/manifest.json`, `archives/candidates.jsonl`, and `archives/warnings.jsonl`. Injected-entry telemetry is append-only log data under `.harness/logs/` and never enters resume-affecting state files.

## Archive layout

Every `archives/<id>/` directory contains a mix of contracted and internal artifacts. The two lists below are disjoint: no artifact name appears in both.

**CONTRACT** (shapes documented here; changing them is a breaking change):

- `manifest.json` — the archive manifest.
- `spec.md` and `spec.json` — the archived input pair.
- `state/mission-*.json` — mission state snapshots.
- `verification/*.json` — verification results.
- `analysis/` — gate-failure files, `history-<taskId>.json`, and `invalidations.jsonl`.
- The already-contracted log outlets — session `.jsonl` logs under `.harness/logs/` and `.harness/logs/token-usage.json` — are documented in the Pro-facing data outlets paragraph above; see that paragraph for their enumeration.

`state/mission-*.json` shape, verbatim (as produced by `writeMissionState` in `src/orchestrator/core/state.js`):

- `id` — the mission id (same value as `missionId`).
- `missionId` — the mission id.
- `description` — the mission description.
- `status` — the mission's own status (see the status enum below; the mission-level and sub-mission-level status live on `PARENT_TRANSITIONS`, not `TASK_TRANSITIONS`, in `src/orchestrator/core/state-machine.js`).
- `subMissions` — **an OBJECT keyed by sub-mission id, NOT an array.** Each value is `{ id, description, status, tasks }`.

Within each sub-mission, `tasks` is likewise **an OBJECT keyed by task id, NOT an array.** This objects-not-arrays keying holds at BOTH levels (`subMissions` keyed by sub-mission id, and each sub-mission's `tasks` keyed by task id) — this is the exact trap that broke the first external consumer, who iterated `subMissions`/`tasks` as arrays instead of looking up entries by id.

Each task record's fields, verbatim (as written by `writeMissionState`):

- `id` — the task id.
- `description` — the task description.
- `status` — the task's current status (see the status enum below).
- `createdAt` — ISO timestamp the task record was created.
- `startedAt` — ISO timestamp the task first transitioned to `in_progress`, or `null` until then.
- `completedAt` — ISO timestamp the task transitioned to `complete`, or `null` until then.
- `targetFiles` — array of file paths the task is scoped to touch.
- `dependencies` — array of task ids this task depends on.
- `testCases` — array of test cases the task is expected to cover.
- `tracesScenario` — array linking the task back to spec scenario(s).
- `dataSchemas` — array of data-schema references (context-enrichment field).
- `patternReferences` — array of pattern references (context-enrichment field).
- `retryCount` — number of times the task has transitioned to `failed`; starts at `0`.
- `progressFile` — path to the task's progress report file (`progress/task-<id>.json`).
- `verificationFile` — path to the task's verification sidecar (`verification/task-<id>.json`).
- `verifyFile` — path to the task's verify spec (`verify/task-<id>.json`).

CONDITIONAL task fields:

- `invalidationReason` — present ONLY on tasks that have been invalidated, and only when the caller supplied a non-empty string reason to the transition (`src/orchestrator/core/state-machine.js`, `transitionTask`). A task invalidated without a reason will not have this key.
- `invalidatedAt` — ISO timestamp set on the task record at the moment the state machine transitions the task to `invalidated` (`transitionTask` in `src/orchestrator/core/state-machine.js`). Marked CONDITIONAL because tasks invalidated by older engine versions (before this bookkeeping was added) may lack it.

Task `status` enum — the PERSISTED value set only, derived from `TASK_TRANSITIONS` in `src/orchestrator/core/state-machine.js` with never-persisted transients pruned: `pending`, `in_progress`, `awaiting_verification`, `complete`, `failed`, `blocked`, `needs_revalidation`, `invalidated`. Note `verified` is a transient: both call sites that transition a task to `verified` immediately follow it with a transition to `complete` in the same synchronous flow (`src/orchestrator/core/pipeline.js`), so it drains to `complete` (or `invalidated`) before any external reader observes it at rest — it is not part of the persisted enum documented here.

`analysis/invalidations.jsonl` additionally keeps durable append-only invalidation records, separate from the task-record fields above. It is written by `appendInvalidationRecord` in `src/orchestrator/core/state.js` — one JSON line per call, each shaped `{ ts, taskId, reason, site, detail }`, appended (never rewritten) to `<harnessDir>/analysis/invalidations.jsonl`.

### `verification/*.json` filename families

- `task-<taskId>.json` — per-task verifier sidecar, written by the verifier session (`src/orchestrator/agents/verifier.js`).
- `task-regression-<milestone>-<n>.json` — mission-level regression gate's verifier sidecar. `verifyMission` in `src/orchestrator/gates/regression.js` gives the gate task the synthetic id `regression-<missionId>`; since a `missionId` is itself formatted `<milestoneId>-<n>`, the sidecar written under the shared `task-<taskId>.json` naming rule lands as `task-regression-<milestone>-<n>.json`.
- `task-regression-milestone-<n>.json` — milestone-level regression gate's verifier sidecar. `verifyMilestone` in the same file gives the gate task the synthetic id `regression-milestone-<milestoneId>`, which under the same `task-<taskId>.json` naming rule lands as `task-regression-milestone-<n>.json`.
- `regression-milestone-<n>.json` — NOT a verifier sidecar. This is the milestone regression gate's own structured findings companion, written directly by `verifyMilestone` (`src/orchestrator/gates/regression.js`) next to its `.md` report of the same stem. Keys, verbatim: `milestoneId`, `passed`, `softPass`, `isStub`, `findings`.
- `review-milestone-<n>.json` — milestone reviewer sidecar, written by the reviewer session (`src/orchestrator/agents/reviewer.js`).
- `milestone-summary-<n>.json` — cross-task verification summary for a milestone, written by `writeVerificationSummary` in `src/orchestrator/core/verification-helpers.js`.
- the internal `.md` companions (e.g. `task-<id>-hard.md`, `regression-milestone-<n>.md`) — see the INTERNAL list below; their contents are not part of the contract.

### `task-<taskId>.json` (per-task verifier sidecar) keys, split by origin

SCHEMA properties — ALL SEVEN, verbatim, from `verifierSchema` in `src/orchestrator/agents/_schemas.js`:

- `result` — enum `PASSED` / `FAILED`.
- `hardChecks` — array of `{ name, status, evidence }`.
- `taskScopeChecks` — array of `{ description, status, evidence }`.
- `standardsChecks` — array of `{ description, status, evidence }`.
- `notes` — free-text string.
- `back_reference_check` — object `{ spec_consulted, plan_consulted, spec_injected, deviations }`. Only `spec_consulted`, `plan_consulted`, and `deviations` are declared directly on `verifierSchema`'s `back_reference_check` properties; `spec_injected` is written into this same object at run time by the spec-read audit patch described below — it is not a static schema property.
- `redundancyCitations` — array of `{ claim, file, pattern }`, populated on redundancy-probe verdicts.

PLUS `specReadAudit` — NOT a schema property (absent from `verifierSchema.properties`). It is a sidecar-only field appended after the fact by the verifier's spec-read audit patch in `src/orchestrator/agents/verifier.js`, which reads the just-written sidecar back off disk and sets `sidecar.specReadAudit = { didReadSpec, specPath }` (and, in the same patch, stamps `back_reference_check.spec_consulted`/`spec_injected`) before rewriting the file. Because it is produced by this post-write mutation rather than by structured-output validation, it can never appear via the schema path. Its presence is conditional on that same patch: the patch — and therefore `specReadAudit` — is SKIPPED (left absent from the sidecar) when `verdict.isStub === true` (a stub verdict — the verifier timed out or returned no structured_output) OR when the caller did not request the audit (`!opts.runSpecReadAudit`, the regression-gate callers' path).

### `review-milestone-<n>.json` (review sidecar) keys

All FIVE, verbatim, from `reviewerSchema` in `src/orchestrator/agents/_schemas.js`:

- `result` — enum `PASSED` / `FAILED`.
- `findings` — array of `{ severity, category, file, description, relatedFiles?, tier?, disposition?, dispositionReason? }`.
- `notes` — free-text string.
- `scopeCompliance` — object `{ verdict, evidence, exceededFiles }`.
- `uncoveredCriteria` — array of strings; acceptance criteria the reviewer judges not covered by the milestone.

### `regression-milestone-<n>.json` keys

Written directly by `verifyMilestone` in `src/orchestrator/gates/regression.js`, verbatim: `milestoneId`, `passed`, `softPass`, `isStub`, `findings`.

### `milestone-summary-<n>.json` keys

Written by `writeVerificationSummary` in `src/orchestrator/core/verification-helpers.js`, verbatim: `milestoneId`, `summary`, `tasks`, `timestamp`.

### Pointer relationship

A task record's `verificationFile` field (see the task record fields above, `verification/task-<id>.json`) names that task's verification sidecar under `verification/`. Consumers resolve a task's verdict by reading the file at that path, not by re-deriving the filename themselves.

### `analysis/` family

- `gate-failure-<taskId>-<epoch>.json` — per-event analyzer output, written by `src/orchestrator/agents/analyzer.js` (event id `gate-failure-${opts.taskId}-${Date.now()}`). Keys — ALL SEVEN analyzer schema properties, verbatim, from `analyzerSchema` in `src/orchestrator/agents/_schemas.js`:
  - `recommendation` — enum `retry` / `re_plan` / `human`.
  - `rootCause` — string.
  - `failureType` — enum `execution` / `verification` / `regression` / `review`.
  - `affectedTasks` — array of `{ taskId, reason, action }`.
  - `evidence` — string.
  - `notes` — string.
  - `secondaryFindings` — CONDITIONAL. Schema-optional by design: `_schemas.js` documents it as deliberately absent from `analyzerSchema.required` ("an analyzer report with no secondaryFindings still validates"). Absent from a given `gate-failure-*.json` file whenever the analyzer reports none.
- `history-<taskId>.json` — per-task analysis history: the analyzer's verdict history for one canonical task id, read/written by `src/orchestrator/agents/analyzer.js`.
- `invalidations.jsonl` — append-only durable invalidation records, one JSON object per line (documented in full just above): each line carries an invalidation timestamp (`ts`) plus `taskId`, `reason`, `site`, `detail`.

`manifest.json` shape, verbatim (as produced by `buildManifest` in `src/cli/commands/archive.js`):

- `id` — the archive directory's own id, `<seq>-<slug>`.
- `name` — the archive's display name.
- `seq` — the zero-padded 3-digit sequence number.
- `spec` — the path to the source spec file (or `null`).
- `specSnapshot` — the FULL spec markdown text, inlined into the manifest verbatim. This can be tens of KB.
- `startedAt` — ISO timestamp the run started.
- `archivedAt` — ISO timestamp the archive was written.
- `gitHead` — the git commit SHA at archive time.
- `gitStatus` — `'clean'`, `'dirty'`, or `'unknown'`.
- `models` — array of model metadata (currently always empty; reserved for caller enrichment).
- `milestones` — array of `{ id, description, status }` for each milestone.
- `totalCost` — total USD cost across the run's agent sessions.
- `totalSessions` — total number of agent sessions.
- `headline` — one-line human-readable summary of the run.
- `summary` — prose summary of the run.
- `bugs` — array of bug descriptions surfaced during the run.
- `changelog` — array of changelog entries.
- `uncertainAssumptions` — array of `{ text, specSection }` for advisory assumptions the run could not fully verify.

On the failed/halted (`--include-failed`) archive path, `headline` and `summary` are both empty strings (`''`) — the Summarizer is never invoked for a forensic archive.

CONDITIONAL keys — present only on failed/halted archives (i.e. only when `haltInfo` is supplied to `buildManifest`; absent entirely on a clean, successful archive):

- `haltReason` — the detected halt category (e.g. `circuit-breaker`, `regression-failure`, `reviewer-stop`, or a `HaltError` site, falling back to `unknown`).
- `haltTaskId` — the task id associated with the halt, or `null` if none could be determined.

**INTERNAL** (implementation detail; not part of the contract):

- `report.html`
- `dispersion-fingerprint.json`
- `snapshots/`
- `progress/`
- `verify/`
- `plan/`
- the top-level `state.json`
- the verification `.md` companions (e.g. `task-*-hard.md`)

These internal artifacts may change or vanish in any release without notice, and their contents are not documented.

## Stability discipline

Any change to the public surface (adding, removing, or renaming an entry) requires updating BOTH this file AND `test/test-stability-contract.js` in the same commit. The test fails closed if `index.js` drifts from its EXPECTED list; this doc is the human-readable mirror that explains *what* each entry is for. ARCHITECTURE.md Rule 12 is the rationale.
