<!-- legacy: pre-framework, migration-pending -->
# nightfoundry Architecture Rules

This document codifies the load-bearing architectural rules of nightfoundry. These are not style preferences — they are rules whose violation has caused real bugs during the project's dogfood runs, each traceable to the commits cited below.

> **Note on commit references:** the SHAs cited throughout this file point to the project's internal development history from before the public release, which is not part of this repository's git history. They are kept as provenance labels — evidence that each rule was forced by a specific real failure — not as resolvable links.

If you are about to do work that involves an agent-to-JS handoff or a convention rename, **read this file first**.

---

## Rule 1 — Schema-first agent boundaries

**Every agent-to-JS handoff MUST be a schema-validated structured contract, never a soft-prompt parser.**

When an agent session needs to return data to the JS pipeline, the data flows through the SDK's `jsonSchema` mechanism. The agent's structured output is the contract. JS reads `result.structured_output` and validates it against the same schema that the SDK enforced.

**No new code may parse prose, regex-match agent output, or rely on agent prompt wording for correctness.**

### Required components for any new agent-to-JS handoff

1. **Schema** — defined in `src/orchestrator/agents/_schemas.js` with explicit `enum`, `required`, and nested object types
2. **Spawn with `jsonSchema`** — passed to `sessionManager.spawn(...)`
3. **Pure extraction helper** — exported function that takes the SDK result and returns the parsed object (mockable, testable without spawning sessions)
4. **Schema validation at the seam** — `validateStructured()` runs before the parsed object is trusted; failures fall through to a conservative default (FAILED / BLOCKED / `human` recommendation)
5. **Fixture round-trip test** — at least 4 cases per schema: happy path, enum violation, missing required field, malformed payload
6. **JSON sidecar as source of truth** — written to disk via the extraction helper, not by the agent. Filenames follow `.harness/{verification|progress|analysis}/task-{id}.json`
7. **Graceful degradation path** — kept for one release after introduction, then deleted. Logs `[DEPRECATED]` if hit

### What "no soft-prompt parsers" means in practice

