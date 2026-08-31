#!/usr/bin/env node
/**
 * run-tests.js — Runs all tests independently (no fail-fast), aggregates
 * results, and exits non-zero if any test failed.
 *
 * Usage:
 *   node scripts/run-tests.js
 *   CC_ORCH_TEST_JOBS=1 node scripts/run-tests.js   # force serial (debugging)
 *
 * Test files run CONCURRENTLY through a worker pool (default
 * min(8, cores - 2), override via CC_ORCH_TEST_JOBS ≥ 1). Every test file
 * is a self-contained node process against its own mkdtemp fixture root —
 * the suite holds no cross-file shared state (audited: no fixed ports, no
 * shared write paths, no repo-root mutation), so file-level concurrency is
 * safe and the verdict stays exit-code-per-child.
 *
 * Hang backstop: a child that never exits (e.g. a runtime wedged in its own
 * shutdown) is SIGKILLed after CHILD_HANG_TIMEOUT_MS and retried ONCE,
 * serially, after the pool drains. Assertion failures are never retried.
 *
 * Summary is printed at the end showing PASS/FAIL per test and total counts,
 * in manifest order regardless of completion order.
 * Exit code 0 if all tests passed, 1 if any failed.
 */

import { spawn } from 'child_process';
import os from 'os';

// The test suite is NOT a re-entrant cc-orch invocation: its cases spawn
// cc-orch subprocesses against isolated fs.mkdtemp fixture roots, not the live
// run's project root. But when the suite is launched from inside a run (the
// spec-criteria drain / archive test gate run it with `env: withRunMarkerEnv()`),
// CC_ORCH_ACTIVE_RUN is inherited by every test child and their cc-orch
// grandchildren — tripping assertNoReentrantLiveRun on any fixture root that
// carries an active state.json (false positive on the sanctioned mkdtemp
// pattern). Clear the marker here so the whole suite runs re-entrancy-neutral
// regardless of launch context; tests that exercise the guard itself
// (test/test-active-run-marker.js TC1-TC4) set the marker explicitly in the
// child env/process.env they construct for each case, so this parent-level
// clear — which runs once, before any test file is spawned — does not
// clobber the marker under test.
delete process.env.CC_ORCH_ACTIVE_RUN;

