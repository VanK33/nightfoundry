<!-- legacy: pre-framework, migration-pending -->
<div align="center">

# Night Foundry

**Spec. Verify. Ship. — all in one go**

Trust the delivery, not the demo — hand it a spec, get back a verified diff.

English · [简体中文](./README.zh-CN.md)

**[About](#about) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Recovery & batch](#recovery-batch-and-forensics) · [Why it exists](#why-it-exists) · [Scope](#scope) · [Reference](#reference) · [License](#license)**

</div>


## About

Night Foundry (`nightfoundry` on npm) is an external harness for LLM coding agents. The model writes the code. Every check that decides "done" runs outside it, as plain JavaScript: scope contracts, hard checks, regression, the full test suite. Nothing gets skipped, reworded, or self-graded.

It is not an everything-agent. One loop, done well: spec in → gated, verified delivery out.

## Quickstart

Prereqs: Node.js 18+, a git repo you want to change (JS or Python), and a logged-in Claude Code or `ANTHROPIC_API_KEY`. Runs spend real Anthropic tokens — a small spec costs a few dollars, larger ones more; `nightfoundry usage` reports cost after every run.

Install:

```bash
npm install -g nightfoundry
```

The package installs two equivalent commands, `nightfoundry` and `cc-orch` — they point at the same CLI. Every example below uses `nightfoundry`; `cc-orch` is the same CLI under its long-standing name, so every example works with either.

<details>
<summary>Install from source instead</summary>

```bash
git clone https://github.com/VanK33/nightfoundry.git
cd nightfoundry
npm install
npm link
```

</details>

From inside the repo you want to change:

```bash
# 1. Simplest first run — a one-off change, no spec to write
nightfoundry task "Add input validation to the /api/users endpoint"
```

nightfoundry plans, executes, verifies, and shows the diff. Nothing lands without passing the JS-side gates first.

For anything bigger than a one-liner, give it a **spec**. Two ways:

```bash
# 2a. Write a .uspec.json by hand — seven fields, no engine internals:
#     goal, scope_in, scope_out, success_criteria,
#     constraints, assumptions, architecture_notes
nightfoundry run my-feature.uspec.json -a    # hand-written uspecs run directly (dry-run queues .md specs only)

# 2b. Or generate one from prose (interactive Q&A):
nightfoundry brainstorm "Add rate limiting to all write endpoints"
#   → asks clarifying questions, writes <slug>.spec.md + <slug>.spec.json
```

Then run it:

```bash
nightfoundry dry-run <spec>       # cheap safety check: plan + assumption-check, no execution
nightfoundry run <spec>           # interactive: confirms the plan, shows each diff
nightfoundry run <spec> -a        # auto-approve (headless)
nightfoundry resume --batch -a    # work through the dry-run queue unattended
```

When it finishes: a verified diff, an auto-generated changelog entry, a per-role cost breakdown, and an archived snapshot you can diff against future runs.

## How it works

```
  spec  →  dry-run  →  run / resume --batch  →  archive
 (what)  (plan +      (execute + gate            (version +
         assumptions;  each task; recover;       cost;
         queue)        park on human-only)       diffable)
```

The orchestration lives **outside** the model. Claude sessions are short-lived stateless workers: they get a task, return schema-validated JSON, exit. Everything else — state, gates, invariants — is JavaScript the model can't override. It's a cockpit, not an autopilot: a human owns the decisions, nightfoundry owns the interlocks.

### Gates (each one is code, not a prompt)

A gate is a check the model cannot talk its way past: it runs as ordinary JavaScript at a fixed point in the pipeline, and a red result stops the run. Four of the ten carry the core stance — a green run has to mean something:

<!-- The four rows below are verbatim copies of rows in the full table inside the details block. Edit both together. -->

| Gate | What it enforces |
|---|---|
| **Baseline** | Refuses to spend if the target repo's `test` / `test:all` isn't green before the run starts. |
| **Phantom-write detection** | Denies executors that report "wrote" a file without an actual on-disk change. |
| **Regression** | Mission- and milestone-level regression against pre-task snapshots; failure rolls back the offending mission and preserves sibling work. |
| **Final `test:all` gate** | Blocks archival if the full suite isn't green (override: `nightfoundry archive --skip-test-gate`). |

<details>
<summary>All ten gates, with source paths</summary>

| Gate | What it enforces | Where |
|---|---|---|
| **Baseline** | Refuses to spend if the target repo's `test` / `test:all` isn't green before the run starts. | `src/orchestrator/gates/baseline.js` |
| **Plan-structure lint** | Rejects planner output that violates the mission / milestone / task shape before any execution starts. | `src/orchestrator/gates/plan-structure-lint.js` |
| **Plan-scope lint** | Every task declares the files it will touch; unmatched scope items either fail or warn (per [`--allow-incomplete-scope`](./.claude/skills/nightfoundry-operator/references/commands.md)). | `src/orchestrator/gates/plan-scope-lint.js` |
| **Scope coverage** | Every scope item in the spec must be covered by some task, or the run halts. | `src/orchestrator/gates/scope-coverage.js` |
| **Hard checks** | Per-task deterministic commands from `verify.json` — the task doesn't advance until they pass. | `src/orchestrator/gates/hard-checks.js` |
| **Regression** | Mission- and milestone-level regression against pre-task snapshots; failure rolls back the offending mission and preserves sibling work. | `src/orchestrator/gates/regression.js` |
| **Coverage / audit** | Structural coverage and audit checks on written state. | `src/orchestrator/gates/coverage.js`, `audit.js` |
| **Phantom-write detection** | Denies executors that report "wrote" a file without an actual on-disk change. | `src/orchestrator/core/pipeline.js` |
| **Test-registration circuit breaker** | Trips into analyzer escalation when the same test-registration failure repeats, instead of infinite retry. | `src/orchestrator/gates/test-registration.js` |
| **Final `test:all` gate** | Blocks archival if the full suite isn't green (override: `nightfoundry archive --skip-test-gate`). | `src/cli/commands/archive.js` |

</details>

Design rationale for each gate: [ARCHITECTURE.md](./ARCHITECTURE.md).

Agent I/O is **schema-validated JSON**, not markdown parsing (`src/orchestrator/agents/_schemas.js`). The state machine (`src/orchestrator/core/state-machine.js`) is the only path that can change a task's status. A transient API failure at any gate is retried or leaves the run resumable — it is never recorded as if your code failed.

Every executor write passes a pre-write hook (`src/orchestrator/infra/session-manager.js`) before bytes land. The path must resolve inside the project root and match one of the task's declared target files. A file that already exists must have been Read earlier in the same session. That hook is what backs the guarantee that the model can't write a file it hasn't read, and it is enforced in plain JavaScript, outside the model.

## Recovery, batch, and forensics

The pipeline is designed to survive being interrupted and to leave a trail when it fails:

- **Interrupt-safe.** Ctrl-C, API outage, machine sleep → state is saved. `nightfoundry resume` continues where it left off; completed work stays intact.
- **Batch.** `nightfoundry dry-run` queues a validated spec. `nightfoundry resume --batch -a` works the queue unattended: each spec runs in isolation, a failed spec is reverted, and the queue continues (`nightfoundry queue list`).
- **Park.** When a run hits something only a human can decide (a failed spec assumption, an analyzer escalation, a rejected review), the entry is **parked**, not lost. `nightfoundry park list` shows what's waiting and why; `nightfoundry park resolve <slug> --requeue|--waive|--reject` sends it back with your decision.
- **Non-blocking warnings.** Reviewer findings that don't warrant halting a run land in a ledger (`nightfoundry warnings list`). Batch several into one fix spec with `nightfoundry warnings brainstorm <ids>` when you're ready.
- **Archives.** Every completed run is archived under `archives/<id>/` with the full state, verifier verdicts, reviewer findings, cost breakdown, and an HTML report (`nightfoundry archive show <id> --report`). Diffable across runs (`nightfoundry archive diff a b`, `nightfoundry dispersion`).

## Why it exists

Running a multi-step build inside one long Claude session breaks predictably: context gets compressed and state is lost mid-pipeline; the agent skips its own checks or marks its own work done; and token spend is invisible until the bill arrives.

Moving orchestration outside the model gives you the property the pitch is built around: **trust the delivery, not the demo.** Every green in an archive is a *verified* green (the JS gates said so, not the agent), and every failure leaves an actionable forensic trail (state, verifier output, snapshots, reviewer notes) rather than a black box.

The load-bearing rules — each traced to a real bug with a commit SHA — are written up in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Scope

**Works today:**

- Single-spec pipeline end to end: plan → execute → verify → review → archive.
- Multi-mission decomposition with parallel scheduling and file-conflict detection.
- Mission- and milestone-level regression gates, snapshot rollback that preserves sibling work, phantom-write detection.
- Multi-spec batch queue, unattended, with per-spec isolation: a failed spec is reverted and the queue continues; interrupts and API outages leave entries resumable, not corrupted.
- Human-in-the-loop escape hatches: park/resolve for stuck entries, a warnings ledger for non-blocking findings.
- Cost transparency: per-run and cross-archive (`nightfoundry usage --all`), per-role breakdowns.
- A local web dashboard (`nightfoundry ui`) for watching runs.

**Not there yet — don't expect it:**

- **Cold-start on an arbitrary repo is unproven.** Most exercise has been on this codebase plus a couple of known JS/Python repos. First runs on unfamiliar projects hit friction.
- **JS and Python only.** Go, Rust, TS-heavy projects, etc. are untested.
- **Single repo only.** No cross-repo / monorepo-workspace support.
- The memory / architect layer is a later phase.

## Reference

<details>
<summary>Full CLI</summary>

**Spec workflow**

```bash
nightfoundry task "..."                              # one-off change, no spec
nightfoundry brainstorm "..."                        # prose → spec pair (interactive)
nightfoundry dry-run <spec.md>                       # plan + assumption-check, no execution; queues for batch
nightfoundry run <spec.md | spec.uspec.json> [-a]    # run a spec (also: --spec-stdin to pipe a uspec in)
nightfoundry status [<mission-id>]                   # progress
```

**Batch & recovery**

```bash
nightfoundry resume [--batch] [-a]                   # resume an interrupted run / work through the queue
nightfoundry queue list | remove <slug>              # batch queue
nightfoundry park list | show <slug> | resolve <slug> --requeue|--waive|--reject
nightfoundry warnings list | show <id> | resolve <id...> | brainstorm <id...>
```

**Archives**

```bash
nightfoundry archive [name] [-P|--preserve] [--skip-test-gate]
nightfoundry archive list | show <id> [--report] | diff <a> <b>
nightfoundry dispersion [<id> | compare <a> <b>]     # archive fingerprints
```

**Cost & upkeep**

```bash
nightfoundry usage [--detailed | --all | --role <r> | --last <n> | --since <yyyy-mm-dd> | --include-failed]
nightfoundry usage compare <a> <b>                   # cost / token breakdown across archives
nightfoundry ui [--port N]                           # local web dashboard
nightfoundry health                                  # config + state integrity checks
nightfoundry clean [--force]                         # clear stale .harness/ state
nightfoundry init [spec.md] | version | help
```

`nightfoundry help` prints the same list from the router. Models per role are configurable in `src/orchestrator/infra/config.js`.

</details>

### Global safety flags

Preflight overrides — each trades one safety check for convenience, so the scope of each flag is explicit:

| Flag | Effect | Accepted by |
|---|---|---|
| `--allow-dirty` | Skip the clean-working-tree git preflight | `run`, `dry-run` |
| `--no-git-required` | Proceed without requiring a git repository | `run`, `dry-run` |
| `--allow-incomplete-scope` | Warn instead of error when the planner flags scope items that match no task | `run`, `dry-run`, `resume`, `task` |

### Docs

`nightfoundry init` deploys an AI-facing operator manual (the `nightfoundry-operator` skill) into the target repo's `.claude/skills/`, so Claude sessions working there know how to drive, debug, and write specs for runs — and the manual updates with the engine. Anything this README leaves unexplained (flags, states, recovery verbs) is answered there; ask the session, it reads these files. They double as the docs:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — pipeline, gates, and the structural rules with commit-SHA provenance.
- [`docs/STABILITY-CONTRACT.md`](./docs/STABILITY-CONTRACT.md) — public-API surface.
- [`commands.md`](./.claude/skills/nightfoundry-operator/references/commands.md) — authoritative command / flag reference.
- [`spec-authoring.md`](./.claude/skills/nightfoundry-operator/references/spec-authoring.md) — the hand-written spec contract (six sections, declared files, verification shapes).
- [`state-layout.md`](./.claude/skills/nightfoundry-operator/references/state-layout.md) — on-disk state (`.harness/`, `queue/`, `archives/`, `refs/park/`).
- [`gotchas.md`](./.claude/skills/nightfoundry-operator/references/gotchas.md) — sharp edges to know about.

`nightfoundry init` writes `nightfoundry-guidance.md` and `.nightfoundry.json.example` into the target repo; an existing `.cc-orch.json` is honored forever, with no migration required.

### Dependencies

`@anthropic-ai/claude-agent-sdk` (spawns Claude sessions) + `@anthropic-ai/sdk` + `express` / `node-cron` (webhook + cron triggers) + dev-only `@xterm/headless`, `jsdom`. No build step, pure ESM.

### Tests

`npm run test:all` runs the full suite (`scripts/run-tests.js`); individual suites are the `test:*` scripts in `package.json`. `npm run audit:r2` runs the doc-drift audit.

## License

[Fair Source](https://fair.io/), not open source: the code is licensed under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE.md) — free to use, read, modify, and redistribute (including commercial and internal use), with one restriction: you may not use it to build a competing product or service. Each release automatically becomes Apache-2.0 two years after it ships.
