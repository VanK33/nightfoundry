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

## Stability discipline

Any change to the public surface (adding, removing, or renaming an entry) requires updating BOTH this file AND `test/test-stability-contract.js` in the same commit. The test fails closed if `index.js` drifts from its EXPECTED list; this doc is the human-readable mirror that explains *what* each entry is for. ARCHITECTURE.md Rule 12 is the rationale.