// All test file paths (mirroring test:all in package.json), in order.
// Entries are plain strings only (test-manifest-integrity.js TC4 forbids
// the retired { npm: true, ... } shape from reappearing).
export const TEST_FILES = [
  'test/test-pipeline.js',
  'test/test-state-machine.js',
  'test/test-bootstrap.js',
  'test/test-bootstrap-run-scoped.js',
  'test/test-preflight.js',
  'test/test-hard-checks.js',
  'test/test-scenario-parser.js',
  'test/test-audit.js',
  'test/test-verification-audit-gate.js',
  'test/test-staging.js',
  'test/test-promote-candidate.js',
  'test/test-review.js',
  'test/test-usage-json.js',
  'test/test-usage-detailed.js',
  'test/test-usage-all.js',
  'test/test-analyze-overhead-snapshot.js',
  'test/test-context-enrichment.js',
  'test/test-prompt.js',
  'test/test-mutex.js',
  'test/test-contract-integration.js',
  'test/test-concurrency-writers.js',
  'test/test-scheduler.js',
  'test/test-dashboard.js',
  'test/test-pipeline-scheduler.js',
  'test/test-scheduler-resume.js',
  'test/test-verifier-contract.js',
  'test/test-executor-contract.js',
  'test/test-analyzer-contract.js',
  'test/test-summarizer-contract.js',
  'test/test-headline-cap.js',
  'test/test-import-graph.js',
  'test/test-blast-radius.js',
  'test/test-archive-list.js',
  'test/test-archive-show.js',
  'test/test-archive-diff.js',
  'test/test-archive-gitignore.js',
  'test/test-cli-router.js',
  'test/test-cli-router-spec-stdin.js',
  'test/test-cli-unknown-flag.js',
  'test/test-archive.js',
  'test/test-archive-changelog.js',
  'test/test-archive-manifest.js',
  'test/test-cache-efficiency.js',
  'test/test-config-contract.js',
  'test/test-coupled-files.js',
  'test/test-ui-config-contract.js',
  'test/test-dry-run.js',
  'test/test-dry-run-integration.js',
  'test/test-format-banner.js',
  'test/test-health.js',
  'test/test-menu-prompt.js',
  'test/test-per-turn-tracking.js',
  'test/test-pipeline-formatting.js',
  'test/test-pipeline-reviewer-gate.js',
  'test/test-planner-reuse.js',
  'test/test-planner-rotation.js',
  'test/test-read-then-write.js',
  'test/test-write-boundary.js',
  'test/test-review-gate.js',
  'test/test-review-gate-auto-accept.js',
  'test/test-review-gate-auto-align.js',
  'test/test-reviewer-contract.js',
  'test/test-reviewer-contract-integration.js',
  'test/test-reviewer-integration.js',
  'test/test-reviewer-acceptance-criteria.js',
  'test/test-spec-json-readers.js',
  'test/test-run-cost-display.js',
  'test/test-session-manager-guard.js',
  'test/test-pretooluse-guard-hook.js',
  'test/test-session-manager-instrumentation.js',
  'test/test-session-manager-unit.js',
  'test/test-small-task.js',
  'test/test-token-tracker.js',
  'test/test-usage-analyzer.js',
  'test/test-usage-compare.js',
  'test/test-usage-intelligence.js',
  'test/test-usage-since.js',
  'test/test-verification-summary.js',
  'test/test-clean.js',
  'test/test-clean-orphan-ref-no-harness.js',
  'test/test-clean-run-reaper.js',
  'test/test-harness-auto-hygiene.js',
  'test/test-status-bar.js',
  'test/test-status-bar-integration.js',
  'test/test-structured-output-fallback.js',
  'test/test-summarizer-context-scoping.js',
  'test/test-status-bar-terminal.js',
  'test/test-write-verify-json.js',
  'test/test-hard-checks-integration.js',
  'test/test-hard-checks-pipeline-wiring.js',
  'test/test-snapshots-integration.js',
  'test/test-task-reset.js',
  'test/test-restore-sibling-supersede.js',
  'test/test-assert-changes-landed-all-files.js',
  'test/test-coverage-remediation.js',
  'test/test-scenario-coverage-by-identity.js',
  'test/test-schema-id-validation.js',
  'test/test-read-task-status-guard.js',
  'test/test-regression-stub.js',
  'test/test-configurable-test-commands.js',
  'test/test-regression-runner-signal.js',
  'test/test-project-config.js',
  'test/test-prompt-sigint.js',
  'test/test-brainstorm-no-tty.js',
  'test/test-spec-hardcheck-scoping.js',
  'test/test-spec-criteria-drain.js',
  'test/test-multi-owner-check-routing.js',
  'test/test-warnings-ledger.js',
  'test/test-candidates-ledger.js',
  'test/test-usage-ledger.js',
  'test/test-cli-failure-ledger-emit.js',
  'test/test-plan-scope-warnings-ledger.js',
  'test/test-phantom-write-guard.js',
  'test/test-phantom-write-readonly-sentinel.js',
  'test/test-audit-r2.js',
  'test/test-build-file-to-mission-map.js',
  'test/test-review-remediation-routing.js',
  'test/test-assumption-fix-prompt.js',
  'test/test-assumption-remediation.js',
  'test/test-assumption-verify-infra-retry.js',
  'test/test-batch-resume.js',
  'test/test-candidate-emit.js',
  'test/test-batch-interrupt-recovery.js',
  'test/test-batch-abort-between-entries.js',
  'test/test-batch-revert-and-continue.js',
  'test/test-plan-time-disposition.js',
  'test/test-coverage-id-normalize.js',
  'test/test-dry-run-queue.js',
  'test/test-incremental-usage.js',
  'test/test-infra-error.js',
  'test/test-infra-slow-failure-cap.js',
  'test/test-milestone-cascade.js',
  'test/test-pipeline-replan.js',
  'test/test-pipeline-retry-evidence.js',
  'test/test-session-manager-sdk-lifecycle.js',
  'test/test-session-inflight-reconcile.js',
  'test/test-signal-abort-integration.js',
  'test/test-planner-prompt.js',
  'test/test-planner-constraints-injection.js',
  'test/test-planglobal-mission-targetfiles.js',
  'test/test-planglobal-lint-retry.js',
  'test/test-planner-behavior-not-form.js',
  'test/test-planner-no-readonly-tasks.js',
  'test/test-render-reviewer-digest.js',
  'test/test-resume.js',
  'test/test-reviewer-digest.js',
  'test/test-run-report.js',
  'test/test-state.js',
  'test/test-progress-total-cache.js',
  'test/test-queue-cli.js',
  'test/test-queue-state.js',
  'test/test-queue-retry.js',
  'test/test-replan-task-planner.js',
  'test/test-review-remediation-contract.js',
  'test/test-review-remediation-persist.js',
  'test/test-review-remediation-planner.js',
  'test/test-reviewer-retry.js',
  'test/test-scheduler-circuit-breaker.js',
  'test/test-scheduler-replace-task.js',
  'test/test-session-manager-classify-wiring.js',
  'test/test-session-manager-infrastructure-error.js',
  'test/test-session.js',
  'test/test-summarizer-citation-validation.js',
  'test/test-summarizer-scope.js',
  'test/test-task-replan-contract.js',
  'test/test-auto-cli-plumbing.js',
  'test/test-auto-mode.js',
  'test/test-reviewer-guard-zero-findings.js',
  'test/test-reviewer-stub-disposition.js',
  'test/test-scheduler-replan-persistence.js',
  'test/test-agent-ticker.js',
  'test/test-pipeline-agent-ticker.js',
  'test/test-is-stub-propagation.js',
  'test/test-enforce-sequential-ordering.js',
  'test/test-planner-sequential-ordering.js',
  'test/test-planner-sequential-ordering-integration.js',
  'test/test-assumption-phase-routing.js',
  'test/test-archive-preserve.js',
  'test/test-wrap.js',
  'test/test-wrap-integration.js',
  'test/test-auto-batch-persistence.js',
  'test/test-auto-construction-sites.js',
  'test/test-auto-effective-mode.js',
  'test/test-auto-trigger-parity.js',
  'test/test-coverage-auto-mode.js',
  'test/test-gate-category-a.js',
  'test/test-gate-category-b.js',
  'test/test-gate-category-c.js',
  'test/test-gate-confirm-impl.js',
  'test/test-pipeline-auto-mode.js',
  'test/test-halt-error-unification.js',
  'test/test-stability-contract.js',
  'test/test-brainstormer-contract.js',
  'test/test-brainstorm-spec-contract.js',
  'test/test-brainstorm-cli.js',
  'test/test-brainstorm-frame-first.js',
  'test/test-brainstorm-adaptive-questions.js',
  'test/test-brainstorm-style-seam.js',
  'test/test-brainstorm-elicitation-tty-only.js',
  'test/test-brainstorm-digest.js',
  'test/test-brainstorm-digest-channel.js',
  'test/test-brainstorm-telemetry.js',
  'test/test-brainstorm-multi-round-loop.js',
  'test/test-brainstorm-round-ceiling.js',
  'test/test-brainstorm-round-cap-transparency.js',
  'test/test-brainstorm-integration-note.js',
  'test/test-brainstorm-multiround-style-telemetry.js',
  'test/test-schemas-verification.js',
  'test/test-brainstormer-evidence-contract.js',
  'test/test-parse-spec-hardchecks-verification.js',
  'test/test-brainstormer-prompt-verification.js',
  'test/test-user-spec.js',
  'test/test-user-spec-projection.js',
  'test/test-user-spec-input.js',
  'test/test-user-spec-cli.js',
  'test/test-ui-server.js',
  'test/test-ui-per-run-resolution.js',
  'test/test-ui-api.js',
  'test/test-ui-kanban.js',
  'test/test-ui-archives-api.js',
  'test/test-ui-archives-frontend.js',
  'test/test-ui-notify.js',
  'test/test-ui-siderail.js',
  'test/test-ui-siderail-page.js',
  'test/test-siderail-lineage.js',
  'test/test-siderail-timing.js',
  'test/test-cross-archive-analyzer.js',
  'test/test-usage-all-cli.js',
  'test/test-analyzer-task-id-filter.js',
  'test/test-ui-command.js',
  'test/test-ui-routing.js',
  'test/test-archive-failed.js',
  'test/test-failed-archive-parity.js',
  'test/test-dispersion-fingerprint.js',
  'test/test-dispersion-cli.js',
  'test/test-git-safety-precheck.js',
  'test/test-circuit-breaker-replan.js',
  'test/test-taskid-collision-rejection.js',
  'test/test-dispatch-pending-invariant.js',
  'test/test-task-id-collision.js',
  'test/test-sidecar-reuse.js',
  'test/test-pending-tasks-invariant.js',
  'test/test-replace-task-cascade.js',
  'test/test-scope-parser.js',
  'test/test-spec-text.js',
  'test/test-scope-coverage-gate.js',
  'test/test-blast-radius-gate-wiring.js',
  'test/test-scope-mapping-gate.js',
  'test/test-allow-incomplete-scope-flag.js',
  'test/test-unassigned-spec-check-error.js',
  'test/test-detect-uncheckable-spec.js',
  'test/test-r2-defect-coverage.js',
  'test/test-verifier-callsite-plumbing.js',
  'test/test-verifier-foreign-pending.js',
  'test/test-verifier-spec-read-audit.js',
  'test/test-spec-consulted-honest-report.js',
  'test/test-whole-suite-guard.js',
  'test/test-whole-suite-command-defer.js',
  'test/test-wholesuite-scope-recognition.js',
  'test/test-verifier-wholesuite-verdict.js',
  'test/test-verifier-schemafail-result.js',
  'test/test-verifier-escalation.js',
  'test/test-verifier-foreign-pending.js',
  'test/test-pipeline-hard-check-gate.js',
  'test/test-pipeline-hard-check-reval-gate.js',
  'test/test-scheduler-reval-dispatch.js',
  'test/test-scheduler-stall-rescue.js',
  'test/test-needs-revalidation-repass.js',
  'test/test-firstwrite-skip-executor.js',
  'test/test-usage-coverage.js',
  'test/test-scheduler-file-conflict-normalization.js',
  'test/test-path-utils.js',
  'test/test-scheduler-normalize.js',
  'test/test-remediation-orphan-reparent.js',
  'test/test-replan-cascade-rewire.js',
  'test/test-replan-dep-validation.js',
  'test/test-remediation-related-files.js',
  'test/test-regression-remediation-unknown-scope.js',
  'test/test-regression-structured-findings.js',
  'test/test-classify-result.js',
  'test/test-planner-rejected-behavior-warn.js',
  'test/test-planner-warn-rejected-wiring.js',
  'test/test-planner-warn-rejected.js',
  'test/test-session-wall-clock.js',
  'test/test-pipeline-wall-clock.js',
  'test/test-pipeline-elapsed.js',
  'test/test-session-wall-clock-cap.js',
  'test/test-percall-wallclock.js',
  'test/test-planner-path-anchor-validation.js',
  'test/test-plan-scope-lint.js',
  'test/test-plan-scope-lint-wiring.js',
  'test/test-plan-structure-lint.js',
  'test/test-plan-lint-retry.js',
  'test/test-archive-final-test-gate.js',
  'test/test-archive-view-url.js',
  'test/test-ui-theme-tokens.js',
  'test/test-test-registration-gate.js',
  'test/test-test-registration-pipeline.js',
  'test/test-gate-external-project.js',
  'test/test-enrich-runtests-targetfiles.js',
  'test/test-queue-spec-json.js',
  'test/test-regression-verdict-signal.js',
  'test/test-regression-verdict-filter.js',
  'test/test-regression-purity-strip.js',
  'test/test-milestone-gate-rejudge.js',
  'test/test-cycle-rollback-pending.js',
  'test/test-batch-failure-crash-safety.js',
  'test/test-batch-failure-input-boundary.js',
  'test/test-batch-interrupt-preserve.js',
  'test/test-replan-cap-retry-budget.js',
  'test/test-blocked-direct-analyzer.js',
  'test/test-p1-prompt-hardening.js',
  'test/test-hardcheck-rehoming.js',
  'test/test-invalidation-reason.js',
  'test/test-invalidation-forensics.js',
  'test/test-prdpath-anchor.js',
  'test/test-state-resume-persistence.js',
  'test/test-path-token-quote-strip.js',
  'test/test-eval-token-extraction.js',
  'test/test-cross-mission-dep.js',
  'test/test-park-foundation.js',
  'test/test-cli-park.js',
  'test/test-park-diff-preservation.js',
  'test/test-park-leg-selection.js',
  'test/test-park-snapshot-scene.js',
  'test/test-park-requeue-reattach.js',
  'test/test-park-snapshot-cleanup.js',
  'test/test-park-resume-consistency.js',
  'test/test-park-requeue-preflights.js',
  'test/test-park-pointer-release.js',
  'test/test-uncertain-advisory.js',
  'test/test-analyzer-closure.js',
  'test/test-auto-waive-scene.js',
  'test/test-analyzer-disposition-telemetry.js',
  'test/test-assumption-classifier.js',
  'test/test-warnings-cleanup.js',
  'test/test-milestone-only-classification.js',
  'test/test-gate-predicate-fidelity.js',
  'test/test-is-checkable-criterion.js',
  'test/test-extract-path-tokens-exclusions.js',
  'test/test-curl-url-milestone-only.js',
  'test/test-milestone-check-robustness.js',
  'test/test-run-final-test-gate.js',
  'test/test-archive-clean-delivery.js',
  'test/test-batch-entry-cost.js',
  'test/test-run-complete-status.js',
  'test/test-multi-edit-split.js',
  'test/test-audit-r2-map-serialize.js',
  'test/test-pipeline-milestone-regression-remediation.js',
  'test/test-regression-remediation-integration.js',
  'test/test-circuit-breaker-human-escalation-routing.js',
  'test/test-gitignore-stanza-and-compound-evidence.js',
  'test/test-git-excludes.js',
  'test/test-memory-lifecycle.js',
  'test/test-assumption-data.js',
  'test/test-verification-helpers.js',
  'test/test-test-gate-disposition.js',
  'test/test-thin-preflight.js',
  'test/test-batch-test-gate-park-snapshot.js',
  'test/test-spec-criterion-disposition.js',
  'test/test-spec-criteria-disposition.js',
  'test/test-spec-criteria-resume-catch.js',
  'test/test-gate-timeout-honesty.js',
  'test/test-reentrancy-guard.js',
  'test/test-active-run-marker.js',
  'test/test-run-context.js',
  'test/test-make-run.js',
  'test/test-archive-pointer.js',
  'test/test-resolve-harness-fileref.js',
  'test/test-harness-file-ref.js',
  'test/test-cli-usage-run-dir.js',
  'test/test-runid-flip.js',
  'test/test-preclaimed-run.js',
  'test/test-pipeline-repoint.js',
  'test/test-webhook-claim.js',
  'test/test-webhook-run-claim.js',
  'test/test-post-flip-hygiene.js',
  'test/test-batch-interrupt-and-spec-cache.js',
  'test/test-regression-gate-escalation.js',
  'test/test-regression-sequencing-context.js',
  'test/test-disposition-residue-hygiene.js',
  'test/test-repoint-agent-rewire.js',
  'test/test-test-gate-honesty.js',
  'test/test-baseline-gate.js',
  'test/test-bundle-gate.js',
  'test/test-batch-log-anchoring.js',
  'test/test-halt-aftermath.js',
  'test/test-init-onboarding.js',
  'test/test-operator-manual.js',
  'test/test-batch-git-excludes-bare.js',
  'test/test-extract-spec-section.js',
  'test/test-git-guard-cli.js',
  'test/test-git-guard.js',
  'test/test-hard-checks-milestone-only.js',
  'test/test-planner-reextract-assumptions.js',
  'test/test-regression-remediation-planner.js',
  'test/test-regression-softpass.js',
  'test/test-remediation-no-line-refs.js',
  'test/test-spec-edit-logging.js',
  'test/test-write-json-atomic.js',
  'test/test-manifest-integrity.js',
  'test/test-suite-hermeticity.js',
  'test/test-cost-ceiling.js',
  'test/test-active-run-pointer-recovery.js',
  'test/test-tree-hash-memo.js',
  'test/test-final-gate-memo.js',
  'test/test-parallel-runner.js',
  'test/test-replay-lib.js',
  'test/test-replay-driver.js',
  'test/test-readonly-deletion-guard.js',
];

