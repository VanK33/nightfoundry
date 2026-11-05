# Hand-written spec authoring contract

How to write a `<slug>.spec.md` + `<slug>.spec.json` pair by hand, without going through `nightfoundry brainstorm`. Read this before hand-writing a spec, and whenever `run`/`dry-run` rejects a spec you wrote yourself.

## Contents
- [(a) The six-section spec skeleton](#a-the-six-section-spec-skeleton)
- [(b) Sibling `.spec.md` / `.spec.json` naming](#b-sibling-specmd--specjson-naming)
- [(c) The declared-set contract](#c-the-declared-set-contract)
- [(d) Ripple files](#d-ripple-files)
- [(e) The `plan_structure` field](#e-the-plan_structure-field)
- [(f) Check-shape](#f-check-shape)
- [(g) Smoke vs full test-run semantics and assumption-safe wording](#g-smoke-vs-full-test-run-semantics-and-assumption-safe-wording)

## (a) The six-section spec skeleton

A hand-written spec's markdown file follows one six-section skeleton, in this order. Copy this verbatim and fill in the blanks:

```markdown
# Spec: <short title>

## Goal

<one paragraph: what outcome this spec delivers and why>

## Scope — in

1. **<short label for change 1>** — <what behavior changes>
   - path/to/file/one.js
   - path/to/file/two.js
2. **<short label for change 2>** — <what behavior changes>
   - path/to/file/three.js

## Scope — out

- <something explicitly NOT being changed by this spec>

## Constraints

- <a rule the plan/implementation must respect>

## Acceptance criteria

1. <description of what "done" looks like>
   - Evidence: `<a command that proves it, or the file to inspect>`

## Architecture notes

<any grounding facts an implementer needs — current state, existing helpers to reuse, things already verified true>
```

Each `## Scope — in` entry MUST use the numbered-bold shape — `N. **<label>** — <behavior>` followed by indented file bullets (`   - <path>`) — because this is the exact shape the scope-parsing and scope-coverage gates read back out. Free-form prose in `## Scope — in` will not be recognized as scope items. `## Scope — out` is optional but recommended whenever there's an adjacent file or behavior a reader might otherwise assume is in scope.

A `## Scope — in` numbered-bold item's label may start with a `[context]` marker to flag it as existing behavior the plan builds on, rather than new work the plan must implement:

```markdown
N. **[context] label** — existing behavior the plan builds on; no mission will be required
   - path/to/file/existing.js
```

The marker is the exact literal `[context]` at the start of the bold label, matched case-insensitively, and it must be followed by whitespace — so `**[context]foo**` (no whitespace after the marker) is NOT recognized as a context item and is instead read as an ordinary label starting with the literal text `[context]foo`. The marker is only recognized on `## Scope — in` numbered-bold items; the label the plan sees has the marker stripped out. A context item is exempt from the requirement that every scope id be mapped to a mission — no mission or task will be created for it. However, a context item's indented file sub-bullets still project into `target_files` / the declared-authorized file set exactly like any other scope file bullet, so other missions may legitimately touch those files.

## (b) Sibling `.spec.md` / `.spec.json` naming

A hand-written spec is always a pair of sibling files sharing one slug, both at the project root (not nested under a state directory):

| File | Role |
|---|---|
| `<slug>.spec.md` | Human-readable narrative — the six-section document from (a). What a reviewer reads. |
| `<slug>.spec.json` | The structured, authoritative fields: `goal`, `target_files`, `acceptance_criteria`, `constraints`, `architecture_notes`, and optionally `plan_structure` (see (e)). What the planner reads. |

Pick one slug (e.g. `add-retry-backoff`) and name both files from it: `add-retry-backoff.spec.md` and `add-retry-backoff.spec.json`. Pass the `.md` path to `nightfoundry run` / `nightfoundry dry-run` — the tool locates the sibling `.json` automatically from that path. Keep the two files in agreement: if you edit the `.md` scope after writing the `.json`, update `target_files` and `acceptance_criteria` to match, or the two will silently diverge.

## (c) The declared-set contract

Every file your spec's goal implies will be touched must be **declared** — listed in `target_files` in the `.json`, or named as a path token inside a command-shaped acceptance-criterion's verification command. Together these form the declared set.

At plan time, the plan-scope lint compares every file a planned task would touch against this declared set. A task that targets a path outside the declared set is a **hard scope excursion** and the plan is rejected before any work starts — the tool refuses to let a run silently touch a file your spec never mentioned.

Practical rule: if the goal or scope text implies a file changes, put that file's path in `target_files` (or in a `## Scope — in` file sub-bullet, which projects into `target_files`). Don't rely on an implementer to infer an unlisted file from prose alone.

Hard rule: `target_files` must never include a `.claude/**` path. Session-owned config under `.claude/` cannot be edited by an agent session — it only refreshes via `nightfoundry init` — so a spec must never declare it as a target.

## (d) Ripple files

Some files are not the "main" edit but are changed as a necessary side effect of it — call these ripple files. Common examples:

- A package/module barrel file with an explicit export list (e.g. an `__init__.py` with `__all__`, or an `index.js` re-export list) that must add the new symbol alongside the primary file.
- A shared test-fixture or configuration file (e.g. `conftest.py`) that every test in a directory implicitly depends on.
- A central registration manifest that lists every file of its kind (e.g. a test-suite runner's registration list) that must gain an entry for a newly added file.

Ripple files are real scope, not accidental scope. Declare them the same way as any other target file (see (c)) — list them in `target_files`, or in the relevant `## Scope — in` entry's file bullets — so the declared-set contract doesn't reject the task that has to touch them.

If the same ripple pair recurs across specs, declare it once via `scope.coupledFiles` (see (g)) instead of re-listing the coupled file in every spec.

## (e) The `plan_structure` field

`plan_structure` is an optional object in `<slug>.spec.json`:

```json
{
  "plan_structure": {
    "max_milestones": 1,
    "max_missions": 1,
    "max_tasks_per_mission": 1,
    "max_tasks": 1
  }
}
```

| Field | Meaning |
|---|---|
| `max_milestones` | Upper bound on the number of milestones the plan may contain. |
| `max_missions` | Upper bound on the total number of missions across the whole plan. |
| `max_tasks_per_mission` | Upper bound on the number of tasks within a single mission's plan. |
| `max_tasks` | Upper bound on the plan-wide total task count. |

These four fields behave in three distinct ways. `max_milestones` and `max_missions` remain opt-in: when `plan_structure` is absent, or present but malformed (not an object, or non-integer fields), that leg is skipped entirely and no cap is enforced — e.g. use `{ "max_milestones": 1, "max_missions": 1 }` to pin a small, single-mission change and get an early, clear failure instead of an unexpectedly large decomposition. `max_tasks_per_mission` is always-on: when absent, the engine default of 24 applies; an integer overrides that default; and the literal `null` disables the leg. It is checked against a mission's actual task count, and the planner gets one corrective retry turn on a breach. `max_tasks` is off by default: when absent, the engine default `null` means no plan-wide cap; an integer enables the guaranteed-breach floor at planGlobal, where a mission count exceeding the cap cannot fit even at one task per mission. That breach is not retryable and fails the plan directly, so dry-run rejects such a spec.

**Set caps as a runaway fuse, not a prescription: leave roughly 2x headroom over the decomposition you expect.** The planner's grouping instincts legitimately differ from a spec author's guess — it may split by src-vs-test, or emit one mission per scope item — and a cap written to the exact expected shape turns that ordinary variance into a hard failed-plan, with every retry re-paying the full baseline gate. That same 2x-headroom guidance applies to the task dimension too: `max_tasks_per_mission` and `max_tasks` should leave roughly 2x headroom over the task count you expect a mission (or the whole plan) to actually need, for the same reason — a planner may reasonably split work into more tasks than a spec author's guess, and a tight task cap turns that variance into an avoidable failed-plan. Reserve the tight `{ "max_milestones": 1, "max_missions": 1 }` pin for changes that genuinely touch a single file in a single mission.

Measured calibration: observed single-mission task maxima on successful runs were 17, 16, and 14, while a run that hit a task cap and failed reached 19 — the basis for the engine default of 24 on `max_tasks_per_mission`.

## (f) Check-shape

Each acceptance criterion carries a `verification` with one of three kinds:

| kind | Shape | When to use |
|---|---|---|
| `command` | `{ kind: 'command', command, targetFile }` | The criterion is provable by running a command against a specific file (e.g. a test file). |
| `file-check` | `{ kind: 'file-check', targetFile }` | The criterion is provable just by a file's existence/content, no command needed. |
| `manual` | `{ kind: 'manual', manualSteps }` | The criterion can't be automated — describe the steps a human would follow. |

Write evidence so it's checkable: a bare path (`path/to/file.js`) becomes `file-check`; a runnable line (`node test/thing.js`, `npm test`, or a `&&`-chained command that names a file) becomes `command`; anything else falls back to `manual`.

Keep every check scoped to its own task's declared files: a check should assert the content or behavior of the file(s) that task is responsible for, not the state of the tree as a whole. Phrasing like "only these files were modified" or "no other files changed" is a tree-wide assertion and is rejected by the structural lint — write instead what the task's own file now does or contains. (A behavioral verb or arrow — e.g. "returns", "throws", "→" — in the check text is fine and doesn't trigger this rejection; so is a tree-state phrase that appears strictly inside a backtick-quoted literal, e.g. quoting an error message.)

## (g) Smoke vs full test-run semantics and assumption-safe wording

**Two test commands, two purposes:**

| Command | Scope | When it runs |
|---|---|---|
| `testCommand` | A fast smoke subset (a small, quick slice of the suite) | Per-milestone, as a cross-check during a run |
| `testAllCommand` | The full test suite | Once, as the final gate before a run is archived |

Both are configurable per project — create an optional `.nightfoundry.json` file at the project root with an `execution.testCommand` / `execution.testAllCommand` override if your project's test entry points aren't the defaults. `.nightfoundry.json` is still honored forever as a fallback location for this same override; when both files exist, `.nightfoundry.json` takes precedence, and the loader emits a single non-fatal warning noting that both are present. The loader is fail-loud: an unrecognized key, or a non-string/empty command value, raises an error naming the file and the offending key rather than silently ignoring a typo. When writing acceptance criteria, prefer the smoke command for fast per-change evidence and reserve the full command for a criterion that genuinely needs the whole suite green.

**Run-wide spend ceiling:** the same `.nightfoundry.json` file also supports a `budgets.runCeilingUsd` override. `.nightfoundry.json` is still honored forever as a fallback for this override too; `.nightfoundry.json` takes precedence when both exist, and the both-present case emits a single non-fatal warning. This caps *cumulative* USD spend across all agent sessions within a single run — distinct from the existing per-session budgets, which cap each individual session's spend on its own. The shipped default is `50`. Setting it to the literal `null` is the off-switch: it disables the ceiling entirely, so the run is never stopped for cumulative spend. Validation is fail-loud exactly like the existing `execution` keys: an unrecognized key inside `budgets`, or a value that is not a positive finite number and not `null`, raises an error naming the file and the offending key rather than silently ignoring a typo. A breach of the ceiling is not surfaced as a code error or bug — it stops the run RESUMABLY: state is saved, the queue entry stays resumable, and no work is lost.

**Coupled-file ripple rules:** the same `.nightfoundry.json` file also supports a `scope.coupledFiles` override — with `.nightfoundry.json` still honored forever as a fallback, `.nightfoundry.json` taking precedence when both exist, and the both-present case emitting a single non-fatal warning — for declaring a recurring ripple pair (see (d)) once instead of re-listing it by hand in every spec that touches one side of the pair — the engine folds the paired file into the spec's declared set (see (c)) for you. Its shape is an array of rule objects, each `{ when, alsoTarget }`, where `when` is a glob string matched against a changed path and `alsoTarget` is an array of path strings to add to the declared set whenever `when` matches — for example, `{ "when": "src/foo/*.js", "alsoTarget": ["src/foo/index.js"] }` couples any direct `.js` file under `src/foo/` to that directory's barrel file. Only two glob metacharacters are recognized in `when`: `*` matches within a single path segment (it does not cross a `/`), and `**` matches across segments; every other character, including `.`, is taken literally — there are no other metacharacters. The pattern is anchored to the full project-root-relative path, written with forward slashes. Expansion happens engine-side and lands only in the spec's declared set — it does NOT expand any mission's `target_files`, which continue to list only what that mission itself is responsible for. Validation is fail-loud exactly like the existing `execution` and `budgets` keys: an unrecognized key inside `scope`, or a malformed rule (missing/wrong-typed `when` or `alsoTarget`), raises an error naming the file and the offending key rather than silently ignoring a typo.

**Assumption-safe wording** — a spec is read by a planner and implementer that treat its claims literally, so:

- Name any file or symbol your spec expects the run itself to create as **to be created** (e.g. "a new file `path/to/new-thing.js`, which does not exist yet") rather than describing it as already present.
- Don't assert facts about files the run's own tooling excludes from its view (for example, a file a `.gitignore`-style rule keeps out of tracked state) — the run cannot confirm a claim about a file it cannot see.
- Frame facts about external systems or tools as context for the reader, not as invariants of the codebase itself — say "the external service returns X" rather than implying the codebase guarantees X.

Getting this wording right matters: an assumption stated as fact that turns out false can trip an assumption gate and halt the run for a wording fix, even when the underlying code change was correct.
