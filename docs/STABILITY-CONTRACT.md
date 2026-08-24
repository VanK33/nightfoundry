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

## Stability discipline

Any change to the public surface (adding, removing, or renaming an entry) requires updating BOTH this file AND `test/test-stability-contract.js` in the same commit. The test fails closed if `index.js` drifts from its EXPECTED list; this doc is the human-readable mirror that explains *what* each entry is for. ARCHITECTURE.md Rule 12 is the rationale.
