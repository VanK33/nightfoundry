## [0.2.0] - 2026-07-23 — nightfoundry: first public npm release under the new name

### Milestone
- First public npm release as `nightfoundry` (renamed from cc-orchestrator; Fair Source, FSL-1.1-ALv2). The package ships two equivalent commands, `nightfoundry` and `cc-orch`.

### Bug fixes
- The CLI's run-vs-import guard only recognized invocations named `cc-orch`, so the `nightfoundry` bin from a published install loaded the module and exited silently without running the command. The guard now accepts both bin names. (0.1.178 on npm has a working `cc-orch` bin but an inert `nightfoundry` bin.)

## [0.1.178] - 2026-07-21 — Failure-candidate ledger: deterministically record every terminal failure as a classed event

### New features
- Every terminal-failure routing leg (failed-validation / failed-plan / failed-test-gate / failed-criteria / failed-execution and the park/halt funnel incl. single-run halted-analyzer) now appends one self-contained candidate event to archives/candidates.jsonl: a four-field mechanism signature (phase, errorClass, analyzerRecommendation, taskState) with a stable sha256 over exactly those fields, plus a summary and evidence pointers. Legs that leave an entry pending for rerun (InfrastructureError rethrows, user interrupts) deliberately do not emit, so transient API blips never pollute the ledger
- The append is best-effort and fail-soft: a ledger write failure warns once and never alters failure-routing behavior. Append-only facts — no dedup, counters, status lifecycle, or LLM involvement (grouping and triage live outside the tool)

### Fixes
- Batch-test fixtures now ignore the cross-run ledger files (archives/candidates.jsonl, archives/warnings.jsonl) so a post-revert clean-tree assertion still holds; the plan-time-disposition forensic-archive count excludes the ledger files
- External projects now exclude the two ledger files (archives/candidates.jsonl, archives/warnings.jsonl) via git-excludes and the init .gitignore block, while keeping the archives/ directory itself trackable so forensic archives stay committable — without this, a ledger file written on a failure leg would read as untracked dirt and trip the next run's clean-tree guard
- cc-orch init's deployed .cc-orch.json.example now uses language-neutral placeholder commands (naming the smoke/full concepts with npm/pytest/go examples) instead of hardcoded npm defaults — cc-orch is runner-agnostic, and a copyable npm command silently mis-runs on a non-JS project; the placeholders fail loudly if copied verbatim, prompting the user to fill in their own
- plan-structure-lint's cross-mission duplicate checks (the L3 hard-fail and the WARN observer) now use strict same-file equality (exact or path.resolve) instead of suffix matching, so a standard Python package layout (pkg/__init__.py and tests/pkg/__init__.py declared by different missions in one milestone) is no longer falsely rejected as a declared duplicate; the planner's looser suffix path-anchor matching stays scoped to plan-scope-lint
- Executor writes are now hard-bounded to the project root: the Edit/Write session guard resolves every path and denies anything outside the session root (previously a substring match let a same-named directory in an UNRELATED project through — observed live), targetFiles membership is exact resolved-path equality (closing the endsWith/includes loopholes), the harness pre-creates in-root targetFile parent directories before the executor spawns (removing the missing-dir search trigger), and the progress sidecar records per-entry absolutePath with an outOfRoot flag + warning for out-of-root claims. Bash-mediated writes and symlink escapes remain documented residuals (watch item)

## [0.1.177] - 2026-07-20 — Persist reviewer-gate remediation plans before executing them

### Bug fixes
- The reviewer-gate remediation loop now merges every remediation group into mission state and advances the persisted retry counter BEFORE any fix task executes, so a process death between planning and merging no longer loses the plan: resume picks up the persisted pending tasks through the completed-mission DAG channel and returns to the reviewer with the retry cap intact
- A remediation group that yields no fix tasks now aborts the attempt before any group merges (all-or-nothing), instead of leaving earlier groups half-applied

## [0.1.176] - 2026-07-19 — Delivered the operator manual: src-canonical skill package with channel-gated deployment