// Per-child captured-output ceiling, matching the old spawnSync maxBuffer:
// a child that exceeds it is killed and marked FAIL.
const CHILD_OUTPUT_CAP = 64 * 1024 * 1024;

// Hang backstop: a child that has not exited after this long is presumed
// wedged — SIGKILLed (a runtime stuck in shutdown cannot service a normal
// signal) and flagged `hung` so runAll can give it ONE serial retry. The
// slowest legitimate file is ~1 min; 5 min is contention headroom, not a
// target. Observed trigger: Node v25.7.0's exit-path deadlock
// (uv_thread_join waiting on a V8 worker parked in a GC barrier) — the
// test's cases all pass, the PROCESS never exits. That is a runtime
// symptom, not a failing test, which is why hangs (and only hangs — never
// assertion failures) earn a retry.
const CHILD_HANG_TIMEOUT_MS = 300_000;

/**
 * Run a single entry and resolve { label, passed, hung }.
 *
 * Children get PIPED stdio, never the parent's terminal. With
 * `stdio: 'inherit'` from an interactive terminal, every test child saw a
 * real TTY, so TTY-gated code paths (interactive prompts, the status bar's
 * ANSI renderer, readline terminal mode) activated inside tests written for
 * scripted stdio — ~30 files failed when the suite ran on a TTY yet passed
 * when piped (`npm run test:all 2>&1 | ...`). The suite's verdict must not
 * depend on how it was invoked: pipe always, then forward the captured
 * output once the child exits — the whole capture in one write, so under
 * concurrency the transcript interleaves at FILE granularity, never
 * mid-line. `[RUN]` is still logged before the spawn (long-op visibility).
 *
 * @param {string} entry
 * @param {{hangTimeoutMs?: number}} [opts]
 * @returns {Promise<{label: string, passed: boolean, hung: boolean}>}
 */
