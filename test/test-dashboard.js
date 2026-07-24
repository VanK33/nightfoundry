/**
 * test-dashboard.js — Unit tests for src/orchestrator/infra/dashboard.js.
 *
 * Covers both TTY mode (with a fake stream that pretends isTTY=true)
 * and non-TTY mode (plain Writable with no isTTY flag).
 *
 * Run: node test/test-dashboard.js
 */
import assert from 'assert';
import { Writable } from 'stream';
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
 * A Writable stream that records everything written to it, with an
 * optional isTTY flag to exercise the TTY rendering path.
 */
function makeFakeStream({ isTTY = false } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.isTTY = isTTY;
  return { stream, chunks };
}

function makeSink() {
  const lines = [];
  return {
    sink: (msg) => lines.push(String(msg)),
    lines,
  };
}

function makeMockStatusBar() {
  const calls = [];
  const agents = new Map();
  return {
    calls,
    agents,
    onLog:           (msg)          => calls.push(String(msg)),
    updateAgent:     (name, state)  => { if (state === null) agents.delete(name); else agents.set(name, state); },
    updateProgress:  ()             => {},
    updateMilestone: ()             => {},
    setPhase:        ()             => {},
    promptWillStart: ()             => {},
    promptDidEnd:    ()             => {},
    hide:            ()             => {},
    show:            ()             => {},
    teardown:        ()             => {},
    destroy:         ()             => {},
  };
}

async function run() {

// ── Non-TTY mode ────────────────────────────────────────────────────

await test('non-TTY: log() falls through to sink', () => {
  const { stream } = makeFakeStream({ isTTY: false });
  const { sink, lines } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.log('hello');
  dashboard.log('world');

  assert.deepStrictEqual(lines, ['hello', 'world']);
});

await test('non-TTY: onProgress emits plain log lines for milestone-start', () => {
  const { stream } = makeFakeStream({ isTTY: false });
  const { sink, lines } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 10, pending: 10, preTerminal: 0 });

  assert.ok(lines.length === 1, `expected 1 line, got ${lines.length}`);
  assert.ok(/milestone 001/.test(lines[0]), `expected milestone id in line, got: ${lines[0]}`);
});

await test('non-TTY: onProgress emits milestone-complete summary', () => {
  const { stream } = makeFakeStream({ isTTY: false });
  const { sink, lines } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 3, pending: 3, preTerminal: 0 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1, description: 'a' });
  dashboard.onProgress({ type: 'task-complete', taskId: '001-001-001-001', running: 0 });
  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 3, errored: 0 });

  // Find the milestone-complete summary line
  const summary = lines.find((l) => /milestone 001 complete/.test(l));
  assert.ok(summary, `expected milestone-complete summary, got lines: ${lines.join(' | ')}`);
  assert.ok(/1\/3 done/.test(summary), `summary should include 1/3 done, got: ${summary}`);
});

await test('non-TTY: task-fail emits a log line', () => {
  const { stream } = makeFakeStream({ isTTY: false });
  const { sink, lines } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1 });
  dashboard.onProgress({ type: 'task-fail', taskId: '001-001-001-001', error: 'boom' });

  const failLine = lines.find((l) => /task 001-001-001-001 failed/.test(l));
  assert.ok(failLine, `expected fail line, got: ${lines.join(' | ')}`);
  assert.ok(/boom/.test(failLine));
});

await test('non-TTY: writes no ANSI escapes to output stream', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 2, pending: 2 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1 });
  dashboard.onProgress({ type: 'task-complete', taskId: '001-001-001-001', running: 0 });
  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 2 });

  const combined = chunks.join('');
  assert.ok(!/\x1b\[/.test(combined), 'non-TTY output should not contain ANSI escape sequences');
});

// ── TTY mode ─────────────────────────────────────────────────────────

await test('TTY: isActive() tracks milestone lifetime', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  assert.strictEqual(dashboard.isActive(), false);

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  assert.strictEqual(dashboard.isActive(), true);

  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 1 });
  assert.strictEqual(dashboard.isActive(), false);
});

await test('TTY: milestone-start writes a status line with ANSI clear', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 5, pending: 5, preTerminal: 0 });

  const combined = chunks.join('');
  assert.ok(/\x1b\[K/.test(combined), 'should include ANSI clear-line escape');
  assert.ok(/sched 001/.test(combined), 'should include milestone id in status');
  assert.ok(/5 total/.test(combined), 'should include total count');
});

await test('TTY: task-start prints event line above status line', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 3, pending: 3 });
  chunks.length = 0;  // drop the initial render
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1, description: 'hello' });

  const combined = chunks.join('');
  assert.ok(/001-001-001-001/.test(combined), 'should print task id');
  assert.ok(/hello/.test(combined), 'should print description');
  assert.ok(/1 running/.test(combined), 'status should show 1 running');
});

await test('TTY: counts update across start/complete cycle', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 2, pending: 2 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1 });
  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-002', running: 2 });
  chunks.length = 0;
  dashboard.onProgress({ type: 'task-complete', taskId: '001-001-001-001', running: 1 });

  const combined = chunks.join('');
  assert.ok(/1 running/.test(combined), 'should show 1 running after completion');
  assert.ok(/1 done/.test(combined), 'should show 1 done after completion');
});

await test('TTY: log() clears status line, prints log, and re-renders status', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  chunks.length = 0;

  dashboard.log('incoming log line');
  const combined = chunks.join('');
  assert.ok(/\x1b\[K/.test(combined), 'should clear the status line');
  assert.ok(/incoming log line\n/.test(combined), 'should print the log line with newline');
  assert.ok(/sched 001/.test(combined), 'should re-render the status line');
});

