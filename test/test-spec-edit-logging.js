/**
 * test-spec-edit-logging.js — Integration tests for _applySpecEdit logging behaviour.
 *
 * Run: node test/test-spec-edit-logging.js
 *
 * No live Claude sessions are spawned.
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Harness helpers ────────────────────────────────────────────────────────

function makePipelineHarness({ specContent = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sel-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of [
    'state', 'plan', 'verify', 'progress', 'verification',
    'analysis', 'snapshots', 'learning', 'dry-run', 'logs',
  ]) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath: '',
        createdAt: new Date().toISOString(),
        currentPhase: 'planning',
      },
      globalStatus: 'active',
      milestones: {},
    }, null, 2),
  );

  const specPath = path.join(root, 'spec.md');
  fs.writeFileSync(specPath, specContent);

  return { root, harnessDir, specPath };
}

function pipelineCleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Tests ──────────────────────────────────────────────────────────────────

// TC1: successful edit with options emits [specEdit] log with subsystem, section, summary
await test('TC1: successful edit emits [specEdit] log', async () => {
  const oldText = 'The original goal text';
  const newText = 'The updated goal text';
  const specContent = `# Spec\n\n## Goal\n\n${oldText}\n`;

  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const onLog = [];
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => onLog.push(msg),
      onConfirm: async () => false,
    });

    pipeline._applySpecEdit(specPath, oldText, newText, {
      subsystem: 'remediation',
      section: '## Goal',
      summary: 'test edit',
    });

    const matching = onLog.filter((msg) => /\[specEdit\].*remediation.*Goal.*test edit/.test(msg));
    assert.ok(
      matching.length > 0,
      `Expected at least one [specEdit] log entry matching /\\[specEdit\\].*remediation.*Goal.*test edit/, got:\n${JSON.stringify(onLog, null, 2)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// TC2: failed edit (old text missing) does not emit [specEdit]
await test('TC2: failed edit does not emit [specEdit] log', async () => {
  const specContent = `# Spec\n\n## Goal\n\nSome content here.\n`;
  const oldText = 'TEXT THAT IS NOT IN THE SPEC';
  const newText = 'replacement text';

  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const onLog = [];
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => onLog.push(msg),
      onConfirm: async () => false,
    });

    pipeline._applySpecEdit(specPath, oldText, newText, {
      subsystem: 'remediation',
      section: '## Goal',
      summary: 'test edit',
    });

    const specEditEntries = onLog.filter((msg) => /\[specEdit\]/.test(msg));
    assert.equal(
      specEditEntries.length,
      0,
      `Expected zero [specEdit] log entries, got:\n${JSON.stringify(specEditEntries, null, 2)}`,
    );

    // Verify the WARN was emitted instead
    const warnEntries = onLog.filter((msg) => /\[WARN\]/.test(msg));
    assert.ok(
      warnEntries.length > 0,
      `Expected at least one [WARN] log entry, got:\n${JSON.stringify(onLog, null, 2)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// TC3: omitted options uses fallback subsystem='unknown'
await test('TC3: omitted options uses fallback subsystem=\'unknown\'', async () => {
  const oldText = 'Original assumption text';
  const newText = 'Corrected assumption text';
  const specContent = `# Spec\n\n## Assumptions\n\n${oldText}\n`;

  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const onLog = [];
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => onLog.push(msg),
      onConfirm: async () => false,
    });

    // Call without 4th argument — all options should use their defaults
    pipeline._applySpecEdit(specPath, oldText, newText);

    const matching = onLog.filter((msg) => /\[specEdit\]/.test(msg) && /unknown/.test(msg));
    assert.ok(
      matching.length > 0,
      `Expected [specEdit] log containing 'unknown' as subsystem fallback, got:\n${JSON.stringify(onLog, null, 2)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
