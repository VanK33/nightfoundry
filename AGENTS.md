# nightfoundry — project instructions

nightfoundry (CLI: `cc-orch`) is an external harness that turns a written spec into verified code changes: a planner decomposes the spec, executor sessions implement tasks under schema-validated contracts, and a stack of deterministic gates (scope contract, hard checks, regression, full-suite test gate) plus verifier/reviewer/analyzer agents decides what counts as done. See `README.md` for usage and `ARCHITECTURE.md` for the design rules.

## Commands

- Full test suite: `npm run test:all` (runs every file registered in the `TEST_FILES` manifest in `scripts/run-tests.js`)
- Single test file: `node test/test-<name>.js` (each test file is a self-contained node script)
- The CLI entry point is `cc-orch` (see `src/cli/index.js` for the command surface; `.Codex/skills/cc-orch-operator/` is the AI-facing operator manual deployed with the package)

## Conventions

- New test files follow `test/test-<name>.js` and MUST be registered in the `TEST_FILES` manifest in `scripts/run-tests.js` — an unregistered test never runs in the suite.
- Root-level `*.spec.md` / `*.spec.json` files are ephemeral run inputs (gitignored); never commit them. Successful runs archive them under `archives/`.
- `archives/` is committable by design (forensic park-commits stage it), except the cross-run ledger files (`archives/candidates.jsonl`, `archives/warnings.jsonl`) which are excluded.
- Deterministic gates over prompt guidance: when a fix can live either in an agent prompt or in a structural check at a function boundary, prefer the structural check (see `ARCHITECTURE.md`).
- Stability guarantees for consumers are documented in `docs/STABILITY-CONTRACT.md`.

## Project-specific overrides

(none currently — add `【topic】` entries here when public-repo-specific rules emerge)
