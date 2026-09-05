# nightfoundry debugging flows

Symptom-driven diagnostic paths for a run that looks stopped, stuck, or otherwise misbehaving. Each flow below follows the same shape: **observed symptom → state file(s) to read → command to run**. For the preconditions and footguns of any command mentioned here, see [gotchas.md](gotchas.md) — that file is the canonical home for per-command sharp edges, so this chapter does not repeat them.

## Contents
- [How to use this chapter](#how-to-use-this-chapter)
- [Flow a: run looks stalled, no visible progress](#flow-a-run-looks-stalled-no-visible-progress)
- [Flow b: run is waiting on a human review gate](#flow-b-run-is-waiting-on-a-human-review-gate)
- [Flow c: run escalated after repeated task failures](#flow-c-run-escalated-after-repeated-task-failures)
- [Flow d: a queued spec never seems to advance](#flow-d-a-queued-spec-never-seems-to-advance)
- [Flow e: reported cost or usage looks wrong](#flow-e-reported-cost-or-usage-looks-wrong)
- [Flow f: a command exits cleanly but nothing changed](#flow-f-a-command-exits-cleanly-but-nothing-changed)
- [Flow g: regression verdict looks weaker than expected after a purity strip](#flow-g-regression-verdict-looks-weaker-than-expected-after-a-purity-strip)

## How to use this chapter

Start from what you actually observe (a stalled terminal, a strange status, a cost number that doesn't add up), match it to the closest flow a-f, read the listed state file(s) first to confirm the diagnosis, then run the listed command. Flows are ordered roughly from "nothing is happening" toward "something happened but not what was expected."

## Flow a: run looks stalled, no visible progress

- **Symptom:** the run appears to have stopped; no new task activity, and the operator is unsure whether it crashed, halted, or is simply slow.
- **Read:** `.harness/state.json` for `globalStatus` and the milestone/mission tree; the relevant `.harness/state/mission-*.json` for per-task status.
- **Act:** if `globalStatus` is `active`, run `nightfoundry status` to confirm which task is in flight before assuming it is stuck. If it is genuinely halted, run `nightfoundry resume` to continue from the persisted state.

## Flow b: run is waiting on a human review gate

- **Symptom:** the run stopped and nothing seems to be executing, but it isn't reporting an error.
- **Read:** `.harness/state.json` `globalStatus` (look for `halted-review`).
- **Act:** run `nightfoundry review` to enter the interactive accept/reject/edit loop for the staged candidates blocking progress.

## Flow c: run escalated after repeated task failures

- **Symptom:** a task kept failing verification and the run stopped advancing on its own.
- **Read:** `.harness/state.json` `globalStatus` (look for `halted-analyzer`); the parked scene at `refs/park/<slug>/scene.json` and `refs/park/<slug>/park.json` for why it escalated and any operator notes.
- **Act:** run `nightfoundry park show <slug>` to see the full context, then `nightfoundry park resolve <slug>` with `--requeue`, `--waive`, or `--reject` to move it forward.

When it is a single task that keeps repeatedly failing verification and tripping the circuit breaker, `nightfoundry reset <taskId>` gives that task a fresh chance: it clears the task's `retryCount` (returning its status to `pending`), the canonical `replanAttempts` entry for the task, the analyzer history file for that task, and the task's snapshot directory. Run it ONLY when no run process is live — it mutates on-disk state that a live run also reads and writes, so running it concurrently with an active run can corrupt state. This is distinct from the entry-level `nightfoundry queue retry <slug>`, which resets a whole queue ENTRY's status so `nightfoundry resume --batch` picks it up again; `nightfoundry reset <taskId>` operates one level down, on a single task within a run, and the two are complementary rather than interchangeable.

## Flow d: a queued spec never seems to advance

- **Symptom:** a spec was queued for batch processing but its status doesn't seem to change over time.
- **Read:** `queue/<slug>/status` for its current one-line status, and `queue/<slug>/plan.json` for the plan that was built at validation time.
- **Act:** run `nightfoundry queue list` to see all entries and their statuses at a glance; if an entry is `parked`, `halted-review`, or `halted-analyzer`, follow flow b or c above via `nightfoundry park show <slug>` first.

## Flow e: reported cost or usage looks wrong

- **Symptom:** `nightfoundry usage` reports a number that seems too low, too high, or missing entirely for a run the operator expects to have cost something.
- **Read:** `.harness/logs/token-usage.json` for the live, in-progress run; `archives/<id>/manifest.json` for a completed run's recorded `totalCost`/`totalSessions`.
- **Act:** run `nightfoundry usage` for the active run, or `nightfoundry usage --all` to aggregate across archives. Confirm the run hasn't already been archived — cost is reported at archive time, not after.

## Flow f: a command exits cleanly but nothing changed

- **Symptom:** a command ran without any error, but the expected effect (a filter applied, a gate skipped, a state change) doesn't show up afterward.
- **Read:** the state file the command is supposed to affect (for example `.harness/state.json`, `archives/<id>/manifest.json`, or `archives/warnings.jsonl`) to confirm whether the effect actually happened.
- **Act:** re-check the exact flags used against [gotchas.md](gotchas.md), which catalogs the known silent no-ops and footguns per command, then re-run with the corrected flags.

## Flow g: regression verdict looks weaker than expected after a purity strip

- **Symptom:** a regression verdict reads differently than the verifier seemed to intend — certain checks the verifier wrote are simply absent from the verdict, and it looks like it was quietly downgraded.
- **Read:** `archives/warnings.jsonl` for an entry under the literal category `regression-purity-strip` describing which check(s) were removed and why; then the matching regression verdict sidecar under `.harness/verification/`, which carries the cleaned verdict alongside its `strippedChecks` record of what was taken out.
- **Act:** the strip removes only verifier-authored assertions about modification status or working-tree cleanliness — an only-X-modified assertion, a no-other-files-changed assertion, or git-status/git-diff cleanliness or modified/untracked wording — because those are not meaningful regression checks. Confirm the stripped check(s) match one of those shapes in the warnings ledger entry, then evaluate the verdict on its remaining, legitimate checks.
