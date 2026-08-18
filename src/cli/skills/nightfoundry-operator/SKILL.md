---
name: nightfoundry-operator
description: Operate the nightfoundry CLI (`nightfoundry`, with `cc-orch` as a permanent alias) on behalf of a user — map a plain-language request to the correct files to read and the correct command to run. Use when the user wants to drive a nightfoundry run/batch, check on or resume a run, inspect why a run stopped, resolve a parked/halted entry, brainstorm a spec, check cost/usage, or work with the queue, archives, parks, or reviewer warnings — typically from a separate terminal while nightfoundry runs in another. Triggers on mentions of nightfoundry, cc-orch, the orchestrator, "the run/batch", .harness state, queue/park/archive/warnings, or "what is it doing / why did it stop / resume it".
---

# nightfoundry operator

Drive the `nightfoundry` CLI for a user: read state to understand what is happening, then run the right command. The user typically has nightfoundry running in one terminal and talks to you in another.

## Invocation

Use `nightfoundry <command>` (the installed bin). `cc-orch <command>` remains a permanent alias that resolves to the same CLI with identical behavior. If neither is on PATH in this checkout, fall back to `node src/cli/index.js <command>` from the repo root, or `npx nightfoundry <command>`. All of these are equivalent — `bin.nightfoundry` (and its `cc-orch` alias) point at `src/cli/index.js`.

## Golden rules

1. **Read state before acting.** Before any state-changing command (`run`, `resume`, `archive`, `park resolve`, `clean`), read the run's state — the per-run harness dir under the active-run pointer, with the flat `.harness/state.json` root as fallback when no run is active — for `globalStatus`, and run `nightfoundry status` to know what state the run is actually in. Don't resume a run you haven't inspected.
2. **Never invent a command or flag.** The exact, code-grounded command surface is in [references/commands.md](references/commands.md). If you are not certain a command/flag exists, read that file — a hallucinated command is the main failure mode this skill exists to prevent.
3. **Mind preconditions.** Most run-state commands need that state (the per-run harness dir under the active-run pointer, or the flat `.harness/` root as fallback) to exist first; `run` and `dry-run` require a git repo with a clean working tree. The full precondition/footgun list is in [references/gotchas.md](references/gotchas.md).
4. **Confirm before destructive or costly actions.** `run`/`resume` spend real model tokens; `clean` deletes state; `park resolve --reject` drops a queue entry. State the command and what it will do, and confirm, before running it.
5. **Report, don't guess.** If state is ambiguous (e.g. a halt with no park scene), say what you read and what's missing rather than running a command on a hunch.
6. **Respect read-only mode.** By default, this skill may run state-changing commands with per-action confirmation, as described above. The operator may instead declare the session read-only; once they do, read state and surface the commands the operator would need to run, but do not run any state-changing command yourself. Note that this supersedes any earlier guidance you may have seen framed only as "never invoke a state-changing command from inside a session" — the actual, current rule is the confirm-by-default / read-only-on-declaration split above. Relatedly, and always in force regardless of mode: never invoke the CLI — whether as `nightfoundry` or via its permanent `cc-orch` alias — from inside a session that it itself spawned — a live run stamps its child processes, and re-entering against the same project root can corrupt that run's state, no matter which invocation name you use.

## The operating loop

1. **Read** the run's state — the per-run harness dir under the active-run pointer, with the flat `.harness/state.json` root as fallback when no run is active — `globalStatus` tells you the macro state (see table below).
2. **Determine intent** from the user's request.
3. **Read the right files** for that intent (see the routing table; details in [references/state-layout.md](references/state-layout.md)).
4. **Run the right command** (verify it against [references/commands.md](references/commands.md) if unsure).

## "What is it doing / why did it stop?" — read globalStatus first

`globalStatus`, read from the run's state (the per-run harness dir under the active-run pointer, with the flat `.harness/state.json` root as fallback when no run is active):

| globalStatus | Meaning | What to do |
|---|---|---|
| `active` | Run in progress (or crashed mid-run) | `nightfoundry status` for the milestone/mission/task tree |
| `complete` | Run finished, not yet archived | `nightfoundry archive` to release it |
| `archived` | Already archived | `nightfoundry archive list` / `show <id>` |
| `halted-review` | Waiting for human diff review of a milestone | `nightfoundry review` (accept/reject) |
| `halted-analyzer` | Escalated to analyzer after repeated task failures | `nightfoundry park list` / `park show <slug>`, then `nightfoundry resume` |
| `parked` | A queue entry paused at an operator gate | `nightfoundry park show <slug>` then `park resolve <slug> --requeue|--waive|--reject` |

For batch runs, also check `nightfoundry queue list` (per-entry status) and `nightfoundry park list`. The full status vocabulary and on-disk locations are in [references/state-layout.md](references/state-layout.md).

## Intent → (read, then run)

The heart of this skill. Match the user's request to a row; read the listed files first, then run the command. Verify any unfamiliar flag against [references/commands.md](references/commands.md).

