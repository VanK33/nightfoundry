/**
 * test-reviewer-digest.js — Unit tests for Pipeline._renderReviewerDigest()
 *
 * Covers:
 *   TC1 — FAILED with 2 critical findings → boxed output with FAILED header,
 *          both finding lines, and footer
 *   TC2 — PASSED with 1 warning → boxed output with PASSED with warnings header
 *   TC3 — Clean PASS (no findings) → single 'Reviewer passed for milestone' line
 *   TC4 — Description >80 chars is truncated with '…'
 *
 * Run: node test/test-reviewer-digest.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal Pipeline instance with a captured log array.
 * We only need onLog — no real execution.
 */
function makePipelineWithLogs() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-digest-test-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  const cleanup = () => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { pipeline, logs, cleanup };
}

// ── TC1: FAILED with 2 critical findings → boxed output ──────────────

await test('TC1: FAILED with 2 critical findings → boxed output with FAILED header, both finding lines, and footer', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: false,
      findings: [
        { severity: 'critical', file: 'src/alpha.js', description: 'missing required export' },
        { severity: 'critical', file: 'src/beta.js',  description: 'undefined reference to fooBar' },
      ],
    };

    pipeline._renderReviewerDigest('001', reviewResult);

    const all = logs.join('\n');

    // Must contain boxed FAILED header
    assert.ok(
      all.includes('┌─ Reviewer FAILED'),
      `Expected '┌─ Reviewer FAILED' header. Got:\n${all}`
    );

    // Both critical finding lines
    assert.ok(
      all.includes('src/alpha.js') && all.includes('missing required export'),
      `Expected first finding (src/alpha.js: missing required export). Got:\n${all}`
    );
    assert.ok(
      all.includes('src/beta.js') && all.includes('undefined reference to fooBar'),
      `Expected second finding (src/beta.js: undefined reference to fooBar). Got:\n${all}`
    );

    // Must contain '└─' footer
    assert.ok(
      all.includes('└─'),
      `Expected '└─' footer. Got:\n${all}`
    );

    // Must NOT emit the clean-pass single line
    assert.ok(
      !all.includes('Reviewer passed for milestone'),
      `Must not emit clean-pass line on FAILED result. Got:\n${all}`
    );
  } finally {
    cleanup();
  }
});

// ── TC2: PASSED with 1 warning → boxed output ────────────────────────

await test('TC2: PASSED with 1 warning → boxed output with PASSED with warnings header', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: true,
      findings: [
        { severity: 'warning', file: 'src/utils.js', description: 'consider extracting helper function' },
      ],
    };

    pipeline._renderReviewerDigest('002', reviewResult);

    const all = logs.join('\n');

    // Must contain PASSED with findings header
    assert.ok(
      all.includes('┌─ Reviewer PASSED with findings'),
      `Expected '┌─ Reviewer PASSED with findings' header. Got:\n${all}`
    );

    // The warning finding line
    assert.ok(
      all.includes('src/utils.js') && all.includes('consider extracting helper function'),
      `Expected warning finding (src/utils.js: consider extracting helper function). Got:\n${all}`
    );

    // Must NOT emit the clean-pass single line
    assert.ok(
      !all.includes('Reviewer passed for milestone'),
      `Must not emit clean-pass line when there are warnings. Got:\n${all}`
    );
  } finally {
    cleanup();
  }
});

// ── TC3: Clean PASS (no findings) → single line ──────────────────────

await test('TC3: Clean PASS (no findings) → single "Reviewer passed for milestone" line', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = { passed: true, findings: [] };

    pipeline._renderReviewerDigest('003', reviewResult);

    const all = logs.join('\n');

    // Must emit the single-line pass message
    assert.ok(
      all.includes('Reviewer passed for milestone'),
      `Expected single-line "Reviewer passed for milestone" message. Got:\n${all}`
    );

    // Must NOT emit a box (no '┌─')
    assert.ok(
      !all.includes('┌─'),
      `Must not emit box for clean pass. Got:\n${all}`
    );
  } finally {
    cleanup();
  }
});

// ── TC4: Description >80 chars is truncated with '…' ─────────────────

await test('TC4: Description >80 chars is truncated with "…"', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const longDesc = 'X'.repeat(100); // 100 chars — exceeds the 80-char limit
    const reviewResult = {
      passed: false,
      findings: [
        { severity: 'critical', file: 'src/overflow.js', description: longDesc },
      ],
    };

    pipeline._renderReviewerDigest('004', reviewResult);

    const all = logs.join('\n');

    // Must contain truncation ellipsis
    assert.ok(
      all.includes('…'),
      `Expected truncation ellipsis "…". Got:\n${all}`
    );

    // Full 100-char description must NOT appear verbatim
    assert.ok(
      !all.includes(longDesc),
      `Expected description to be truncated; full 100-char string should not appear. Got:\n${all}`
    );

    // The first 80 chars followed by '…' should appear
    assert.ok(
      all.includes('X'.repeat(80) + '…'),
      `Expected exactly 80 'X' chars followed by '…'. Got:\n${all}`
    );
  } finally {
    cleanup();
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