function runEntry(entry, { hangTimeoutMs = CHILD_HANG_TIMEOUT_MS } = {}) {
  const label = entry;
  console.log(`[RUN] ${label}`);
  return new Promise((resolve) => {
    const child = spawn('node', [entry], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let overflowed = false;
    const collect = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > CHILD_OUTPUT_CAP) {
        if (!overflowed) {
          overflowed = true;
          child.kill('SIGTERM');
        }
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdoutChunks));
    child.stderr.on('data', collect(stderrChunks));

    let settled = false;
    let hangTimer = null;
    const settle = (passed, note, hung = false) => {
      if (settled) return;
      settled = true;
      if (hangTimer) clearTimeout(hangTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (note) process.stderr.write(`[runner] ${label}: ${note}\n`);
      resolve({ label, passed, hung });
    };

    // Settle directly on timeout instead of waiting for 'close': a wedged
    // runtime may never close its stdio, and a grandchild holding inherited
    // pipe fds would keep 'close' from firing even after the SIGKILL.
    hangTimer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(false, `no exit after ${Math.round(hangTimeoutMs / 1000)}s — SIGKILLed, flagged as hung`, true);
    }, hangTimeoutMs);

    child.on('error', (err) => settle(false, `spawn error: ${err.message}`));
    child.on('close', (code) => settle(
      code === 0 && !overflowed,
      overflowed ? 'output exceeded the 64 MiB cap — child killed, marked FAIL' : null
    ));
  });
}