| User wants | Read first | Command |
|---|---|---|
| Run a spec | the spec `.md` | `nightfoundry run <spec.md>` (add `-a` for unattended) |
| Plan/validate a spec without running | the spec `.md` | `nightfoundry dry-run <spec.md>` (queues it as `validated`) |
| Generate a spec from an idea | — | `nightfoundry brainstorm "<prose>"` (interactive; produces `<slug>.spec.md` + `.json`) |
| Hand-write a spec without brainstorm | [references/spec-authoring.md](references/spec-authoring.md) | `nightfoundry dry-run <spec.md>` (validates it), then `nightfoundry run <spec.md>` |
| Run a one-off change without a spec | — | `nightfoundry task "<description>"` |
| Resume a stopped single run | run state (per-run harness dir under the active-run pointer; flat `.harness/state.json` root as fallback) | `nightfoundry resume` (add `-a` for unattended) |
| Run the whole batch queue | `nightfoundry queue list` | `nightfoundry resume --batch` (add `-a`) |
| See current progress | run state (per-run harness dir under the active-run pointer; flat `.harness/state.json` root as fallback), mission files | `nightfoundry status` (or `status <mission-id>`) |
| Find why a batch stopped | `globalStatus`, `nightfoundry queue list` | `nightfoundry park list` → `park show <slug>` |
| Resolve a parked entry | `nightfoundry park show <slug>` | `nightfoundry park resolve <slug> --requeue\|--waive\|--reject [--note "..."]` |
| Review staged candidates | — | `nightfoundry review` |
| Check cost of the live run | `.harness/logs/token-usage.json` | `nightfoundry usage` (add `--detailed`) |
| Check cost across past runs | `archives/*/manifest.json` | `nightfoundry usage --all` (`--last N`, `--since DATE`, `--include-failed`) |
| List / inspect past runs | `archives/` | `nightfoundry archive list` → `archive show <id>` (`--report` opens HTML) |
| Compare two runs | two `archives/<id>/manifest.json` | `nightfoundry archive diff <a> <b>` |
| Triage a failed run | `archives/failed-*/` | `nightfoundry archive show failed-<id>` |
| Work reviewer warnings | `archives/warnings.jsonl` | `nightfoundry warnings list` → `resolve <id> --waive\|--defer\|--done`, or `warnings brainstorm <id...>` |
| Archive a finished run | run state (per-run harness dir under the active-run pointer; flat `.harness/state.json` root as fallback), `globalStatus` `complete` | `nightfoundry archive` (`-P` keeps the spec; `--skip-test-gate` skips final tests) |
| Start the web UI | — | `nightfoundry ui` (`--port N`, default 3939) |
| Wipe local run state | run state (per-run harness dir under the active-run pointer; flat `.harness/state.json` root as fallback) | `nightfoundry clean` (offers archive-first; `--force` skips prompts) |

## Interactive commands

`brainstorm`, `run`/`resume` without `-a`, `review`, and `park resolve` prompts are interactive (they read from the terminal). When the user wants an unattended run, pass `-a`/`--auto`. Do not pipe canned input to an interactive command expecting a specific question — the questions are dynamic; let the user answer, or use `-a`.

**One reply per prompt — no multi-line paste.** When the user is answering `brainstorm`'s questions (or any interactive prompt), remind them to enter ONE answer at a time and press Enter. Do NOT paste a multi-line block, or several answers, in one go. The prompt reads one line per question, so a pasted multi-line answer is split line-by-line: later lines shift onto the *following* questions (answer↔question misalignment) and the overflow spills into the accept/regenerate menu as `Unknown command`. If a single answer is genuinely long, keep it on one line. One trunk per reply.

## Reference files

Read these on demand — do not load them all upfront:

- **[references/commands.md](references/commands.md)** — the full, authoritative command + flag surface (every command, subcommand, flag, what it reads/writes, and which need `.harness`/git). Read when you need a flag or a command not covered above, or to confirm one exists.
- **[references/state-layout.md](references/state-layout.md)** — the on-disk map (`.harness/`, `queue/`, `archives/`, `refs/park/`, brainstorm drafts), the `state.json` shape, and the full `globalStatus` / queue-status vocabularies. Read to interpret raw state files or locate where something is persisted.
- **[references/gotchas.md](references/gotchas.md)** — preconditions, silent no-ops, and footguns (git guard, unresumable state, deprecated `--no-review`, `usage --include-failed` needing `--all`, batch force-reinit, etc.). Read before non-obvious operations or when a command appears to do nothing.
- **[references/spec-authoring.md](references/spec-authoring.md)** — the hand-written spec authoring contract: the six-section skeleton, sibling `.spec.md`/`.spec.json` naming, and the declared-set contract. Read before hand-writing a spec without `brainstorm`, or when `run`/`dry-run` rejects a hand-written spec.
- **[references/debugging.md](references/debugging.md)** — symptom-driven diagnostic flows (observed symptom → state file(s) to read → command to run) for a run that looks stalled, stuck, or otherwise misbehaving. Read when something looks wrong but the standard status table above doesn't explain it.
