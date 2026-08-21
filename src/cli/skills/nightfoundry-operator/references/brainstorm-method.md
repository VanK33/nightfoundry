# Brainstorm method — eliciting a spec that survives the gates

How to interview a user (or yourself) into a spec whose assumptions hold, whose scope is complete, and whose acceptance criteria the deterministic gates can actually verify. This is the METHOD; the FORMAT contract lives in [spec-authoring.md](spec-authoring.md) — read both before authoring, and follow spec-authoring.md wherever they touch the same ground.

## Frame first, then question

Before asking anything, restate the request in your own words: a paraphrase of what the user wants, what the repo actually shows (read it — do not assume), and an enumerated list of the unknowns. Let the user correct the frame. Most spec failures are frame failures: the author and the repo disagreed about the starting state, and every downstream answer inherited the error.

## One question at a time, each with a stated premise

Ask exactly one question per turn, and state the premise that motivates it ("the request says X but src/y.js does Z — which wins?"). Never batch questions; batched questions get shallow answers and let contradictions slip through unexamined.

Tag each question with the hardening category it serves:

- **ambiguity** — the request has two readings; force the choice now, not at execution time.
- **boundary** — where does the change stop? The file/module the user did not mention but the change plausibly touches.
- **non-goal** — what looks in-scope but is not. Explicit non-goals become `## Scope — out` entries and save the planner from helpful over-reach.
- **failure-scenario** — what does WRONG look like? The answer usually becomes an acceptance criterion or a constraint.
- **inconsistency-challenge** — the request contradicts the repo or itself. Surface with evidence, ask which side wins.

Design decisions with real trade-offs get 2-4 candidates, your lean, and a one-line reason each — then wait for the call. Structural questions with an obvious conventional answer you decide yourself; do not Socratic-method the obvious.

## Enumerate scope from the filesystem, never from memory

When the spec's target-file list is assembled, every entry and every omission must come from a fresh `ls`/grep of the repo, not from recall. Hard-won rules (each one paid for by a failed run):

1. **A directory rename touches every file in the directory** — `find <dir> -type f` and declare them all.
2. **A behavior change breaks the tests that pin the old behavior** — grep the test tree for the literals being changed (names, output strings, file paths) and declare every pinning file. Grep classes get missed: where a prior full-suite run against the change exists, the measured red set outranks any grep.
3. **The planner may NOT extend the declared set itself** — the declared-set contract is an authorization boundary, not a knowledge claim. If the planner will foreseeably need a file, the spec must declare it; instructing the planner to "add files as needed" produces a plan-lint rejection, not flexibility.

## Acceptance criteria the gates can run

Every criterion carries a runnable verification (`command` kind wherever possible). Evidence discipline:

- Prefer `node test/<file>.js` evidence over ad-hoc shell — test files are declared scope and immune to the lint's path-token analysis.
- Grep patterns must not look like file paths (no extensions/slashes in the pattern) — the scope lint cannot tell a search pattern from a file argument.
- `grep -c` passes on ANY match; to assert a count, wrap it: `test "$(grep -c "stem" file)" -ge N`.
- A criterion the spec forbids the milestone from satisfying (e.g. tests deferred to a later milestone while the gate grades against the full spec) makes the milestone structurally unpassable — keep tests and implementation in the same milestone.

## Assumptions: split invariant from post-fix, and mark uncertainty honestly

State assumptions with explicit tense discipline: present-tense facts that hold before and after (invariant), future-tense facts the change will make true (post-fix). An assumption you have not verified against the repo is a parked run waiting to happen — verify it now or mark it uncertain and let the assumption gate decide.
