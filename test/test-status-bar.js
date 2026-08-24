/**
 * test-status-bar.js — Unit tests for src/orchestrator/infra/status-bar.js.
 *
 * Covers both non-TTY mode (all methods are no-ops, no ANSI output) and
 * TTY mode (constructor defaults, updateAgent, updateProgress, updateMilestone
 * rendering, and agent row lifecycle).
 *
 * NOTE: updateAgent/updateProgress/updateMilestone are debounced (100 ms).
 * Tests that need to inspect rendered output call sb._render() directly to
 * bypass the timer and get deterministic results.
 *
 * Run: node test/test-status-bar.js
 */
import assert from 'assert';
import { Writable } from 'stream';
import { StatusBar } from '../src/orchestrator/infra/status-bar.js';
import { Dashboard } from '../src/orchestrator/infra/dashboard.js';

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
 * A Writable stream that records everything written to it.
 * isTTY, rows, and columns can be configured to exercise TTY rendering.
 */
function makeFakeStream({ isTTY = false, rows = 24, columns = 80 } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.isTTY = isTTY;
  stream.rows = rows;
  stream.columns = columns;
  return { stream, chunks };
}

/**
 * Sleep helper for debounce/timing tests.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {

// ── Non-TTY mode ─────────────────────────────────────────────────────

// TC1: all update methods produce no output
await test('non-TTY: all update methods produce no output to stream (TC1)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('planner-1', {
    role: 'planner',
    taskId: '001-001-001-001',
    description: 'plan',
    status: 'active',
    elapsed: 0,
    cost: 0,
  });
  sb.updateProgress(1, 5, 0.01, 1);
  sb.updateMilestone('001-001', 5, 60);
  sb.hide();
  sb.show();

  assert.strictEqual(chunks.length, 0, 'non-TTY: no method should write to stream');
  sb.destroy();
  assert.strictEqual(chunks.length, 0, 'non-TTY: destroy() must also write nothing');
});

// TC2: no ANSI escape sequences
await test('non-TTY: no ANSI escape sequences in stream chunks (TC2)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('verifier-1', {
    role: 'verifier',
    taskId: '001-001-001-002',
    description: 'verify',
    status: 'active',
    elapsed: 5,
    cost: 0.001,
  });
  sb.updateProgress(2, 8, 0.03, 3);
  sb.updateMilestone('001-001', 8, 300);
  sb.hide();
  sb.show();
  sb.destroy();

  const combined = chunks.join('');
  assert.ok(!/\x1b\[/.test(combined), 'non-TTY output must contain no ANSI escape sequences');
});

// ── TTY mode ─────────────────────────────────────────────────────────

// TC3: constructor defaults
await test('TTY: constructor defaults maxRows=8 and enabled=true when isTTY (TC3)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  assert.strictEqual(sb.maxRows, 8, 'default maxRows should be 8');
  assert.strictEqual(sb.enabled, true, 'enabled should be true when stream isTTY');

  sb.destroy();
});

await test('TTY: constructor enabled=false when stream is not TTY', () => {
  const { stream } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream });

  assert.strictEqual(sb.enabled, false, 'enabled should be false for non-TTY stream');
});

await test('TTY: constructor respects explicit maxRows option', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream, maxRows: 4 });

  assert.strictEqual(sb.maxRows, 4, 'should respect explicit maxRows');

  sb.destroy();
});

// TC4: updateAgent with status='active' adds agent row with correct icon and role
await test("TTY: updateAgent with status='active' adds agent row with correct icon and role (TC4)", () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('exec-agent', {
    role: 'executor',
    taskId: '001-001-001-001',
    description: 'running tests',
    status: 'active',
    elapsed: 10,
    cost: 0.002,
  });
  // Call _render() to bypass the 100ms debounce
  sb._render();

  const combined = chunks.join('');
  assert.ok(/⚡/.test(combined), `executor row should include ⚡ icon, got: ${combined.slice(0, 200)}`);
  // _buildAgentRow capitalizes first letter for display
  assert.ok(/Executor/.test(combined), `row should include role name "Executor", got: ${combined.slice(0, 200)}`);

  sb.destroy();
});

// TC4b: Verifier icon check
await test('TTY: updateAgent for Verifier shows 🔍 icon (TC4b)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('v1', {
    role: 'verifier',
    taskId: '001-001-001-002',
    description: 'verifying',
    status: 'active',
    elapsed: 4,
    cost: 0,
  });
  sb._render();

  const combined = chunks.join('');
  assert.ok(/🔍/.test(combined), `Verifier row should include 🔍 icon, got: ${combined.slice(0, 200)}`);

  sb.destroy();
});

// TC5: updateAgent with null signal removes agent row (idle rows no longer rendered)
await test('TTY: updateAgent with null signal removes agent row — idle rows no longer rendered (TC5)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  // Add an agent first so it appears in the render output
  sb.updateAgent('exec-remove', {
    role: 'executor',
    taskId: 'task-to-remove',
    description: 'running',
    status: 'active',
    elapsed: 0,
    cost: 0,
  });
  sb._render();

  const before = chunks.join('');
  assert.ok(/task-to-remove/.test(before), `agent row should appear before null signal, got: ${before.slice(0, 200)}`);

  // Clear chunks and send null signal (agent-end / deletion)
  chunks.length = 0;
  sb.updateAgent('exec-remove', null);
  sb._render();

  const after = chunks.join('');
  // Agent must be deleted from the Map — its taskId must not appear in the rendered output
  assert.ok(
    !/task-to-remove/.test(after),
    `agent row must NOT appear after null signal (agent deleted), got: ${after.slice(0, 200)}`,
  );
  // The "(no active agents)" placeholder must appear (agent removed, nothing left)
  assert.ok(
    /no active agents/.test(after),
    `"(no active agents)" placeholder must appear after all agents removed via null signal, got: ${after.slice(0, 200)}`,
  );

  sb.destroy();
});

// TC6: removing agent removes row from render output
await test('TTY: removing agent removes row from render output (TC6)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  // Add an agent with a unique taskId we can detect in the render output
  sb.updateAgent('agent-to-remove', {
    role: 'analyzer',
    taskId: 'UNIQUE-TASK-REMOVE-001',
    description: 'temporary work',
    status: 'active',
    elapsed: 3,
    cost: 0,
  });
  sb._render();

  const before = chunks.join('');
  assert.ok(/UNIQUE-TASK-REMOVE-001/.test(before),
    `taskId should appear in rendered output before removal, got: ${before.slice(0, 300)}`);

  // Clear chunks, remove the agent by passing null
  chunks.length = 0;
  sb.updateAgent('agent-to-remove', null);
  sb._render();

  const after = chunks.join('');
  assert.ok(!/UNIQUE-TASK-REMOVE-001/.test(after),
    `taskId should NOT appear in rendered output after removal, got: ${after.slice(0, 300)}`);

  sb.destroy();
});

// TC7: updateMilestone renders header with version and milestone ID
await test('TTY: updateMilestone renders header with version and milestone ID (TC7)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateMilestone('001-003', 12, 240);
  // Force render to bypass debounce
  sb._render();

  const combined = chunks.join('');
  // Header should contain the package version prefix
  assert.ok(/(cc-orch|nightfoundry) v/.test(combined),
    `render should include the display name + version, got: ${combined.slice(0, 300)}`);
  // Header should include milestone ID
  assert.ok(/001-003/.test(combined),
    `render should include milestone ID "001-003", got: ${combined.slice(0, 300)}`);

  sb.destroy();
});

// TC8: updateProgress renders progress bar proportional to done/total
await test('TTY: updateProgress renders progress bar proportional to done/total (TC8)', () => {
  const { stream: s1, chunks: c1 } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb1 = new StatusBar({ output: s1 });

  // 5 done out of 10 total = 50% → ~equal fill/empty
  sb1.updateProgress(5, 10, 0.10, 2);
  sb1._render();

  const combined1 = c1.join('');
  // Progress bar uses █ for fill and ░ for empty
  assert.ok(/█/.test(combined1), `progress bar should have filled chars (█) at 50%, got: ${combined1.slice(0, 300)}`);
  assert.ok(/░/.test(combined1), `progress bar should have empty chars (░) at 50%, got: ${combined1.slice(0, 300)}`);

  sb1.destroy();

  // Verify proportionality: 8/10 should have more fill than 2/10
  const { stream: s2, chunks: c2 } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb2 = new StatusBar({ output: s2 });
  sb2.updateProgress(8, 10, 0, 1);
  sb2._render();
  const high = c2.join('');
  sb2.destroy();

  const { stream: s3, chunks: c3 } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb3 = new StatusBar({ output: s3 });
  sb3.updateProgress(2, 10, 0, 1);
  sb3._render();
  const low = c3.join('');
  sb3.destroy();

  const countFill = (s) => (s.match(/█/g) || []).length;
  assert.ok(
    countFill(high) > countFill(low),
    `80% fill (${countFill(high)} chars) should be greater than 20% fill (${countFill(low)} chars)`,
  );
});

// TC9: progress bar shows done/total count, cost, session count
await test('TTY: progress bar shows done/total count, cost, session count (TC9)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 100 });
  const sb = new StatusBar({ output: stream });

  sb.updateProgress(7, 15, 0.42, 3);
  sb._render();

  const combined = chunks.join('');
  // done/total count in "7/15 tasks" format
  assert.ok(/7\/15/.test(combined),
    `render should show done/total as "7/15", got: ${combined.slice(0, 300)}`);
  // cost in $0.42 format
  assert.ok(/\$0\.42/.test(combined),
    `render should show cost "$0.42", got: ${combined.slice(0, 300)}`);
  // session count in "3 sessions" format
  assert.ok(/3 sessions/.test(combined),
    `render should show "3 sessions", got: ${combined.slice(0, 300)}`);

  sb.destroy();
});

// ── Role icon coverage ────────────────────────────────────────────────

await test('TTY: all role icons render correctly (Planner, Reviewer, Analyzer, Summarizer)', () => {
  const roles = [
    { role: 'planner',    icon: '🧠' },
    { role: 'reviewer',   icon: '📋' },
    { role: 'analyzer',   icon: '🔧' },
    { role: 'summarizer', icon: '📝' },
  ];

  for (const { role, icon } of roles) {
    const { stream, chunks } = makeFakeStream({ isTTY: true });
    const bar = new StatusBar({ output: stream });
    bar.updateAgent('agent', {
      role,
      taskId: null,
      description: '',
      status: 'active',
      elapsed: 0,
      cost: 0,
    });
    bar._render();
    const combined = chunks.join('');
    assert.ok(combined.includes(icon),
      `expected icon ${icon} for role ${role}, got: ${combined.slice(0, 200)}`);
    bar.destroy();
  }
});

// ── Sleep helper test ─────────────────────────────────────────────────

await test('sleep() helper waits at least the requested duration', async () => {
  const start = Date.now();
  await sleep(20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 15, `sleep(20) should wait at least 15ms, waited ${elapsed}ms`);
});

// ── Debounce test — updateAgent fires after delay ─────────────────────

await test('TTY: update methods debounce and eventually render (via sleep)', async () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb.updateProgress(3, 10, 0.05, 1);
  // Nothing should be written yet (debounce pending)
  assert.strictEqual(chunks.length, 0, 'nothing rendered synchronously (debounce active)');

  // Wait for debounce to fire
  await sleep(150);
  assert.ok(chunks.length > 0, 'render should have fired after debounce timeout');

  sb.destroy();
});

// ── Advanced TTY Tests ────────────────────────────────────────────────

// ADV-TC1: DECSTBM escape sequence (\x1b[{top};{bottom}r) present in render output
await test('TTY advanced: DECSTBM escape (\\x1b[<top>;<bottom>r) present in render output (ADV-TC1)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();

  const combined = chunks.join('');
  // DECSTBM: ESC [ <digits> ; <digits> r
  assert.ok(
    /\x1b\[\d+;\d+r/.test(combined),
    `render output must contain DECSTBM \\x1b[<top>;<bottom>r, got: ${combined.slice(0, 200)}`,
  );

  sb.destroy();
});

// ADV-TC2: debounce — 3 rapid _scheduleRender calls produce ≤1 render within 100ms
await test('TTY advanced: 3 rapid schedule calls produce ≤1 render within 100ms window (ADV-TC2)', async () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  let renderCount = 0;
  const origRender = StatusBar.prototype._render.bind(sb);
  sb._render = function () { renderCount++; origRender(); };

  // 3 rapid _scheduleRender calls — only the last debounce timer should fire
  sb._scheduleRender();
  sb._scheduleRender();
  sb._scheduleRender();

  // Synchronously, debounce has not fired yet → ≤1 render
  assert.ok(renderCount <= 1, `expected ≤1 render within 100ms window, got ${renderCount}`);

  // Allow the pending timer to fire cleanly before destroy
  await sleep(150);
  sb.destroy();
});

// ADV-TC3: after debounce window (sleep 150ms), render has fired exactly once
await test('TTY advanced: after debounce window (150ms), render fired exactly once (ADV-TC3)', async () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  let renderCount = 0;
  const origRender = StatusBar.prototype._render.bind(sb);
  sb._render = function () { renderCount++; origRender(); };

  // 3 rapid _scheduleRender calls
  sb._scheduleRender();
  sb._scheduleRender();
  sb._scheduleRender();

  // Wait for debounce to fire
  await sleep(150);

  assert.strictEqual(renderCount, 1,
    `expected exactly 1 render after debounce window, got ${renderCount}`);

  sb.destroy();
});

// ADV-TC4: resize event on stream triggers re-render with updated rows/columns
await test('TTY advanced: resize event on stream triggers re-render with updated rows/columns (ADV-TC4)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0; // clear initial render output

  // Update stream dimensions then fire resize
  stream.rows = 30;
  stream.columns = 100;
  stream.emit('resize');

  const combined = chunks.join('');
  assert.ok(chunks.length > 0, 'resize event should trigger a re-render');
  // Re-render must position the bar using the updated row count.
  // With rows=30 and barHeight=7 (chrome=6 + 1 placeholder), scrollBottom=23, barStartRow=24.
  // The output must contain a cursor move to row 23 or 24 reflecting the new terminal dimensions.
  assert.ok(
    /\x1b\[2[3-4];1H/.test(combined),
    `re-render after resize must position cursor using updated row count (row 23 or 24 for rows=30), got: ${combined.slice(0, 200)}`,
  );

  sb.destroy();
});

// ADV-TC5: hide() clears bar area and resets DECSTBM scroll region
await test('TTY advanced: hide() clears bar area and resets DECSTBM scroll region (ADV-TC5)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Render first so _renderedLines > 0, enabling the clear-area path in hide()
  sb._render();
  chunks.length = 0;

  sb.hide();

  const combined = chunks.join('');
  // hide() must emit ANSI_RESET_SCROLL = '\x1b[r' (no digits — full-screen reset)
  assert.ok(
    /\x1b\[r(?!\d)/.test(combined),
    `hide() must reset scroll region with \\x1b[r, got: ${combined.slice(0, 200)}`,
  );
  // hide() must also erase the bar area with ANSI_CLEAR_TO_END = '\x1b[J'
  assert.ok(
    /\x1b\[J/.test(combined),
    `hide() must clear bar area with \\x1b[J, got: ${combined.slice(0, 200)}`,
  );

  sb.destroy();
});

// ADV-TC6: show() re-establishes scroll region and renders bar
await test('TTY advanced: show() re-establishes scroll region and renders bar (ADV-TC6)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  sb.hide();
  chunks.length = 0;

  sb.show();

  const combined = chunks.join('');
  // show() calls _render() which must re-establish DECSTBM scroll region
  assert.ok(
    /\x1b\[\d+;\d+r/.test(combined),
    `show() must re-establish DECSTBM scroll region, got: ${combined.slice(0, 200)}`,
  );
  // show() calls _render() which must redraw the bar — verified by presence of
  // ANSI_SAVE_CURSOR (\x1b[s) followed by a cursor-position sequence (\x1b[<row>;1H).
  // (_render() no longer emits \x1b[J; it uses save/move/lines/restore instead.)
  assert.ok(
    /\x1b\[s/.test(combined),
    `show() must redraw bar content (\\x1b[s save-cursor emitted by _render()), got: ${combined.slice(0, 200)}`,
  );

  sb.destroy();
});

// ADV-TC7: destroy() removes resize listener from stream
await test('TTY advanced: destroy() removes resize listener from stream (ADV-TC7)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  const listenersBefore = stream.listenerCount('resize');
  assert.ok(listenersBefore >= 1, 'resize listener should be attached after construction');

  sb.destroy();

  const listenersAfter = stream.listenerCount('resize');
  assert.strictEqual(
    listenersAfter,
    listenersBefore - 1,
    `destroy() should remove exactly one resize listener (before: ${listenersBefore}, after: ${listenersAfter})`,
  );
});

// ADV-TC8: long description truncated with '...' to fit terminal width
await test("TTY advanced: long description truncated with '...' to fit terminal width (ADV-TC8)", () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  const longDesc = 'D'.repeat(300);
  sb.updateAgent('trunc-agent', {
    role: 'executor',
    taskId: '001-001',
    description: longDesc,
    status: 'active',
    elapsed: 1,
    cost: 0,
  });
  // Explicit _render() call to ensure output is captured synchronously
  sb._render();

  const combined = chunks.join('');
  assert.ok(
    /\.\.\./.test(combined),
    `long description should be truncated with '...', got: ${combined.slice(0, 400)}`,
  );
  // The 300-character raw description should not appear verbatim
  assert.ok(
    !combined.includes('D'.repeat(50)),
    'long description should be truncated — verbatim content should not appear',
  );

  sb.destroy();
});

// ADV-TC9: fallback to 80×24 when stream.rows and stream.columns are undefined
await test('TTY advanced: fallback to 80×24 when stream.rows/columns are undefined (ADV-TC9)', () => {
  const chunks = [];
  const rawStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  rawStream.isTTY = true;
  // rows and columns intentionally NOT set → they are undefined

  const sb = new StatusBar({ output: rawStream });

  const { rows, columns } = sb._getDimensions();
  assert.strictEqual(rows, 24, `fallback rows must be 24, got ${rows}`);
  assert.strictEqual(columns, 80, `fallback columns must be 80, got ${columns}`);

  // Also verify _render() does not throw when using fallback dimensions
  assert.doesNotThrow(() => sb._render(), 'render with undefined stream dimensions should not throw');

  sb.destroy();
});

// TC13: agent rows capped at maxRows=8 — overflow produces "+N more" indicator
await test('TTY: agent rows capped at maxRows=8, overflow shows "+N more" indicator (TC13)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 40, columns: 120 });
  const sb = new StatusBar({ output: stream, maxRows: 8 });

  // Add 10 agents — 2 should be hidden (10 - maxRows=8 = 2)
  for (let i = 1; i <= 10; i++) {
    sb.updateAgent(`agent-${i}`, {
      role: 'executor',
      taskId: `task-${i}`,
      description: `working on task ${i}`,
      status: 'active',
      elapsed: i,
      cost: 0.001 * i,
    });
  }
  sb._render();

  const combined = chunks.join('');
  // The overflow line should mention "+2 more"
  assert.ok(
    /\+2 more/.test(combined),
    `expected "+2 more" overflow indicator for 10 agents with maxRows=8, got: ${combined.slice(0, 400)}`,
  );

  sb.destroy();
});

// ── New test cases: concurrency, maxRows, prompt coexistence, dashboard coexistence, error path ──

// NEW-TC1: 3 concurrent executors with different names produce 3 separate rows
await test('TTY: 3 concurrent executors produce 3 separate agent rows (NEW-TC1)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 30, columns: 120 });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('executor-A', {
    role: 'executor',
    taskId: 'task-A-001',
    description: 'working on A',
    status: 'active',
    elapsed: 1,
    cost: 0.001,
  });
  sb.updateAgent('executor-B', {
    role: 'executor',
    taskId: 'task-B-002',
    description: 'working on B',
    status: 'active',
    elapsed: 2,
    cost: 0.002,
  });
  sb.updateAgent('executor-C', {
    role: 'executor',
    taskId: 'task-C-003',
    description: 'working on C',
    status: 'active',
    elapsed: 3,
    cost: 0.003,
  });
  sb._render();

  const combined = chunks.join('');
  assert.ok(/task-A-001/.test(combined), `executor-A taskId should appear in output, got: ${combined.slice(0, 400)}`);
  assert.ok(/task-B-002/.test(combined), `executor-B taskId should appear in output, got: ${combined.slice(0, 400)}`);
  assert.ok(/task-C-003/.test(combined), `executor-C taskId should appear in output, got: ${combined.slice(0, 400)}`);
  // Each row contains the Executor label — expect at least 3 occurrences
  const executorMatches = combined.match(/Executor/g) || [];
  assert.ok(
    executorMatches.length >= 3,
    `expected at least 3 Executor rows for 3 concurrent executors, got ${executorMatches.length} in: ${combined.slice(0, 400)}`,
  );

  sb.destroy();
});

// NEW-TC2: adding 10 agents with maxRows=8 renders only 8 agent rows
await test('TTY: maxRows=8 cap — adding 10 agents renders exactly 8 agent rows (NEW-TC2)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 40, columns: 120 });
  const sb = new StatusBar({ output: stream, maxRows: 8 });

  for (let i = 1; i <= 10; i++) {
    sb.updateAgent(`agent-nr-${i}`, {
      role: 'executor',
      taskId: `nr-task-${String(i).padStart(2, '0')}`,
      description: `task ${i}`,
      status: 'active',
      elapsed: i,
      cost: 0.001 * i,
    });
  }
  sb._render();

  const combined = chunks.join('');
  // Count how many of the 10 unique task IDs appear in the output
  let visibleCount = 0;
  for (let i = 1; i <= 10; i++) {
    const taskId = `nr-task-${String(i).padStart(2, '0')}`;
    if (combined.includes(taskId)) visibleCount++;
  }
  assert.strictEqual(
    visibleCount,
    8,
    `expected exactly 8 agent rows visible with maxRows=8, got ${visibleCount}`,
  );
  // The 9th and 10th agents should not appear as individual rows
  assert.ok(
    !combined.includes('nr-task-09'),
    `agent 9 should not render as a row (beyond maxRows=8), got: ${combined.slice(0, 500)}`,
  );
  assert.ok(
    !combined.includes('nr-task-10'),
    `agent 10 should not render as a row (beyond maxRows=8), got: ${combined.slice(0, 500)}`,
  );

  sb.destroy();
});

// NEW-TC4: Dashboard + StatusBar on same stream — Dashboard events do not corrupt StatusBar bar region
// NOTE: first-render may emit a scroll-region-scoped clear (e.g. \x1b[J) to initialise the bar
// area, but it must NEVER emit the full-screen clear \x1b[2J which would wipe Dashboard output.
await test('TTY: Dashboard + StatusBar on same stream — Dashboard output does not corrupt bar (NEW-TC4)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 30, columns: 100 });

  const dashboard = new Dashboard({
    output: stream,
    sink: () => {},   // no-op sink — we only care about stream output
  });

  const sb = new StatusBar({ output: stream });
  sb.updateAgent('exec-shared-1', {
    role: 'executor',
    taskId: 'shared-task-001',
    description: 'running',
    status: 'active',
    elapsed: 5,
    cost: 0.01,
  });

  // Fire Dashboard events on the same stream BEFORE the first StatusBar render.
  // This verifies that Dashboard output on the shared stream does not prevent StatusBar
  // from correctly establishing its DECSTBM scroll region on first render.
  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 3, pending: 3 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1, description: 'parallel' });

  // Clear Dashboard output; isolate StatusBar render output
  chunks.length = 0;

  // First StatusBar render — must establish DECSTBM even after Dashboard activity
  sb._render();

  const combined = chunks.join('');
  // StatusBar must establish DECSTBM scroll region (bar region not corrupted by Dashboard output)
  assert.ok(
    /\x1b\[\d+;\d+r/.test(combined),
    `StatusBar DECSTBM must be present after Dashboard events on same stream, got: ${combined.slice(0, 500)}`,
  );
  // StatusBar must NOT use full-screen clear which would wipe Dashboard output
  assert.ok(
    !/\x1b\[2J/.test(combined),
    `StatusBar must not use full-screen clear (\\x1b[2J) after Dashboard events, got: ${combined.slice(0, 500)}`,
  );
  // The agent registered with StatusBar should still appear
  assert.ok(
    /shared-task-001/.test(combined),
    `StatusBar agent row must still render after Dashboard events on same stream, got: ${combined.slice(0, 500)}`,
  );

  sb.destroy();
});

// NEW-TC6: agent lifecycle error path — row persists until explicit null signal (agent deletion)
await test('TTY: agent lifecycle error path — row persists until explicit null signal (NEW-TC6)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Step 1: agent starts active
  sb.updateAgent('exec-error', {
    role: 'executor',
    taskId: 'error-task-001',
    description: 'processing work',
    status: 'active',
    elapsed: 10,
    cost: 0.005,
  });
  sb._render();

  const beforeError = chunks.join('');
  assert.ok(
    /error-task-001/.test(beforeError),
    `agent row should be visible while active, got: ${beforeError.slice(0, 300)}`,
  );

  // Step 2: simulate error — no explicit end call is made, agent state is unchanged
  chunks.length = 0;
  sb._render();  // re-render without updating the agent — row must persist

  const duringError = chunks.join('');
  assert.ok(
    /error-task-001/.test(duringError),
    `agent row must persist after simulated error (no end/null call made), got: ${duringError.slice(0, 300)}`,
  );

  // Step 3: null signal removes the agent row (no idle state — null is the deletion signal)
  chunks.length = 0;
  sb.updateAgent('exec-error', null);
  sb._render();

  const afterNull = chunks.join('');
  // The error taskId should no longer appear after null signal
  assert.ok(
    !/error-task-001/.test(afterNull),
    `error-task-001 must NOT appear after null signal (agent deleted), got: ${afterNull.slice(0, 300)}`,
  );
  // The "(no active agents)" placeholder must appear — agent was deleted, no idle row rendered
  assert.ok(
    /no active agents/.test(afterNull),
    `"(no active agents)" must appear after null signal — idle rows are not rendered, got: ${afterNull.slice(0, 300)}`,
  );

  sb.destroy();
});

// ── Data-model unit tests (TC-DM series) ─────────────────────────────────────

// TC-DM-1: All 6 lowercase role keys resolve to correct icons
await test('data-model: all 6 lowercase role keys resolve to correct icons (TC-DM-1)', () => {
  const EXPECTED = [
    { role: 'planner',    icon: '🧠' },
    { role: 'executor',   icon: '⚡' },
    { role: 'verifier',   icon: '🔍' },
    { role: 'reviewer',   icon: '📋' },
    { role: 'analyzer',   icon: '🔧' },
    { role: 'summarizer', icon: '📝' },
  ];

  for (const { role, icon } of EXPECTED) {
    const { stream, chunks } = makeFakeStream({ isTTY: true });
    const sb = new StatusBar({ output: stream });
    sb.updateAgent('agent', {
      role,
      taskId: `task-${role}`,
      description: `testing ${role}`,
      status: 'active',
      elapsed: 1,
      cost: 0,
    });
    sb._render();
    const combined = chunks.join('');
    assert.ok(
      combined.includes(icon),
      `expected icon "${icon}" for lowercase role "${role}", got: ${combined.slice(0, 200)}`,
    );
    sb.destroy();
  }
});

// TC-DM-2: updateAgent adds entry to Map, Map.size increases
await test('data-model: updateAgent adds entry to Map, Map.size increases (TC-DM-2)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  assert.strictEqual(sb.agents.size, 0, 'agents Map should be empty initially');

  sb.updateAgent('executor-1', {
    role: 'executor',
    taskId: 'dm-task-001',
    description: 'doing work',
    status: 'active',
    elapsed: 0,
    cost: 0,
  });
  assert.strictEqual(sb.agents.size, 1, 'Map.size should be 1 after adding first agent');

  sb.updateAgent('executor-2', {
    role: 'executor',
    taskId: 'dm-task-002',
    description: 'doing more work',
    status: 'active',
    elapsed: 0,
    cost: 0,
  });
  assert.strictEqual(sb.agents.size, 2, 'Map.size should be 2 after adding second agent');

  sb.destroy();
});

// TC-DM-3: updateAgent(key, null) removes entry from Map, Map.size decreases
await test('data-model: updateAgent(key, null) removes entry, Map.size decreases (TC-DM-3)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('agent-a', {
    role: 'planner',
    taskId: 'dm-plan-001',
    description: 'planning',
    status: 'active',
    elapsed: 2,
    cost: 0,
  });
  sb.updateAgent('agent-b', {
    role: 'verifier',
    taskId: 'dm-verify-001',
    description: 'verifying',
    status: 'active',
    elapsed: 3,
    cost: 0,
  });
  assert.strictEqual(sb.agents.size, 2, 'Map.size should be 2 before removal');

  sb.updateAgent('agent-a', null);
  assert.strictEqual(sb.agents.size, 1, 'Map.size should be 1 after removing agent-a');

  sb.updateAgent('agent-b', null);
  assert.strictEqual(sb.agents.size, 0, 'Map.size should be 0 after removing all agents');

  sb.destroy();
});

// TC-DM-4: After removing all agents, _buildLines shows '(no active agents)'
await test('data-model: after removing all agents, _buildLines shows (no active agents) (TC-DM-4)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateAgent('temp-agent', {
    role: 'analyzer',
    taskId: 'dm-analyze-001',
    description: 'analyzing',
    status: 'active',
    elapsed: 5,
    cost: 0,
  });
  assert.strictEqual(sb.agents.size, 1, 'precondition: 1 agent in map');

  // Remove the agent via null (agent-end)
  sb.updateAgent('temp-agent', null);
  assert.strictEqual(sb.agents.size, 0, 'Map.size must be 0 after removal');

  // _buildLines should show the no-agents placeholder
  const lines = sb._buildLines(80);
  const combined = lines.join('\n');
  assert.ok(
    /\(no active agents\)/.test(combined),
    `_buildLines should show "(no active agents)" when Map is empty, got: ${combined}`,
  );

  sb.destroy();
});

// TC-DM-5: updateProgress(0,0,...) with phase set shows phase name in progress line
await test('data-model: updateProgress(0,0,...) with phase shows phase name, not bar (TC-DM-5)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateProgress(0, 0, 0, 0, 'planning mission 001');

  const line = sb._buildProgressLine(80);
  assert.ok(
    /planning mission 001/.test(line),
    `progress line should show phase name when total===0, got: ${line}`,
  );
  // Must NOT show numeric bar chars when in phase-name mode
  assert.ok(
    !/█/.test(line) && !/░/.test(line),
    `progress line must not show bar chars when in phase mode, got: ${line}`,
  );

  sb.destroy();
});

// TC-DM-6: updateProgress(3,10,...) shows numeric bar, not phase name
await test('data-model: updateProgress(3,10,...) shows numeric bar, not phase name (TC-DM-6)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  sb.updateProgress(3, 10, 0.05, 1, 'some phase');

  const line = sb._buildProgressLine(80);
  // Should show bar characters
  assert.ok(
    /█/.test(line),
    `progress line should show fill chars (█) when total>0, got: ${line}`,
  );
  assert.ok(
    /░/.test(line),
    `progress line should show empty chars (░) when total>0 and not full, got: ${line}`,
  );
  // Should show done/total count
  assert.ok(
    /3\/10/.test(line),
    `progress line should show "3/10", got: ${line}`,
  );
  // Phase name must NOT appear when total>0
  assert.ok(
    !/some phase/.test(line),
    `phase name must not appear when total>0, got: ${line}`,
  );

  sb.destroy();
});

// TC-DM-7: Phase name truncated to terminal width
await test('data-model: phase name truncated to terminal width (TC-DM-7)', () => {
  const { stream } = makeFakeStream({ isTTY: true, columns: 40 });
  const sb = new StatusBar({ output: stream });

  const longPhase = 'A'.repeat(200);
  sb.updateProgress(0, 0, 0, 0, longPhase);

  const line = sb._buildProgressLine(40);
  // Line must not exceed the given width
  assert.ok(
    line.length <= 40,
    `progress line must not exceed terminal width of 40, got length ${line.length}: ${line}`,
  );
  // The full 200-char phase name must not appear verbatim
  assert.ok(
    !line.includes('A'.repeat(50)),
    `phase name must be truncated — verbatim content should not appear, got: ${line}`,
  );
  // Truncation marker '...' must be present
  assert.ok(
    /\.\.\./.test(line),
    `truncated phase name must end with '...', got: ${line}`,
  );

  sb.destroy();
});

// ── 001-001-002-004: Layout safety, onLog, prompt coexistence, bar height ─────

// NEW-LAYOUT-TC1: _render() never emits \x1b[2J (full-screen clear)
// NOTE: first-render may emit a scroll-region-scoped clear (e.g. \x1b[J) to
// initialise the bar area, but it must NEVER emit the full-screen clear \x1b[2J.
await test('NEW-LAYOUT-TC1: _render() never emits \\x1b[2J (full-screen clear)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Add an agent so bar content is non-trivial
  sb.updateAgent('agent-layout', {
    role: 'executor',
    taskId: 'layout-task-001',
    description: 'checking layout safety',
    status: 'active',
    elapsed: 5,
    cost: 0.01,
  });
  sb._render();
  sb._render(); // render twice to exercise update path as well

  const combined = chunks.join('');
  assert.ok(
    !/\x1b\[2J/.test(combined),
    `_render() must never emit \\x1b[2J (full-screen clear), got: ${combined.slice(0, 400)}`,
  );

  sb.destroy();
});

// NEW-ONLOG-TC1: onLog() scroll-up path — emits save-cursor + scroll-up + move-to + text + restore-cursor
// The scroll-up single path is triggered when the scroll region is full (_logRow >= scrollBottom).
// In this path the message is NOT followed by \n but by \x1b[u (ANSI_RESTORE_CURSOR).
// Sequence: \x1b[s (save) + \x1b[S (scroll-up 1 line) + \x1b[<row>;1H (move to scrollBottom) + text + \x1b[u (restore)
await test('NEW-ONLOG-TC1: onLog() scroll-up path emits \\x1b[s + \\x1b[S + MOVE_TO + text + \\x1b[u (no trailing \\n)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Render first so _renderedLines is set (bar visible, not hidden)
  sb._render();

  // Compute scrollBottom for the assertion below (onLog is always scroll-up)
  const { rows } = sb._getDimensions();
  const scrollBottom = Math.max(1, rows - sb._renderedLines);

  chunks.length = 0;

  sb.onLog('column0-test-message');

  const combined = chunks.join('');

  // (1) output must contain ANSI_SAVE_CURSOR \x1b[s
  assert.ok(
    combined.includes('\x1b[s'),
    `onLog() scroll-up path must emit \\x1b[s (save cursor), got: ${combined.slice(0, 300)}`,
  );

  // (2) output must contain \x1b[S (scroll-up 1 line inside DECSTBM region)
  assert.ok(
    combined.includes('\x1b[S'),
    `onLog() scroll-up path must emit \\x1b[S (scroll-up), got: ${combined.slice(0, 300)}`,
  );

  // (3) output must contain ANSI_MOVE_TO(scrollBottom, 1) = \x1b[<scrollBottom>;1H
  assert.ok(
    combined.includes(`\x1b[${scrollBottom};1H`),
    `onLog() must move to scrollBottom row (\\x1b[${scrollBottom};1H), got: ${combined.slice(0, 300)}`,
  );

  // (4) The message text must appear in the output
  assert.ok(
    combined.includes('column0-test-message'),
    `onLog() must write the message text, got: ${combined.slice(0, 300)}`,
  );

  // (5) The message must be followed by \x1b[u (ANSI_RESTORE_CURSOR), NOT by \n
  const msgIndex = combined.indexOf('column0-test-message');
  const afterMsg = combined.slice(msgIndex + 'column0-test-message'.length);
  assert.ok(
    afterMsg.startsWith('\x1b[u'),
    `onLog() scroll-up path: message must be followed immediately by \\x1b[u (restore cursor), not \\n, got after msg: ${JSON.stringify(afterMsg.slice(0, 20))}`,
  );

  sb.destroy();
});

// NEW-ONLOG-TC2: Two onLog() calls produce two separate scroll-up writes in output (no interleaving)
// Assertions (column-0 moves ≥ 2, order preserved) are direction-agnostic and remain correct
// for both the fill path and the scroll-up path.
await test('NEW-ONLOG-TC2: Two onLog() calls produce two separate scroll-up writes in output', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Render so bar is visible; then isolate onLog output
  sb._render();
  chunks.length = 0;

  sb.onLog('first-line-001');
  sb.onLog('second-line-002');

  const combined = chunks.join('');

  // Both messages must appear
  assert.ok(
    combined.includes('first-line-001'),
    `first-line-001 must appear in output, got: ${combined.slice(0, 400)}`,
  );
  assert.ok(
    combined.includes('second-line-002'),
    `second-line-002 must appear in output, got: ${combined.slice(0, 400)}`,
  );

  // Both messages must appear in their own writes — each preceded by a column-0 move
  const moveCursorCount = (combined.match(/\x1b\[\d+;1H/g) || []).length;
  assert.ok(
    moveCursorCount >= 2,
    `expected at least 2 column-0 cursor moves (one per onLog call), got ${moveCursorCount} in: ${combined.slice(0, 400)}`,
  );

  // The messages must appear in order: first-line before second-line
  const idx1 = combined.indexOf('first-line-001');
  const idx2 = combined.indexOf('second-line-002');
  assert.ok(
    idx1 < idx2,
    `first-line-001 (at ${idx1}) must appear before second-line-002 (at ${idx2}) in output`,
  );

  sb.destroy();
});

// NEW-PROMPT-TC1: promptWillStart() positions cursor in scroll region (native implementation)
await test('NEW-PROMPT-TC1: promptWillStart() positions cursor in scroll region (native impl)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Render so _renderedLines is populated (bar established)
  sb._render();
  chunks.length = 0;

  // Call the native promptWillStart() — not a shim
  sb.promptWillStart();

  const combined = chunks.join('');

  // promptWillStart() must emit ANSI_MOVE_TO(scrollBottom, 1) = \x1b[<row>;1H
  // where scrollBottom = rows - barHeight (some row above the bar, inside scroll region)
  assert.ok(
    /\x1b\[\d+;1H/.test(combined),
    `promptWillStart() must position cursor via \\x1b[<row>;1H, got: ${combined.slice(0, 300)}`,
  );

  // The row number in the cursor move must be at or below the scroll region bottom
  // (strictly less than the terminal row count, since barHeight > 0 after _render)
  const match = combined.match(/\x1b\[(\d+);1H/);
  assert.ok(match, `cursor move escape must be present in promptWillStart() output`);
  const cursorRow = Number(match[1]);
  const { rows } = sb._getDimensions();
  const barHeight = sb._renderedLines;
  const expectedScrollBottom = Math.max(1, rows - barHeight);
  assert.strictEqual(
    cursorRow,
    expectedScrollBottom,
    `cursor row ${cursorRow} must equal scrollBottom (rows - barHeight = ${rows} - ${barHeight} = ${expectedScrollBottom})`,
  );

  sb.destroy();
});

// NEW-PROMPT-TC2: promptDidEnd() triggers re-render (DECSTBM reappears in output)
await test('NEW-PROMPT-TC2: promptDidEnd() triggers re-render (native impl — DECSTBM reappears)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Render to set up the bar
  sb._render();
  chunks.length = 0;

  // Call the native promptDidEnd() — must call _render() internally
  sb.promptDidEnd();

  const combined = chunks.join('');

  // promptDidEnd() must trigger _render(), which produces output (chunks non-empty)
  assert.ok(
    chunks.length > 0,
    `promptDidEnd() must trigger re-render (output chunks must be non-empty), got: ${combined.slice(0, 300)}`,
  );
  // The re-render must position the cursor in the bar region (row 17 for rows=24, barHeight=7)
  assert.ok(
    /\x1b\[\d+;1H/.test(combined),
    `promptDidEnd() re-render must emit a cursor-positioning sequence (\\x1b[<row>;1H), got: ${combined.slice(0, 300)}`,
  );

  // The re-render must also NOT use full-screen clear
  assert.ok(
    !/\x1b\[2J/.test(combined),
    `promptDidEnd() re-render must not emit \\x1b[2J, got: ${combined.slice(0, 300)}`,
  );

  sb.destroy();
});

// NEW-BARHEIGHT-TC1: bar height = agent count + chrome (no empty gap rows)
await test('NEW-BARHEIGHT-TC1: bar height = agent count + chrome (no empty gap rows)', () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 40, columns: 120 });
  const sb = new StatusBar({ output: stream });

  // Chrome = top border + header + sep + sep + progress + bottom border = 6 lines
  const CHROME = 6;

  // With 0 agents: bar = CHROME + 1 (the "(no active agents)" placeholder)
  const linesZero = sb._buildLines(120);
  assert.strictEqual(
    linesZero.length,
    CHROME + 1,
    `with 0 agents, bar height must be CHROME(6) + 1 placeholder = ${CHROME + 1}, got ${linesZero.length}`,
  );

  // With 1 agent: bar = CHROME + 1
  sb.updateAgent('agent-h1', {
    role: 'executor', taskId: 'h-task-001', description: 'one', status: 'active', elapsed: 1, cost: 0,
  });
  const lines1 = sb._buildLines(120);
  assert.strictEqual(
    lines1.length,
    CHROME + 1,
    `with 1 agent, bar height must be CHROME(6) + 1 = ${CHROME + 1}, got ${lines1.length}`,
  );

  // With 3 agents: bar = CHROME + 3
  sb.updateAgent('agent-h2', {
    role: 'verifier', taskId: 'h-task-002', description: 'two', status: 'active', elapsed: 2, cost: 0,
  });
  sb.updateAgent('agent-h3', {
    role: 'planner', taskId: 'h-task-003', description: 'three', status: 'active', elapsed: 3, cost: 0,
  });
  const lines3 = sb._buildLines(120);
  assert.strictEqual(
    lines3.length,
    CHROME + 3,
    `with 3 agents, bar height must be CHROME(6) + 3 = ${CHROME + 3}, got ${lines3.length}`,
  );

  // Verify no "empty gap" — no line in the array is undefined or empty string beyond expected
  for (let i = 0; i < lines3.length; i++) {
    assert.ok(
      typeof lines3[i] === 'string',
      `every line in _buildLines() output must be a string, but line[${i}] is ${typeof lines3[i]}`,
    );
    // We don't assert non-empty since separators are valid (they are ═ or ─ repeated chars)
  }

  sb.destroy();
});

// ── teardown() test cases (001-002-001-002) ────────────────────────────────

// TEARDOWN-TC1: teardown() emits \x1b[r (scroll region reset)
await test('teardown: emits \\x1b[r (scroll region reset) (TEARDOWN-TC1)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.teardown();

  const combined = chunks.join('');
  assert.ok(
    /\x1b\[r/.test(combined),
    `teardown() must emit \\x1b[r (scroll region reset), got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// TEARDOWN-TC2: teardown() erases bar area (\x1b[J present in output)
await test('teardown: erases bar area (\\x1b[J present in output) (TEARDOWN-TC2)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.teardown();

  const combined = chunks.join('');
  assert.ok(
    /\x1b\[J/.test(combined),
    `teardown() must emit \\x1b[J (erase to end) to clear bar area, got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// TEARDOWN-TC3: teardown() emits \x1b[?25h (show cursor)
await test('teardown: emits \\x1b[?25h (show cursor) (TEARDOWN-TC3)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.teardown();

  const combined = chunks.join('');
  assert.ok(
    /\x1b\[\?25h/.test(combined),
    `teardown() must emit \\x1b[?25h (show cursor), got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// TEARDOWN-TC4: teardown() removes resize listener from output stream
await test('teardown: removes resize listener from output stream (TEARDOWN-TC4)', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream });

  const listenersBefore = stream.listenerCount('resize');
  assert.ok(listenersBefore >= 1, 'resize listener should be attached after construction');

  sb.teardown();

  const listenersAfter = stream.listenerCount('resize');
  assert.strictEqual(
    listenersAfter,
    listenersBefore - 1,
    `teardown() should remove exactly one resize listener (before: ${listenersBefore}, after: ${listenersAfter})`,
  );
});

// TEARDOWN-TC5: After teardown(), all public methods are no-ops (no further output.write calls)
await test('teardown: all public methods are no-ops after teardown() (TEARDOWN-TC5)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  sb.teardown();
  chunks.length = 0;  // reset after teardown output

  // All public methods must produce zero output after teardown()
  sb.updateAgent('agent-1', { role: 'executor', taskId: 't1', description: 'x', status: 'active', elapsed: 0, cost: 0 });
  sb.updateProgress(1, 5, 0.01, 1);
  sb.updateMilestone('001', 5, 60);
  sb.onLog('should-not-appear');
  sb._render();
  sb.hide();
  sb.show();
  sb.promptWillStart();
  sb.promptDidEnd();
  sb.destroy();
  sb.teardown();

  assert.strictEqual(
    chunks.length,
    0,
    `all public methods must be no-ops after teardown(), but ${chunks.length} write(s) were emitted`,
  );
});

// TEARDOWN-TC6: teardown() is idempotent — second call produces zero output
await test('teardown: idempotent — second call produces zero output (TEARDOWN-TC6)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  sb.teardown();       // first call — produces output
  chunks.length = 0;  // clear first-call output

  sb.teardown();       // second call — must produce nothing

  assert.strictEqual(
    chunks.length,
    0,
    `second teardown() call must produce zero output (idempotent), but ${chunks.length} write(s) were emitted`,
  );
});

// TEARDOWN-TC7: destroy() still works (delegates to teardown internally)
await test('teardown: destroy() delegates to teardown() and produces correct ANSI (TEARDOWN-TC7)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.destroy();  // should delegate to teardown()

  const combined = chunks.join('');

  // destroy() via teardown() must emit all three sequences
  assert.ok(/\x1b\[r/.test(combined),
    `destroy() must emit \\x1b[r via teardown(), got: ${JSON.stringify(combined.slice(0, 200))}`);
  assert.ok(/\x1b\[J/.test(combined),
    `destroy() must emit \\x1b[J via teardown(), got: ${JSON.stringify(combined.slice(0, 200))}`);
  assert.ok(/\x1b\[\?25h/.test(combined),
    `destroy() must emit \\x1b[?25h via teardown(), got: ${JSON.stringify(combined.slice(0, 200))}`);

  // Subsequent destroy() must be a no-op
  chunks.length = 0;
  sb.destroy();
  assert.strictEqual(chunks.length, 0, 'second destroy() must be a no-op after teardown()');
});

// TEARDOWN-TC8: Non-TTY: teardown() is a no-op
await test('teardown: non-TTY — teardown() is a no-op (TEARDOWN-TC8)', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream });

  assert.strictEqual(sb.enabled, false, 'precondition: enabled must be false for non-TTY');

  sb.teardown();  // must not write anything

  assert.strictEqual(
    chunks.length,
    0,
    `teardown() on non-TTY instance must produce zero output, but ${chunks.length} write(s) were emitted`,
  );
});

// ── Scroll-region scaffolding invariant tests (001-001-001-002) ──────────────

// SCROLL-TC2: SET_SCROLL emitted exactly once across show()/_render() lifecycle
await test('scroll-region SET emitted exactly once across show()/_render() lifecycle', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // show() internally calls _render() which emits SET_SCROLL on first call
  sb.show();
  // Multiple additional _render() calls must NOT re-emit SET_SCROLL
  sb._render();
  sb._render();

  const combined = chunks.join('');

  // Exactly one SET_SCROLL sequence: \x1b[1;<bottom>r  (top is always 1)
  const setScrollMatches = combined.match(/\x1b\[1;\d+r/g) || [];
  assert.strictEqual(
    setScrollMatches.length,
    1,
    `SET_SCROLL (\\x1b[1;<bottom>r) must be emitted exactly once, got ${setScrollMatches.length} in: ${combined.slice(0, 400)}`,
  );

  // The scroll region bottom must equal rows(24) - barHeight
  const barHeight = sb._renderedLines;
  const expectedBottom = 24 - barHeight;
  const bottomMatch = setScrollMatches[0].match(/\x1b\[1;(\d+)r/);
  const actualBottom = Number(bottomMatch[1]);
  assert.strictEqual(
    actualBottom,
    expectedBottom,
    `scroll region bottom must be rows(24) - barHeight(${barHeight}) = ${expectedBottom}, got ${actualBottom}`,
  );

  sb.destroy();
});

// SCROLL-TC3: hide() emits RESET and next show() re-emits SET exactly once
await test('hide() emits RESET and next show() re-emits SET exactly once', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Establish the scroll region
  sb._render();
  assert.strictEqual(
    sb._scrollRegionActive,
    true,
    'precondition: _scrollRegionActive must be true after _render()',
  );

  // hide() must emit RESET (\x1b[r) and clear _scrollRegionActive
  chunks.length = 0;
  sb.hide();
  const hideOutput = chunks.join('');
  assert.ok(
    /\x1b\[r(?!\d)/.test(hideOutput),
    `hide() must emit \\x1b[r (RESET), got: ${hideOutput.slice(0, 200)}`,
  );
  assert.strictEqual(
    sb._scrollRegionActive,
    false,
    'hide() must clear _scrollRegionActive',
  );

  // show() + extra _render() must re-emit SET exactly once
  chunks.length = 0;
  sb.show();       // internally calls _render() → emits SET_SCROLL
  sb._render();    // second call → must NOT emit SET_SCROLL again

  const showOutput = chunks.join('');
  const setScrollMatches = showOutput.match(/\x1b\[1;\d+r/g) || [];
  assert.strictEqual(
    setScrollMatches.length,
    1,
    `SET_SCROLL must be emitted exactly once after hide()+show(), got ${setScrollMatches.length} in: ${showOutput.slice(0, 400)}`,
  );

  sb.destroy();
});

// SCROLL-TC4: destroy() emits RESET (\x1b[r) in its atomic write
await test('destroy() emits RESET', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.destroy();

  const combined = chunks.join('');
  assert.ok(
    /\x1b\[r/.test(combined),
    `destroy() must emit \\x1b[r (RESET) in its atomic write, got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// SCROLL-TC5: teardown() emits RESET (\x1b[r) in its atomic write
await test('teardown() emits RESET', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  sb._render();
  chunks.length = 0;

  sb.teardown();

  const combined = chunks.join('');
  assert.ok(
    /\x1b\[r/.test(combined),
    `teardown() must emit \\x1b[r (RESET) in its atomic write, got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// SCROLL-TC6: non-TTY: show/hide/destroy/teardown emit zero ANSI escapes
await test('non-TTY: show/hide/destroy/teardown emit zero ANSI escapes', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream });

  assert.strictEqual(sb.enabled, false, 'precondition: enabled must be false for non-TTY');

  sb.show();
  sb._render();
  sb.hide();
  sb.destroy();
  sb.teardown();

  const combined = chunks.join('');
  assert.strictEqual(
    chunks.length,
    0,
    `non-TTY: no method should write to stream, but got ${chunks.length} write(s)`,
  );
  assert.ok(
    !combined.includes('\x1b'),
    `non-TTY: show/hide/destroy/teardown must write zero bytes containing '\\x1b', got: ${JSON.stringify(combined.slice(0, 200))}`,
  );
});

// ── New tests: resize re-emission, prompt buffering, promptDidEnd cursor (001-003-001-003) ──

// resize re-emits DECSTBM with new bounds
await test('resize re-emits DECSTBM with new bounds', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream, enabled: true });

  // Initial render — must emit exactly one SET_SCROLL (\x1b[1;<bottom>r)
  sb._render();

  const afterFirstRender = chunks.join('');
  const firstScrollMatches = afterFirstRender.match(/\x1b\[1;\d+r/g) || [];
  assert.strictEqual(
    firstScrollMatches.length,
    1,
    `expected 1 SET_SCROLL after initial _render(), got ${firstScrollMatches.length} in: ${afterFirstRender.slice(0, 200)}`,
  );

  const N = sb._renderedLines;
  const expectedFirstBottom = 24 - N;
  const firstBottom = Number(firstScrollMatches[0].match(/\x1b\[1;(\d+)r/)[1]);
  assert.strictEqual(
    firstBottom,
    expectedFirstBottom,
    `first SET_SCROLL bottom must be 24-${N}=${expectedFirstBottom}, got ${firstBottom}`,
  );

  // Mutate stream.rows and fire resize — _onResize resets _scrollRegionActive then re-renders
  stream.rows = 30;
  stream.emit('resize');

  const afterResize = chunks.join('');
  const allScrollMatches = afterResize.match(/\x1b\[1;\d+r/g) || [];
  assert.strictEqual(
    allScrollMatches.length,
    2,
    `expected 2 SET_SCROLL sequences total after resize, got ${allScrollMatches.length} in: ${afterResize.slice(0, 300)}`,
  );

  const expectedSecondBottom = 30 - sb._renderedLines;
  const secondBottom = Number(allScrollMatches[1].match(/\x1b\[1;(\d+)r/)[1]);
  assert.strictEqual(
    secondBottom,
    expectedSecondBottom,
    `second SET_SCROLL bottom must be 30-${sb._renderedLines}=${expectedSecondBottom}, got ${secondBottom}`,
  );

  sb.destroy();
});

// promptDidEnd does not emit absolute MOVE_TO after _render()
await test('promptDidEnd does not emit absolute MOVE_TO after _render()', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream, enabled: true });

  // Establish the bar and set up a prompt lifecycle
  sb._render();
  sb.promptWillStart();
  // Update state while prompt is active (buffered, not rendered)
  sb.updateProgress(2, 5, 0.10, 1);
  // End prompt — triggers _render() internally
  sb.promptDidEnd();

  const combined = chunks.join('');

  // The final byte sequence must end with \x1b[u (RESTORE_CURSOR)
  const lastRestoreIdx = combined.lastIndexOf('\x1b[u');
  assert.ok(
    lastRestoreIdx >= 0,
    `output must contain at least one \\x1b[u (restore cursor), got: ${combined.slice(0, 300)}`,
  );

  // After the last \x1b[u there must be no absolute MOVE_TO (\x1b[<n>;1H)
  const afterLastRestore = combined.slice(lastRestoreIdx + '\x1b[u'.length);
  assert.ok(
    !/\x1b\[\d+;1H/.test(afterLastRestore),
    `no absolute MOVE_TO (\\x1b[<n>;1H) may follow the last \\x1b[u (restore), got after restore: ${JSON.stringify(afterLastRestore.slice(0, 100))}`,
  );

  sb.destroy();
});

// updateProgress during prompt is buffered and rendered on promptDidEnd
await test('updateProgress during prompt is buffered and rendered on promptDidEnd', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream, enabled: true });

  // Establish the bar
  sb._render();

  // Start prompt — rendering is paused
  sb.promptWillStart();
  const chunkCountAfterPromptWillStart = chunks.length;

  // State update during prompt — _scheduleRender() is a no-op while _promptActive
  sb.updateProgress(2, 5, 0.10, 1);

  // No new chunks must be written while prompt is active
  assert.strictEqual(
    chunks.length,
    chunkCountAfterPromptWillStart,
    `no new chunks should be written while prompt is active (buffering), got ${chunks.length - chunkCountAfterPromptWillStart} extra`,
  );

  // End prompt — must trigger _render() which uses the buffered state
  sb.promptDidEnd();

  // New chunks must have been written
  assert.ok(
    chunks.length > chunkCountAfterPromptWillStart,
    `promptDidEnd() must trigger a render (new chunks expected), got chunks.length=${chunks.length} vs before=${chunkCountAfterPromptWillStart}`,
  );

  // The rendered output must reflect done=2 / total=5
  const combined = chunks.join('');
  assert.ok(
    /2\/5/.test(combined),
    `render after promptDidEnd() must show "2/5" (done/total), got: ${combined.slice(0, 400)}`,
  );

  sb.destroy();
});

// ── PAD-TC1..4: line padding to terminal width (Bug 5 padding fix coverage) ───
//
// Bug 5 fix in status-bar.js applies .padEnd(width) to header, agent rows,
// (no active agents), hidden-count line, and progress line so a render at
// barHeight=H+1 followed by a render at barHeight=H doesn't leave stale
// characters in cells that the shorter line didn't overwrite.
//
// Borders (sep1/sep2) are already exactly width via '═'.repeat(w) — no
// padEnd needed; PAD-TC1's "every line" assertion still must pass.
//
// These tests were missed by the v3.3 cc-orch run's test-alignment task and
// added manually after a phantom-write recovery.

await test('PAD-TC1: every line from _buildLines(80) has length exactly 80', () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });
  sb.updateAgent('Executor',  { role: 'executor',  status: 'active', taskId: 'pad-task-001', description: 'running padding test', elapsedMs: 5000, costUsd: 0.10 });
  sb.updateAgent('Verifier',  { role: 'verifier',  status: 'active', taskId: 'pad-task-002', description: 'verifying padding',     elapsedMs: 3000, costUsd: 0.05 });
  sb.updateMilestone('001', 5, 12345);
  sb.updateProgress(2, 5, 1.23, 7);

  const lines = sb._buildLines(80);

  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length !== 80) {
      offenders.push({ i, len: lines[i].length, preview: lines[i].slice(0, 40) });
    }
  }

  assert.strictEqual(
    offenders.length, 0,
    `all lines must be padded to exactly 80 chars; offenders: ${JSON.stringify(offenders)}`,
  );

  sb.destroy();
});

await test('PAD-TC2: _buildAgentRow output length equals width', () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  const row = sb._buildAgentRow('Executor', {
    role: 'executor',
    status: 'active',
    taskId: 'pad-agent-task-001',
    description: 'testing padding',
    elapsedMs: 42000,
    costUsd: 0.12,
  }, 80);

  assert.strictEqual(row.length, 80, `_buildAgentRow must return a string of length 80, got length ${row.length}: ${JSON.stringify(row)}`);

  sb.destroy();
});

await test('PAD-TC3: _buildProgressLine output length equals width (numeric bar mode)', () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });
  sb.updateProgress(3, 10, 4.56, 2);

  const line = sb._buildProgressLine(80);

  assert.strictEqual(line.length, 80, `_buildProgressLine numeric mode must return length 80, got ${line.length}: ${JSON.stringify(line)}`);

  sb.destroy();
});

await test('PAD-TC4: phase-mode progress line length equals width', () => {
  const { stream } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });
  sb.updateProgress(0, 0, 0, 0, 'planning mission 002');

  const line = sb._buildProgressLine(80);

  assert.strictEqual(line.length, 80, `_buildProgressLine phase mode must return length 80, got ${line.length}: ${JSON.stringify(line)}`);

  sb.destroy();
});

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
