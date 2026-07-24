/**
 * test-analyzer-task-id-filter.js — Tests for mission-shaped task ID filtering
 * in analyzer.extractAnalysis.
 *
 * Run: node test/test-analyzer-task-id-filter.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-task-id-filter-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── TC1: extractAnalysis drops mission-shaped IDs from affectedTasks ─────

await test('extractAnalysis drops mission-shaped IDs from affectedTasks', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();

  // Fixture: mix of valid 4-segment IDs (needs_revalidation) and mission-shaped IDs (needs_revalidation)
  const fixture = {
    structured_output: {
      recommendation: 're_plan',
      rootCause: 'Task depends on missing API',
      failureType: 'execution',
      affectedTasks: [
        { taskId: '001-001-001-002', reason: 'shares file with failed task', action: 'needs_revalidation' },
        { taskId: '001-001-001-003', reason: 'overlap in output', action: 'needs_revalidation' },
        { taskId: '001-001', reason: 'whole mission affected', action: 'needs_revalidation' },
        { taskId: '001-002-001', reason: 'sub-mission', action: 'needs_revalidation' },
      ],
      evidence: 'grep found no such function',
      notes: 'planner should re-decompose',
    },
  };

  const warnMessages = [];
  const spy = (...args) => warnMessages.push(args.join(' '));

  try {
    const out = extractAnalysis(fixture, 'evt-filter-1', dir, { warn: spy });

    // Only 4-segment IDs survive
    assert.deepEqual(
      out.affectedTasks,
      ['001-001-001-002', '001-001-001-003'],
      `expected only 4-segment IDs, got: ${JSON.stringify(out.affectedTasks)}`
    );

    // Warn spy must include drop message
    const dropMsg = warnMessages.find((m) => /Dropped 2 non-task-shaped/.test(m));
    assert.ok(
      dropMsg,
      `expected warn message matching /Dropped 2 non-task-shaped/, got: ${JSON.stringify(warnMessages)}`
    );

    // Drop message must name both dropped IDs
    assert.ok(
      dropMsg.includes('001-001'),
      `expected drop message to include '001-001', got: ${dropMsg}`
    );
    assert.ok(
      dropMsg.includes('001-002-001'),
      `expected drop message to include '001-002-001', got: ${dropMsg}`
    );
  } finally {
    cleanup(dir);
  }
});

// ── TC2: extractAnalysis keeps replan-suffixed task IDs ──────────────────

await test('extractAnalysis keeps replan-suffixed task IDs', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();

  // Fixture: a replan-suffixed ID (should pass isTaskShapedId after stripping -rp-N)
  const fixture = {
    structured_output: {
      recommendation: 're_plan',
      rootCause: 'Task needs replanning',
      failureType: 'execution',
      affectedTasks: [
        { taskId: '001-001-001-002-rp-1', reason: 'replanned task', action: 'needs_revalidation' },
      ],
      evidence: 'trace shows failure',
      notes: '',
    },
  };

  const warnMessages = [];
  const spy = (...args) => warnMessages.push(args.join(' '));

  try {
    const out = extractAnalysis(fixture, 'evt-filter-2', dir, { warn: spy });

    // Replan-suffixed ID must be preserved
    assert.ok(
      out.affectedTasks.includes('001-001-001-002-rp-1'),
      `expected affectedTasks to include '001-001-001-002-rp-1', got: ${JSON.stringify(out.affectedTasks)}`
    );

    // No drop warning should appear
    const dropMsg = warnMessages.find((m) => /Dropped.*non-task-shaped/.test(m));
    assert.ok(
      !dropMsg,
      `expected no drop warning, but got: ${dropMsg}`
    );
  } finally {
    cleanup(dir);
  }
});

// ── TC3: extractAnalysis with all valid task IDs emits no drop warning ───

await test('extractAnalysis with all valid task IDs emits no drop warning', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();

  // Fixture: only valid 4-segment IDs
  const fixture = {
    structured_output: {
      recommendation: 're_plan',
      rootCause: 'Multiple tasks affected',
      failureType: 'execution',
      affectedTasks: [
        { taskId: '001-001-001-001', reason: 'file overlap', action: 'needs_revalidation' },
        { taskId: '001-001-001-002', reason: 'file overlap', action: 'needs_revalidation' },
        { taskId: '001-002-001-001', reason: 'shared dep', action: 'needs_revalidation' },
      ],
      evidence: 'all IDs are properly shaped',
      notes: '',
    },
  };

  const warnMessages = [];
  const spy = (...args) => warnMessages.push(args.join(' '));

  try {
    const out = extractAnalysis(fixture, 'evt-filter-3', dir, { warn: spy });

    // All three IDs should appear in output
    assert.deepEqual(
      out.affectedTasks,
      ['001-001-001-001', '001-001-001-002', '001-002-001-001'],
      `expected all 3 task IDs, got: ${JSON.stringify(out.affectedTasks)}`
    );

    // Zero drop warnings
    const dropMessages = warnMessages.filter((m) => /Dropped.*non-task-shaped/.test(m));
    assert.equal(
      dropMessages.length,
      0,
      `expected zero drop warnings, got: ${JSON.stringify(dropMessages)}`
    );
  } finally {
    cleanup(dir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