/**
 * Run every entry through a worker pool of at most `jobs` concurrent
 * children. Dispatch follows manifest order; whichever worker frees up
 * takes the next entry. Results land at their manifest index, so the
 * returned array (and the summary printed from it) is in manifest order
 * regardless of completion order. No fail-fast.
 *
 * After the pool drains, entries flagged `hung` (killed by the hang
 * backstop — the process never exited) get ONE serial retry each, and the
 * retry's verdict replaces the hang. Assertion failures (a child that
 * exited non-zero) are never retried — a hang is a runtime symptom, a
 * non-zero exit is a red test.
 *
 * @param {string[]} entries
 * @param {{jobs?: number, hangTimeoutMs?: number}} [opts]
 * @returns {Promise<{label: string, passed: boolean, hung: boolean, retriedAfterHang?: boolean}[]>}
 */
export async function runAll(entries, { jobs = 1, hangTimeoutMs = CHILD_HANG_TIMEOUT_MS } = {}) {
  const workerCount = Math.max(1, Math.min(jobs, entries.length || 1));
  const results = new Array(entries.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      results[index] = await runEntry(entries[index], { hangTimeoutMs });
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));

  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].hung) {
      console.log(`[runner] ${entries[i]}: hung in the pool — one serial retry (a hang is a runtime symptom, not a failing test)`);
      const retry = await runEntry(entries[i], { hangTimeoutMs });
      results[i] = { ...retry, retriedAfterHang: true };
    }
  }
  return results;
}