**Forbidden** (this is the bug class that landed dogfood 1's bug 5):
```js
// Parsing the agent's recommendation from prose
const match = report.match(/##\s+(?:Recommendation|建议方案)\s*\n([\s\S]*?)(?:\n##|$)/i);
const section = match[1].toLowerCase();
if (/\bre-?plan\b/.test(section)) recommendation = 're-plan';
```

**Required**:
```js
// Schema-validated structured output
const analysis = extractAnalysis(sdkResult, eventId, harnessDir);
// analysis.recommendation is enum-validated: 'retry' | 're_plan' | 'human'
```

The forbidden version drifts the moment the agent prompt changes language. The required version fails loudly at session time if the schema is violated.

### Worked example

`src/orchestrator/agents/_schemas.js` is the canonical example. It contains three schemas (verifier, analyzer, executor), each paired with extraction + validation helpers. `test/test-{verifier,analyzer,executor}-contract.js` are the canonical fixture round-trip tests.

---

## Rule 2 — Callsite audit on every convention rename or addition

**When you rename a path/state/field/enum value, OR add a new value to an existing enum, schema, or error class, you MUST grep for every caller that branches on the old set and either migrate it or explicitly mark it as "intentionally unchanged with reason."**

This is the rule whose absence caused both dogfood 2 bonus bugs. The contracts migration was a careful, well-tested refactor of the *definitions* (verifier output, executor output, analyzer output). It was not a careful refactor of the *callers*. Two caller sites were missed:

1. `state-machine.js`'s `verified` transition gate hardcoded `.md` instead of checking the new `.json` sidecar — fixed in `d62c5fa`
2. `pipeline.js`'s resume path didn't handle the `awaiting_verification` resume case introduced by the contracts migration — fixed in `d9184e1`

Both were caught only when a live dogfood spent real money. Both would have been caught at edit-time by a single `grep` step.

### The discipline

Before any commit that renames a convention:

1. **`grep` for the old name across the entire codebase** — `Grep` tool with the old path/state/field as the pattern, scoped to `src/**/*.js` and `test/**/*.js`
2. **For every match, decide one of**:
   - **Migrate** — update the caller to use the new convention
   - **Intentionally unchanged** — leave it, but add an inline comment explaining why (e.g., "kept as deprecation fallback for one release")
   - **Dead code** — delete the caller entirely
3. **Run the test suite** — both unit tests and integration-level tests (see Rule 3)
4. **Document the migration in the commit message** — list the callers touched and the rationale for any "intentionally unchanged" decisions

### What "convention" means here

A convention is anything one piece of code assumes about another. Examples that have caused bugs:

- File path conventions: `.md` vs `.json` sidecar (dogfood 2 bonus bug 1)
- State name conventions: `awaiting_verification` resume handling (dogfood 2 bonus bug 2)
- Field name conventions: `re-plan` vs `re_plan` enum (would have broken `pipeline.js:342` if I hadn't checked)
- Section header conventions: `## 修改的文件` vs `## Modified Files` (dogfood 1 bug 5, the original lesson)

Any rename of any of these triggers Rule 2.

### Additions are renames in disguise

Adding a new value to an existing enum, a new failure type to a class hierarchy, or a new variant to a schema is not safer than renaming — it just hides the audit requirement. Every code path that switched on the old set must be considered for the new value. The dogfood 12-20 arc had four R2 violations of this shape:

1. **Reviewer added → analyzer enum unaudited.** The analyzer's `failureType` enum did not include `'review'` (commit `116299b`). Without it, every reviewer-driven failure failed schema validation and was silently routed to `recommendation: 'human'`. Caught only by an integration test that injected a failing reviewer mock.

2. **`InfrastructureError` added → scheduler still threw plain `Error`.** The pipeline's `instanceof InfrastructureError` check then failed, and the exit-75 path didn't trigger (commit `e26787a`).

3. **`taskReplanSchema` added → reusable-session branch unaudited.** The planner's "use reusable session if available" path called `missionDecompositionSchema` instead of `taskReplanSchema`. On warm caches it would silently win and produce wrong-shape output (commit `0b4a26a`).

4. **`remediateAssumption` returned revised text → in-memory plan unaudited.** Spec on disk was edited correctly, but `plan.assumptions[i]` in memory still held the old text. Round 2 re-verified the wrong text and failed (commit `3257e6d`).

The pattern: when you ship a new schema, class, or enum value, the audit question is *"which existing code paths branch on this set, and does the new value travel through each one correctly?"* Not *"does my new code work."*

### Defect-coverage policy

**Every commit that fixes a numbered defect (`Defect #N`) must either (a) add or annotate an R2 pair invariant in `scripts/audit-r2.js` whose description references that defect number, OR (b) include a `<!-- r2-exempt: reason -->` HTML comment marker in the defect's CHANGELOG.md entry.**

Defects are the highest-signal source of structural invariants — each numbered defect represents a class of bug that actually shipped. The pair-invariant or exempt marker ensures the class is either mechanically prevented going forward or explicitly acknowledged as non-structural. Without this policy, the same structural gap that allowed a defect to ship can silently recur across future refactors, because no machine-checkable invariant encodes the lesson learned.

- **Structurally capturable:** defects where the bug class can be expressed as "if A appears in a file, B must also appear" (e.g., Defect #15 → `archived-log requires archive()`, Defect #2 → `restoreSnapshot requires _captureLastFailed`). These get a new `PAIR_INVARIANTS` entry in `scripts/audit-r2.js` with `Closes Defect #N` in the description.

- **Non-structural / exempt:** defects where the fix is internal to a single function (UI text, rendering logic, format validation). These get `<!-- r2-exempt: reason -->` on the line after the CHANGELOG heading.

Mechanized by `scripts/audit-r2.js` Phase 4 (defect-coverage check). Run `node scripts/audit-r2.js` to verify all defects are covered or exempt. Use `--strict` to promote uncovered defects from warnings to hard errors.

---

## Rule 3 — Integration tests alongside isolation tests

**Every contract test SHOULD be paired with at least one integration-level test that exercises the full chain from agent output to downstream consumer, without spawning real sessions.**

Isolation tests catch logic bugs in the extraction layer. They do not catch bugs in callers that depend on the extraction layer's output. Both bonus bugs from dogfood 2 lived in callers, not in the extraction layer.

### What an integration test looks like

The canonical example is `test/test-contract-integration.js`, which exercises the full chain that the bonus bugs broke:

```
fake structured_output
  → extractProgress writes JSON sidecar
  → snapshots.readAffectedFiles reads sidecar
  → state-machine.transitionTask gates on sidecar existence
  → audit.auditVerification reads sidecar at milestone close
```

No SDK calls. No real agent sessions. Pure JS, pure fixtures, milliseconds to run. Would have caught both bonus bugs **at edit-time** instead of **at dogfood-time**.

### What integration tests are NOT

- They are not end-to-end tests that spawn real agent sessions (those are dogfoods, run separately and rarely)
- They are not unit tests that mock everything (those test logic, not chains)
- They are not "fast feedback during development" alone — they are **caller-site safety nets** that catch the bug class Rule 2 prevents

### When to add an integration test

- Whenever you add a new contract under Rule 1
- Whenever you migrate a convention under Rule 2 (the test should exercise the chain from the renamed point downstream)
- Whenever a live dogfood surfaces a caller-site bug (add a regression sentinel test referencing the commit SHA that fixed it)

### Assert on observable state, not on emitted protocol

An integration test that asserts *"the right ANSI sequence was emitted"* is not equivalent to one that asserts *"the right characters appeared in the right rows after the sequence rendered."* The first checks the producer; the second checks what the user sees.

Dogfood 25 shipped 1583 new lines of green tests against terminal output bugs that surfaced in production within a day. Every test asserted on the protocol layer (ANSI escape sequences, log-line formatting, scroll-region setup). None asserted on the buffer state the user actually observed. The tests passed; the bar fragmented across log writes; the elapsed time stayed frozen at `0s`.

Dogfood 27 closed the gap by introducing `xterm-headless` as a test-only dependency. The new tests instantiate a real terminal emulator, feed the cc-orch output stream into it, and assert on the rendered buffer — *what is in row 23 column 5 after the bar updates?*

The discipline: when the user-facing artifact is a rendered surface (terminal buffer, JSON file on disk, archive directory tree, HTTP response body), the integration test must assert on the rendered artifact. Asserting on the emitted protocol is a unit-test concern, not an integration-test concern.

### Related

The surface-polish dogfood round (lesson: terminal state is part of the contract); `test/test-status-bar-terminal.js`.

---

## Rule 4 — State-machine transitions are gates, not advisories

**The state machine is the single source of truth for valid status transitions. Callers MUST go through `transitionTask` / `transitionMission` / etc. — never write `task.status = 'X'` directly.**

This rule predates the contracts work and is mostly enforced by code review + the absence of direct assignment paths. It is documented here because the bonus bug 2 fix (`pipeline.js` skipping the `awaiting_verification` self-transition on resume) is a worked example of the rule:

- The state machine correctly rejects the `awaiting_verification → awaiting_verification` self-loop
- The pipeline must respect that rejection by **not calling the transition** when already in that state
- The pipeline does NOT get to bypass the gate by writing the status field directly

The rule's broader version: **if the state machine says no, the answer is "fix the caller", not "weaken the state machine."** This is what kept the state machine clean during dogfood 2's debugging.

---

## Rule 5 — Knowledge survives model upgrades

**Domain knowledge MUST live in model-neutral source files — markdown, JSON, structured state — never in an agent's in-context prompt tuning, cached summaries, or any artifact shaped by a specific model's quirks. Caches and indices are derivable; they get rebuilt from source on demand.**

Claude model generations ship every few months. An agent that was calibrated on Sonnet 3.5's phrasing quirks does not automatically speak Opus 4.6. A system prompt that squeezed the last 5% of accuracy from one model routinely regresses on its successor. Anything stored as "what the current model does well with" rots the moment the model changes.

The rule's positive form: whatever the pipeline needs to *know* about the project — patterns, decisions, conventions, schemas — belongs in a file the next model can read fresh. Whatever the pipeline computes *from* that knowledge — embeddings, summaries, digests, context packages — is a cache, allowed to exist only if it can be thrown away and regenerated.

### How to apply

- If a piece of information is load-bearing for pipeline correctness, it must be persisted in a file the next-gen model can parse without re-training prompts.
- If a file only exists because the current model "works better with it phrased this way," flag it — it's fragile to the next upgrade.
- Caches (embeddings, in-context digests, tool-result summaries) must have a regenerate-from-source path. No cache-only state.
- Schemas and enums beat prose for anything the pipeline branches on. Prose instructions to an agent may need retuning per model; a schema constrains every model the same way.

### Worked example

Audit artifacts, dogfood retrospectives, planning notes, and the JSON sidecars under `.harness/` are all model-neutral source. A planner that distills those into context for a single decomposition call is producing a cache. Rule 5 says: the distilled context is disposable; the source files are not.

### Related

The planner design's first-principle notes and the dogfood-3 retrospective's memory-system brainstorm.

---

## Rule 6 — Test fixtures from real code execution

**Fixtures for tests that consume harness state MUST be produced by invoking the real state-writing functions, not hand-authored from spec assumptions. Snapshot the producer's output; do not reason about what the shape "should" be.**

Dogfood 3 shipped a test-archive-manifest fixture that hand-authored `milestones` as an array. The real `writeGlobalPlan()` writes `milestones` as an object keyed by ID. The hand-authored fixture passed every test; the real code crashed on first dogfood run with `state.milestones.every is not a function`. This is a Rule 1 violation (schemas that disagree with code) dressed up as a test-data problem — except the "schema" here was one engineer's mental model.

The lesson: when a human writes a fixture JSON by hand, they are encoding their *assumption* about the shape. When the producer writes the fixture, the shape is correct by construction. The producer is already tested (or will be). The hand-written fixture has no test behind it.

### How to apply

- Any test that reads or asserts on a harness state file (mission state, global state, verify/progress/verification sidecars, manifest, archive layout) must produce its fixture by calling the real writer with sample input.
- Use a temp project root and `bootstrap()` + `writeGlobalPlan()` + `writeMissionState()` / equivalents, then assert against the files on disk.
- If the producer is slow or has side effects you don't want in a test, refactor the producer — do not hand-author the fixture to work around it.
- Exception: fixtures for pure-data transformations (e.g. session entry arrays for usage-analyzer) can be hand-written because there is no producer to call — the function under test *is* the producer.

### Worked example

`test/test-context-enrichment.js` uses `bootstrap()` + real `writeMissionState()` to produce the fixture for every state-writer and stateToDecomp round-trip test. Without this pattern, the dogfood 4 state-writer bug (silently dropped enrichment fields) and its sibling found in PR review (stateToDecomp dropped the same fields) would have slipped the same way the archive-manifest bug did.

### Related

Dogfood-3 bug 1 root-cause analysis, commit `02734a0`.

---

## Rule 7 — Match tool surface to task

**An agent's tool list is a scoping constraint, not a convenience. Synthesis-only agents get no tools. Exploration agents get the minimum tools required for their specific task. Never hand an agent more reach than its job description demands.**

Dogfood 3 shipped a summarizer with `[Read, Glob, Grep, Bash]` and a vague "produce a progress digest from the archive" prompt. Haiku spent 121 seconds making 31 tool calls spelunking 97 log files for work that should take under 15 seconds. The fix was to give the summarizer an **empty tool set** and pre-compute the data package in JS, so the agent only synthesizes — it has no way to explore. Runtime dropped from 121s to 15s with no loss of output quality.

Tool surface shapes behavior before the prompt does. An agent with filesystem tools will explore the filesystem. An agent with Bash will run commands. The more reach the agent has, the harder its prompt has to work to *prevent* exploration the task doesn't need — and prompts are not reliable enforcement mechanisms (Rule 1).

### How to apply

- **Synthesis-only role** (summarizer, formatters, any agent whose input is fully pre-computed): tools MUST be `[]`. If the agent needs data, compute it in JS and pass it in the prompt.
- **Bounded exploration role** (planner during decomposition, analyzer during failure triage): tools are `[Read, Glob, Grep]` only. No Bash. No Edit/Write. The agent reads the repo and produces a structured output; JS handles persistence.
- **Mutation role** (executor): tools include `Edit`, `Write`, `Bash` — but the job is to execute a concrete task description, not to explore. The task description is the scope.
- When adding a new role, default to the smallest tool set that can plausibly do the job. Expanding later is cheap; shrinking later requires debugging a runaway session first.

### Worked example

`src/orchestrator/infra/config.js` `tools` block is the single source of truth. `tools.summarizer: []` is the canonical enforcement of this rule — the config comment points back to the incident. Any new role added to that block must come with a justification for its tool list in the same comment style.

### Related

Dogfood-3 bug 3, commit `02734a0`, `src/orchestrator/infra/config.js` summarizer comment.

---

## Rule 8 — Thin planner, thick JS

**Mechanical computations run in JS before or after the planner session, never inside it. The planner's token budget is reserved for creative decomposition and context judgment — the things AI is good at. Everything deterministic belongs in JS.**

The planner (Opus) is the most expensive agent in the pipeline: 60% of dogfood 5's cost ($3.15 of $5.44), 62% of dogfood 6's ($4.75 of $7.69). Every field we add to the planner's output schema increases output tokens, hallucination surface, and session duration. Every mechanical task we move from "planner figures it out in-session" to "JS computes it pre-session" saves money, eliminates hallucination risk, and runs in milliseconds instead of minutes.

### The pattern

| Computation | Where it runs | Cost | Hallucination risk |
|---|---|---|---|
| Import graph (which files import what) | `import-graph.js` pre-session | $0, ~50ms | Zero |
| Scenario coverage aggregation | `checkMilestoneCoverage` post-planning | $0, ~10ms | Zero |
| File-conflict detection for parallelism | `scheduler.js` at dispatch time | $0, ~1ms | Zero |
| Creative decomposition (what to build) | Planner session | ~$0.25/call | Acceptable |
| Context enrichment hints (style examples) | Planner session | ~$0.10/call | Acceptable |

Before adding any new responsibility to the planner, ask: **"Can JS compute this from source files, the import graph, or the harness state?"** If yes, build a JS helper. If the answer requires judgment about code intent, architecture tradeoffs, or decomposition strategy, that's the planner's job.

### Worked examples

**Import graph** (`src/orchestrator/core/import-graph.js`): the planner needs to know which files are connected to decompose by runtime dependency instead of directory proximity. Original approach would have been: "planner explores the codebase and figures out imports." Actual approach: JS scans import statements in ~50ms, produces a graph, injects it into the planner's prompt. The planner reads it, doesn't compute it.

**Milestone-level coverage** (`checkMilestoneCoverage` in `coverage.js`): the coverage system needs to know which spec scenarios are addressed across all missions. Original approach: planner's remediation system checked per-mission, spawning N $0.40 remediation sessions that all returned "out of scope." Actual approach: JS unions `tracesScenario` across all mission state files in ~10ms, checks once. Saved $2/dogfood.

**Available imports** (deferred): the executor needs to know which modules it can import. Original Phase II design: "planner pre-resolves the import surface per task." Revised design: if ever needed, JS reads the import graph + task's targetFiles and computes `availableImports` deterministically. No planner involvement, no hallucination.

### Why this matters for the Architect/Planner split (Phase IV)

The long-term vision splits `planner.js` into an architect (owns global structure + knowledge) and a reduced planner (owns per-mission decomposition). Rule 8 prepares for this split by ensuring the planner's scope is already minimal before the refactor starts — every JS helper we extract now is one fewer responsibility to migrate later. The architect inherits the creative judgment; the planner inherits the task-level detail; JS keeps everything deterministic.

### Related

The parallel-dogfood cost analysis (planner measured at 60% of dogfood cost). `src/orchestrator/core/import-graph.js` — canonical Rule 8 implementation, where the "JS pre-processing" pattern emerged.

---

## Rule 9 — Cross-cutting features require upstream architecture

**When a feature touches every component's output stream, state stream, or lifecycle, the architecture must accommodate it from the source — not parasitically intercept it downstream. A single-file fix for an N-file problem will produce N rounds of bugs.**

The shape: some features are not local to one module. Status reporting, structured logging, request tracing, signal handling, audit recording — each of these spans every agent, every dispatch path, every output sink. Treating them as a single-file concern (e.g., "the status bar reads stdout and renders the bar") sets up a parasitic relationship that fails the moment any upstream component writes to stdout in a way the parasite did not anticipate.

The diff is the diagnostic. If a feature claims to be system-wide but its implementation lives in one file, the system-wide claim is aspirational, not structural.

### Worked example

**StatusBar v1 → v2 → v3 (dogfoods 21, 25, 26-reverted, 27).**

Three attempts at the same feature:

| Iteration | Approach | Diff shape | Outcome |
|---|---|---|---|
| v1 (DF21, `e3acad7`) | DECSTBM scroll region; Dashboard + StatusBar both write to stdout independently | All in `status-bar.js` (462 new lines) + light pipeline edits | 14 latent observables; bugs surfaced in production |
| v1-bugfix (DF25, `6f16c4d`) | Fix all 14 in place; preserve two-writer architecture | All in `status-bar.js` + pipeline (~350 LOC delta) | 14 closed; 2 new bug classes shipped within 24 hours |
| v2 (DF26, `620d38c`) | Drop DECSTBM; passive-bottom rendering; atomic `\r\x1b[K` | Still in `status-bar.js` | **Reverted same day** in `0369bbc` |
| v3 (DF27, `182acce`) | StatusBar becomes the single stdout gate; Dashboard delegates; new `logger.js`; every agent rewired | `status-bar.js` + `pipeline.js` + `dashboard.js` + new `logger.js` + **5 agent files** + signal handlers | Shipped |

The first three iterations failed not because the implementation was wrong but because the *architecture* assumed two stdout writers could be reconciled by careful coordination inside one file. The fourth succeeded by changing the architecture: stdout has one gate; everyone who used to write to stdout writes through the gate.

### How to apply

When proposing a feature, ask: *"Does this feature observe, transform, or depend on output produced by other components?"* If yes:

1. **List every component whose output the feature touches.** This includes upstream producers (every agent, every dispatch site, every error path), not just downstream consumers.
2. **The implementation must include changes to those components**, or a written rationale for why the parasitic interception is structurally safe in this specific case.
3. **A single-file diff for an N-component feature is a smell.** Treat it like a `console.log` left in production — defensible only with an explicit "yes, I know" comment.

The corollary: when fixing bugs in an existing cross-cutting feature, if every previous fix has stayed local, the diagnosis is probably that the feature needs upstream changes. Localizing the next fix will produce the next round of bugs.

### Related

The "StatusBar saga"; commits `e3acad7`, `6f16c4d`, `620d38c`, `0369bbc`, `182acce`.

---

## Rule 10 — Scope retreat is a first-class deliverable

**When a feature's claimed property does not hold, removing it is a ship — own spec, own tests, own version bump. Before deletion, the working alternative must already exist. Code that claims a property it cannot deliver is worse than no claim at all.**

Some features ship with a load-bearing contract: *this feature provides X.* Trust-layer features in particular tend to look like this — *worktree provides isolation*, *dry-run provides cost-bounded preview*, *diff gate provides approval*. When the contract turns out to be structurally false (the SDK doesn't behave as expected, the abstraction leaks at a boundary, the safety property collides with another guarantee), the feature has not become "incomplete." It has become a lie the codebase tells.

The fix is deletion, not patching. A patched lie is still a lie; a deleted lie is a missing feature, which is honest.

### Prerequisites for retreat

Deletion is cheap when the working alternative is already in place. It is expensive when deletion forces an emergency replacement. The discipline:

1. **Reproduce the contract violation** with a clear written cause — not "this seems flaky" but "the SDK's `.git` pointer resolution makes worktree paths fall through to the main repo."
2. **Verify the working alternative covers the original use case.** If the alternative isn't there yet, build the alternative *first*, in a separate ship, then retreat.
3. **Treat the retreat as a real ship.** Spec describing what is removed and why. Tests removed in the same commit (not orphaned). Version bump. CHANGELOG entry that names the contract violation, not just the deletion.
4. **Do not soften the language.** "Deprecated" / "moved" / "refactored" obscure the lesson. The CHANGELOG should say "removed because the isolation guarantee was structurally false."

### Worked example

**Worktree retreat (dogfoods 10 → 19, commits `70130ba` → `f6ba735`).**

Worktree shipped on 2026-04-11 as a core trust-layer feature with a documented isolation guarantee: cc-orch executes inside a separate git worktree directory; the executor cannot write to the user's working tree. The Agent SDK, however, resolves file paths through the `.git` pointer in worktrees back to the main repo. Executor writes bled into the original directory regardless of the worktree wrapper. Confirmed reproducible 2026-04-13.

The replacement was already in place: driver/target split (separate clones, absolute paths, no shared `.git`). Five days after ship, the feature was deleted (1108 lines removed, 129 lines added in the replacement `clean.js`). Net `-613 LOC` was a feature ship.

### How to apply

This rule has a meta-component: **knowing when to invoke it.** Most buggy features should be patched, not deleted. The trigger for Rule 10 is specifically *"the claimed contract is structurally false"* — not *"this has a lot of bugs"* or *"this is hard to maintain."*

The test: if the feature were behaving exactly as designed, would it deliver the contract it advertises? If yes, it's a bug-fixing problem (stay with patching). If no, it's a contract problem (retreat).

### Related

Dogfood 19 of the resilience-recovery round; `git show 225c240:spec-remove-worktree-add-clean.md`.

---

## Rule 11 — Fail loud, name the failure mode, recover

**When the pipeline encounters a failure that is not a task-correctness failure — infrastructure stall, validation drift, over-decomposition, SDK lifecycle stranding — name it as a class, schema enum, or exit code BEFORE writing the recovery logic. Naming the failure mode is half the recovery code; without a name, every downstream layer ends up inspecting message strings.**

A pipeline that conflates failure modes ("something threw, mark the task failed") cannot route them differently. An API rate-limit and a buggy executor must produce different responses: one freezes state and waits, the other escalates to the planner. A pipeline that sees both as "an Error" cannot make that distinction without parsing strings — and string parsing is Rule 1's anti-pattern (soft-prompt parsing applied to error messages instead of agent outputs).

The discipline: every failure class the pipeline distinguishes between must be a named primitive. The name lives in code (a class, an enum value, an exit code, a schema field), not in a comment or a runbook.

### The pattern

| Phase | Action | Example |
|---|---|---|
| Detect | Identify the failure class at its source | SDK throws `429` → caught in `session-manager` |
| Name | Wrap it in a named primitive | `throw new InfrastructureError(rawError)` |
| Route | Branch on the primitive, never on message strings | `if (e instanceof InfrastructureError) scheduler.pause()` |
| Recover | Each named class has a documented recovery action | Pause dispatch, exit 75, shell-level cooldown |
| Preserve | State invariant: failed task stays `in_progress`, not `failed` | The user's code is not blamed for an Anthropic outage |

### Worked examples

**`InfrastructureError` (dogfood 17, commit `0d24b31`).** API 429 / 500 / "overloaded" responses are not task failures — they are dispatch failures. The class boundary lets every layer above the SDK do the right thing: scheduler pauses on 3 errors in 60s, pipeline exits 75 (`EX_TEMPFAIL`), `batch-runner.sh` retries with 2h/4h/8h cooldown. Tasks stay `in_progress`. The exit code is a contract with the OS; the class is a contract with the JS layer.

**`failed-validation` queue state (dogfood 18, commit `d08ea6d`).** When a spec's assumptions fail and remediation cannot fix them, the spec doesn't block the queue — it gets marked `failed-validation` and the batch keeps going. Naming the state lets `queue list` show it, lets `resume --batch` skip it, lets the user grep for it. The alternative — leaving such specs in `pending` forever — would have required every consumer to inspect spec contents to figure out why they kept being skipped.

**`replanTask` + `replaceTask` + `-rp-NNN` ID convention (dogfood 20, commit `1bc9265`).** When a task hits the circuit breaker and the analyzer recommends `re_plan`, the planner produces replacement tasks with `{originalId}-rp-NNN` IDs. The naming convention lets the scheduler perform deterministic DAG surgery (remove the failed node, remove its blocked dependents, insert replacements with named dependencies). The cap is 1 replan per task — bounded retry per Rule 4's gating discipline.

### How to apply

Before writing recovery logic, write the name. Every recovery branch in the pipeline must answer:

1. **What is the failure class?** Not "what threw" but what shape of problem — infrastructure, validation, decomposition, lifecycle.
2. **Where is it named in code?** Class name, enum value, exit code, schema field. Not a comment, not a docstring, not a runbook.
3. **What state does the failure preserve?** Tasks that hit infra errors stay `in_progress`; specs that fail validation become `failed-validation`; tasks that fail decomposition become `replanned`. Each state name is a contract with `cc-orch resume`.
4. **What is the bounded retry?** Per Rule 4, the gate must reject, not retry forever. Every recovery loop has a documented cap.

### Related

The resilience-recovery round's lesson 2 ("Naming a failure mode is half the recovery code"); commits `0d24b31`, `d08ea6d`, `1bc9265`, `e26787a` (the wrong-error-class same-day fix that proved why the class boundary matters).

---

## Rule 12 — Public API surface is the package.json exports field

**The public API surface of nightfoundry is exactly what `package.json#exports` resolves to. Everything reachable only via deep relative paths (`nightfoundry/src/...`) is private and may break on any release — patch, minor, or major — with no notice and no migration aid.**

The project ships frequent `Z` bumps per the versioning philosophy, so consumers MUST anchor on the stable surface. Without a named contract, every internal refactor risks silently breaking downstream callers; with the `exports` field acting as the contract, the breakage is mechanical — Node refuses the import — not subtle.

### The pattern

| Layer | Status | Example |
|---|---|---|
| `package.json#exports` entries | Public, semver-respected | `"." : "./index.js"` |
| Anything re-exported via `index.js` | Public | `export { runPipeline } from './src/pipeline.js'` |
| `src/orchestrator/**` reached by deep import | Private, may break on any release | `import x from 'nightfoundry/src/orchestrator/planner.js'` |
| `test/**`, `scripts/**` | Private, never importable | `import t from 'nightfoundry/test/helpers.js'` |

### How to apply

When adding a public export, edit `index.js` AND verify `npm run test:all` (which runs `test/test-stability-contract.js`); the test fails closed if the surface drifts. To consume nightfoundry from another package, import only from the bare specifier `nightfoundry` — never `nightfoundry/src/...`.

### Related

`test/test-stability-contract.js` (the pinned mechanical contract) and `docs/STABILITY-CONTRACT.md` (the human-readable mirror). These two files together replace what would otherwise be a runbook — per Rule 11, the contract lives in code, not in prose.

---

## What this document is NOT

This is not a style guide. This is not a list of best practices. This is the minimum set of rules whose violation has cost us real money in real dogfoods. Every rule here is backed by at least one commit SHA you can inspect.

If you find yourself wanting to add a rule to this document, the bar is: **a real bug from a real dogfood has demonstrated the absence of the rule**. Speculation does not qualify.
