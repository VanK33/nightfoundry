---
name: nightfoundry-operator
description: Operate the nightfoundry CLI on behalf of a user — map a plain-language request to the correct files to read and the correct command to run. Use when the user wants to run a spec through the loop, inspect why a run parked, resolve a parked entry, check cost/usage, or work with the queue and archives — typically from a separate terminal while nightfoundry runs in another. Triggers on mentions of nightfoundry, "the run", queue/park/archive state, or "what happened / why did it park / resolve it".
---

# nightfoundry operator

Drive the `nightfoundry` CLI for a user: read state to understand what happened, then run the right command. The user typically has nightfoundry running in one terminal and talks to you in another.

## Invocation

Use `nightfoundry <command>` (the installed bin). If it is not on PATH in this checkout, fall back to `node src/cli/index.js <command>` from the repo root, or `npx nightfoundry <command>`.

## Golden rules

1. **Never invent a command or flag.** The exact, code-grounded command surface is in [references/commands.md](references/commands.md). If you are not certain a command/flag exists, read that file — a hallucinated command is the main failure mode this skill exists to prevent.
2. **Confirm before costly or destructive actions.** `run` spends real model tokens; `park resolve --reject` / `queue remove` drop a queue entry. State the command and what it will do, and confirm, before running it.
3. **Report, don't guess.** If state is ambiguous, say what you read and what's missing rather than running a command on a hunch.
4. **Never invoke the CLI from inside a session it spawned itself** — re-entering against the same project root can corrupt a live run's state.

## The loop in one paragraph

`nightfoundry run <spec.md>` takes a spec triple (`<name>.spec.md` + `<name>.spec.json` + a sealed acceptance exam printing PASS/FAIL lines), preflights it (clean tree + envelope limits), runs a single executor session, then grades mechanically (exam + full suite + scope diff). Red grades enter a bounded red loop (in-place fix → fresh redo → park). Exit codes: 0 delivered (archived under `archives/`), 1 argument error, 2 parked, 3 preflight refusal.

## Intent → (read, then run)

| User wants | Read first | Command |
|---|---|---|
| Run a spec | the spec `.md` (+ its `.spec.json` and exam) | `nightfoundry run <spec.md>` (`--model <id>`, `--suite <cmd>`) |
| Find why a run parked | `nightfoundry park list` | `nightfoundry park show <slug>` |
| Resolve a parked entry | `nightfoundry park show <slug>` | `nightfoundry park resolve <slug> --requeue\|--waive\|--reject\|--approve [--note "..."]` |
| See queued work | — | `nightfoundry queue list` |
| Drop / reset a queue entry | `nightfoundry queue list` | `nightfoundry queue remove <slug>` / `queue retry <slug>` |
| Check cost across runs | `archives/*/record.json` | `nightfoundry usage --all` (`--last N`, `--since DATE`, `--include-failed`) |
| Compare two runs' cost | — | `nightfoundry usage compare <a> <b>` |
| Check install/config health | — | `nightfoundry health` |

## Reference files

Read these on demand — do not load them all upfront:

- **[references/commands.md](references/commands.md)** — the full, authoritative command + flag surface. Read when you need a flag or a command not covered above, or to confirm one exists.
- **[references/state-layout.md](references/state-layout.md)** — the on-disk map (`queue/`, `archives/`, park refs). Read to interpret raw state files or locate where something is persisted.
- **[references/gotchas.md](references/gotchas.md)** — preconditions, silent no-ops, and footguns. Read before non-obvious operations or when a command appears to do nothing.
- **[references/spec-authoring.md](references/spec-authoring.md)** — the spec-triple authoring contract. Read before hand-writing a spec, or when `run` refuses one.
- **[references/debugging.md](references/debugging.md)** — symptom-driven diagnostic flows. Read when something looks wrong.