/**
 * Worker-pool width: CC_ORCH_TEST_JOBS (≥ 1; 1 forces the old serial
 * behaviour) or min(8, cores - 2) — capped low enough to leave headroom
 * for whatever loaded the machine (the drain typically fires right after
 * a batch).
 *
 * @returns {number}
 */
export function defaultJobs() {
  const fromEnv = Number(process.env.CC_ORCH_TEST_JOBS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
  return Math.min(8, Math.max(1, os.availableParallelism() - 2));
}

// Only run when executed directly (not when imported as a module).
// In ESM, we check if this file is the entry point.
const isMain = process.argv[1] && process.argv[1].endsWith('run-tests.js');

if (isMain) {
  // Force the hermetic test environment for every spawned test child.
  // These statements live inside the isMain block (not at module top level)
  // because this module is dynamically imported purely for its TEST_FILES
  // export (see the checkTestRegistration gate / test/test-test-registration-
  // gate.js) — mutating process.env at module scope would leak into that
  // importer's environment. A future real-SDK lane runs
  // `node test/test-session.js` directly (outside this runner), which is
  // exactly why the runner clears the CC_ORCH_REAL_SDK opt-in here: the
  // runner's own children must always run hermetically, while the direct
  // real-SDK lane invocation bypasses this file entirely and keeps its own
  // env intact.
  process.env.CC_ORCH_TEST = '1';
  delete process.env.CC_ORCH_REAL_SDK;

  const jobs = defaultJobs();
  console.log(`[runner] ${TEST_FILES.length} files, ${jobs} concurrent`);
  const results = await runAll(TEST_FILES, { jobs });

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  let passCount = 0;
  let failCount = 0;

  for (const { label, passed, retriedAfterHang } of results) {
    const status = passed ? 'PASS' : 'FAIL';
    const note = retriedAfterHang
      ? (passed ? ' (passed on serial retry after hang)' : ' (failed serial retry after hang)')
      : '';
    console.log(`  [${status}] ${label}${note}`);
    if (passed) passCount++;
    else failCount++;
  }

  console.log('='.repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passCount} | Failed: ${failCount}`);
  console.log('='.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}