### New features
- The cc-orch-operator skill is now the AI-facing manual, canonical under src/cli/skills/ (agent sessions cannot edit a repo's .claude/ paths — deployed copies there are init-refreshed artifacts): two new chapters (spec-authoring contract incl. the never-target-.claude rule; symptom-driven debugging flows), read-only-mode golden rule with the reentrancy line, run-scoped state paths throughout, and a refreshed state-layout reference
- cc-orch init deploys the skill package into the target repo's .claude/skills/cc-orch-operator/ (read-into-memory-then-write, version/channel/hash sidecar) and recommends committing it; the guidance template's spec-authoring pointer now names the deployed skill directly
- Release-channel gating: package.json declares releaseChannel (alpha/beta/stable); every freshness hint fires only on stable, so fast alpha iteration never nags users; explicit init always deploys and prints its channel
- Drift test pins every CLI verb into the manual's command reference; channel-gate and shipped-default-seam behaviors are mutation-verified

## [0.1.175] - 2026-07-19 — Completed init-onboarding recovery: delivered thin template and test suite (354/354 passing).

### New features
- Created thin four-anchor machine-owned template for init guidance with managed-marker, state layout, memory guidance, and spec-authoring pointer
- Added comprehensive init-onboarding test suite covering 8 acceptance cases with 80/80 passing assertions; registered in suite runner

## [0.1.174] - 2026-07-18 — Delivered plan-structure-lint feature with deterministic structural plan-time enforcement

### New features
- Validates structural constraints deterministically at plan time: mission/milestone counts against spec-declared limits, declared-duplicate targetFiles within same milestone, tree-purity check shapes (T1/T2 markers with backtick-literal exemptions and KNOWN-ESCAPE pins), and cross-mission duplicate task detection with ledger warnings. Eliminates regression risk by moving enforcement from non-deterministic prompt-based compliance to deterministic gates-based validation at zero executor spend.

## [0.1.173] - 2026-07-18 — Delivered milestone 001: closed three engine holes (22, 23, 24) with halt-aftermath parity on single-resume path; one composition defect identified in review.

### Bug fixes
- Single-resume circuit breaker halts now persist with paused status and recovery state: globalStatus='paused' + projectMeta.haltRecord enable resumability via park resolve (HOLE-22)
- Queue entry recreation via dry-run now removes stale park.json before writing, preventing stale halt history pollution in live entries (HOLE-23)
- Dry-run validation now returns structured {queued, reason} result on all failure paths; CLI exits non-zero with diagnostic message on validation failure (HOLE-24)
- park resolve --reject/--waive/--requeue on singlePath scenes now clear the active-run pointer when matching, enabling complete single-run lifecycle closure

## [0.1.172] - 2026-07-17 — Delivered harness auto-hygiene with orphan sweep at three pipeline windows and 117 comprehensive tests

### New features
- Harness auto-hygiene module with two-layer orphan run directory API: classifyOrphanRunDirs for pure classification and sweepOrphanRunDirs for automatic disposition with fail-soft behavior
- Interactive clean command integration using harness-reaper classification API with improved disposal handling for orphan and superseded run directories
- Pipeline auto-hygiene integration wiring sweepOrphanRunDirs at three windows: run() immediately after successful claim, batchResume start after clean-tree check, and batchResume finally block after closeReusableSession
- Comprehensive auto-hygiene test suite with 14 tests covering cross-form canonical identity matching (EC33), parked-runId shield, marker exemption, fail-soft handling, and window wiring verification
- CLI-path test additions (TC17–TC22) covering canonical identity cross-form matching both directions, task non-collapse, parked-runId shield, and marker-dir behavior through interactive wrapper
- Test suite registration integrating auto-hygiene test in test runner

## [0.1.171] - 2026-07-16 — Delivered SUPERSEDED classifier and quarantine disposition for the run-dir reaper (engine hole 21).

### Bug fixes
- Run-dir reaper now recognizes SUPERSEDED attempts (runs whose spec has a newer terminal archive) and quarantines them to `.harness/stale/` for safe recovery instead of permanent deletion. Includes park/interrupt ref shields to prevent false positives.

## [0.1.170] - 2026-07-16 — Delivered engine hole 20 fix with per-entry harness anchoring and comprehensive regression test suite

### New features
- Added batch-log-anchoring regression test suite that validates all six acceptance criteria for engine hole 20 fix via comprehensive testing of real batchResume over 2-entry queue with stubbed seams. Test file test/test-batch-log-anchoring.js registered in scripts/run-tests.js.

### Bug fixes
- Closed engine hole 20 by implementing per-entry harness anchoring in batchResume. Three surgical relocations prevent batch entry N+1's pre-bootstrap sessions from writing logs and token records into entry N's drained run dir, fixing content bleed and cost under-reporting.

## [0.1.169] - 2026-07-16 — Delivered pre-spend baseline gate (engine hole 18) preventing token spend on configured test failures

### New features
- Pre-spend baseline gate module (src/orchestrator/gates/baseline.js) executing configured test commands to prove baseline is GREEN before token spend, with $0 refusal cost and no bypass mechanism
- Baseline gate integrated into five CLI dispatch paths (run, dry-run, task, .md-shortcut, resume --batch) refusing token spend on configured test command failures
- Baseline gate wired into webhook POST /run handler with injectable parameter, failing fast before pipeline construction on gate refusal

## [0.1.168] - 2026-07-16 — Successfully closed engine hole 19 by exempting command-position and environment-assignment tokens from plan-scope lint coverage requirements, verified against all acceptance criteria.

### Bug fixes
- Close engine hole 19: plan-scope lint now exempts command-position (argv[0]) and environment-assignment (VAR=value) tokens from per-scoped-check coverage requirements, allowing standard interpreter invocations like '.venv/bin/python -m pytest tests/...' to pass plan validation

## [0.1.167] - 2026-07-16 — Delivered git-excludes module closing engine hole 17: cc-orch artifacts now auto-excluded via untracked .git/info/exclude

### Bug fixes
- Engine hole 17 closed: cc-orch artifacts (.harness/, queue/, spec files) now properly auto-excluded from git via untracked .git/info/exclude before clean-tree evaluations, eliminating false clean-tree refusals on fresh projects and subdirectory projects
- Updated clean-tree refusal hint messages to accurately describe auto-exclusion behavior via git configuration instead of false .gitignore claims

## [0.1.166] - 2026-07-15 — Implemented per-project .cc-orch.json configuration enabling test-command customization without forking cc-orch source

### New features
- Projects can now create a .cc-orch.json file in their root to override test commands (testCommand and testAllCommand) without editing cc-orch source or maintaining a fork. The loader applies overrides once at startup; absent file is a silent no-op and present file undergoes strict schema validation with fail-loud behavior on invalid JSON, unknown keys, or malformed values.

## [0.1.165] - 2026-07-15 — Closed engine hole 9: delivered sibling-supersede restore (Leg A) and snapshot evidence for analyzer (Leg C)

### New features
- Snapshot restore now applies per-file sibling supersession — restoring any task's snapshot never rolls a file back past that file's latest completed attestation
- Analyzer now receives engine-computed snapshot evidence (SHA-256-labeled 'intact' or 'overwritten-after-completion') preventing misattribution when completed work was later overwritten

### Bug fixes
- Fixed after-phase self-disqualification regression where the requesting task's own latest after/ snapshot could be overridden by a stale sibling copy, preventing data loss

## [0.1.164] - 2026-07-14 — Delivered reviewer stub disposition fix (engine hole 14) with all 5 tasks passing and full test verification

### Bug fixes
- Reviewer stub responses now retry once on the same model when SDK/transport failures occur, providing automatic recovery before gate disposition
- Stub verdicts at reviewer gate now classified as InfrastructureError (retryable=true) instead of generic failed-execution, keeping milestones pending for infrastructure rerun instead of burning with forensic archive/revert

## [0.1.163] - 2026-07-14 — Delivered milestone 001: closed engine hole 6 with npm-script resolution for whole-suite command recognition at both consumers

### New features
- Added test-wholesuite-scope-recognition.js with comprehensive coverage of 7 acceptance criteria: live hole shape recognition, regression pins with/without projectRoot, fail-soft behavior, inert-gate classification, scoping integration, single-level resolution without recursion, and drain integration

### Bug fixes
- Extended isWholeSuiteCommand with single-level npm-script resolution to recognize direct-runner test commands as whole-suite commands, closing engine hole 6 where they were incorrectly scoped to individual tasks causing timeout failures
- Fixed hard-checks.js drain re-filter to forward projectRoot parameter to isMilestoneOnlyCheck, ensuring consistent milestone-only classification at both planner and drain consumers

## [0.1.162] - 2026-07-14 — Milestone 001 delivered: disposition residue hygiene implementation complete with 6 tasks verified and full test suite passing

### New features
- resume() archive leg now cleans up batch-originated runs by removing queue entries and mirroring the batch leg's post-archive git commit with manifest headline, ensuring complete residue cleanup and committed archive state.
- park resolve removes .harness/run-<runId>/ directories after consuming park scenes on successful dispositions (requeue/waive/reject), preventing parked run residue when runId is recorded and dir exists.
- Forensic failed-archive leg now removes per-run harness directories after moveHarnessToArchive drained their contents, preventing empty run-dir shells while preserving shared flat harness directories.

### Bug fixes
- queue list now gracefully soft-degrades broken queue entries (e.g., missing spec.md) by rendering [broken] rows with removal hints instead of crashing, while healthy entries list normally.
- planMission filters out 'references unknown missionId' warnings from scope-mapping consistency checks when checking global scopeMapping against mission-level plans, reducing log spam while preserving genuinely malformed entry warnings.

## [0.1.161] - 2026-07-14 — Delivered regression sequencing context — mission targetFiles persistence and pending-deliverables awareness for regression gates

### New features
- Mission targetFiles now persist in state.json when present in the armed plan, enabling regression gates to track deliverables of missions not yet run
- Regression gates now build and inject PENDING-DELIVERABLES context block listing files from missions not yet run, preventing false acceptance criteria failures
- Verifier prompt updated to permit naming intended paths of required-but-absent files as evidence and defer judgment on acceptance criteria targeting pending-deliverables

### Bug fixes
- Terminal status predicate now correctly excludes both 'complete' and 'invalidated' missions when determining which are still pending, matching codebase convention

## [0.1.160] - 2026-07-13 — Delivered deterministic regression verdict downgrade filter for handling failures concerning only not-yet-due deliverables

### New features
- Regression verdict downgrade filter module with deterministic failure resolution: automatically downgrades regression failures to pass when findings concern only not-yet-due deliverables using two-arm file-state predicates, pending-scoping validation, and FAIL-check coverage rules; installed at both mission and milestone regression verification points
- Regression filter test suite: 14 scenarios validating two-arm file-state detection (never-existed and pre-existing-and-untouched), pending-scoping, fail-closed error paths, FAIL-check coverage rules, and pipeline consumer wiring for both mission and milestone regression gates

## [0.1.159] - 2026-07-12 — Delivered gate timeout honesty: SIGTERM-killed test gates now classified as infrastructure timeouts requiring retry when quiet

### New features
- Comprehensive test suite validating gate timeout honesty across batch resume, single-resume, and archive command paths with guards against .every() traps on empty/mixed/absent timeout fields.

### Bug fixes
- Gate timeout honesty: SIGTERM-killed full-suite test gates (exitCode -1) are now classified as infrastructure timeouts requiring retry when quiet, rather than test failures. Entry stays pending without revert or criteria failure marking. Archive command outputs distinguished timeout message.

## [0.1.158] - 2026-07-12 — Completed plan-time death disposition (engine hole 10) with infrastructure error classification and failed-plan routing

### Bug fixes
- Reusable-session turn results now classify infrastructure errors at the turn-boundary, rejecting with InfrastructureError for transport failures instead of passing them to the executor
- Plan-phase validation errors on clean trees now use a lightweight failed-plan disposition that writes plan-failure.txt without forensic archiving or git reset
- Batch failures now persist error.txt to forensic archives with the error message and stack trace
- closeReusableSession errors are caught in a finally guard and do not escape batch summary generation

## [0.1.157] - 2026-07-12 — Spec constraints now reach both planner prompts.

### Bug fixes
- spec.json `constraints` are deterministically injected as a "Spec constraints (binding)" block into the planGlobal user prompt and every planMission turn prompt. Previously they reached only an output-side advisory, so binding planning rules (test-surface boundaries, milestone structure) were invisible to decomposition — the root of the recurring planner-invents-test-files failure class (8 occurrences, 4 caught by the plan-scope lint).

## [0.1.156] - 2026-07-12 — Raised both full-suite gate timeouts to 30 minutes.

### Bug fixes
- The spec-criteria drain (`MILESTONE_ONLY_CHECK_TIMEOUT_MS`) and the archive/run final test gate (`RUN_TEST_ALL_TIMEOUT_MS`) no longer SIGTERM a healthy full suite at 10 minutes when the machine is still loaded right after a batch; both raised to 30 minutes. The timeout is a ceiling, not a target — green suites return immediately.

## [0.1.155] - 2026-07-12 — Delivered runId-isolation segment 2e post-flip cleanup: orphan run-dir reaper, shared-skeleton init reshape, context-aware infra error guidance, and silent scheduler hydration.

### New features
- New `cc-orch clean --runs` command for orphan run-directory cleanup. Reaps mechanically-safe orphan run directories while preserving terminal/active runs and pointer-target directories.
- Reshaped `cc-orch init` for shared-skeleton-only initialization. Creates only shared skeleton (learning/, dry-run/, brainstorm/) without flat state.json, preventing stale-state artifacts that misled dispatch logic.
- Context-aware infrastructure error guidance. Error hints now adapt to context: batch mode suggests `resume --batch`, active runs suggest `resume`, no active run provides safe fallback without incorrect command advice.

### Bug fixes
- Silent scheduler startup on fresh harness. Scheduler no longer warns about missing state.json during initial hydration (normal post-flip case); warnings only on JSON corruption.

## [0.1.154] - 2026-07-12 — Delivered Milestone 001: Armed the lintGlobalPlanScope gate by requiring mission-level targetFiles in planGlobal schema and prompt.

### New features
- planGlobal mission schema now requires targetFiles array (minItems 1); missions must declare project-root-relative files they create or modify.
- planGlobal system prompt updated to instruct missions to declare targetFiles covering all spec-identified target files and all files referenced in acceptance-criterion verify commands.
- Added test/test-planglobal-mission-targetfiles.js with 5 test cases validating mission targetFiles schema requirement, live-path lint enforcement on uncovered acceptance-command files, and backward-compatibility no-op when targetFiles absent.

### Bug fixes
- lintGlobalPlanScope pure-omission gate activated for production: was structurally inert due to empty mission-level targetFiles; now enforced as required schema field, catching plans that omit files named by acceptance criteria.

## [0.1.153] - 2026-07-10 — Delivered milestone 001: webhook claim-in-handler with honest 409, pipeline preclaimedRun support, and active-run pointer routing through readers.

### New features
- Webhook POST /run now returns 409 with activeRun pointer for concurrent requests, before any response is sent, replacing eventual pipeline refusal with honest immediate error
- Pipeline.run() accepts opts.preclaimedRun option to skip claimActiveRun when the webhook handler has already claimed the pointer, improving concurrent-request handling and enabling honest error responses
- Webhook summarizeState/usage and cron hourly token tracking now follow active-run pointer via activeHarnessDir, reporting metrics for the active run instead of the flat .harness root
- Webhook handler implements claim hygiene: clears dangling pointer only when bootstrap fails to create run directory, preserving pointer for discovered runs on error

## [0.1.152] - 2026-07-09 — Delivered milestone 001 (runId isolation flip) with all 28 tasks completed and acceptance criteria met.

### New features
- Pipeline runs now execute in isolated per-run directories (.harness/run-{id}/) instead of flat .harness/, eliminating slug-reuse state collisions and enabling strict per-run isolation of mission/verification/analysis state.
- Active-run pointer lifecycle (.harness/active-run file) claims at run start (O_EXCL), persists through execution, and clears only at successful archive, enabling concurrent run detection and mutual-exclusion semantics for sequential pipeline invocations.

### Bug fixes
- CLI commands (run, task) and UI API handlers (state, cost, task-verify, siderail) now resolve active harness directory per-request via activeHarnessDir(projectRoot) instead of frozen construction-time value, enabling transparent pointer followthrough when summarizing or querying live per-run state.

## [0.1.151] - 2026-07-09 — Delivered run-scoped bootstrap layout capability with full backward compatibility and comprehensive test coverage

### New features
- bootstrap() in src/orchestrator/core/bootstrap.js now accepts optional opts.runId parameter to create isolated .harness/run-{id}/ directory layouts with per-run state.json and segregated per-run/shared subdirectories, while preserving byte-identical flat-layout behavior for all existing callers without runId
- Exported two new constants from src/orchestrator/core/bootstrap.js: PER_RUN_SUBDIRS (8 directories: state, plan, verify, progress, verification, analysis, snapshots, logs) and SHARED_SUBDIRS (3 directories: learning, dry-run, brainstorm) defining the directory structure for run-scoped layouts
- Created test/test-bootstrap-run-scoped.js with 7 comprehensive test cases covering run-scoped layout creation, flat layout preservation, multiple runId coexistence, force-wipe semantics, return value shapes, and state.json structural identity

## [0.1.150] - 2026-07-09 — Delivered milestone 001: behavior-preserving migration from `.harness/`-prefixed to harness-relative file paths with unified resolver helper—all 10 tasks passed, full suite green (317/317).

### New features
- Added resolveHarnessFileRef(harnessDir, ref) helper function to state.js as the single source of harness file path resolution, supporting three ref shapes: absolute paths (passthrough), legacy `.harness/`-prefixed refs (backward-compatible), and new run-relative refs.

### Bug fixes
- Migrated persisted file-reference string literals in state.js from `.harness/`-prefixed to harness-relative format (e.g., `.harness/state/mission-{id}.json` → `state/mission-{id}.json`), applied to mission stateFile, planFile, milestone planFile, and task-level verifyFile/progressFile/verificationFile.
- Migrated remediation task file-reference literals in coverage.js from `.harness/`-prefixed to harness-relative format, aligning with the new state.js shape.
- Replaced inline path.join(harnessDir, '..', ref) walks with shared resolveHarnessFileRef helper across all six reader sites: status.js (2 ternaries), audit.js, verification-helpers.js, preflight.js, and pipeline.js—eliminating duplicate resolution logic and enabling future run-scoped harnessDir support.

## [0.1.149] - 2026-07-08 — Delivered behavior-preserving refactoring of harness resolution routing in three orchestrator agents

Maintenance release (no notable changes).

## [0.1.148] - 2026-07-08 — Delivered reentrancy guard for dryRunValidate() entry point with comprehensive test coverage and full verification passing.

### New features
- Added comprehensive test coverage (TC1-TC11) for reentrancy guard behavior in both Pipeline.resume() and Pipeline.dryRunValidate(), validating refusal under active marker + state.json and pass-through when marker is absent or empty.

### Bug fixes
- Pipeline.dryRunValidate() now calls assertNoReentrantLiveRun() as the first statement to catch reentrant execution before bootstrap, state mutations, or session spawning, mirroring existing guard placement in run() and resume().

## [0.1.147] - 2026-07-07 — Delivered SpecCriterionError disposition on both batchResume and resume paths with comprehensive test coverage.

### New features
- New 'failed-criteria' queue entry status for spec-criteria failures in batch resumption, distinct from infrastructure failures (failed-execution)
- SpecCriterionError handling in batchResume: snapshot pre-revert WIP to refs/test-gate/, write failure details to queue/<slug>/criteria-failures.txt with field mapping (name + targetFile for file-checks, name + exitCode + command for command-checks), revert tree for batch isolation, and requeue with failed-criteria status
- Comprehensive test suite for SpecCriterionError disposition: batch path tests verify snapshot creation, criteria-failures.txt writing, tree revert, and status change; single-path tests verify no revert, criteria output, and exit semantics; degenerate input tests (empty/undefined failures) exercise both paths; all existing resume paths tested for byte-identity regression

### Bug fixes
- SpecCriterionError in single-entry resume() now caught before CLI escape: prints failing criteria clearly with 'Fix the failing criteria above, then re-run `cc-orch resume`' hint, leaves WIP in place, persists globalStatus='paused' to state.json for future resume recognition, and exits non-zero without stack trace

## [0.1.146] - 2026-07-06 — Delivered test-gate pre-revert WIP snapshot and failing test identity persistence with soft-degrade error handling.

### New features
- Pre-revert WIP snapshots are now created as refs/test-gate/<slug> when a batch entry fails the final-test-gate, enabling forensic inspection of failed work.
- Failed test-gate batch entries now persist failing test names to queue/<slug>/test-gate-failures.txt and emit per-test FAIL lines to the log.

## [0.1.145] - 2026-07-06 — Delivered blast-radius gate for deterministic symbol-consumer enumeration at plan time

### New features
- Plan-time blast-radius gate for deterministic symbol-consumer enumeration: warns when changed symbols have consumers outside declared scope, emits one ledger entry per invocation, and surfaces uncovered consumers to reviewer as optional advisory. New module exports enumerateSymbolConsumers() for word-boundary whole-identifier matching across src/test/scripts/ and readChangedSymbols() for lenient spec.json reading; both implement never-throws defensive semantics. Stash resets per invocation to prevent leaks across batch entries.

## [0.1.144] - 2026-07-05 — Delivered comprehensive JSDoc documentation and readability improvements for scheduler.js and state.js

### Bug fixes
- Added comprehensive JSDoc documentation to all exported functions and class methods in scheduler.js and state.js. Corrected stale inline comments to match current implementation and applied conservative local variable renames for improved clarity.

## [0.1.143] - 2026-07-05 — Delivered milestone 001: extracted verification helper family from Pipeline class with backward-compatible thin delegation and full test coverage.

### New features
- Create src/orchestrator/core/verification-helpers.js exporting 8 pure stateless functions (runTestRegistrationGate, recordGateOverride, applyHardCheckGate, formatBannerLines, writeVerificationSummary, parseVerificationSidecar, logVerifierPassCounts, writeElapsedToSidecar) extracted from Pipeline methods with explicit parameter forwarding.
- Reduce 8 Pipeline verification methods to single delegating calls into verification-helpers module while preserving async signatures, method names, and ~20 internal call sites using this._ syntax.
- Add test/test-verification-helpers.js with 6 unit tests directly importing verification helpers and asserting degenerate-input parity pins: null on missing/corrupt sidecars, fail-soft on absent sidecar recording, notApplicable pass with 'not applicable' log on no-manifest projects.

## [0.1.142] - 2026-07-05 — Completed Milestone 001: extracted assumption/spec data layer into pure module with thin Pipeline delegations

### New features
- Extract assumption/spec data layer from pipeline.js into pure, independently-testable module with five stateless functions
- Refactor five Pipeline methods to thin delegations, preserving byte-identical behavior including log wording and disk writes
- Add comprehensive unit tests for assumption-data module with degenerate-input parity pins covering edge cases

## [0.1.141] - 2026-07-04 — Delivered lean web side-rail monitoring system with progress tracking, decision/error indicators, and webhook notifications — all 11 tasks passed with two composition warnings.

### New features
- /api/siderail endpoint aggregates harness state into progress counts (tasks/milestones complete/total), current in-progress task with mission/milestone lineage, decision-pending and error status flags, and timing metrics (elapsed time, remaining tasks, average task duration)
- src/ui/public/siderail.html: self-contained page with inline JS/CSS that polls /api/siderail, renders progress bar with task counts, current task description and lineage, decision-needed banner as most prominent visual element, error banner, timing information (elapsed/remaining/reference), and pauses polling when browser tab is hidden
- src/ui/notify.js: webhook transition-watch system detects three state edges (decision pending, error occurred, run complete/archived) and posts exactly one webhook notification per transition to configured endpoint, with fail-soft error handling that logs warnings without crashing the server
- UI configuration knobs in src/orchestrator/infra/config.js: notifyWebhookUrl (default empty string to disable notifications) and siderailPollMs (default 3000ms with enforced minimum floor of 2000ms)

## [0.1.140] - 2026-07-02 — Milestone 001 complete: user-spec projection layer delivered with full CLI integration and 41-test suite

### New features
- userSpecSchema: new user-input boundary contract in _schemas.js enabling declarative goal/scope/success-criteria specification without verification knowledge
- Deterministic spec projection layer (classifyEvidence, renderUserSpecMd, projectUserSpec) compiling user specs into frozen engine spec pairs with pure, side-effect-free implementation
- CLI helpers (loadUserSpec, validateUserSpecFailClosed, prepareUserSpecInput, warnOnEngineSpecJson) supporting .uspec.json files and --spec-stdin input with automatic spec.json/spec.md generation
- CLI integration: run.js and dry-run.js now route .uspec.json positionals and --spec-stdin to projection layer, with warn-only validation of hand-written engine specs
- Comprehensive test suite: 41 tests across four modules validating projection determinism, evidence classification matrix, CLI routing, and pipeline consumability without subprocess invocation

## [0.1.139] - 2026-06-27 — Delivered planner read-only-task efficacy probe and supporting test infrastructure

### New features
- Created scripts/probe-planner-readonly.mjs as manual real-LLM efficacy probe for read-only task validation
- Enhanced planner prompts with new section
- Added planner read-only task test suite
- Added read-only task sentinel test suite

## [0.1.138] - 2026-06-27 — Successfully delivered milestone 001: planner forbids read-only pre-step tasks (S1) and phantom-write detections emit zero-delta sentinel (S3), all tests passing.

### New features
- Added PROMPT_SECTION_NO_READONLY_TASKS prompt section forbidding pure read-only/analysis/approval pre-step tasks, wired into both buildMissionSystemPrompt and buildReplanSystemPrompt
- Added formatZeroDeltaLog function to emit [zero-delta-task] diagnostic sentinel at phantom-write NO-OP detection point for improved observability
- Added test-planner-no-readonly-tasks.js unit test validating PROMPT_SECTION_NO_READONLY_TASKS export, content requirements, and wiring into mission and replan prompts
- Added test-phantom-write-readonly-sentinel.js unit test validating formatZeroDeltaLog function output and [zero-delta-task] single-emission guarantee

## [0.1.137] - 2026-06-27 — Completed comment-cleanup refactor of pipeline.js, removing 5 stale restatement-only inline comments with zero behavioral impact.

### Bug fixes
- Remove 5 stale restatement-only inline comments from src/orchestrator/core/pipeline.js (all pure 'what the code does' without load-bearing 'why' or cross-reference markers); all executable code, JSDoc, trailing comments, blank lines, and protected rationale preserved; zero behavioral impact confirmed by full test suite pass.

## [0.1.136] - 2026-06-27 — Head-heavy brainstormer (frame-first elicitation + understanding-playback), park work-in-progress preservation, batch-interrupt safety, and analyzer disposition telemetry; all 274 tests pass.

### New features
- Brainstormer frame-first elicitation (TTY authoring path): before drafting a spec, the brainstormer restates its understanding in its own words — with cited repo evidence and an explicit list of what it could not determine — for the user to confirm, reject-and-restate, or correct, then asks importance-ranked clarifying questions one at a time, bounded by a config-defaulted style seam (config.elicitation.maxQuestions). Batch / non-TTY drafting is byte-identical to before.
- Brainstormer understanding-playback digest (TTY authoring path): after the initial draft and each revision, a one-page digest — goal, scope in/out, each acceptance criterion paired with how it is verified, key assumptions, and risks — is rendered for confirm-or-correct. Scope-out / assumptions / risks ride an optional sidecar channel (digest.json) that leaves the spec.json contract frozen and is never fed to the planner; digest verbosity is controlled by the same config-defaulted style seam. Per-turn elicitation counts are recorded for downstream-noise correlation.
- Park work-in-progress preservation: when a batch execution-time gate-halt routes an entry to a resolvable park (review or analyzer human-handoff), the verified work-in-progress is preserved as a gc-safe git stash object (anchored by a ref) and the working tree is left clean, instead of being discarded with `git reset --hard`. `park show` displays the preserved diff, and `park resolve --requeue` re-attaches it (3-way) before re-running — surfacing a conflict loudly without losing the work; the ref is cleaned up on resolution. True-failure paths keep their revert; the batch stays single-tree.
- Analyzer disposition telemetry: resolving an analyzer-human (or review-gate) park records the human's disposition (requeue / waive / reject) — paired with the analyzer's recommendation and event id — to a durable, mine-able log (archives/analyzer-dispositions.jsonl), so analyzer human-recommendation accuracy can be measured later. Raw signals only; no false/true-human label is computed at record time.

### Bug fixes
- A SIGINT during task execution in a batch run no longer discards work: the milestone wrapper's non-terminal-task invariant is now guarded by the same abort short-circuit the run/resume paths already use, and the batch loop breaks on a mid-execution abort without marking the entry failed or reverting — leaving it resumable with its work intact for `cc-orch resume --batch`. Single-run was already safe.

## [0.1.135] - 2026-06-18 — Reconciled TC11 test mock to production's plain git add form; all 255 tests pass.

### Bug fixes
- Reconciled TC11 test mock and assertion to match production's plain 'git add -A' form, removing stale ':(exclude)queue' pathspec variant from test/test-batch-resume.js

## [0.1.134] - 2026-06-17 — Delivered targeted fix scoping readSpecTargetFiles markdown fallback to declared-target-files section, verified with all 254 tests passing.

### Bug fixes
- Scope readSpecTargetFiles markdown fallback to `## Declared target files` section only, returning [] when section is absent. Prevents false-positive file collection from prose sections such as Goal, Architecture, and out-of-scope notes.

## [0.1.133] - 2026-06-17 — Successfully reconciled regression-remediation test to repeat-verdict detector and registered test in suite

### Bug fixes
- Reconciled TC5 to post-detector early-break contract: changed iteration assertion from 3 to 2, added 'REPEATED its previous verdict' log assertion, maintained regression-failed gate validation
- Registered test/test-pipeline-milestone-regression-remediation.js in TEST_FILES array to enable test suite execution

## [0.1.132] - 2026-06-16 — Fixed scenario coverage gate to validate by identity, preventing invalid remediation acceptance

### Bug fixes
- Scenario coverage gate (checkMilestoneCoverage) now validates closure by scenario identity instead of count, preventing remediation sets with wrong scenario IDs from incorrectly passing the gate

## [0.1.131] - 2026-06-16 — Delivered manifest.json-based per-archive cost tracking with comprehensive test coverage, eliminating double-counting across batch archives.

### New features
- Added loadArchiveManifestTotal helper function to safely read manifest.json totalCost with proper handling of missing, malformed, or non-numeric cases
- Added 11 new test cases covering manifest precedence, filter-triggered fallback behavior, mixed-archive aggregation, and byRole/cache metric preservation

### Bug fixes
- Eliminated double-counting of costs across batch archives by preferring manifest.json's totalCost as the authoritative per-archive source (with session-sum fallback for backward compatibility) and computing aggregate cost as the sum of per-archive totals rather than re-summing cumulative sessions

## [0.1.130] - 2026-06-16 — Delivered fix for Map serialization in audit-r2.js with comprehensive test coverage

### New features
- Added mapToObject(map) helper function that converts JavaScript Maps to plain objects using Object.fromEntries, with guards for non-Map inputs
- Created comprehensive test suite (test-audit-r2-map-serialize.js) with 4 test cases covering Map-to-object conversion, defectCoverage round-tripping, negative control, and empty-Map edge cases

### Bug fixes
- Fixed Map serialization bug in audit-r2.js where defectCoverage.coveredDefects and exemptDefects serialized as empty objects; they now preserve all entries as plain objects

## [0.1.129] - 2026-06-16 — Milestone 001 complete: split clone descriptions now scoped to individual edits, eliminating executor redundancy.

### New features
- Add comprehensive test coverage for split clone description scoping via test/test-splitmultiedit-clone-desc.js (TC1, TC2) and TC10 in test-multi-edit-split.js, validating determinism, distinctness, and non-split task preservation.

### Bug fixes
- Clone descriptions in splitMultiEditTasks are now scoped to each clone's own hardCheck instead of inheriting the full multi-edit description, preventing the executor from performing all edits redundantly on each clone.

## [0.1.128] - 2026-06-15 — Uncertain assumptions are advisory: recorded and surfaced, never parked

### Bug fixes
- A genuine `uncertain` assumption verdict no longer parks, gates, or stops the run. On every path (run, dry-run, and both batch verification rounds) an uncertain is now appended to the warnings ledger and the run continues; this run's uncertains are surfaced at the review gate when a human is present and recorded in the archive manifest (`uncertainAssumptions`). `failed` assumptions still remediate and block, `post-fix` still defers, and the `halted-review` / `halted-analyzer` park sites are unchanged — the deterministic downstream gates (hard checks, regression, verification audit, final test suite) remain the safety net. The benign-uncertain auto-waive path (introduced in 0.1.113) is superseded and removed from the assumption gate; its classifier and scene-writer modules are retained but no longer called.

## [0.1.127] - 2026-06-15 — Assumption verification retries infrastructure failures instead of marking uncertain

### Bug fixes
- A retryable infrastructure failure (transport / network / rate-limit / timeout) during assumption verification was caught and mapped to an `uncertain` verdict for every assumption, conflating "the check did not run" with "the model could not decide" — so a single transient failure could trip the assumption gate. The verification session is now retried a bounded number of times on a retryable infrastructure error and re-thrown on exhaustion (or immediately for a non-retryable one) so the run halts resumably via the existing resume path. A genuine `uncertain` verdict from a successful session, and the generic (non-infrastructure) error fallback, are unchanged.

## [0.1.126] - 2026-06-15 — Delivered milestone 001: clean-run completion status and per-entry batch cost attribution.

### Bug fixes
- run() now writes globalStatus='complete' on clean completion, enabling detectHaltInfo to correctly classify successful runs instead of misidentifying them as halted
- Batch entry manifests now report per-entry cost and session count instead of cumulative totals via optional usage-baseline subtraction during archive

## [0.1.125] - 2026-06-15 — Delivered two independent completeness fixes for scope parsing and audit verification.

### New features
- `extractScopeItems` now recognizes numbered-bold list items (e.g., `1. **Foo bar**`) as scope items under a `## Scope — in` heading, enabling scope coverage verification for specs using this dialect

### Bug fixes
- `auditVerification` now reports missing mission state files as anomalies instead of silently skipping them, ensuring unverified tasks cannot bypass the fail-closed verification gate during milestone completion

## [0.1.124] - 2026-06-15 — Gate the run/archive completion boundary

### Bug fixes
- The full test-suite gate only ran during archiving, which `cc-orch run` never reaches — a run could finish green with the suite red. The gate now also runs at the end of a run (without archiving or bumping), sharing one implementation with the archive path.
- A rejected, non-terminal, or zero-completed-milestone run could still bump the version and write the changelog and run history. Those release-tracking writes are now gated on the run being a clean delivery, while the archive record is still written; a review-gate rejection is persisted so a later archive treats it as non-clean even when every milestone is complete on disk.

## [0.1.123] - 2026-06-15 — Fail closed on milestone-completion verification-audit anomalies

### Bug fixes
- The Phase-5 verification audit (auditVerification) flagged a complete task with a missing/FAILED/unparseable verification sidecar but only logged a warning, then transitioned the milestone to complete — a false-green on an unverified deliverable. _executeMilestone now throws VerificationAuditError before the transition (run/resume halt; batch routes to failed-execution); detection logic is unchanged, no escape hatch. Ten existing tests that drove milestone completion with synthetic complete-task fixtures gained PASSED verification sidecars (via a shared test helper) to match the now-enforced contract.

## [0.1.122] - 2026-06-14 — Backfill unit tests for the assumption-gate auto-waive modules

### New features
- Added dedicated unit tests for the benign-uncertain classifier (test/test-assumption-classifier.js, 7 cases over BENIGN_CATEGORIES + classifyBenignUncertain) and the auto-waive scene writer (test/test-auto-waive-scene.js, 5 cases over writeAutoWaiveScene's append-by-rename rotation). The auto-waive feature itself shipped in 0.1.113 with only an integration test; these add the missing per-module coverage.

## [0.1.121] - 2026-06-14 — Replace lexical scope-coverage gate with planner-declared scope mapping

### New features
- Scope-coverage gate now verifies coverage against an explicit planner-authored scopeItem→mission mapping carried on the plan object, replacing lexical (substring + distinctive-keyword) matching that false-positived on symmetric/parallel scope sections. extractScopeItems emits stable ids; the set + mapping persist in writeGlobalPlan's single atomic write, round-trip through the queue, and rehydrate on resume.

### Bug fixes
- A dangling mission id in the mapping counts as uncovered (strict all-valid). Goal-only runs persist an empty set and skip; a legacy run with no persisted set fails closed (escapable via --allow-incomplete-scope). Lexical-matcher tests retired; mapping-contract tests added.

## [0.1.120] - 2026-06-14 — Fix export-ccusage producing malformed model IDs

### Bug fixes
- roleToModelId treated config.execution.*Model (now full model IDs) as shorthand aliases and fell back to claude-${id}-4-6, yielding names like claude-claude-haiku-4-5-4-6; it now uses the configured ID directly, with only a haiku dated-form override for ccusage pricing.

## [0.1.119] - 2026-06-14 — Pin agent model IDs to full strings via shared constants

### Bug fixes
- Replaced SDK aliases (opus/sonnet/haiku) in per-role model assignments with full model IDs, centralized as editable constants at the top of config.js; synced the two config-contract assertions.

## [0.1.118] - 2026-06-13 — Rescue mid-run needs_revalidation tasks before the milestone-advance invariant

### Bug fixes
- A task marked needs_revalidation by the analyzer cascade after the scheduler's start-time scan was stranded, tripping the milestone-advance invariant and landing the run failed-execution. The scheduler pass is now wrapped in a bounded re-pass loop that re-dispatches/re-validates such tasks (no-progress capped); a non-draining cycle escalates to a human halt (park) instead of a bare invariant throw; a genuinely unrescuable non-terminal task still throws.

## [0.1.117] - 2026-06-13 — Preserve evidence and types on batch failure paths; stop input-boundary file theft

### Bug fixes
- A real park-commit failure no longer lets the failure-path git clean delete the just-created forensic archive (archive unstaged before reset, excluded from clean; genuine commit failure logged loudly, empty-archive case stays quiet).
- A CircuitBreakerError now survives the scheduler-stall wrap as the thrown error's cause, so a breaker on a non-final task of a multi-task milestone routes to halted-analyzer with a park scene.
- A non-.md dry-run input is rejected at the queue boundary instead of copying/unlinking an unrelated project-root spec.json; spec-text readers return empty on a falsy prdPath instead of injecting the root spec.json into prompts.

## [0.1.116] - 2026-06-13 — Make persisted run state crash-consistent and resume-faithful

### Bug fixes
- Verify sidecars are written before mission state (the commit point) and the anchor-path state write is atomic, so a crash in the window leaves only orphan sidecars a resumed re-plan overwrites.
- --allow-incomplete-scope and small-task gate dispositions persist into state and are read back as defaults on resume/batch (explicit flags still win; guarded against a missing state file).
- Re-queuing a bare spec over a slug that carried a spec.json clears the stale json; a missing prdPath fails honestly at validate time.
- replaceTask renames a colliding replacement id instead of resurrecting an existing task, with acyclicity-rollback cleanup of its on-disk artifacts.

## [0.1.115] - 2026-06-13 — Clear eight reviewer-warning fidelity fixes

### Bug fixes
- One 'error' emit per transport-classified failure; verifier returns the audit-patched verdict matching its on-disk sidecar; ProgressTracker exposes a public driftActive getter; dead negation token removed; README/CLI flag scoping corrected; audit-r2 text aligned to its 30-line check; usage --include-failed implies --all.
- The cross-archive usage aggregator reads token-usage.json (every session) rather than session-summary.json (completed only), closing a 30-60% cost/session undercount on failed runs.

## [0.1.114] - 2026-06-13 — Auto-accept clean reviewer passes at the batch review gate

### New features
- In batch mode, when every milestone's reviewer sidecar is a clean pass (PASSED, no critical finding), the review gate auto-accepts and proceeds instead of prompting; any missing/unreadable/non-clean sidecar falls through to the existing menu (fail-closed). A single exported clean-pass predicate is shared by the reviewer and the gate. run()/resume()/single-run unchanged.

## [0.1.113] - 2026-06-13 — Add benign-uncertain auto-waive to the batch assumption gate

### New features
- When a batch run's assumption gate has only uncertain verdicts matching known inspector-tool-limit shapes (cannot-execute, git-history-inaccessible, planning-claim, cannot-trace) and zero failures, it auto-waives and proceeds instead of parking, logging a per-category breakdown and recording the classification to a queue-side scene. Any unmatched uncertain or any failed verdict still parks. One pure classifier backs both round-1 and round-2; run()/resume()/single-run unchanged.

## [0.1.112] - 2026-06-12 — Delivered four gate-predicate fidelity fixes with comprehensive test coverage and regression verification.

### New features
- planGlobal defensive filtering: acceptance_criteria array now tolerates non-object and missing-description items by skipping with warning log (opts.onLog callback or console.warn fallback) instead of crashing during context building.
- Drain-time warning logs: when spec.json becomes unreadable post-planning, _assertSpecHardCheckCoverage and _runSpecCriteriaDrain now emit informative warning logs naming file path and consequences (which gates/checks will not fire) instead of silently no-opping.
- test-gate-predicate-fidelity.js: 23-test integration suite covering all 4 acceptance criteria (AC1: predicate fidelity 8 tests, AC2: URL/directory exclusion 8 tests, AC3: invalidationReason semantics 3 tests, AC4: robustness/warnings 4 tests) with boilerplate, helper infrastructure (createEnv, makeDrainPipeline, writeSidecar), and comprehensive assertions.
- Supporting regression test suite: 73 new test cases across 6 files (test-is-checkable-criterion.js 12 TC, test-extract-path-tokens-exclusions.js 12 TC, test-curl-url-milestone-only.js 5 TC, test-invalidation-reason.js 7 TC, test-milestone-check-robustness.js 6 TC) plus compatibility verification of existing test files with regression sweep confirming all 232 tests green.

### Bug fixes
- isCheckableCriterion predicate extraction and single-sourcing: dialect guard now matches parser extraction contracts exactly (kind='command' with non-empty string command, kind='file-check' with non-empty targetFile, or explicit kind='manual'), rejecting false-positives like empty verification objects, missing command strings, typo'd kinds, and arrays.
- extractPathTokens URL and directory exclusion: curl/http checks (://) and existing-directory tokens now excluded from path extraction, enabling correct milestone-only classification and routing through criteria drain instead of spurious plan-fatal orphan errors.
- invalidationReason persistence with asymmetric drain semantics: task invalidation now persists reason field ('replaced', 'redundant') enabling drain to skip replaced-task sidecars while counting redundant-task sidecars as coverage; legacy tasks without reason conservatively skipped with warning.
- runMilestoneOnlyChecks robustness: set 16 MiB maxBuffer to prevent ENOBUFS silent failures, emit honest buffer overflow diagnostic instead of misleading exit code, classify SIGTERM/ETIMEDOUT as timedOut field for accurate timeout handling.

## [0.1.111] - 2026-06-11 — Completed milestone 001: successfully extracted planner prompt builders into dedicated module.

### New features
- Created src/orchestrator/agents/planner-prompts.js module housing prompt construction logic extracted from planner.js (four PROMPT_SECTION_* constants and three builder functions: buildMissionSystemPrompt, buildMissionUserPrompt, buildReplanSystemPrompt).
- Refactored planner.js to import prompt builders from planner-prompts.js and re-export the four PROMPT_SECTION_* constants, maintaining full backward compatibility with existing consumers.
- Extended test-planner-prompt.js with TC-sot-wiring test case verifying planner.js re-exported constants are reference-identical (===) to planner-prompts.js originals, pinning the single-source-of-truth wiring.

## [0.1.110] - 2026-06-11 — Milestone 001 completed: Extracted spec-text reading logic from pipeline.js into a new pure module.

Maintenance release (no notable changes).

## [0.1.109] - 2026-06-11 — Completed shared prompt section refactoring in planner.js with regression tests—all 4 tasks passed, 217 tests green.

### New features
- Added shared-section identity regression tests to verify prompt sections render identically in both builders

### Bug fixes
- Extracted shared prompt sections into reusable module-level constants to prevent accidental divergence between mission and replan system prompts

## [0.1.108] - 2026-06-11 — Successfully extracted three duplicated block families from pipeline.js into behavior-preserving private helpers, with full test suite validation

### New features
- Extract 5 duplicated progress-bump blocks into _bumpProgress(taskId) private helper method to consolidate progress tracking on the verification path
- Extract 2 duplicated hard-check gate override blocks into _applyHardCheckGate(task, verifyResult, label) async private helper method with parameterized labels
- Extract 2 duplicated verifier pass-count log blocks into _logVerifierPassCounts(taskId, label) private helper method with sidecar parsing

## [0.1.107] - 2026-06-10 — Delivered README.md documentation fix correcting web UI port reference from 8743 to 3939.

### Bug fixes
- README.md: Corrected web UI default port documentation from 8743 to 3939 in the cc-orch ui command listing (line 155), and updated the PORT environment variable table (line 189) to separately document webhook server (8743) and web UI (3939) defaults while preserving all three legitimate 8743 references (webhook comment, webhook example, webhook table cell)

## [0.1.106] - 2026-06-10 — Successfully retired ALLOWED_TRANSITIONS alias and migrated to direct TASK_TRANSITIONS usage with all tests passing.

### Bug fixes
- Retired ALLOWED_TRANSITIONS backward-compatibility alias from state-machine.js; updated module documentation and test imports to use TASK_TRANSITIONS directly. This simplifies the module's public API while maintaining identical transition validation behavior.

## [0.1.105] - 2026-06-10 — Successfully removed three dead-code items across CLI and gates modules with full test suite passing

### Bug fixes
- Removed unused projectRoot parameter from health() function signature and updated corresponding call site in index.js
- Removed unused out parameter from promptFilename() function signature and call site while preserving promptDecision() out parameter
- Removed unused IncompleteScopeError import from scope-coverage.js and updated documentation to remain truthful

## [0.1.104] - 2026-06-10 — Milestone 001 completed: successfully removed dead code from the pipeline orchestrator.

### Bug fixes
- Removed dead code: _renderDryRunSummary method and unused config knobs (maxRetryCount, verbose) from pipeline orchestrator

## [0.1.103] - 2026-06-10 — Milestone 001 completed: extracted Pipeline._formatBanner into a pure banner module; all 203 tests passing.

### New features
- Extracted Pipeline._formatBanner into a pure formatBanner() module (src/orchestrator/core/banner.js) with delegating wrapper for improved code organization and reusability

## [0.1.102] - 2026-06-09 — Milestone 001 complete: spec.json structured fields injected into planGlobal user prompt with comprehensive test coverage

### New features
- Inject spec.json target_files and acceptance_criteria into planGlobal user prompt with fail-soft behavior, ensuring prompt byte-identity when fields are empty
- Add test coverage for spec.json field injection including fail-soft verification and system prompt isolation validation

## [0.1.101] - 2026-06-09 — Successfully extracted progress-tracking concern from Pipeline into ProgressTracker class with behavior-preserving refactoring across all 203 tests.

Maintenance release (no notable changes).

## [0.1.100] - 2026-06-01 — Milestone 001 delivered: implemented deterministic test-registration gate with fail-blocking verification in all pipeline paths and refactored checkTestWiring to read real TEST_FILES source.

### New features
- New deterministic `checkTestRegistration` gate module flags unregistered test files with optional R2-OK escape-hatch annotation in first 30 lines
- Test-registration gate integrated as fail-blocking override into all four verify-pass paths in pipeline: per-task verification, scheduler-loop revalidation, executor revalidation, and aggregate submission

### Bug fixes
- checkTestWiring refactored to read real TEST_FILES array from scripts/run-tests.js via injectable parameter instead of reading package.json test:all script

## [0.1.99] - 2026-06-01 — Delivered spec-read-and-compare capability for submission verifier with deterministic warn-only audit mechanism; all 9 tasks passed.

### New features
- Submission verifier prompt now includes spec path and cross-task spec-fidelity comparison instruction when context.specPath is supplied
- Added optional back_reference_check field to submissionVerifierSchema with spec_consulted, plan_consulted, and deviations structure matching per-task verifier schema
- Implemented deterministic spec-read audit in verifySubmission that records didReadSpec result, overrides back_reference_check.spec_consulted based on audit, and warns when spec not read without changing verdict
- Extracted buildSubmissionVerifierPrompt helper function to construct submission verifier prompt with or without spec context
- Hardened extractSubmissionVerdict with Invariants JSDoc, guard comments, and runtime assertion ensuring back_reference_check verbatim passthrough contract is maintained
- Added 5 contract tests for optional back_reference_check field validation (payload omission, full population, enum validation, required field enforcement, empty object rejection)
- Registered test/test-submission-verifier-spec-read.js in TEST_FILES array and added acceptance criteria test suite covering spec path inclusion, schema validation, audit override, gating conditions, and warn-only behavior

## [0.1.98] - 2026-05-31 — Delivered milestone 001: Implemented deterministic, warn-only spec-read audit in per-task verifier with complete test coverage and 196-pass full suite.

### New features
- Per-task verifier now includes deterministic spec-read audit: replaces unreliable self-reported spec_consulted with ground-truth signal from session's _readFiles Set, records didReadSpec and specPath in verification sidecar specReadAudit field, warns when spec not read (warn-only, never changes verdict), and gates audit for stub verdicts and regression-* synthetic tasks
- Comprehensive test coverage for spec-read audit: 8 acceptance criteria tests covering signal resolution with path.resolve, self-report override, extractVerdict contract preservation, gating logic for stubs and regression tasks, and warn-only behavior
- Integration tests for spec-read audit call path: 4 tests (A1-A4) exercising audit through verifyTask with mock session handles, _readFiles patterns, and sidecar assertions

### Bug fixes
- Regression test confirms extractVerdict pure contract maintained: signature.length === 3 and byte-identical sidecar output when called without audit parameter, ensuring backward compatibility

## [0.1.97] - 2026-05-31 — Completed Tier-1 small-fixes bundle: path-anchor gate, submission verifier retry, archive-preserve determinism, and no-fail-fast test runner—all 9 tasks passing.

### New features
- Path-anchor validation now supports optional projectRoot parameter for resolving prose short-name target files to their canonical locations, preventing false positive violations when short names and full paths reference the same file
- Submission verifier now retries non-stub FAIL verdicts up to config.maxRetries times before dispatching to analyzer with real retry count instead of hardcoded zero
- test:all script decoupled from fail-fast chaining to independent test runner (scripts/run-tests.js) with aggregated results and summary reporting, providing complete visibility into test suite health
- New scripts/run-tests.js test runner executes tests independently without early exit on failure, aggregates results across all tests, and exits non-zero only if any test failed
- Extended path-anchor validation test suite with TC13 (same-file resolution via projectRoot does not throw) and TC14 (genuine violation still throws with projectRoot) test cases
- New test suite (test-submission-verifier-fail-retry.js) validates submission verifier FAIL retry behavior with tests for retry count, analyzer dispatch, and early termination on PASS verdict
- Path-anchor validation test file integrated into test:all suite via scripts/run-tests.js TEST_FILES array, ensuring extended TC13 and TC14 tests execute in CI

### Bug fixes
- archive-preserve test (TC3) now deterministic by excluding report.html from byte comparison, eliminating false failures from non-deterministic archive timestamps and cost/session totals

## [0.1.96] - 2026-05-31 — Delivered per-session wall-clock cap and elapsed observability with non-retryable abort routing across 10 tasks.

### New features
- Add configurable per-task wall-clock cap (45-minute default) to execution config to prevent runaway sessions
- Implement WallClockExceededError class with non-retryable flag and wall-clock timer in session spawning (spawn() and ReusableSession._consumeEvents())
- Route wall-clock timeouts as non-retryable circuit-breaker failures to analyzer in both executor and verifier catch blocks
- Surface per-task execution and verification elapsed time in .harness/progress task sidecars via _writeElapsedToSidecar() helper
- Add comprehensive test suite covering wall-clock abort promptness, non-retryable classification, default budget validation, and elapsed time tracking (18 tests across 4 files)
- Wire wall-clock test files into package.json test:all CI gate script

## [0.1.95] - 2026-05-30 — Milestone 001 delivered: deterministic plan-time validator detects spec-rejected task behaviours with warn-only posture.

### New features
- Add extractRejectedPhrases() deterministic parser to extract DO NOT phrases from spec sections, with stopword filtering and distinctiveness threshold (≥2 content tokens)
- Add _warnIfRejectedBehavior() warn-only validator method that flags task descriptions matching rejected phrases, with 6-word negation-context guard to reduce false positives
- Thread spec text through planMission context via new _getSpecText() helper that reads prdPath from project metadata with caching and error handling
- Wire rejected-behaviour validator into both planMission call sites, positioned between _warnIfVagueDescriptions and _enforceSequentialOrdering validators
- Comprehensive test coverage: 8 unit tests (TC-EXTRACT-1..3, TC-WARN-1..5) exercising extractRejectedPhrases and _warnIfRejectedBehavior, plus integration tests validating end-to-end spec-text flow

### Bug fixes
- Export STOPWORDS from scope-coverage.js to enable reuse in scope-parser.js for token distinctiveness filtering

## [0.1.94] - 2026-05-30 — Delivered transport-layer timeout classification as retryable InfrastructureError with comprehensive test coverage.

### New features
- Added comprehensive test suite (test/test-classify-result.js) with 5 test cases verifying transport timeout detection predicates, semantic error passthrough, and spawn() integration behavior.

### Bug fixes
- Transport-layer timeouts now classified as retryable InfrastructureError instead of returned as normal results, preventing transient connectivity failures from consuming maxRetries budget and bricking task execution.

## [0.1.93] - 2026-05-30 — Delivered fix for resume-on-residual-sidecar crashes with comprehensive regression test suite.

### New features
- Added four new regression test cases (TC-FW-FAILED-EXEC, TC-FW-FAILED-VERIFY, TC-FW-INPROGRESS, TC-FW-PENDING-COLLISION) to verify firstWrite behavior across task status scenarios (failed, in_progress, pending with collision)

### Bug fixes
- Changed firstWrite computation from retryCount === 0 to preExecStatus === 'pending' in pipeline.js to fix false-positive SidecarReuseError crashes when resuming tasks with residual sidecars from prior failed attempts; guards in executor and verifier remain unchanged

## [0.1.92] - 2026-05-30 — Delivered milestone 001: re_plan dedup and cascade-rewire with 6 passing tasks and comprehensive test coverage

### New features
- Insert-time deduplication of replacement tasks by (description, sorted targetFiles) with droppedToKept mapping for dependency rewrites
- Narrowed invalidation to only failed task; direct dependents preserved and cascade-rewired to lastReplacementId
- Acyclicity rollback with rewireSnapshot: captures original dependencies before mutation, restores on cycle detection
- New test file test-replan-cascade-rewire.js with 6 test cases covering dedup (TC-DEDUP-1/2/3) and cascade-rewire (TC-CASCADE-1/2/3) behaviors

### Bug fixes
- Updated test-scheduler-replace-task.js Tests 2 and 3 to reflect preserve+rewire contract: A→B→C chain asserts only A invalidated, B/C preserved and rewired
- Added test-scheduler-replace-task.js Tests 12 and 13 for dedup collapse with dependency redirect and acyclicity rollback restoration

## [0.1.91] - 2026-05-30 — Delivered orphan task ID re-parenting with comprehensive regression tests.

### New features
- Added comprehensive regression test coverage for ID normalization re-parenting logic with 8 new test cases spanning all four decision quadrants (accept-as-is, throw on cross-mission collision, orphan re-parent, benign same-namespace collision).

### Bug fixes
- Orphan remediation task IDs are now re-parented when their ID prefix diverges from deposit location, preventing non-convergent loops in remediation planner. Added prefixMatches guard to normalizeTaskId early-return condition.

## [0.1.90] - 2026-05-29 — Delivered milestone 001: submission-verifier stub-retry with config knob, helper method, integration, and comprehensive test coverage—all tests passing.

### New features
- Add `submissionMaxRetries` config knob (default 2) to control submission verifier retry budget, separate from per-task `config.maxRetries` due to different cost profile
- Add Pipeline helper method `_verifyWithRetryOnStub(verifyFn, maxRetries, label)` that retries verification calls while returned verdict has `isStub: true`, up to `maxRetries + 1` total attempts; real verdicts return immediately, thrown errors propagate unchanged
- Wire `_verifyWithRetryOnStub` helper into `_verifySubmission` around `verifier.verifySubmission()` call to absorb transient SDK stub responses while preserving try/catch/finally and InfrastructureError handling
- Create test file `test/test-submission-verifier-retry-on-stub.js` with 6 test cases (TC1-TC6) covering stub→success retry, all-stub exhaustion, real FAIL no-retry, error propagation, success-first-attempt, and config defaulting behavior
- Register new test in `package.json`: add `test:submission-verifier-retry-on-stub` script and append to `test:all` chain for integration into full test suite

## [0.1.89] - 2026-05-29 — Successfully shipped milestone 001: path normalization for scheduler file-conflict detection with all six tasks completed and passing.

### New features
- New src/orchestrator/core/path-utils.js module exports normalizeTargetFile(projectRoot, file) utility that canonicalizes file paths to absolute form using path.resolve(), enabling reliable file-conflict detection for any lexical form of the same file (./src/foo.js, src/foo.js, /absolute/path/src/foo.js collapse to single string representation)
- Added test-path-utils.js with four test cases validating normalizeTargetFile utility: relative path resolution, absolute path passthrough, parent-directory (..) resolution, and ./ prefix normalization
- Added test-scheduler-normalize.js with three async integration test cases exercising scheduler's runtime conflict detection with mixed path forms across dispatch, probe, and completion phases using mock runTask and minimal harness fixture
- Added test-scheduler-file-conflict-normalization.js with six comprehensive test cases covering path normalization invariants (dot-slash vs bare relative, relative vs absolute, false positive regression, consistency across three input forms, Set.add/has round-trip, Set.delete symmetry); wired test:scheduler-file-conflict-normalization script into package.json and test:all chain

### Bug fixes
- Scheduler file-conflict detection now works correctly with mixed path forms. Updated hasFileConflict(task, runningFiles, projectRoot) signature to normalize all file paths before set operations; wired normalizeTargetFile at all five runningFiles touchpoints: conflict lookup (line 96), dispatch add (line 268), probe dispatch add (line 365), task completion delete (line 331), probe release delete (line 376); ensures runningFiles set members are always absolute paths

## [0.1.88] - 2026-05-28 — Successfully completed CLI surface reconciliation with USAGE updates, README refresh, and drift-prevention tests

### New features
- USAGE help string synchronized with current CLI surface: added all commands (review, health, clean, ui, dispersion family), documented all flags (--no-review, --task, --include-failed, --allow-dirty, --no-git-required, --allow-incomplete-scope), added Environment subsection for PORT/PROJECT_ROOT/EDITOR, added Exit codes subsection (0, 1, 75, 76), removed unimplemented exit-77 promise, documented .md file shortcut
- README.md updated from v0.1.59 to v0.1.86 with expanded CLI section documenting new commands and safety flags; added Environment subsection documenting PORT, PROJECT_ROOT, EDITOR variables; added Triggers subsection documenting webhook and cron services; version banner updated to reflect Phase III shipped features (ui, dispersion, review, health)
- Created test/test-usage-coverage.js with TC1 validating all KNOWN_COMMANDS entries appear in USAGE and TC2 validating required subcommands (archive list/show/diff, usage compare, queue list/remove, dispersion compare) appear in USAGE; integrated into package.json test:all script to prevent future documentation drift

<!-- legacy: pre-framework, migration-pending -->

## [0.1.87] - 2026-05-28 — Fixed needs_revalidation parallel-path dispatch and awaiting_verification resume sidecar reuse.

### Bug fixes
- needs_revalidation tasks reaching the parallel scheduler path now route through verifier-only re-validation: scheduler preTerminal scan special-cases the state and _executeAndVerifyTask gets an explicit branch mirroring the sequential reference (executor is correctly NOT re-run).
- Resume from awaiting_verification now passes firstWrite:false to the verifier, so the prior crashed run's sidecar no longer trips SidecarReuseError; the verifier overwrites cleanly and the executor is correctly skipped.

### New features
- Added test/test-scheduler-reval-dispatch.js (3 cases) covering needs_revalidation parallel-path dispatch contracts.
- Added test/test-firstwrite-skip-executor.js (2 cases) covering the conditional firstWrite flag based on skipExecutor.
- Extended test/test-sidecar-reuse.js with TC-SR-7 (F02) and TC-SR-8 (F04) integration-level no-throw contract tests; all 8 cases pass.
- Wired both new test files into the test:all chain.

## [0.1.86] - 2026-05-28 — Milestone 001 delivered: isStub flag persists to verifier sidecars with transition guards integrated into pipeline.

### New features
- Added assertNoStubVerifierSidecar and assertNoStubSubmissionSidecar guard functions to enforce stub state boundaries at verification transitions
- Extended test-is-stub-propagation.js with six new test cases (TC6-TC11) covering stub disk persistence, guard behavior, and pipeline integration

### Bug fixes
- isStub flag now persists to verifier stub sidecars on disk, enabling accurate downstream analysis and state resumption

## [0.1.85] - 2026-05-28 — Successfully delivered milestone 001: wired runHardChecks deterministic gate into pipeline verification paths with timeout constant and contract test suite.

### New features
- Export HARD_CHECK_DEFAULT_TIMEOUT_MS constant from hard-checks.js (value: 30,000ms) for configurable hardCheck timeout behavior
- Wire runHardChecks deterministic gate into _executeAndVerifyTask main verification path with asymmetric override semantics (JS gate can downgrade LLM PASS to FAIL when hardChecks fail)
- Wire runHardChecks deterministic gate into _executeSubMission revalidation path using identical override pattern as main verification path
- Create comprehensive contract test suite (test-hard-checks-pipeline-wiring.js) with 7 test cases covering hardCheck pass/fail scenarios, timeout behavior, edge cases, and revalidation path integration
- Register test-hard-checks-pipeline-wiring in package.json scripts and integrate into test:all chain between test-hard-checks-integration and test-snapshots-integration

## [0.1.84] - 2026-05-28 — Delivered verifier specPath plumbing fix with contract enforcement and path normalization across 9 completed tasks

### New features
- Export verifierContextSchema to define and validate specPath contract—specPath required as non-empty string
- Add comprehensive verifier callsite plumbing test suite (test-verifier-callsite-plumbing.js) with 6 test cases covering plumbing refactoring, schema validation, and contract enforcement

### Bug fixes
- Verifier now receives actual specPath instead of undefined by fixing state plumbing—replace this.state?.projectMeta?.prdPath with readState(this.harnessDir)?.projectMeta?.prdPath at 3 pipeline.js callsites
- Normalize prdPath to absolute paths—dryRunValidate now writes absolute paths via path.join(this.projectRoot, ...) and bootstrap rejects relative paths with loud error
- Verifier enforces specPath contract—throws loudly on missing or nonexistent specPath at function entry instead of silent no-spec fallback

## [0.1.83] - 2026-05-27 — Delivered R2 enforcer expansion with defect-to-invariant coverage lint, policy documentation, retroactive bootstrap, and comprehensive test coverage.

### New features
- Phase 4 defect-coverage lint added to audit-r2.js: scans CHANGELOG.md for Defect #N mentions, cross-references with PAIR_INVARIANTS descriptions, detects r2-exempt markers, and returns structured coverage report (covered/exempt/uncovered defects) with proper exit-code semantics (--warn-only exit 0, standard exit 2, --strict exit 1)
- r2-exempt HTML comment marker system: allows CHANGELOG.md entries to explicitly justify why a defect has no structural R2 invariant, with bidirectional ±3-line scan and section-scoped exemption detection to prevent false negatives
- Defect-coverage policy documented in ARCHITECTURE.md subsection: establishes governance requiring every commit fixing a Defect #N to either add an R2 pair invariant or include an r2-exempt marker, with enforcement via Phase 4
- Retroactive bootstrap of R2 pair invariants: added restoreSnapshot(before) requires _captureLastFailed (Defect #2) and appended Defect #13 reference to existing verifyTask invariant
- Retroactive bootstrap of r2-exempt markers: documented Defects #3, #6, #9 as non-structural with explicit exemption reasons (UI text, rendering logic, internal guards) in CHANGELOG.md
- Comprehensive test suite for defect coverage (test-r2-defect-coverage.js): 8 test cases validating covered defects, exempt markers, uncovered defects, strict mode enforcement, pure function behavior, manifest structure, and r2-exempt marker edge cases with 100% pass rate

## [0.1.82] - 2026-05-27 — Successfully delivered scope-completeness gate with extractor, checker, pipeline integration, CLI flag, and comprehensive tests

### New features
- New scope-completeness gate validates every spec scope item maps to at least one mission, preventing silent omissions
- New --allow-incomplete-scope CLI flag allows operator to downgrade scope validation failures to warnings
- Scope parser (extractScopeItems) recognizes numbered subsections, named-bug bullets, and HTML comment markers in spec markdown
- Scope coverage checker (checkScopeCoverage) uses substring and distinctive-keyword matching to validate mission coverage
- IncompleteScopeError class reports uncovered scope items with item count and labels

## [0.1.81] - 2026-05-27 — Delivered milestone 001: aggregate verifier implementation for ≥2-task sub-missions, with dual-format sidecar support and automatic dispatcher routing.

### New features
- New submissionVerifierSchema in _schemas.js for aggregate verification of ≥2-task sub-missions, wrapping per-task verdicts with cross-task observations and notes
- New extractSubmissionVerdict function in verifier.js to extract, validate, and persist aggregate verdicts to verification/submission-{id}.json sidecars
- New async Verifier.verifySubmission method that spawns single SONNET session to verify all tasks in a sub-mission, replacing N per-task HAIKU sessions with one aggregate session for cost savings and cross-task drift detection
- Automatic dispatcher routing in _executeSubMission: sub-missions with ≥2 tasks route to aggregate verifier via skipVerification flag; 1-task sub-missions use existing per-task verifier
- New resolveVerificationSidecar function to read both task-level (task-{id}.json) and submission-level (submission-{id}.json) sidecar formats with priority to task-level
- Consumer updates to support dual-format sidecars: audit.js checks submission sidecar taskVerdicts, dispersion-fingerprint.js expands submission verdicts to individual entries, pipeline._parseVerificationSidecar extracts verdicts from either format
- Config entries for aggregate verifier: budgets.submissionVerifier (2.0 USD) and execution.submissionVerifierModel ('haiku' for per-task, with infrastructure ready for SONNET in aggregate path)
- Comprehensive test coverage: contract tests for submissionVerifierSchema and extractSubmissionVerdict, dispatch routing tests, audit and fingerprint integration tests, dual-format sidecar tests, end-to-end integration test

## [0.1.80] - 2026-05-26 — Shipped Bug C cascadeComplete fix and four reviewer findings across scheduler, pipeline, coverage, and test integration

### New features
- Wire four new test files into package.json test:all script: test-replace-task-cascade.js, test-task-id-collision.js, test-pending-tasks-invariant.js, test-sidecar-reuse.js

### Bug fixes
- scheduler.js replaceTask now calls cascadeComplete after invalidating tasks to properly complete sub-missions when all tasks become terminal via invalidation
- pipeline.js now passes correct milestone ID to assertNoNonTerminalTasks, fixing PendingTasksAtMilestoneAdvance error reporting
- coverage.js normalizeTaskId now checks for cross-mission task ID collisions in addition to local sub-mission collisions

## [0.1.79] - 2026-05-26 — Delivered Milestone 001: TaskId collision detection, sidecar reuse rejection, and pending-task invariant enforcement to prevent silent dispatch corruption in cc-orchestrator remediation pipeline.

### New features
- Add comprehensive state-validation test coverage with 23 test cases across 5 new test files validating TaskId collision detection, sidecar reuse rejection, and pending-task invariant enforcement

### Bug fixes
- Prevent task ID collisions across missions when remediation injects new tasks by scanning state directory and throwing TaskIdCollisionError with collision location
- Prevent stale sidecar reuse on first task dispatch by adding firstWrite guards to executor and verifier, throwing SidecarReuseError instead of overwriting existing progress/verification files
- Enforce pending-task invariant with assertNoNonTerminalTasks at 4 pipeline checkpoints to prevent silent task dispatch gaps by validating all tasks are terminal before milestone advancement

## [0.1.78] - 2026-05-26 — All 8 tasks of tier-1 quick-fixes bundle completed successfully, delivering fixes for specHash display, resume command gating, gitignore initialization, and test helper signature.

### New features
- Init command idempotently appends .gitignore stanza during bootstrap for cc-orch ephemeral spec files (spec-*.md and *.spec.md patterns), marked with '# cc-orch ephemeral inputs' comment.

### Bug fixes
- compareFingerprints now uses tri-state logic for specHash matching: returns null when either fingerprint has null specHash, true when both are non-null and equal, false when both are non-null and different. Output displays 'unknown (null specHash)' for the null case instead of incorrectly reporting true.
- Fixed test-circuit-breaker-replan.js replaceTask helper to construct Set<string> of target files instead of passing failedTask object, correcting signature mismatch with production _validateTargetFilesSubset. Tests now integrated into test:all suite.
- Resume command no longer invokes git safety precheck gating; users can resume halted runs without --allow-dirty flag even if working tree contains cc-orch ephemeral changes.

## [0.1.77] - 2026-05-26 — Delivered git safety precheck guard preventing cc-orch mutations on non-git or dirty repositories

### New features
- New git-guard.js module with upward directory walk and dirty-tree detection preventing mutations on unsafe repositories
- Integration of git safety checks into mutating CLI commands (run, dry-run, resume, .md shortcut) with fail-closed defaults
- New global flags --allow-dirty and --no-git-required for explicit override of git safety checks with help documentation
- Comprehensive test coverage with 20+ test cases validating git guard module behavior, CLI integration, and read-only command exemption

## [0.1.76] - 2026-05-26 — Completed milestone 001: delivered dispersion compare subcommand, fixed verifier enum display, and added usage --all filtering

### New features
- Add cc-orch dispersion compare subcommand to compare two archive fingerprints side-by-side, displaying field-by-field deltas for specHash, planStructure counts, verifier verdicts, and reviewer findings with text (default) or JSON output
- Add --include-failed flag to cc-orch usage --all to optionally include archives with ids prefixed by 'failed-' in cost aggregation; by default these archives are excluded

### Bug fixes
- Fix verifier status enum comparison in dispersion display functions from lowercase 'pass'/'fail' to uppercase 'PASSED'/'FAILED' to show accurate verdict counts instead of always displaying pass:0 fail:0

## [0.1.75] - 2026-05-26 — Completed refactoring to move writeFingerprint into archive() function, ensuring all archives emit dispersion-fingerprint.json.

### New features
- Added TC-fingerprint test case to verify fingerprint is created in archive directory with valid fingerprintVersion property

### Bug fixes
- All archives now emit dispersion-fingerprint.json including those created via standalone cc-orch archive command by moving writeFingerprint responsibility into archive() function

## [0.1.74] - 2026-05-26 — Implemented `cc-orch dispersion` CLI command for reading and inspecting archive fingerprints with comprehensive test coverage.

### New features
- `cc-orch dispersion` command added: list mode shows one summary line per archive with fingerprint; show mode displays detailed fingerprint with plan structure, deviation summary, reviewer findings histogram, and warnings
- JSON output support via `--json` flag for both list and show modes of dispersion command

### Bug fixes
- Fixed `--json` flag being silently ignored in legacy array-branch call form; flags.json property now correctly merged into opts

## [0.1.73] - 2026-05-25 — Delivered verifier context expansion: spec and plan back-reference checking with optional advisory field and comprehensive test coverage.

### New features
- Verifier agent now reads spec.md and mission plan files to detect spec mismatches and inter-task contradictions during verification
- New optional back_reference_check field in verifier output with spec_consulted and plan_consulted booleans plus deviations array
- Deviation kind enum includes spec_mismatch, plan_contradiction, missing_constraint, and undefined_composition
- Comprehensive test coverage for back_reference_check: 7 new test cases validating schema presence/absence, enum constraints, required fields, and extractVerdict preservation behavior

### Bug fixes
- Pipeline passes projectMeta.prdPath through verifier context to enable spec file access during verification
- Verifier budget increased from 0.75 to 1.25 USD to absorb spec and plan file cache-read tokens

## [0.1.72] - 2026-05-24 — Milestone 001 complete: delivered graceful shutdown with atomic state writes and AbortSignal propagation

### New features
- Graceful shutdown: SIGINT/SIGTERM handlers now trigger AbortController.abort() instead of process.exit(), enabling clean termination after resource cleanup
- Atomic state persistence: state.json and mission-*.json now use crash-safe temp-file + fsync + rename pattern, preventing corruption during interruption
- AbortSignal propagation: signal threads cleanly from Pipeline through Scheduler and SessionManager, enabling graceful cancellation of in-flight agent execution and SDK calls
- Resume reliability: pipeline can resume from last committed state checkpoint after Ctrl-C interruption, eliminating manual recovery workarounds

## [0.1.71] - 2026-05-23 — Completed Tier 1 final cleanup milestone: menu option rendering, orphan spec removal, and scope complexity detection

### New features
- Menu option keys and labels now render before readline prompt for all menu invocations (plan-approval, review-gate, and future menus)
- Brainstormer agent detects oversized specs via scope-complexity heuristics (acceptance criteria count, target file count, directory spread, goal complexity) and emits warnings with splitting recommendations

### Bug fixes
- Dry-run validation now removes orphan spec files from project root after queuing with boundary guards; updates state.json projectMeta.prdPath to reference queue copy

## [0.1.70] - 2026-05-22 — Shipped milestone 001: three structural brainstormer CLI improvements (readline input, progress indicator, slug-named output).

### Breaking changes
- Brainstormer accept output now writes &lt;slug&gt;.spec.json and &lt;slug&gt;.spec.md instead of literal spec.json and spec.md, enabling multi-brainstorm workflows without file overwriting

### New features
- Readline-based menu input supports backspace and delete characters in brainstormer CLI menu prompts
- Brainstormer CLI displays live progress indicator during long SDK calls with 5-second interval updates, elapsed time tracking, and reliable cleanup on success or Ctrl-C interrupt

## [0.1.69] - 2026-05-22 — Delivered milestone-regression in-flow auto-remediation loop with analyzer-driven fix recommendations and 3-iteration retry cap

### New features
- Milestone regression failures now automatically attempt in-flow remediation with analyzer-driven fix recommendations and up to 3 retry iterations before user-gate fallback

## [0.1.68] - 2026-05-22 — Milestone 001 complete: Fixed cross-sub-mission dependency remapping in splitMultiEditTasks.

### New features
- Added test cases TC7-TC9 validating cross-sub-mission dependency remapping, error handling, and false-positive prevention after task splits

### Bug fixes
- Cross-sub-mission dependencies now correctly reference cloned tasks instead of stale task IDs after splitting
- Unresolvable dependency references now throw descriptive errors containing both referencing and target task IDs instead of silent failures

## [0.1.67] - 2026-05-22 — Delivered all 5 brainstormer CLI UX improvements (confirmations, separator, help, sub-prompts, preview)—all 13 tasks verified, 24/24 tests passing.

### New features
- Post-action confirmation messages for all menu actions: accept outputs file paths and next commands; regenerate/edit show artifact location and 'd' view tip; cancel shows draft location and resume command; diff view shows spec terminator.
- Visual turn separator (60-char horizontal rule + 'Done. Ready for next action.') inserted after each menu action before the next menu prompt, omitted before the first menu.
- Expanded help block ('h' key): covers how to use feedback with 'r' (bare vs. inline), edit syntax ('e field value'), distinction between cancel (draft preserved) and accept (writes to project root), draft file location, and resume command.
- Bare 'r' and 'e' actions now sub-prompt for feedback/edits when invoked without inline arguments; inline forms ('r feedback text', 'e field value') continue to work as before without sub-prompting.
- Spec preview shown before menu prompt after generation and each revision: displays full content with delimiters for specs ≤2000 chars; displays structured summary (heading + first paragraph + line count + ellipsis) for longer specs.

## [0.1.66] - 2026-05-21 — Completed regression verifier soft-pass milestone: delivered cross-signal verification for unreliable structured output across 4 tasks with 63 passing tests

### New features
- Regression verifiers now apply soft-pass logic when npm test passes but structured verifier output is unreliable—cross-checks npm exit code and text signals against verifier boolean before halting pipeline
- Added runNpmTest() helper function to spawn npm test with 120s timeout and extractTextSignal() helper to extract pass/fail signal from structured output and report text
- Implemented 3-signal soft-pass decision rule in verifyMission and verifyMilestone gates: applies soft-pass when (npm exit 0 AND text PASS) overrides verified=false; logs [verifier-disagreement] for auditability
- Added 14 soft-pass test cases (TC-SP-1 through TC-SP-8 in new test-regression-softpass.js, TC-SP-1 through TC-SP-6 appended to test-regression-stub.js) covering all signal combinations and edge cases

## [0.1.65] - 2026-05-21 — Fixed detectHaltInfo priority-ordering bug: analysis-file halt signals now correctly take precedence over state heuristics

### Bug fixes
- Correct halt signal priority in detectHaltInfo: analysis-file signals now take precedence over state-heuristic regression-failure inference, ensuring reviewer-stop and other explicit halt reasons are not misclassified as regression-failure

## [0.1.64] - 2026-05-20 — Delivered four auto-remediation reliability fixes: stale round-2 assumption re-extraction, bullet-bold section locator support, mid-pipeline spec-edit logging, and line-number prohibition in remediation prompt.

### Bug fixes
- Round 2 assumption-verifier re-extracts assumptions from edited spec via planner.reExtractAssumptions(), preventing spurious FAILs when auto-remediation resolves spec issues between verification rounds
- Section locator (_extractSpecSection) adds Pass 4 to match bullet-bold patterns (`- **Heading:**`) in addition to markdown headings (`## Heading`), resolving silent skips on bullet-based sections
- Spec edits during pipeline now emit visible [specEdit][subsystem] log entries with section and summary for post-mortem audit trails
- Remediation prompt now forbids line-number references (line ranges, column offsets) to prevent stale position-based assumptions in spec edits

## [0.1.63] - 2026-05-20 — Delivered milestone 001: cleared four Tier 1 emergent items from archive 047.

### Bug fixes
- Wire test-ui-command.js and test-ui-routing.js into test:all chain to resolve test-wiring violations.
- Add documentation comment in brainstormer.js explaining indirect read path for brainstormSpecSchema.acceptance_criteria to resolve schema-coverage warning.
- Change analyzer.js line 81 from console.warn to opts.warn callback for consistent logging pattern; remove console.warn monkey-patching from test-analyzer-task-id-filter.js.

## [0.1.62] - 2026-05-20 — Milestone 001 complete — all 5 Tier 1 quick wins (config hygiene + test gaps) delivered and verified.

### New features
- Added test-analyzer-task-id-filter.js test suite with 3 test cases covering analyzer task ID filtering: drops mission-shaped IDs (1–3 segments) from affectedTasks, preserves replan-suffixed IDs (4-segment + suffix), and validates drop warnings.

### Bug fixes
- Wired orphan test files test-cross-archive-analyzer.js and test-usage-all-cli.js into npm run test:all chain and added standalone script aliases in package.json for consistency with existing convention.
- Implemented date column fallback in cc-orch usage --all: when NNN-slug archives lack YYYY-MM-DD date prefix, enumerateArchives now derives date from earliest startedAt ISO timestamp in session-summary.json (fallback only when regex fails).
- Separated analyzer budget configuration: added config.budgets.analyzer: 2.0 to config.js, restored config.budgets.verifier to 0.75, and updated analyzer.js line 190 to reference config.budgets.analyzer instead of verifier.
- Separated brainstormer configuration: added config.execution.brainstormerModel: 'opus' and config.budgets.brainstormer: 6.0 to config.js, and updated all 4 borrow sites in brainstormer.js (lines 304, 308, 353, 357) to use dedicated config keys instead of analyzer references.

## [0.1.61] - 2026-05-10 — Delivered milestone 001: read-only kanban dashboard with three GET APIs, frontend polling UI, and comprehensive test suite (10/10 tasks shipped, 235/235 tests passing).

### New features
- GET /api/state endpoint: reads `.harness/state.json` and per-mission files, projects into nested milestones→missions→subMissions→tasks hierarchy, returns safe defaults {active:false, milestones:[]} when files missing
- GET /api/cost endpoint: reads `.harness/logs/token-usage.json`, returns top-level totals (sessionCount, inputTokens, outputTokens, cacheCreation, cacheRead, totalCostUsd) plus per-type aggregation in byType map, all-zeros response when file missing
- GET /api/task/:id/verify endpoint: returns {hardChecks, taskScopeChecks} from verification sidecars, includes dual-layer path-traversal protection (regex validation + resolved path check), returns 404 for missing/unverified tasks
- Express server updates: mounted three API GET endpoints before static middleware for route precedence, preserved backward-compatible createServer() with optional harnessDir parameter
- Kanban HTML structure: header with title 'cc-orch ui v0' and cost-display slot, main container for milestone columns, aside verify-panel (initially hidden), footer progress-bar with fill and text elements
- Kanban CSS stylesheet: grid-based milestone columns with auto-flow, mission cards, task cards with 60ch description truncation and monospace IDs, five status border colors (gray/blue/green/red/orange), fixed verify panel and fixed progress bar with smooth 0.3s width transition
- Kanban JavaScript module: 1500ms polling with Promise.all dual-fetch, JSON.stringify equality skip for unchanged responses, visibilitychange pause/resume (document.hidden detection), click-to-verify panel with 404 fallback, Escape key dismissal, progress bar percentage calculation (verified/total tasks)
- API integration tests (test-ui-api.js): 8 test cases covering state projection (populated/empty), cost totals and per-type grouping, task verify endpoint with 200/404/400 responses, path-traversal guard validation
- Frontend component tests (test-ui-kanban.js): 10 JSDOM test cases covering DOM structure, status classes, cost display tooltip, progress bar percentage/text, verify panel open/close via click and Escape, visibility-based polling pause/resume, inactive state placeholder
- Package.json updates: added jsdom ^25.0.1 to devDependencies, registered test:ui-api and test:ui-kanban scripts, appended both test suites to test:all chain (now 235 total tests)

## [0.1.60] - 2026-05-10 — Delivered cc-orch ui foundation: Express server, static page, CLI routing, and full test coverage for browser dashboard groundwork.

### New features
- New `cc-orch ui` command starts a local web server (default port 3939, configurable via --port flag or PORT env var)
- Express server factory (src/ui/server.js) serves static files from src/ui/public/ directory
- Static HTML hello page (index.html) with 'cc-orch ui v0' marker as foundation for future dashboard
- Graceful SIGINT shutdown: server.close() on Ctrl+C followed by clean process exit
- CLI router wiring: ui command dispatched in src/cli/index.js with --port flag support and help text
- npm scripts: 'ui' command launcher and test:ui-server integration; test:ui-server appended to test:all chain

## [0.1.59] - 2026-05-10 — Shipped CLI integration test for cc-orch brainstorm with 6 test cases wired into test:all chain

### New features
- Added CLI integration test for brainstorm command with 6 comprehensive test cases (slug generation, non-TTY mode, approval, cancellation, resume, collision handling)
- Integrated brainstorm CLI test into test:all script chain

## [0.1.58] - 2026-05-10 — Delivered brainstormer agent core across 2 milestones: schema, class, CLI command with interactive loop, routing, bootstrap integration, and 35 contract tests — all 13 tasks passed.

### New features
- brainstormSpecSchema: JSON schema with 5-field v0 contract (goal, target_files, acceptance_criteria required; constraints, architecture_notes optional) for spec validation
- Brainstormer agent class with initialize(userInput) and revise(currentSpec, feedback, mode) methods for interactive spec generation with output validation
- brainstorm CLI command: cc-orch brainstorm "<prose>" [--no-tty] and cc-orch brainstorm --resume <slug> with interactive loop (menu keys: accept, regenerate, edit, cancel, diff, help)
- .harness/brainstorm/<slug>/ directory structure: spec.json, spec.md, history.jsonl, state.json with state machine transitions (in-progress→approved, in-progress→cancelled, cancelled→in-progress on resume)
- Harness bootstrap integration: creates .harness/brainstorm/ directory on init; excluded from force-wipe to preserve user-curated specs
- Contract tests: 16 tests for Brainstormer.initialize/revise methods; 19 tests for brainstormSpecSchema validation and CLI utilities (generateSlug, resolveSlugCollision, hashSpec)
- Public API: Brainstormer class and brainstormSpecSchema exported from root index.js; stability contract documentation updated

## [0.1.57] - 2026-05-09 — Delivered exports gate and stability contract, tightening the public API surface to 22 symbols.

### New features
- Added package.json `exports` field restricting public API surface to bare-specifier imports from './index.js', preventing consumers from accessing internal modules via deep paths
- Completed index.js public surface: removed phantom HarnessShell export, added Summarizer agent, and re-exported 10 schema/helper symbols from _schemas.js (22 total public exports)
- Added test-stability-contract.js with 5 test cases enforcing the public API surface contract (validates 22-symbol set, confirms HarnessShell absence, verifies package.json exports field)
- Documented Rule 12 in ARCHITECTURE.md establishing the public API discipline: package.json#exports gate, index.js re-exports, deep-path imports as private, and versioning implications
- Created docs/STABILITY-CONTRACT.md documenting the 22 public symbols organized by layer (Pipeline orchestration, Agents, Infrastructure, Schemas) with stability discipline explaining update requirements

## [0.1.56] - 2026-05-09 — Shipped `cc-orch usage --all` command for cross-run cost and cache metric aggregation with filtering options

### New features
- New `cc-orch usage --all` flag aggregates cost, session count, and cache metrics across all archived runs with chronological table output and aggregate summary. Supports `--json` for structured output.
- Add `--last N` and `--since YYYY-MM-DD` filter flags to narrow archive selection for cross-archive metrics analysis

## [0.1.55] - 2026-05-05 — Phase 1 review follow-ups: HaltError unification + auto-mode migration-advice reconciliation.

### Bug fixes
- Auto-mode halt sites in coverage gate and pipeline._gateConfirm now consistently throw the structured HaltError class (extracted to src/orchestrator/core/halt-error.js to avoid the pipeline.js → coverage.js circular import). External behavior unchanged — same exit semantics — but callers wanting `instanceof HaltError` detection now work uniformly across all halt sites.
- Corrects v0.1.54 migration advice: that release's CHANGELOG referenced `--skip-<class>` flags as a bulldoze-intentional workaround, but no such CLI flags exist (`skipReview` is a Pipeline opts field only). Correct guidance: under auto-mode, when a Category B/C halt fires, re-run interactively or fix the underlying failure. Per-class skip flags are a Phase III feature and not yet implemented.

## [0.1.54] - 2026-05-04 — Delivered Milestone 001: y/n/auto plan-approval menu and unified auto-mode safety semantics with category-based gating across all prompt sites and CLI entry points.

### Breaking changes
- --auto flag now halts with exit code 77 on Category B/C failures instead of silent bulldoze; TTY mode prompts for explicit override

### New features
- Implemented y/n/auto three-option plan-approval menu replacing binary y/n prompt, allowing users to enable auto-approval from the plan review stage
- Introduced category-based gating semantics: Category A sites auto-resolve under auto-mode, Category B/C sites halt and require explicit confirmation in interactive mode or exit with code 77 in non-TTY
- Added halt-y re-confirm prompt ('Continue in auto mode? [y/n]') after user overrides a halt site, allowing explicit re-opt-out from auto-mode mid-run
- Auto-mode state (autoFromHere flag) now persists across batch queue iterations without reset, ensuring consistent behavior for multi-spec runs
- Extended auto-mode support to milestone and scenario coverage checks with Category B gating that halts on non-TTY or prompts interactively on TTY
- Implemented effectiveMode threading for assumption remediation to suppress interactive prompts when auto-mode is active
- Updated --auto flag help text to document Category B/C halt-on-failure semantics and exit-77 behavior
- Unified auto-mode semantics across all 5 CLI entry points (run, task, resume, dry-run, webhook) and in-run menu choice, ensuring identical behavior regardless of activation path

## [0.1.53] - 2026-05-04 — Completed v0.1.52 reviewer follow-ups: documented -P flag and reconciled Finding #32 classification.

### Bug fixes
- Reconcile Audit Finding #32: reclassify from at-risk to idempotent-on-replay with supporting stat updates

## [0.1.52] - 2026-05-04 — Successfully completed Phase II cleanup milestone: archive --preserve flag, log wrapping infrastructure, and recovery atomicity audit

### New features
- Archive --preserve flag for opt-in spec file retention at project root after archiving
- Log wrapping with terminal-aware width detection, soft margins, and hanging indents for pipeline dashboard, assumption-fix prompts, and mission banners
- State-machine recovery atomicity audit document: 37 write/dispatch pairs classified (0 atomic, 18 idempotent-on-replay, 19 at-risk) with prioritized fix order by blast radius

## [0.1.51] - 2026-05-03 — Delivered assumption-phase routing milestone with schema-tagged verifier dispatch to prevent remediation loops.

### New features
- Schema refactoring from `revised: string` to `revisedAssumptions: Array<{text, phase, specSection}>` in assumptionRemediationSchema with phase enum enforcement
- Verifier dispatch routing: phase-based partitioning separates invariant assumptions (verified via grep) from post-fix assumptions (synthetic deferred status without session spawn)
- Tense-disciplined remediation prompts enforcing present-tense for invariant and future-tense for post-fix with Good/Bad examples and assumption splitting
- Pipeline deferred-assumption tracking: [DEFER] logging, postFixAssumptions stashing to globalPlan, and icon rendering for deferred status in both interactive and autonomous paths
- Interactive UX updates: askAssumptionFix displays revisedAssumptions as numbered list with [invariant]/[post-fix] phase tags, edit mode targets individual items by number (e1, e2, etc.)
- Test suite migrations and new phase-routing tests: 95 total tests pass including 8-test suite validating verifier partition logic and 2026-04-21 regression scenario

### Bug fixes
- Fixes 2026-04-21 status-bar-bugfix remediation escalation by preventing post-fix assumptions (e.g., will gate render) from being verified against current codebase state

## [0.1.50] - 2026-05-03 — Delivered reviewer scope-compliance check to surface scope misalignment in milestone execution

### New features
- Reviewer scope-compliance check: evaluates whether milestone modifications align with specification goals. Deterministically computes out-of-scope files from task declarations; reviewer LLM judges semantic alignment with spec. Renders scope warnings (exceeded scope) and info (insufficient scope) in digest, independent of pass/fail verdict. Advisory-only, backward-compatible.

## [0.1.49] - 2026-05-03 — Completed milestone 001 with three surgical bugfixes: batch-resume guard bypass, per-agent elapsed ticker, and autoMode cleanup

### Bug fixes
- Batch-resume command now bypasses unresumable-state guard with --batch flag, enabling execution on post-dry-run state shapes with pending queue entries
- Per-agent elapsed ticker now starts during planning and verification phases, displaying live elapsed time instead of frozen 0s
- Removed dead autoMode parameter spread from Pipeline constructor call

## [0.1.48] - 2026-05-03 — Delivered milestone 001: sequential ordering flag and deterministic hard-dependency chain synthesis

### New features
- Add optional `ordering` enum property to sub-missions in missionDecompositionSchema for specifying sequential vs. parallel task execution
- Planner system prompt now includes guidance on when to use `ordering: 'sequential'` with Good/Bad examples
- Introduce _enforceSequentialOrdering post-processor that synthesizes hard-dependency chains for sequential sub-missions

## [0.1.47] - 2026-05-03 — Delivered isStub marker propagation and consumer guards for regression-verifier path

### New features
- Add isStub marker propagation through regression-verifier path to distinguish stub verdicts (verifier timeout/missing structured_output) from genuine FAILED verdicts
- Prepend stub warning banner to on-disk regression reports when verdict is a stub, alerting users to synthetic verdict origin

### Bug fixes
- Add consumer guards in _missionRegression to prevent wasted budget by rejecting stub verdicts before entering autonomous remediation loops
- Fix const-to-let bug in regression.js enabling safe stub banner prepend operation

## [0.1.46] - 2026-05-03 — Delivered automatic R2 audit gate for test:all via pretest:all lifecycle hook and added 4 unwired test files to suite.

### New features
- Added audit:r2:strict wrapper script that maps exit code 2 (schema-coverage warnings) to 0 while preserving exit 1 (hard violations) as a hard block
- Wired audit:r2 enforcement as pretest:all npm lifecycle hook to automatically block test:all on structural violations
- Appended 4 previously-unwired test files to test:all chain: test-auto-cli-plumbing.js, test-auto-mode.js, test-reviewer-guard-zero-findings.js, test-scheduler-replan-persistence.js

## [0.1.45] - 2026-05-03 — Delivered milestone 001 with all 6 tasks complete: anchor-to-symbol defenses eliminate hardcoded line numbers from planner task descriptions

### New features
- Planner now enforces anchor-to-symbol pattern: buildMissionSystemPrompt and buildReplanSystemPrompt require all task descriptions to reference concrete symbols (function names, file paths, class names) instead of hardcoded line numbers
- Added _warnIfVagueDescriptions helper that flags task descriptions containing potential line-number references (matching /\.[a-z]{1,5}:\d+/i) for operator visibility and regression detection without blocking execution
- Added 7 comprehensive test cases validating anchor-to-symbol rule enforcement, replan prompt mirroring, and _warnIfVagueDescriptions behavior with proper edge-case handling and robustness checks

## [0.1.44] - 2026-05-02 — Completed milestone 001: reviewer-gate zero-findings escalation with comprehensive test coverage

### New features
- Reviewer-gate zero-findings escalation: immediately escalate to human when reviewer returns failures with zero critical findings, preventing vacuous retry loop consumption
- Added isStub marker to reviewer.js SDK-fallback stub path to distinguish SDK failures from validation failures
- Added zero-criticals guard in pipeline.js with branched diagnostics differentiating SDK errors from validation/warnings-only failures
- Comprehensive test coverage for zero-findings guard: 6 test scenarios covering stub-path, warnings-only, empty findings, critical-present, passed-reviewer, and multi-attempt cases

## [0.1.43] - 2026-05-02 — Completed Milestone 001: scheduler replan attempts now persist across resumes

### New features
- Scheduler constructor now hydrates replan attempt counts from state.json with defensive parsing and error handling
- replaceTask() now persists replan attempt counts to state.json after incrementing, enabling cap enforcement across process boundaries
- Added test-scheduler-replan-persistence.js with 7 comprehensive test cases covering hydration edge cases and cross-process persistence scenarios

## [0.1.42] - 2026-05-02 — Delivered milestone 001: --auto flag now bypasses assumption-fix prompt via autonomous mode in pipeline.

### New features
- Wired --auto CLI flag through pipeline to bypass assumption-fix prompt in autonomous mode, enabling automated batch flows without stdin interaction
- Added comprehensive test suite covering auto mode CLI plumbing (2 tests) and pipeline integration (4 tests) to verify --auto flag propagation and autonomous/interactive mode selection

### Bug fixes
- Corrected stale JSDoc in _remediateAssumptions to accurately describe autonomous mode as auto-accepting all planner-proposed fixes via _applySpecEdit, removing false Levenshtein similarity threshold claims

## [0.1.41] - 2026-05-01 — Shipped unresumable-state guard for resume command to prevent silent-complete failures

### New features
- Exit code 76 distinguishes unresumable-state resume failures from infrastructure errors (75) and generic resume errors (1)

### Bug fixes
- Resume command now detects and refuses unresumable state (planning phase crashed before milestones) with clear error message and recovery instructions, instead of silently completing with no work done

## [0.1.40] - 2026-05-01 — Completed milestone 001 with all 4 tasks passing: shipped reviewer digest rendering and task-specificity planner instruction improvements.

### New features
- Added _renderReviewerDigest() method to Pipeline class rendering clean, scannable digest boxes for reviewer results with three output modes (FAILED boxed, PASSED-with-warnings boxed, clean PASS single-line) and 80-character description truncation with ellipsis.
- Added test/test-reviewer-digest.js with comprehensive test suite for reviewer digest rendering covering FAILED with critical findings, PASSED with warnings, clean PASS, and 80-character truncation scenarios.
- Enhanced planner task-specificity instruction in buildMissionSystemPrompt() with 7-line instruction block directing explicit, independently verifiable deliverables (e.g., 'Write TC1: empty queue returns {archived:0}') instead of vague lists.
- Added test/test-planner-prompt.js validating task-specificity instruction keywords ('independently verifiable', 'explicit deliverables') appear in buildMissionSystemPrompt but not in buildGlobalSystemPrompt.

## [0.1.39] - 2026-05-01 — Milestone 001 complete: delivered HTML run reports, cumulative changelog, and --report flag with comprehensive test coverage.

### New features
- HTML run reports with inline CSS summarizing each archive: header with seq/headline/date/cost/sessions, goal section, files changed, milestone status, cost breakdown by session type, test coverage with task statuses, and reviewer findings with severity badges
- RUNS.md cumulative changelog prepending new entries (seq, headline, date, cost, sessions, changelog items, report link) with 20-entry history limit
- Archive integration calling generateRunReport and updateRunHistory after successful archiving with individual error handling that logs warnings but continues on failure
- CLI --report flag support opening generated HTML reports via open (macOS) or xdg-open (Linux) with detached process handling
- Comprehensive test suite with 20 passing tests covering report generation, changelog management, file I/O, data gathering, HTML rendering, edge cases, and CLI flag handling

## [0.1.38] - 2026-05-01 — Completed milestone 001: wired verifier failure evidence into executor retry path with full test coverage and R2 audit invariant.

### New features
- Executor retry prompts now include previous attempt failure evidence. When a task is retried after verification failure, the executor's prompt includes a '## Previous attempt failed verification' section with structured failure descriptions and evidence to guide the next attempt.
- Added R2 audit pair-invariant rule 're-dispatch log requires previousFailures' to ensure retry-evidence wiring consistency between pipeline re-dispatch logs and executor previousFailures context wiring.

## [0.1.37] - 2026-04-29 — Defect #18: reviewer-gate accepts `re_plan` recommendation (routes to remediation retry)

### Bug fixes
- **Reviewer-gate threw on analyzer `re_plan` recommendation (Defect #18)**: the analyzer schema (`_schemas.js:84`) permits `recommendation ∈ {retry, re_plan, human}`, but `pipeline.js:1123` only accepted `'retry'` for the milestone reviewer-gate path. `'human'` was handled at line 1114; `'re_plan'` fell through to a generic "Unexpected analyzer recommendation" throw and halted the run. Surfaced 2026-04-29 mid-batch when the milestone reviewer caught a real composition bug in `run-report.js` (calling `getDiffSummary` after the archive directory was created) and the analyzer recommended `re_plan`. The fix tasks needed to address that finding existed structurally — only the gate was wrong.
- **`pipeline.js _executeMilestone` reviewer-gate**: now accepts both `'retry'` and `'re_plan'`, both routing through the existing per-mission `planner.remediateReviewFindings` + `mergeRemediationTasks` + reviewer re-run path. At reviewer-gate scope the synthetic taskId is `reviewer-${msId}` — there is no real task to re-decompose, so `re_plan` and `retry` reduce to the same downstream action: generate fix tasks from `criticalFindings` and re-run the reviewer. Bounded by `reviewMaxRetries` (default 2) + the existing post-remediation hard-stop at line 1221. Original recommendation logged via `Treating reviewer-gate 're_plan' as remediation retry` so the analyzer's signal is not silently lost.

### Tests
- Extended `test/test-review-remediation-routing.js`:
  - TC7 — analyzer recommendation `'re_plan'` at reviewer-gate routes through `remediateReviewFindings` (defect #18 regression)
  - TC8 — `'human'` recommendation still throws (regression guard for TC7)
- Existing TC1–TC6 unchanged — confirms `'retry'` path still works identically.

### Notes
- Discovered via A+B agent verification of fix plan. Agent A (FAIL) argued the task-level `re_plan` path consumes `analysis.structured` via `planner.replanTask`, and the reviewer-gate path drops that payload. Agent B (PASS) argued the analyzed "task" at reviewer-gate is the synthetic `reviewer-${msId}` — there is nothing to re-decompose, and `criticalFindings` IS the source of truth that `analysis.structured` is derived from. B's reasoning prevailed: the impedance mismatch A implicitly advocated for (preserving task-level surgery) is exactly what we ruled out at decision time — at reviewer-gate, all tasks are `complete`, and `replaceTask` requires `failed`/`awaiting_verification`. Wiring task-level `replanTask` here would require new state-machine transitions; the cost-benefit favors the minimum unblock.
- Considered options at decision time: (A) treat as retry — chosen; (B) per-task `replanTask` surgery — rejected (state-machine impedance, file→task ambiguity); (C) full mission re-plan — deferred (no recurring evidence yet). If reviewer-gate `re_plan` recurs after fix tasks repeatedly fail to address structural issues, promote to (C) — see TODO entry "Reviewer-gate `re_plan` promotion to mission-level re-plan".
- JS-deterministic per `decisions.md:130`: no schema change, no analyzer prompt change, no planner method change. One-line guard relaxation + one log line.

## [0.1.36] - 2026-04-29 — Defect #17: phantom-write routes to verifier-as-probe (no retry); redundant tasks → invalidated

### Bug fixes
- **Phantom-write retry waste + dead-end (Defect #17)**: when v0.1.32's SHA-256 phantom-write guard fired, the previous behavior was to retry up to `maxRetries` times then circuit-break to analyzer (which typically recommended `human`). But phantom-write is *deterministic* — re-running the executor with the same task description against the same code produces the same SHA-256 match every time. Retry was structurally wasteful. Surfaced 2026-04-29 mid-batch when planner-emitted redundant task `001-004-001-003` (sibling task already added the tests it asked for) hit phantom-write 4× → circuit-breaker → analyzer:human → halt. Pipeline cost ~$5 + ~5min wasted per occurrence.
- **`pipeline.js _executeAndVerifyTask`**: when phantom-write fires (`!diff.ok`), now routes to verifier as a no-op disambiguation probe instead of retrying. New flag `phantomWriteProbe` hoisted to function scope so the verifier-PASS / verifier-FAIL branches can branch on it. Skip `transitionTask('failed')` on probe path (was illegal: `failed → awaiting_verification` not in state-machine transitions per `state-machine.js:96`).
- **Probe-PASS branch**: when verifier confirms goal state holds (sibling work satisfied it), task transitions to `invalidated` (not `verified`/`complete`). `invalidated` is already a legal terminal state per `state-machine.js:93,99`. Auto-excludes the redundant task from mission/milestone regression aggregation downstream. Also emits `console.warn('[phantom-write-probe] Redundant task: ...')` so retros can detect planner over-decomposition patterns.
- **Probe-FAIL branch**: when verifier disagrees with goal state (executor genuinely lied), analyzer dispatched once with `failureType: 'execution'`. Skip retry (deterministic failure), skip `_captureLastFailed` (no edits → `last-failed/` would equal `before/`, zero diagnostic value), skip `restoreSnapshot` (nothing to restore).

### Tests
- Extended `test/test-phantom-write-guard.js` with 7 new pipeline-level integration tests (TC-PW-PROBE-1..7):
  - TC-PW-PROBE-1: probe-PASS → task `invalidated`, no retry, no analyzer, WARN logged
  - TC-PW-PROBE-2: probe-FAIL → analyzer once, no retry, no `_captureLastFailed`
  - TC-PW-PROBE-3: verifier throws `InfrastructureError` → propagates
  - TC-PW-PROBE-4: state-transition `in_progress → awaiting_verification → invalidated` (no `failed` intermediate on probe-PASS)
  - TC-PW-PROBE-5: empty `affectedFiles` + empty `targetFiles` → vacuous PW skip preserves existing behavior (verifier path, ends at `complete`, NOT probe path)
  - TC-PW-PROBE-6: non-PW verifier-FAIL still retries (regression guard — gate must not affect non-probe path)
  - TC-PW-PROBE-7: verifier throws non-Infra Error → propagates
- Existing helper-level TC-PW-1..7 still pass (`assertChangesLanded` unchanged).

### Notes
- Discovered via A+B agent verification of fix plan. Agent A caught state-machine bugs in initial plan: `transitionTask('failed')` would have blocked next transition; `phantomWriteProbe` flag needed to be hoisted outside the `!skipExecutor` block to be visible at verifier-FAIL gate; `_captureLastFailed` and `restoreSnapshot` needed conditional skip. Agent B caught the bigger semantic issue: marking probe-PASS task as `verified` was misleading ("verifier confirmed goal state" ≠ "executor's work was verified"); switched to `invalidated` per B's recommendation. B also flagged that verifier-as-probe may FAIL more often than expected because verifier prompt assumes executor just ran — true risk, but mitigated by the fix being net-better than current (always-halt) behavior. The progress sidecar's lie about `affectedFiles` becomes inert because downstream consumers should check status before reading affectedFiles, and `invalidated` excludes the task from aggregation paths.
- Existing v0.1.32 SHA-256 detection logic in `assertChangesLanded` unchanged. Only the *reaction* to phantom-write changes. No schema change. No prompt change to executor or verifier. JS-deterministic per `decisions.md:130`.
- Known follow-up: planner over-decomposition is the root upstream cause. The probe-PASS WARN log + `[phantom-write-probe]` console.warn give retros a discrete signal to spot patterns; planner improvement is separate work.

## [0.1.35] - 2026-04-28 — Defect #16: readTaskStatus rejects replan-suffixed task IDs (`-rp-NNN`)

### Bug fixes
- **`readTaskStatus` strict-segment-count guard rejected `-rp-NNN` replan-suffixed IDs (Defect #16)**: v0.1.31's defensive throw counted dash-separated segments and required exactly 4. This was correct for catching malformed IDs like `"fix-001"` but unintentionally rejected the existing replan-suffix convention from dogfood 20 (commit `1bc9265`): replanned tasks have IDs like `"001-001-001-001-rp-001"` (6 segments). Surfaced 2026-04-28 mid-batch when scheduler.replaceTask correctly created `001-003-001-001-rp-001` after a circuit-breaker → analyzer recommended `re_plan` → readTaskStatus threw on the new ID → batch halted. Pre-existing TODO entry "Preflight regex rejects replan-suffixed task IDs" documents the same bug class in `preflight.js`; this fix is the `state.js` sibling.
- **`src/orchestrator/core/state.js readTaskStatus`**: now strips optional `-rp-NNN` suffix via `taskId.replace(/-rp-\d+$/, '')` before counting segments, then enforces 4-segment count on the canonical ID. Replan-suffixed IDs like `"001-001-001-001-rp-001"` strip to `"001-001-001-001"` and pass. Malformed `-rp-X` (non-numeric N) doesn't match the strip regex and falls through to the segment-count check, throwing. Test-fixture-style non-numeric segments like `"001-001-001-cost1"` continue to work — segment-count check restored without the over-strict 3-digit-per-segment regex from my initial attempt at this fix. Format-level enforcement of 3-digit segments belongs in schema validation (`_schemas.js`), not in this layer.

### Tests
- New tests in `test/test-read-task-status-guard.js`:
  - TC-RTS-4 — valid `-rp-NNN` replan-suffixed id does not throw
  - TC-RTS-5 — malformed `-rp-X` (non-numeric N) throws
  - TC-RTS-6 — non-numeric 4-segment id (test fixture style like `"001-001-001-cost1"`) does not throw
- Existing TC-RTS-1, TC-RTS-2, TC-RTS-3 still pass (3-segment throws, 5-segment throws, valid 4-segment passes).

### Notes
- This is an R2-callsite-audit miss when v0.1.31 #11 shipped. The strict-segment check was added to catch malformed planner output, but a grep across `src/` for existing task-ID handling code would have surfaced `scheduler.js`'s `-rp-NNN` convention. The R2 enforcer's pair invariants don't catch runtime-convention drift like this — only static call-site/schema-coverage relationships. Filed as enforcer enhancement candidate: detect "schema/format constraint added; existing convention regex elsewhere".
- Initial fix attempt was too strict (`^\d{3}-\d{3}-\d{3}-\d{3}(-rp-\d+)?$`) and broke 4 status-bar-integration tests using fixture IDs like `"001-001-001-cost1"`. Caught by full-regression suite before commit; corrected to strip-then-count-segments approach.

## [0.1.34] - 2026-04-28 — Defect #15: batchResume + resume now invoke archive() to actually persist runs to disk

### Bug fixes
- **Missing archive() call in batchResume() and resume() (Defect #15)**: `pipeline.js batchResume()` and `pipeline.js resume()` previously logged "Entry '<slug>' archived successfully" after the review gate without ever invoking the `archive()` function from `cli/commands/archive.js`. Result: queue entries were correctly removed and the harness wiped on next iteration via `bootstrap(force=true)`, but no `archives/{seq}/` directory ever persisted, no version bump, no CHANGELOG prepend, no manifest. Multi-spec batch runs always silently dropped both archives. Single-spec resume() had the same gap, papered over by users manually running `cc-orch archive` after each pipeline. Surfaced 2026-04-28 during E-sprint smoke-test of `2026-04-15-run-report-changelog.md` + `2026-04-15-ux-improvements.md`: terminal output reported both archived successfully, on-disk archives 024/025 never appeared.
- **`pipeline.js batchResume()`**: now calls `await archive(this.projectRoot, entry.slug, { auto: true })` between `_reviewGate({})` and `removeQueueEntry()`. Bootstrap now passes `prdPath: specPath` so `state.projectMeta.prdPath` is set to `queue/{slug}/spec.md`, allowing archive() to read spec content correctly. Throws if archive returns undefined (validation failure).
- **`pipeline.js resume()`**: now calls `await archive(this.projectRoot, null, { auto: true })` after `_reviewGate({})`. Auto-mode is implied because resume is non-interactive post-review-gate.

### Tests
- New R2 pair invariant in `scripts/audit-r2.js`: "every `archived successfully` literal must be preceded by an `await archive(...)` call in the same file." Mechanizes the discipline at audit time so this bug class can't reintroduce silently. Same shape as the v0.1.32 `verifyTask requires writeVerifyJson` invariant.
- Existing test `test/test-batch-resume.js` overrides `pipeline.batchResume` with a parallel stub, which is why the bug went undetected — tests exercised the stub, not the real code. Filed as test-design follow-up; existing tests still pass.

### Notes
- Architectural smell flagged: `pipeline.js` (orchestrator core) now imports `cli/commands/archive.js` (CLI command). archive() should be extracted into `core/archive.js` with the CLI command as a thin wrapper. Refactor candidate, not blocking.
- Discovered via A+B agent investigation. Agent A correctly identified the missing `archive()` call as primary root cause. Agent B's "the framing is wrong; spec 1 never ran" was incorrect — terminal output is real evidence that the pipeline executed both specs end-to-end. B's secondary findings (append-only run-event log, atomic archive ordering, version-stamp on every state mutation) are filed as separate improvements.
- Closes the silent-data-loss class for batch flows. The user's North Star metric ("batch of 5 docs → 5 verified working projects, no human intervention after spec approval") was structurally unreachable until this fix; manual `cc-orch archive` after each batch entry was the hidden human-in-the-loop step.

## [0.1.33] - 2026-04-26 — Completed Milestone 001: review-remediation mission routing fixed to dispatch findings to owning missions

### New features
- Exported buildFileToMissionMap utility function from state.js to determine which mission owns each file based on task targetFiles
- Added diagnostic warning logging when mergeRemediationTasks encounters tasks with unknown subMissionId, showing task ID and fallback resolution

### Bug fixes
- Review-remediation findings now resolve to and route to the mission that owns the affected files, instead of always routing to the alphabetically-first mission

## [0.1.32] - 2026-04-26 — Defect #13: regression-task verify.json stub — fixes false-FAIL when mission/milestone regression manufactures a "file does not exist" hardCheck

### Bug fixes
- **Regression-task verify.json stub (Defect #13)**: `verifyMission` and `verifyMilestone` in `gates/regression.js` synthesize ad-hoc tasks (`regression-{missionId}`, `regression-milestone-{milestoneId}`) that bypass the executor's `writeVerifyJson()` write. The verifier prompt at `verifier.js:104,112,117` instructs the model to "Read the verify.json file" with the absolute path interpolated — when the file is missing the model manufactures a "file exists" hardCheck and returns FAILED, even when the actual functional check (10 taskScopeChecks PASS, npm test 39/39 PASS) succeeded. Fix: regression.js now calls `writeVerifyJson(harnessDir, task)` from `core/state.js` before invoking `verifier.verifyTask`, with the synthetic task carrying empty `hardChecks` and `testCases` arrays. Verifier prompt rule "result PASSED only if every hardCheck passes" becomes vacuously satisfied; the actual functional check (driven by `context.purpose`) survives unchanged. Same fix applied to milestone-level regression. Discovered during v0.1.31 self-host attempt of `2026-04-15-ux-improvements.md`.

### Tests
- New `test/test-regression-stub.js` (4 tests): TC-RS-1 verifyMission stub-write at expected path; TC-RS-2 stub shape matches `writeVerifyJson` contract; TC-RS-3 verifyMilestone stub-write; TC-RS-4 path-parity with `verifier.js:104` so future drift between writer and reader is caught.

### Notes
- Known follow-up (out of scope): the deeper structural mismatch — `verifier.verifyTask` is hard-coded around the per-task `verify.json + targetFiles` contract, and reusing it for mission/milestone regression violates that contract (`targetFiles=[]`, prompt step 3 "Inspect targetFiles" is vacuous). A dedicated `verifier.verifyRegression()` method with regression-specific prompt + schema would be more robust; surfaced as Defect #13.5 / candidate for a future spec.

## [0.1.31] - 2026-04-26 — Shipped Defect #11 fix: deterministic task-ID normalization for review remediation with full test coverage.

### Bug fixes
- Add regex pattern validation support to validateStructured in _schemas.js, enabling schema constraints on string field formats
- Require subMissionId in reviewRemediationSchema and enforce 4-segment task ID format via regex pattern validation
- Add ID normalization in mergeRemediationTasks (coverage.js) to convert malformed task IDs to hierarchical format with collision avoidance before disk write
- Add defensive error throw in readTaskStatus (state.js) when task ID doesn't have exactly 4 segments, preventing silent failures

## [0.1.30] - 2026-04-26 — Defect #9: onLog auto-renders bar when called before first _render
<!-- r2-exempt: internal render-state guard in status-bar.js; no cross-file pair pattern -->

### Bug fixes
- **`onLog` defensive auto-render (Defect #9)**: when `_renderedLines === 0` (bar enabled but never rendered), `onLog` now invokes `_render()` first, making the contract explicit — `onLog` is safe to call at any point regardless of whether the bar has been rendered yet. Without this guard, pre-render logs landed at the terminal's bottom row and flashed visibly before the bar overlaid them on the next debounced render. Caller-order dependency removed.

### Tests
- New regression scenario `S23` in `test/test-status-bar-terminal.js`: asserts that `onLog` with no prior `_render` (a) auto-renders the bar (top + bottom borders contain `═`), (b) message lands in the scroll region above the bar, (c) message does NOT land inside the bar's footprint.

### Notes
- Confirmed via Round 1 paired A+B agent verification (2026-04-26). B explicitly identified the bar-height-zero scenario as a real (not theoretical) hazard during the v0.1.28 evaluation; this commit closes it.

## [0.1.29] - 2026-04-26 — Defect #7: batch-loop residual harness state (mission JSON + snapshots)

### Bug fixes
- **`bootstrap(force=true)` now wipes 7 stateful subdirs (Defect #7)**: `state/`, `plan/`, `verify/`, `progress/`, `verification/`, `analysis/`, `snapshots/`. Previously only `state.json` was overwritten; subdirs from the prior run survived intact, causing two related corruption modes:
  - **Mission state collision**: `batchResume` between queue entries left stale `state/mission-*.json`. The next spec's `_executeAllMilestones` found these via `isMissionAlreadyStarted` and short-circuited decomposition — milestone description matched spec B but mission task lists matched spec A. Caught only by milestone-regression, after waste.
  - **Snapshot collision**: `snapshots/{taskId}/before/` indexed by deterministic taskIds (`001-001-001-001` repeats across specs). If spec B's first task hit retry, `restoreSnapshot('before')` could silently restore spec A's baseline files into the working tree.

  Both fixed by the same wipe. `learning/` (user-curated cross-run baseline) and `dry-run/` (separate code path) are preserved.

### Tests
- Inverted `test-bootstrap.js` "force=true preserves subdir contents" test — now `'force=true wipes stateful subdirs (defect #7 fix)'` asserts each of the 7 subdirs is empty after `force=true`, while `learning/` and `dry-run/` content survives. Pre-seeds all 7 subdirs (including a `snapshots/{taskId}/before/foo.txt` simulating the snapshot-collision risk) to verify the wipe.
- New `'force=true on fresh harness ... does NOT wipe — only force-on-existing wipes'` test covers the wipe gate (`alreadyExisted && force`, not `force` alone).

### Notes
- Confirmed via paired A+B agent investigation (2026-04-26). A originally recommended wiping 6 subdirs and leaving `snapshots/` alone; B caught that snapshot-collision is a real silent corruption risk (deterministic taskIds collide across specs) and expanded the wipe set to 7.
- Approach B (call `archive()` between batch entries) was rejected: archive() spawns the Summarizer LLM agent (~$0.20, ~30s per spec), bumps version, prepends CHANGELOG, and deletes spec from project root — heavy side effects unsuitable for inter-batch cleanup. If per-spec archives across a batch ever becomes desirable, that's a separate proposal.

## [0.1.28] - 2026-04-26 — Defect #6: onLog overflow protection (no DECSTBM bottom-margin escape)
<!-- r2-exempt: terminal rendering overflow guard; internal to status-bar.js, no cross-file pair pattern -->

### Bug fixes
- **status-bar.js onLog overflow protection (Defect #6)**: split incoming `text` on `'\n'` and truncate each segment to `(cols - 1)` before emitting, preventing two distinct overflow modes that previously clobbered bar rows:
  - **Embedded `\n`** (common via `_formatBanner(...).join('\n')` from pipeline.js): VT100 only scrolls DECSTBM on LF/index AT bottom margin INSIDE the region. A `'\n'` at scrollBottom advances cursor to scrollBottom+1 (bar territory) without scrolling; subsequent `'\n'`s land on bar rows.
  - **Auto-wrap (DECAWM)**: a segment longer than terminal width pushes cursor to next physical row past DECSTBM bottom margin.
  Both modes confirmed via paired A+B agent xterm-headless repro (2026-04-26 investigation). User-visible symptom: bar disappeared during prompts and banner-heavy pipeline output (e.g. "Approve and queue this spec?" after full plan emission).

### Tests
- New regression scenario `S22` in `test/test-status-bar-terminal.js`: asserts bar rows survive (a) embedded-`\n` message, (b) `>cols` message, (c) 10 combined banners stress test.

## [0.1.27] - 2026-04-26 — Defect #2 phantom-write recovery + Defect #3 scheduler stall message + prompt double-emit consolidation
<!-- r2-exempt: UI text framing change; no file-level structural pair pattern -->

### Bug fixes
- **Phantom-write recovery (Defect #2)**: when a task hits its circuit breaker, capture a `last-failed/` snapshot of the union of `task.targetFiles` and `progress.affectedFiles` BEFORE the existing `restoreSnapshot('before')` wipes attempt N's writes. Three sites in pipeline.js now invoke a new `_captureLastFailed(task)` helper. Disk surface unchanged (failed tasks still don't pollute working tree); diagnostic snapshots survive in `.harness/snapshots/{taskId}/last-failed/` for forensics.
- **Scheduler stall accurate halt message (Defect #3)**: when a non-infra task error sets `firstError` and the assignment-loop gate blocks dispatch of pending siblings, the throw site now produces "Milestone halted: task X (\"description\") failed: \<underlying error\>. N task(s) were pending and not dispatched: \<ids\>" instead of the misleading "Scheduler stall: ... unmet dependencies on a failed/blocked task". Genuine dep-stall case (no firstError) keeps original message. Plain Error, no structured fields, no schema change.
- **prompt.js double-emit removed (already shipped at f462147)**: readline's natural echo + DECSTBM scroll-up provide transcript persistence; v0.1.25's explicit `statusBar.onLog(question + answer)` was redundant and produced two visible "Proceed? (y/n) y" rows per prompt. v0.1.27 consolidates the version bump.

### Tests
- New `test/test-snapshots-integration.js` (3 tests): verification-FAILED, executor-BLOCKED, revalidation-FAILED paths each capture `last-failed/` correctly with project tree restored.
- New `stall-message-content` test in `test/test-scheduler.js`: 5 assertions covering failing task ID, underlying reason text, pending IDs, no "unmet dependencies" framing, plain Error class.
- Updated `test/test-small-task.js` SKIP regex to tolerate both old "Scheduler stall" and new "Milestone halted" message framings (per Defect #3 spec's regression-gate guidance).
- New `test/test-write-verify-json.js` (5 tests) and `test/test-hard-checks-integration.js` (4 tests) from prior dogfood 33 hardChecks runtime gate now wired into `test:all` chain.

### Notes
- Defect #3 was hand-implemented after cc-orch's batch-run flow exhibited a NEW defect class (#7 candidate, not yet fixed): "batch-loop residual mission state" — `bootstrap(force:true)` between queue entries truncates state.json but leaves `.harness/state/mission-*.json` files from the prior spec's run, causing `isMissionAlreadyStarted` to short-circuit decomposition for the new spec. Surfaced via spec-mixup investigation (A + B agent verification).
- Defect #2 implementation was successfully produced by cc-orch's executor before the batch-loop residual-mission-state defect manifested. Code preserved verbatim.

## [0.1.26] - 2026-04-25 — Delivered milestone 001: hardChecks runtime gate unblocked with writeVerifyJson preservation and comprehensive test coverage

### New features
- Added comprehensive test coverage for hardChecks passthrough: 5 unit tests and 4 integration tests validating end-to-end roundtrip behavior, integrated into npm run test:all

### Bug fixes
- writeVerifyJson now preserves task.hardChecks instead of hardcoding empty arrays, unblocking the verifier runtime hard-gate

## [0.1.25] - 2026-04-26 — Status bar v3.2 bug bundle (manual recovery): bottom-anchored onLog, prompt transcript line, barHeight-change handling, full-width line padding

### New features
- onLog single-path: removed fill-from-top branch in status-bar.js; every log lands bottom-anchored at scrollBottom via DECSTBM scroll-up, regardless of region fill state (Bug 3).
- First-render cursor positioning: `_setupScrollRegion` now emits DECSTBM + scroll-up-by-N + MOVE_TO(scrollBottom, 1) so the first onLog after construction lands just above the bar instead of at row 1 of the terminal (Bug 1).
- Prompt transcript line: askYesNo and askMenu emit `statusBar.onLog(question + ' ' + rawAnswer)` before promptDidEnd, so the prompt + user's answer becomes a permanent log row in the scroll region (Bug 4).
- Pipeline → prompt plumbing: Pipeline constructor wraps user-supplied onConfirm/onMenu closures to inject `{ statusBar: this.statusBar }` automatically; askAssumptionFix call also forwards statusBar; CLI command closures (run/resume/task/dry-run) accept and forward askOpts (Bug 4).
- BarHeight-change handling: `_render` detects barHeight delta vs `_renderedLines`, clears the union of old/new bar footprints, and resets `_scrollRegionActive=false` so DECSTBM re-emits with correct bounds (Bug 5).
- Full-width line padding: `_buildLines` applies `.padEnd(w)` to header / `(no active agents)` / `+N more agents`; `_buildAgentRow` and `_buildProgressLine` pad internally to width so callers always receive a width-length string (Bug 5).
- Drift gap removed: auto-fixed by the onLog single-path change (Bug 6).

### Tests
- New regression scenario S21 in `test-status-bar-terminal.js`: prompt+answer transcript line is visible in scroll region after promptDidEnd, scrolls up under subsequent onLog.
- S1 rewritten from dogfood-30-era fill-from-top assertions to bottom-anchored: A/B/C land at scrollBottom-2..scrollBottom; rows 0..(scrollBottom-3) blank pre-overflow.
- S3 comment updated to describe bottom-anchored scroll-region semantics.
- New PAD-TC1..4 in `test-status-bar.js` covering `_buildLines`, `_buildAgentRow`, `_buildProgressLine` (numeric and phase modes).
- Removed dead `sb._logRow = scrollBottom` test set; field no longer exists in source.

### Notes
- Bug 2 (clear-screen on bar startup) implemented as `\x1b[{scrollBottom}S` (region scroll-up) instead of `\x1b[2J`. Visible viewport is empty as required by spec, but pre-startup content lands in scrollback rather than being erased — preserves Dashboard / pre-bar output the user may want to scroll back to. Documented at status-bar.js:317.

## [0.1.24] - 2026-04-25 — Delivered schema-enforced task ID citation to prevent prior-release feature leakage in summarizer changelog

### New features
- Added required `taskIds` array field to summarizerSchema.changelog items with minItems:1 and minLength:1 constraints, enforcing citation of task IDs from the current run
- Summarizer now receives completedTasks array containing only id and description fields, built from mission state files to enable task-based changelog citation
- Added '## Completed Tasks' section to summarizer prompt with explicit instruction: every changelog item must cite one or more task IDs from the current run, preventing citation of prior-release tasks
- Implemented post-parse citation validation in extractSummary that filters changelog items to drop those citing unknown task IDs, with warning logging and droppedChangelogCount tracking
- Added comprehensive test coverage including schema constraint validation, completedTasks enrichment tests, citation filter unit tests, multi-task citation tests, and prior-release regression test

## [0.1.23] - 2026-04-25 — Milestone 001 complete: StatusBar re-implemented around DECSTBM scroll region with all 14 acceptance scenarios passing and regression baselines preserved.

### New features
- Added 8 new unit tests to StatusBar test suite (55 total) covering DECSTBM scroll region mechanics, cursor save/restore sequence in _render(), hide/show/destroy/teardown lifecycle, and non-TTY edge cases
- Integrated xterm-headless terminal acceptance test suite (test-status-bar-terminal.js with 14 specification scenarios S1-S14 plus 1 new row-mash regression test) into npm test:all script for end-to-end validation

### Bug fixes
- StatusBar refactored to use DECSTBM scroll region for terminal bottom reservation, with _setupScrollRegion() method for first-render-only scroll region setup, resize handler to re-emit DECSTBM on terminal resize, and cursor save/restore (\x1b[s...\x1b[u) around bar rendering to prevent log overwrite

## [0.1.22] - 2026-04-24 — Delivered SDK lifecycle robustness milestone: result-event short-circuit with 60s watchdog, extractStructured edge-case hardening, and 5-agent warn-forwarding audit.

### Bug fixes
- SDK child process hang: spawn() breaks from for-await loop on first result event with 60s watchdog safety net to close stuck subprocesses
- extractStructured edge cases: Section 2 invariant ordering properly handles null vs undefined structured_output, empty objects, and malformed types with diagnostic warnings
- Warn-forwarding audit: analyzer, executor, reviewer, and verifier now consistently forward opts.warn to extractStructured; summarizer confirmed with v0.1.21 fix

## [0.1.21] - 2026-04-24 — Completed Phase II Bug Bundle, fixing verifier extraction drop, summarizer context pollution, and archive naming bugs in the harness bookkeeping layer.

### Bug fixes
- Verifier now correctly extracts structured_output when agent continues tool turns after StructuredOutput call
- Summarizer uses correct context at archive time, preventing manifest headline/bugs and CHANGELOG corruption
- Archive naming and collision bugs resolved in harness bookkeeping layer

## [0.1.20] - 2026-04-24 — Dogfood 27: StatusBar v3 stdout convergence — single stdout gate, cursor contract, signal handlers, elapsed ticker, xterm-headless regression spec.

### New features
- StatusBar.teardown() method — emits scroll region reset, erases bar rows, releases resize listener, idempotent (all public methods become no-ops after teardown).
- Agent-row elapsed ticker — per-agent state carries `startedAt` epoch ms; a 1Hz interval recomputes `elapsed = Date.now() - startedAt` and re-calls `updateAgent`. Active agent rows show live-updating elapsed time instead of a frozen `0s` snapshot.
- Logger.warn() method — routes through the same onLog pathway as regular log messages. All 5 agents (analyzer, executor, reviewer, summarizer, verifier) now call `this.logger.warn(...)` instead of `console.warn(...)`, closing the last our-code stdout bypass.
- xterm-headless integration test file (`test/test-status-bar-terminal.js`) — 11 scenarios asserting actual terminal buffer contents for the v3 StatusBar observable contract (row integrity, bar pinning, row-mash regression, prompt cursor, scroll behavior, hide/show, resize, teardown, concurrent logs, non-TTY parity). `@xterm/headless` devDependency added. Runnable via `npm run test:status-bar-terminal`. **Not wired into `test:all`** in this release — 7 scenarios fail against v0.1.18 behavior by design and serve as a regression spec for the next status-bar bug-fix milestone. See the spec's "Scope adjustment" section for rationale.

### Behavior changes
- StatusBar cursor contract tightened: explicit `ANSI_MOVE_TO(scrollBottom, 1)` after every `_render()`, `onLog()`, and `promptDidEnd()`. No reliance on `\x1b[u` to land the cursor correctly. Scroll region set once on first `show()`/`_render()` instead of per-render.
- Dashboard becomes a single-gate passthrough in TTY+StatusBar-active mode: `Dashboard.log(msg)` checks `(this.isTTY && this.statusBar)` and delegates to `statusBar.onLog(msg)`. Dashboard's `_emitLine` / `_renderStatus` / `onProgress` terminal-output paths are NOT reached in that mode. Non-TTY and StatusBar-disabled behavior is byte-for-byte identical to v0.1.18.
- Pipeline signal handlers for SIGINT, SIGTERM, exit, and uncaughtException now call `statusBar.teardown()` synchronously before delegating to default behavior (re-raise for uncaughtException, process exit for signals). After a Ctrl+C or crash, terminal returns to a usable state automatically — no `reset` required.

### Bug fixes
- Fixed test-file mock drift: `makeMockStatusBar()` in `test/test-status-bar-integration.js` and `test/test-dashboard.js` now expose the full StatusBar public surface (`setPhase`, `teardown`, `onLog`, `promptWillStart`, `promptDidEnd`, `agents` Map) that pipeline.js and dashboard.js call into. Previously the mocks predated v3 additions and caused 13 integration-test failures and a regression-gate stall.

### Known limitations
- Archive manifest for this release was generated with the wrong headline ("Reverted Terminal status bar v2 implementation...") — same summarizer-context-pollution bug that has bitten CHANGELOG entries before (see `TODO.md`). Hand-corrected in this entry.
- Milestone regression verifier reached a valid PASSED verdict via the StructuredOutput tool, but the Agent SDK did not surface `structured_output` on the final `result` event (Haiku kept running confirmation turns after StructuredOutput, which appears to cause the SDK to drop the captured payload). `extractVerdict()` fell back to a conservative FAILED stub; the verdict was recovered from the raw session log and the sidecar hand-patched to PASSED before Phase 5. Tracked in `TODO.md` as a Phase II bug; defense-in-depth fix will add stream-capture fallback in `session-manager.js`.

Note on versioning: v0.1.19 was originally tagged for dogfood 26 (commit `620d38c`), which was reverted the same day (commit `0369bbc`). This release skips 0.1.19 to avoid version reuse — v0.1.19 now refers solely to the reverted dogfood-26 code in git history.

## [0.1.18] - 2026-04-23 — Dogfood 25: terminal status bar bug-fix pass (14 observables).

### Bug fixes
- Status bar rendering: fixed double-header rendering and layout constraint violations
- Pipeline state wiring: routed onAgentStart notifications and connected TokenTracker aggregation to status bar
- Data plumbing: corrected progress bar inversion, elapsed time tracking, and task count reconciliation
- Layout and concurrency: fixed cursor positioning in prompts, user input echo placement, and log line interleaving
- Agent row model: ROLE_ICONS use lowercase keys matching pipeline's role strings; agent Map entries removed on session end (no memory growth)
- Phase-name display: StatusBar shows phase label ("planning global" / "verifying assumptions" / "planning mission 001") during planning phases; transitions to numeric progress bar once execution starts

## [0.1.17] - 2026-04-21 — Completed fixes for four critical cc-orch recovery-path bugs that previously made runs unresumable.

### Bug fixes
- Fix preflight regex to accept `-rp-NNN` recovery task ID suffix format
- Fix scheduler targetFiles scope validator to allow legitimate scope expansion on replan
- Fix reviewer-gate retry loop to generate remediation tasks on `recommendation: retry`
- Fix replan to correctly create replacement tasks for invalidated tasks

## [0.1.16] - 2026-04-20 — Dogfood 22: summarizer CHANGELOG scope fix (partial).

### Bug fixes
- Summarizer `recentCommits` input now scoped to `priorGitHead..HEAD` (commits inside this archive's boundary) instead of an unfiltered 20-commit tail. Closes the git-log leak vector that caused prior-release features to appear in new CHANGELOG entries.

### Known limitations
- A second leak vector remains: the summarizer still receives the full spec excerpt (`specContent`), and specs that name prior releases as "evidence" can cause those names to re-appear in `changelog`. Fix follow-up planned.

## [0.1.15] - 2026-04-20 — Dogfood 21: terminal status bar shipped.

### New features
- Terminal status bar — sticky bottom pane showing per-agent activity (role, task ID, description, elapsed time, per-role cost) and overall progress. Coexists with Dashboard's rolling log output via a reserved scroll region; remains visible during prompts (no hide/show wrapping)
- Scheduler `task-fail` event now carries `running` / `pending` counts for parity with `task-start` / `task-complete`

## [0.1.14] - 2026-04-19 — 

Maintenance release (no notable changes).

## [0.1.13] - 2026-04-15 — Pipeline actively implementing circuit-breaker mid-execution replan while maintaining stability through recent infrastructure and bug fixes.

### New features
- Circuit-breaker mid-execution replan with invalidated state, taskReplanSchema, and scheduler.replaceTask()
- Dry-run redesign with batch queue support (v0.1.12)
- Infrastructure error detection and graceful exit handling (v0.1.11)
- Reviewer gate retry loop for improved fault tolerance (v0.1.9)
- Autonomous assumption failure remediation (v0.1.8)
- Auto-removal of archived specs from project root

### Bug fixes
- Removed Levenshtein gate from autonomous remediation to auto-accept all fixes
- Queue status read now trims trailing newline from status file
- Fixed spec section matching with fuzzy lookup using substring and word overlap
- Corrected milestone cascade to stop at mission level

## [0.1.9] - 2026-04-14 — Dry-run redesign and batch queue implementation advancing with 16 dogfoods completed and multiple quality fixes shipped.

### New features
- Assumption failure auto-remediation with interactive human approval
- Reviewer gate retry loop for transient failures
- Read-then-write enforcement across pipeline
- Phase-2 quality gates via code review
- Import graph caching for improved analyzer performance

### Bug fixes
- Scheduler InfrastructureError on infra-stall
- Milestone cascade now stops correctly at mission level
- Auto-remove spec from project root after archiving
- Archive bump detection for driver/target split
- Script paths for external projects
- Relative path bypass security vulnerability in canUseTool
- Reviewer gate TC numbering and flag check
- 8 Copilot PR review issues in reviewer agent

## [0.1.9] - 2026-04-14 — Completed milestone 001: Infrastructure error detection with graceful exit and batch retry mechanism (v0.1.10).

### New features
- Infrastructure error classification: session-manager detects API errors (429, 5xx, overloaded) via pattern matching and wraps as InfrastructureError
- Scheduler infrastructure circuit breaker: pauses task dispatch on 3+ consecutive infra errors within 60s, retries with exponential backoff
- Graceful exit (code 75) on infra-stall: pipeline saves state and logs recovery instructions
- CLI commands recognize exit code 75 and prompt user to resume when API recovers
- Batch runner shell script implements exponential cooldown retry (2h, 4h, 8h cap) on infrastructure error exit code

### Bug fixes
- Scheduler now correctly emits infra-stall event without incorrectly throwing InfrastructureError to pipeline

## [0.1.9] - 2026-04-14 — Completed bugfix to prevent premature milestone completion before regression and reviewer gates.

### New features
- Add test coverage for milestone cascade behavior (test-milestone-cascade.js) to catch premature completion on resume

### Bug fixes
- Remove milestone-level cascade from cascadeComplete; milestone completion now only happens in Phase 5 after regression and reviewer gates pass

## [0.1.9] - 2026-04-13 — Successfully completed reviewer gate retry loop implementation across 26 sessions and 13 dogfood runs, with remediation of critical issues found during code review and production validation.

### New features
- Implemented reviewer gate retry loop: automatic remediation when reviewer fails and analyzer recommends retry, with planner-generated targeted fixes
- Added read-then-write enforcement (v0.1.7)
- Integrated Opus-based reviewer agent for code quality validation (v0.1.6)

### Bug fixes
- Fixed script path resolution for external projects
- Normalized file paths in canUseTool to prevent relative path bypass
- Corrected reviewer gate flag check logic
- Added null guard for pipeline results
- Fixed manifest spec field fallback behavior

## [0.1.8] - 2026-04-13 — Completed assumption failure auto-remediation milestone across 37 sessions with reviewer agent and read-then-write enforcement shipped.

### New features
- Assumption failure auto-remediation: when assumptions fail verification, planner proposes targeted spec edits with human accept/reject/edit flow (capped at 2 remediation rounds)
- Reviewer agent with Opus integration for comprehensive code review and multi-file consistency checks (v0.1.6)
- Read-then-write enforcement: analyzers must read relevant code before proposing spec changes (v0.1.7)
- Unified test infrastructure with 31 test files integrated into test:all

### Bug fixes
- Normalize file paths in canUseTool to prevent relative path bypass attacks
- Correct reviewer gate flag check logic for proper condition evaluation
- Add manifest spec field fallback to prdPath from state.json

## [0.1.7] - 2026-04-12 — Read-then-write enforcement

### New features
- Read-then-write structural guard: executor sessions must Read existing files before Edit/Write. Enforced via canUseTool hook with SDK PermissionResult return type.

## [0.1.6] - 2026-04-11 — Reviewer agent (dogfood 12)

### New features
- Opus reviewer agent: per-milestone integration checker. Traces call chains, checks cross-module contracts, validates functional composition. Runs after all tasks verified, before milestone regression.
- reviewerSchema with findings (severity/category/file/description/relatedFiles)
- analyzerSchema.failureType extended with 'review'

### Bug fixes
- Auto-export ccusage on archive (wired into archive flow)
- Banner body truncated to 1 line, removed misleading (...) marker

## [0.1.5] - 2026-04-11 — ccusage export integration

### New features
- `scripts/export-ccusage.js` — export cc-orch token usage to ccusage-compatible JSONL format. Maps session roles to model IDs (planner→opus, executor→sonnet, verifier→haiku). Supports `--all`, `--archive <id>`, and current `.harness/` export.

### Bug fixes
- ccusage export: `version` field must be semver (was `'cc-orch'`, ccusage silently rejected all entries). Now reads from package.json.
- ccusage export: `message.id` was not unique across archives, causing deduplication. Now includes archive source ID.
- `cc-orch usage compare` was blocked by state.json check after archive reinit removed state.json creation.
- Fixed 13 integration bugs across trust-layer features (worktree path issues, askMenu crash, stale TokenTracker, suggest.js missing commands)

---

## [0.1.4] - 2026-04-11 — Completed post-run polish milestone and released v0.1.4 with trust layer implementation and cost instrumentation

### New features
- Trust layer features: dry-run mode, worktree support, diff gate, small-task handling, and usage intelligence (Dogfood 10)
- Cost efficiency instrumentation with per-run cost display and systemPromptTokens tracking
- CLI UX overhaul with automatic versioning system and improved banner formatting
- Consolidated verifier report with automatic version bump and changelog generation

### Bug fixes
- Fixed table formatting in usage compare and archive list operations
- Fixed instrumentation wiring for systemPromptTokens and toolCallCount metrics
- Fixed archive reinit during cleanup process

# Changelog

All notable changes to cc-orchestrator are documented here.
Versioning: Z increments per milestone, Y monthly, X rare.

---

## v0.1.3 — Trust Layer (2026-04-11, dogfood 10)

The minimum trust features to run cc-orch on code you didn't write.

### New commands
- `cc-orch dry-run <spec>` — preview the full plan without executing. Shows milestones, missions, tasks, target files, planner-only cost.
- `cc-orch task "..."` — one-liner interface for daily work. Wraps input in a synthetic spec with hard scope caps (max 2 missions, 5 tasks/mission).

### New features
- **Git worktree isolation** (`--worktree`) — runs the pipeline in a separate git worktree. Editor-safe, crash-recoverable, parallel-run-capable.
- **Diff review gate** — after all tasks verified, presents unified diff for user approval before accepting changes. Options: accept, show diff, per-file diff, reject, reject+discard.
- **Usage intelligence** — 3-line cost summary at end of every run. Warns on cost anomalies (>30 tool calls/session, <1.5x cache efficiency).
- **Small-task planner prompt** — planner gets "keep it tight" instruction in small-task mode.

### Bug fixes
- Compare table and archive list formatting — long archive IDs no longer blow out column widths.
- Banner body truncation — mission descriptions capped at 3 lines with (...) overflow.

---

## v0.1.2 — UX Polish (2026-04-11, dogfood 9b)

### New features
- **Banner formatting** — plan/milestone/mission banners split into title + word-wrapped body (72 chars). No more walls of text.
- **Per-run cost display** — end-of-run output distinguishes "This Run" cost from cumulative cost since last archive. `getUsageSince()` API on TokenTracker.

---

## v0.1.1 — Cost Efficiency Instrumentation (2026-04-11, dogfood 9a)

### New features
- **Prompt size visibility** — approximate system prompt token count (4-chars/token heuristic) tracked per session.
- **Cache efficiency ratio** — `cacheEfficiency()` pure function with verdict (excellent/healthy/marginal/wasteful). Surfaced per-role in `cc-orch usage`.
- **Tool-call accounting** — `toolCallCount` per session. Persisted in token-usage.json.
- **Cross-archive comparison** — `cc-orch usage compare <a> <b>` diffs cost profiles between two archives.
- **Per-turn tracking audit** — JSDoc documentation of known metadata fields in recordSession().

### Documentation
- Invisible parent baseline protocol (`docs/audit/cost-baseline-invisible-parent.md`).

### Bug fixes
- Instrumentation wiring — `systemPromptTokens` and `toolCallCount` were captured on SessionHandle but never passed through to `recordSession()`. Fixed across all 8 call sites in 5 agent files.

---

## v0.1.0 — CLI UX Overhaul (2026-04-11, dogfood 8)

### Breaking changes
- CLI rewritten from `--flag` style to subcommand-first: `run`, `status`, `resume`, `archive`, `usage`, `init`, `health`, `version`, `help`.
- Old flags (`--status`, `--resume`, `--init`, `--usage`, `--health`) removed.

### New features
- Compact status display with drill-in (`cc-orch status 001-001`).
- Version bump script (`scripts/bump.js`).
- `.md` shortcut: `cc-orch spec.md` routes to `cc-orch run spec.md`.

---

## v0.0.x — Dogfoods 1-7 (2026-04-10 and earlier)

Foundation work: core pipeline, state machine, contracts (verifier/analyzer/executor/summarizer), archiving, context enrichment, parallel execution, session reuse, Haiku verifier, import graph, planner prompt optimization. See `retro/RETRO-dogfood-*.md` for details.
