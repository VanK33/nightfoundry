# nightfoundry command surface (authoritative)

Every command and flag below is read from `src/cli/index.js` on the v0.3 surface. If a command or flag is not listed here, it does not exist — do not invent one.

Global options (all commands): `-p, --project <path>` project root (default: cwd); `-j, --json` JSON output where supported.

## run

```
nightfoundry run <spec.md> [--model <id>] [--suite <cmd>]
```

Runs the v0.3 loop on a spec triple: preflight (clean tree + envelope limits) → single executor session → mechanical grading (sealed exam + full suite + scope diff) → red loop (in-place fix → fresh redo → park) → archive on green.

- Requires: the spec `.md`, its sibling `<name>.spec.json`, and a sealed acceptance exam. Self-sufficient on a bare checkout — creates `queue/` and `archives/` on demand.
- `--model <id>` overrides the executor model.
- `--suite <cmd>` overrides the full-suite command used for grading.
- Exit codes: `0` delivered (archived), `1` argument error, `2` parked, `3` preflight refusal.

## park

```
nightfoundry park list
nightfoundry park show <slug>
nightfoundry park resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]
```

- `list` — list parked queue entries (`-j` for JSON).
- `show <slug>` — print a parked entry's scene (park reason, refs, spec paths).
- `resolve <slug>` — exactly one action flag required; `--note` attaches an operator note.

## queue

```
nightfoundry queue list
nightfoundry queue remove <slug>
nightfoundry queue retry <slug>
```

- `list` — list queue entries with status (`-j` for JSON).
- `remove <slug>` — delete a queue entry.
- `retry <slug>` — reset an entry's status to pending.

## usage

```
nightfoundry usage [-j] [-d] [--role R] [--all] [--last N] [--since YYYY-MM-DD] [--include-failed] [--task <id>]
nightfoundry usage compare <a> <b>
```

- Without `--all`: reads the live `.harness/state.json` run (errors if none).
- `--all` — aggregate across `archives/`. `--include-failed` implies `--all`.
- `--last N` / `--since DATE` — window the aggregation. `--role R` filters by session role.
- `-d, --detailed` — per-session detail (live path only).
- `compare <a> <b>` — compare token usage between two archives.

## health

```
nightfoundry health
```

Prints install/configuration health.

## version / help

```
nightfoundry version
nightfoundry help
```

## Removed in v0.3

The v0.2 multi-agent pipeline verbs — `run` (old pipeline semantics), `dry-run`, `resume`, `status`, `brainstorm`, `archive`, `init`, `review`, `warnings`, `ui`, `dispersion`, `clean`, `reset`, `task` — no longer exist. `run` now names the v0.3 loop described above. The `cc-orch` alias was removed; the only binary name is `nightfoundry`.
