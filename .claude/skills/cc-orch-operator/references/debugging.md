# cc-orch debugging flows

Symptom-driven diagnostic paths for a run that looks stopped, stuck, or otherwise misbehaving. Each flow below follows the same shape: **observed symptom → state file(s) to read → command to run**. For the preconditions and footguns of any command mentioned here, see [gotchas.md](gotchas.md) — that file is the canonical home for per-command sharp edges, so this chapter does not repeat them.

## Contents
- [How to use this chapter](#how-to-use-this-chapter)
- [Flow a: run looks stalled, no visible progress](#flow-a-run-looks-stalled-no-visible-progress)
- [Flow b: run is waiting on a human review gate](#flow-b-run-is-waiting-on-a-human-review-gate)
- [Flow c: run escalated after repeated task failures](#flow-c-run-escalated-after-repeated-task-failures)
- [Flow d: a queued spec never seems to advance](#flow-d-a-queued-spec-never-seems-to-advance)
- [Flow e: reported cost or usage looks wrong](#flow-e-reported-cost-or-usage-looks-wrong)
- [Flow f: a command exits cleanly but nothing changed](#flow-f-a-command-exits-cleanly-but-nothing-changed)

## How to use this chapter

Start from what you actually observe (a stalled terminal, a strange status, a cost number that doesn't add up), match it to the closest flow a-f, read the listed state file(s) first to confirm the diagnosis, then run the listed command. Flows are ordered roughly from "nothing is happening" toward "something happened but not what was expected."

## Flow a: run looks stalled, no visible progress

- **Symptom:** the run appears to have stopped; no new task activity, and the operator is unsure whether it crashed, halted, or is simply slow.
- **Read:** `.harness/state.json` for `globalStatus` and the milestone/mission tree; the relevant `.harness/state/mission-*.json` for per-task status.
- **Act:** if `globalStatus` is `active`, run `cc-orch status` to confirm which task is in flight before assuming it is stuck. If it is genuinely halted, run `cc-orch resume` to continue from the persisted state.

## Flow b: run is waiting on a human review gate

- **Symptom:** the run stopped and nothing seems to be executing, but it isn't reporting an error.
- **Read:** `.harness/state.json` `globalStatus` (look for `halted-review`).
- **Act:** run `cc-orch review` to enter the interactive accept/reject/edit loop for the staged candidates blocking progress.

## Flow c: run escalated after repeated task failures

- **Symptom:** a task kept failing verification and the run stopped advancing on its own.
- **Read:** `.harness/state.json` `globalStatus` (look for `halted-analyzer`); the parked scene at `refs/park/<slug>/scene.json` and `refs/park/<slug>/park.json` for why it escalated and any operator notes.
- **Act:** run `cc-orch park show <slug>` to see the full context, then `cc-orch park resolve <slug>` with `--requeue`, `--waive`, or `--reject` to move it forward.

## Flow d: a queued spec never seems to advance

- **Symptom:** a spec was queued for batch processing but its status doesn't seem to change over time.
- **Read:** `queue/<slug>/status` for its current one-line status, and `queue/<slug>/plan.json` for the plan that was built at validation time.
- **Act:** run `cc-orch queue list` to see all entries and their statuses at a glance; if an entry is `parked`, `halted-review`, or `halted-analyzer`, follow flow b or c above via `cc-orch park show <slug>` first.

## Flow e: reported cost or usage looks wrong

- **Symptom:** `cc-orch usage` reports a number that seems too low, too high, or missing entirely for a run the operator expects to have cost something.
- **Read:** `.harness/logs/token-usage.json` for the live, in-progress run; `archives/<id>/manifest.json` for a completed run's recorded `totalCost`/`totalSessions`.
- **Act:** run `cc-orch usage` for the active run, or `cc-orch usage --all` to aggregate across archives. Confirm the run hasn't already been archived — cost is reported at archive time, not after.

## Flow f: a command exits cleanly but nothing changed

- **Symptom:** a command ran without any error, but the expected effect (a filter applied, a gate skipped, a state change) doesn't show up afterward.
- **Read:** the state file the command is supposed to affect (for example `.harness/state.json`, `archives/<id>/manifest.json`, or `archives/warnings.jsonl`) to confirm whether the effect actually happened.
- **Act:** re-check the exact flags used against [gotchas.md](gotchas.md), which catalogs the known silent no-ops and footguns per command, then re-run with the corrected flags.