await test('TTY: log() when inactive falls through to sink', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink, lines } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  // Dashboard is TTY but NOT active (no milestone-start yet)
  dashboard.log('should go to sink');

  assert.deepStrictEqual(lines, ['should go to sink']);
  assert.strictEqual(chunks.length, 0, 'nothing should be written to the output stream while inactive');
});

await test('TTY: milestone-complete releases status line with newline', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  dashboard.onProgress({ type: 'task-start', taskId: 'a', running: 1 });
  dashboard.onProgress({ type: 'task-complete', taskId: 'a', running: 0 });
  chunks.length = 0;
  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 1 });

  const combined = chunks.join('');
  assert.ok(combined.includes('\n'), 'should release status line with a newline');
  assert.strictEqual(dashboard.isActive(), false);
});

await test('TTY: errored count appears when task-fail fires', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  dashboard.onProgress({ type: 'task-start', taskId: 'a', running: 1, description: 'oops' });
  chunks.length = 0;
  dashboard.onProgress({ type: 'task-fail', taskId: 'a', error: 'boom' });

  const combined = chunks.join('');
  assert.ok(/1 errored/.test(combined), 'should show errored count in status');
  assert.ok(/boom/.test(combined), 'should show error message in event line');
});

await test('TTY: unknown event types are ignored safely', () => {
  const { stream } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });

  // Should not throw
  dashboard.onProgress({ type: 'something-new', foo: 'bar' });
  dashboard.onProgress(null);
  dashboard.onProgress({});

  assert.strictEqual(dashboard.isActive(), true, 'dashboard should still be active');
});

// ── statusBar-mode (mock StatusBar with onLog spy) ────────────────────

await test('statusBar-mode TTY: log() delegates to statusBar.onLog and does not write \\x1b[K to stream', () => {
  // TC1 / TC3
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const mockStatusBar = makeMockStatusBar();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: mockStatusBar });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  chunks.length = 0;
  mockStatusBar.calls.length = 0; // reset after milestone-start

  dashboard.log('hello from statusBar');
  assert.ok(mockStatusBar.calls.some((c) => /hello from statusBar/.test(c)), 'onLog spy should be called with the log message');
  assert.ok(!/\x1b\[K/.test(chunks.join('')), 'should NOT include ANSI clear-line escape when delegating to statusBar');
});

await test('statusBar-mode TTY: milestone-start produces no ANSI output on stream', () => {
  // TC3
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const mockStatusBar = makeMockStatusBar();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: mockStatusBar });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 5, pending: 5 });

  const combined = chunks.join('');
  assert.ok(!/\x1b\[/.test(combined), 'milestone-start should produce no ANSI escapes on stream when statusBar is set');
});

await test('statusBar-mode TTY: isActive() true during milestone, false after complete', () => {
  // TC3
  const { stream } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const mockStatusBar = makeMockStatusBar();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: mockStatusBar });

  assert.strictEqual(dashboard.isActive(), false, 'should be inactive before milestone-start');

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  assert.strictEqual(dashboard.isActive(), true, 'should be active during milestone');

  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 1 });
  assert.strictEqual(dashboard.isActive(), false, 'should be inactive after milestone-complete');
});

await test('statusBar-mode TTY: milestone-complete writes nothing to stream', () => {
  // TC3
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const mockStatusBar = makeMockStatusBar();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: mockStatusBar });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  dashboard.onProgress({ type: 'task-start', taskId: 'a', running: 1 });
  dashboard.onProgress({ type: 'task-complete', taskId: 'a', running: 0 });
  chunks.length = 0; // reset before milestone-complete

  dashboard.onProgress({ type: 'milestone-complete', milestoneId: '001', total: 1 });
  assert.strictEqual(chunks.join(''), '', 'milestone-complete should write nothing to stream when statusBar is set');
});

await test('statusBar-mode TTY: task-start event delegated to statusBar.onLog', () => {
  // TC3
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const mockStatusBar = makeMockStatusBar();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: mockStatusBar });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  mockStatusBar.calls.length = 0;
  chunks.length = 0;

  dashboard.onProgress({ type: 'task-start', taskId: '001-001-001-001', running: 1, description: 'do work' });
  assert.ok(mockStatusBar.calls.some((c) => /001-001-001-001/.test(c)), 'task-start should delegate task id to statusBar.onLog');
  assert.ok(mockStatusBar.calls.some((c) => /do work/.test(c)), 'task-start should delegate description to statusBar.onLog');
  assert.ok(!/\x1b\[K/.test(chunks.join('')), 'task-start should not write ANSI clear-line escapes when delegating');
});

await test('statusBar=null TTY: existing behavior unchanged (backward compat)', () => {
  // TC6 — TTY mode with no statusBar attached; Dashboard must render its
  // own status line exactly as it did before StatusBar integration shipped.
  const { stream, chunks } = makeFakeStream({ isTTY: true });
  const { sink } = makeSink();
  const dashboard = new Dashboard({ output: stream, sink, statusBar: null });

  dashboard.onProgress({ type: 'milestone-start', milestoneId: '001', total: 1, pending: 1 });
  const startCombined = chunks.join('');
  assert.ok(/\x1b\[K/.test(startCombined), 'statusBar=null: milestone-start should still render status with ANSI clear');

  chunks.length = 0;
  dashboard.log('compat log line');
  const logCombined = chunks.join('');
  assert.ok(/\x1b\[K/.test(logCombined), 'statusBar=null: log() should still clear-line as in normal TTY mode');
  assert.ok(/compat log line\n/.test(logCombined), 'statusBar=null: log message should appear with newline');
  assert.ok(/sched 001/.test(logCombined), 'statusBar=null: status should be re-rendered after log');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
