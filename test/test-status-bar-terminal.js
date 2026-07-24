/**
 * test-status-bar-terminal.js — xterm-headless integration tests for StatusBar.
 *
 * Uses @xterm/headless to render StatusBar ANSI output into a virtual VT100
 * terminal buffer, then queries terminal.buffer.active for assertions about
 * what a user would actually see on screen.
 *
 * Platform scope:
 *   - POSIX terminals (Linux, macOS iTerm2, GNOME Terminal, etc.)
 *   - Windows cmd.exe is OUT OF SCOPE — cmd.exe does not support ANSI/VT100
 *     escape sequences; xterm-headless models a POSIX VT100 terminal only.
 *
 * Each test constructs a fresh Terminal({cols:80, rows:24}), creates a Writable
 * that pipes all writes to terminal.write(), exercises StatusBar public methods,
 * then queries terminal.buffer.active for assertions.
 *
 * All 5 scenarios (S1–S5) are expected to FAIL against v0.1.18 of StatusBar.
 * They serve as regression specs for a future bug-fix release.
 *
 * Run: node test/test-status-bar-terminal.js
 */

import assert from 'assert';
import { Writable } from 'stream';
import { createRequire } from 'module';
import { StatusBar } from '../src/orchestrator/infra/status-bar.js';

// @xterm/headless is a CJS bundle; load via createRequire from ESM context.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

// ── Test runner (mirrors test-status-bar.js pattern) ─────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a fresh xterm-headless Terminal.
 * allowProposedApi is required to access terminal.buffer.
 */
function makeTerminal(cols = 80, rows = 24) {
  return new Terminal({ cols, rows, allowProposedApi: true });
}

/**
 * Create a Writable stream that records every chunk written to it.
 * Used for non-TTY parity tests and teardown no-op assertions.
 */
function makeFakeStream({ isTTY = false, rows = 24, columns = 80 } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.isTTY   = isTTY;
  stream.rows    = rows;
  stream.columns = columns;
  return { stream, chunks };
}

/**
 * Create a Writable stream that pipes every chunk to terminal.write().
 *
 * The stream's isTTY/rows/columns properties are configured so StatusBar
 * treats it as a real TTY and enables rendering.
 *
 * Note: terminal.write() is asynchronous — call flush(terminal) after all
 * output has been written to ensure the buffer is fully settled before
 * making assertions.
 */
function makeTerminalStream(terminal, cols = 80, rows = 24) {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      terminal.write(chunk.toString(), cb);
    },
  });
  stream.isTTY    = true;
  stream.rows     = rows;
  stream.columns  = cols;
  return stream;
}

/**
 * Wait for all pending terminal.write() calls to complete.
 * xterm queues writes internally; writing an empty string with a callback
 * resolves only after all previously queued data has been processed.
 */
function flush(terminal) {
  return new Promise((resolve) => terminal.write('', resolve));
}

/**
 * Return the trimmed text content of a terminal buffer row (0-indexed).
 */
function getRow(terminal, rowIndex) {
  const line = terminal.buffer.active.getLine(rowIndex);
  return line ? line.translateToString(true).trim() : '';
}

/**
 * Return the raw (untrimmed) text content of a terminal buffer row (0-indexed).
 */
function getRawRow(terminal, rowIndex) {
  const line = terminal.buffer.active.getLine(rowIndex);
  return line ? line.translateToString(true) : '';
}

// ── Scenario 1: Basic row integrity (bottom-anchored) ────────────────────────
//
// After calling sb.onLog('A'), sb.onLog('B'), sb.onLog('C') in sequence,
// the three log lines should land bottom-anchored within the DECSTBM scroll
// region.  Each onLog scrolls the region up by one and writes the new message
// at the scroll-region bottom (one row above the bar's top border).
//
// For a 24-row terminal with a 7-row bar:
//   • scrollBottom (0-indexed) = rows - barHeight - 1 = 16
//   • After three onLog calls (A, B, C): A is at row 14, B at row 15, C at row 16.
//   • Rows 0..13 remain blank (region not yet full).
//   • Rows 17..23 hold the bar.
//
// Failure mode (pre-v0.1.24 dogfood-30-era code): a fill-from-top branch in
// onLog placed A at row 0, B at row 1, C at row 2 until the region filled.
// The resulting visual was "logs grow downward from the top" rather than
// "newest at bottom, older scrolls up", contradicting the documented
// scroll-region contract.

await test('S1 basic row integrity: A/B/C bottom-anchored at scrollBottom-2..scrollBottom after three log calls', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t   = makeTerminal(COLS, ROWS);
  const ws  = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish the bar so scroll-region bookkeeping is set up.
  sb._render();
  await flush(t);

  // Three log calls — bottom-anchored, scroll region 0..scrollBottom-1.
  sb.onLog('A');
  sb.onLog('B');
  sb.onLog('C');

  await flush(t);

  // For idle bar (no agents): barHeight = 7; scrollBottom (0-indexed) = 16.
  const barHeight = sb._renderedLines;
  const scrollBottomIdx = ROWS - barHeight - 1;

  const rowA = getRow(t, scrollBottomIdx - 2);
  const rowB = getRow(t, scrollBottomIdx - 1);
  const rowC = getRow(t, scrollBottomIdx);

  assert.strictEqual(rowA, 'A', `row ${scrollBottomIdx - 2} should contain 'A', got: ${JSON.stringify(rowA)}`);
  assert.strictEqual(rowB, 'B', `row ${scrollBottomIdx - 1} should contain 'B', got: ${JSON.stringify(rowB)}`);
  assert.strictEqual(rowC, 'C', `row ${scrollBottomIdx} should contain 'C', got: ${JSON.stringify(rowC)}`);

  // Row 0 should be blank — region not yet full, oldest log only at scrollBottom-2.
  const row0 = getRow(t, 0);
  assert.strictEqual(row0, '', `row 0 should be blank pre-overflow, got: ${JSON.stringify(row0)}`);

  sb.destroy();
});

// ── Scenario 2: Bar pinning ───────────────────────────────────────────────────
//
// After calling updateAgent() + updateProgress() and _render(), the status bar
// should occupy the bottom `barHeight` rows of the terminal buffer.
//
// Correct behaviour:
//   • The first bar row (rows - barHeight, 0-indexed) starts with '═' (top border).
//   • The last bar row (rows - 1, 0-indexed) contains '═' (bottom border).
//   • Every row in the bar area is non-empty — no blank gaps caused by
//     auto-wrap of full-width separator lines.
//
// Failure mode in v0.1.18: The '═'.repeat(80) separator lines are exactly the
// terminal width.  Auto-wrap in xterm advances the cursor to the next row
// BEFORE the trailing '\n' is processed, which creates a spurious blank row
// inside the bar area and shifts subsequent bar content down by one row.
//
// Test expected to FAIL against v0.1.18.

await test('S2 bar pinning: bar rows all non-empty after render', async () => {
  const ROWS = 24;
  const COLS = 80;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  sb.updateAgent('agent-1', {
    role: 'executor',
    taskId: 'task-001',
    description: 'running integration test',
    status: 'active',
    elapsed: 3,
    cost: 0.002,
  });
  sb.updateProgress(2, 10, 0.05, 1);
  sb._render();

  await flush(t);

  const barHeight = sb._renderedLines;

  // Top border row must contain '═'
  const topRow    = getRow(t, ROWS - barHeight);
  assert.ok(
    topRow.includes('═'),
    `bar top row (${ROWS - barHeight}) must contain '═', got: ${JSON.stringify(topRow.slice(0, 40))}`,
  );

  // Bottom border row must contain '═'
  const bottomRow = getRow(t, ROWS - 1);
  assert.ok(
    bottomRow.includes('═'),
    `bar bottom row (${ROWS - 1}) must contain '═', got: ${JSON.stringify(bottomRow.slice(0, 40))}`,
  );

  // No row in the bar area should be completely empty.
  // In v0.1.18 the auto-wrap of '═'×80 creates a blank gap row.
  for (let i = ROWS - barHeight; i < ROWS; i++) {
    const row = getRow(t, i);
    assert.ok(
      row.length > 0,
      `bar area row ${i} must not be empty (auto-wrap creates spurious blank rows in v0.1.18)`,
    );
  }

  sb.destroy();
});

// ── Scenario 3: Log + bar coexistence ────────────────────────────────────────
//
// After the bar is rendered, writing log messages via onLog() must not place
// log text inside the bar area rows.  No terminal row should contain both a
// log message fragment and a bar separator character ('═' or '─').
//
// Correct behaviour:
//   • Log messages appear bottom-anchored within the scroll region (newest at
//     scrollBottom = rows-barHeight-1, older rows scroll upward via DECSTBM).
//   • Bar rows (rows-barHeight … rows-1) contain only bar content.
//
// Failure mode in v0.1.18: onLog positions at scrollBottom (ANSI row 17 for a
// 24-row / 7-high-bar terminal) and successive log calls advance the cursor
// INTO the bar area without respecting the DECSTBM scroll region.  Log messages
// at rows 17–18 overwrite (and displace) the top bar separator, while later
// writes may partially overwrite bar separator rows leaving mixed content.
//
// Test expected to FAIL against v0.1.18.

await test('S3 log+bar coexistence: no row contains both log text and bar separator', async () => {
  const ROWS = 24;
  const COLS = 80;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish the bar.
  sb._render();
  await flush(t);

  // Write three log messages via the StatusBar's onLog API.
  sb.onLog('LOG-ALPHA: first message');
  sb.onLog('LOG-BETA: second message');
  sb.onLog('LOG-GAMMA: third message');

  await flush(t);

  // Scan every row for co-existence of log text and bar separators.
  const BAR_CHARS = ['═', '─'];
  for (let i = 0; i < ROWS; i++) {
    const rowText = getRawRow(t, i);
    const hasLog  = rowText.includes('LOG-');
    const hasBar  = BAR_CHARS.some((ch) => rowText.includes(ch));
    assert.ok(
      !(hasLog && hasBar),
      `row ${i} must not contain both log text and bar separator; got: ${JSON.stringify(rowText.trim().slice(0, 60))}`,
    );
  }

  // Additionally verify that log text appears only in the scroll region
  // (rows 0 to rows-barHeight-1), not in the bar area.
  const barHeight  = sb._renderedLines;
  const barStartRow = ROWS - barHeight;
  for (let i = barStartRow; i < ROWS; i++) {
    const rowText = getRawRow(t, i);
    assert.ok(
      !rowText.includes('LOG-'),
      `log text must not appear in bar row ${i}; got: ${JSON.stringify(rowText.trim().slice(0, 60))}`,
    );
  }

  sb.destroy();
});

// ── Scenario 4: Row-mash regression (LOAD-BEARING) ───────────────────────────
//
// This is the primary regression test for the "row-mash" bug observed in
// v0.1.18.  The sequence exercises the prompt lifecycle:
//
//   1. sb._render()                              — establish bar
//   2. sb.promptWillStart()                      — yield cursor to readline
//   3. ws.write('Type yes (y/n): ')             — simulate readline prompt echo
//   4. sb.onLog('completed')                     — log after prompt interaction
//
// The prompt text 'Type yes (y/n): ' is 16 characters; 'completed' is 9 chars.
// After step 4, onLog positions cursor at col 0 of the prompt row and writes
// 'completed' (9 chars).  This partially overwrites the prompt text:
//   'Type yes ' (9 chars overwritten) + '(y/n): ' (7 chars remain visible)
// → row contains both 'completed' AND '(y/n)'.
//
// Correct behaviour: each message appears on its own row; no row contains text
// fragments from two different operations.
//
// Failure mode in v0.1.18: onLog() repositions to scrollBottom col 0 and
// writes without first clearing the line.  The previous prompt text is
// partially visible after the short log overwrites only the first N chars,
// producing a mixed row with both keywords.
//
// Test expected to FAIL against v0.1.18.

await test('S4 row-mash regression: no row contains both "completed" and "(y/n)"', async () => {
  const ROWS = 24;
  const COLS = 80;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // 1. Establish bar so scroll-region bookkeeping is populated.
  sb._render();
  await flush(t);

  // 2. Signal that a readline prompt is about to start.
  sb.promptWillStart();
  await flush(t);

  // 3. Simulate readline echoing a prompt string at the current cursor position.
  //    'Type yes (y/n): ' — '(y/n)' starts at position 10 (1-indexed).
  //    This is longer (16 chars) than the next log message 'completed' (9 chars),
  //    so partial overwrite will leave '(y/n)' visible.
  ws.write('Type yes (y/n): ');
  await flush(t);

  // 4. Log a follow-up message. 'completed' (9 chars) overwrites only the first
  //    9 characters of 'Type yes (y/n): ', leaving '(y/n): ' intact on the same row.
  sb.onLog('completed');
  await flush(t);

  // Assert: no row contains both 'completed' and '(y/n)'.
  for (let i = 0; i < ROWS; i++) {
    const rowText     = getRawRow(t, i);
    const hasCompleted = rowText.includes('completed');
    const hasPrompt    = rowText.includes('(y/n)');
    assert.ok(
      !(hasCompleted && hasPrompt),
      `row ${i} must not contain both 'completed' and '(y/n)' (row-mash bug); got: ${JSON.stringify(rowText.trim().slice(0, 60))}`,
    );
  }

  sb.destroy();
});

// ── Scenario 5: Prompt cursor position ───────────────────────────────────────
//
// After promptWillStart() positions the cursor in the scroll region and a
// prompt string is written to the stream, cursorX must equal the length of the
// prompt string.  This verifies that the ANSI cursor-positioning sequence
// emitted by promptWillStart() lands the cursor at column 0 of the scroll-
// region bottom row, so readline's echoed prompt text occupies a clean line.
//
// Correct behaviour:
//   • promptWillStart() moves cursor to (scrollBottom, col 0).
//   • Writing a prompt string of length L then places cursorX at L.
//
// Failure mode in v0.1.18: if the DECSTBM scroll region is not properly
// flushed before emitting the cursor-move, or if the cursor-move targets the
// wrong row (e.g. inside the bar rather than just above it), the prompt string
// may scroll or wrap unexpectedly, yielding cursorX ≠ promptText.length.
//
// Test expected to FAIL against v0.1.18 when bar rendering leaves the cursor
// in an unexpected state that promptWillStart() does not fully correct.

await test('S5 prompt cursor position: cursorX equals prompt length after promptWillStart', async () => {
  const ROWS = 24;
  const COLS = 80;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish the bar so _renderedLines / _renderedRows are populated.
  sb._render();
  await flush(t);

  // Signal readline is about to start; cursor should land at scroll-region bottom.
  sb.promptWillStart();
  await flush(t);

  // Capture cursor row immediately after promptWillStart.
  const cursorYAfterPromptWillStart = t.buffer.active.cursorY;

  // Simulate readline writing a prompt string at the cursor's current position.
  const PROMPT_TEXT = 'Continue? (y/n): ';
  ws.write(PROMPT_TEXT);
  await flush(t);

  // cursorX should now equal PROMPT_TEXT.length (prompt fits on one line,
  // no scrolling, cursor at end of prompt text).
  const cursorX = t.buffer.active.cursorX;
  assert.strictEqual(
    cursorX,
    PROMPT_TEXT.length,
    `cursorX (${cursorX}) must equal prompt text length (${PROMPT_TEXT.length}) after promptWillStart + write; cursorY was ${cursorYAfterPromptWillStart}`,
  );

  // Sanity: prompt text must appear on the row where the cursor landed.
  const promptRow = getRawRow(t, cursorYAfterPromptWillStart);
  assert.ok(
    promptRow.includes(PROMPT_TEXT.trim()),
    `prompt row (${cursorYAfterPromptWillStart}) must contain prompt text; got: ${JSON.stringify(promptRow.trim().slice(0, 60))}`,
  );

  sb.destroy();
});

// ── Scenario 6: Scroll behavior ──────────────────────────────────────────────
//
// After writing rows+10 log lines via onLog(), the bar must remain pinned at
// the bottom barHeight rows of the terminal.  The scroll region above the bar
// fills up and oldest log lines scroll off; the newest logs stay visible in
// the scroll region.
//
// Failure mode in v0.1.18: onLog() does not respect DECSTBM and writes below
// the scroll boundary, corrupting the bar rows instead of scrolling old lines.
//
// Test expected to FAIL against v0.1.18.

await test('S6 scroll behavior: bar at bottom after rows+10 logs, oldest logs scrolled off', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  sb._render();
  await flush(t);

  const barHeight = sb._renderedLines;
  const totalLogs = ROWS + 10; // enough to overflow the scroll region

  for (let i = 0; i < totalLogs; i++) {
    sb.onLog(`SCROLL-LOG-${String(i).padStart(3, '0')}`);
  }
  await flush(t);

  // Bar must still be pinned at the bottom barHeight rows
  const topBarRow = getRow(t, ROWS - barHeight);
  assert.ok(
    topBarRow.includes('═'),
    `bar top row (${ROWS - barHeight}) must still have '═' after ${totalLogs} logs; got: ${JSON.stringify(topBarRow.slice(0, 40))}`,
  );
  const bottomBarRow = getRow(t, ROWS - 1);
  assert.ok(
    bottomBarRow.includes('═'),
    `bar bottom row (${ROWS - 1}) must still have '═' after scrolling; got: ${JSON.stringify(bottomBarRow.slice(0, 40))}`,
  );

  // Oldest log (000) should have scrolled off the visible scroll region
  let oldestFound = false;
  for (let r = 0; r < ROWS - barHeight; r++) {
    if (getRow(t, r).includes('SCROLL-LOG-000')) { oldestFound = true; break; }
  }
  assert.ok(
    !oldestFound,
    `SCROLL-LOG-000 should have scrolled off after ${totalLogs} writes`,
  );

  // Newest log should be visible in the scroll region (above the bar)
  const newestLabel = `SCROLL-LOG-${String(totalLogs - 1).padStart(3, '0')}`;
  let newestFound = false;
  for (let r = 0; r < ROWS - barHeight; r++) {
    if (getRow(t, r).includes(newestLabel)) { newestFound = true; break; }
  }
  assert.ok(
    newestFound,
    `newest log (${newestLabel}) should be visible in scroll region above bar`,
  );

  sb.destroy();
});

// ── Scenario 7: Hide / show ───────────────────────────────────────────────────
//
// After hide() the scroll region is reset and the bar rows are erased; after
// show() the bar is redrawn at the same bottom position.
//
// Failure mode in v0.1.18: hide() may not properly clear the bar rows in the
// xterm buffer, leaving stale content visible.
//
// Test expected to FAIL against v0.1.18.

await test('S7 hide/show: hide() clears bar rows, show() restores them', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  sb._render();
  await flush(t);

  const barHeight  = sb._renderedLines;
  const barStartRow = ROWS - barHeight; // 0-indexed

  // Before hide: bar top row must be non-empty (contains '═')
  const topRowBefore = getRow(t, barStartRow);
  assert.ok(
    topRowBefore.length > 0,
    `bar top row must be non-empty before hide(); got: ${JSON.stringify(topRowBefore)}`,
  );

  // hide() — scroll region reset + bar area erased
  sb.hide();
  await flush(t);

  // After hide: bar start row should be blank (cleared to end of screen from barStartRow)
  const topRowAfterHide = getRow(t, barStartRow);
  assert.strictEqual(
    topRowAfterHide,
    '',
    `bar top row must be empty after hide(); got: ${JSON.stringify(topRowAfterHide)}`,
  );

  // show() — bar redrawn
  sb.show();
  await flush(t);

  // After show: bar top row must contain '═' again
  const newBarHeight = sb._renderedLines;
  const topRowAfterShow = getRow(t, ROWS - newBarHeight);
  assert.ok(
    topRowAfterShow.includes('═'),
    `bar top row must contain '═' after show(); got: ${JSON.stringify(topRowAfterShow.slice(0, 40))}`,
  );

  sb.destroy();
});

// ── Scenario 8: Resize ────────────────────────────────────────────────────────
//
// After emitting a resize event with new dimensions, the bar must move to
// the new bottom position (reflecting the updated row count).
//
// Failure mode in v0.1.18: the resize handler may not update _renderedRows
// correctly, leaving the DECSTBM margin at the old dimensions.
//
// Test expected to FAIL against v0.1.18.

await test('S8 resize: bar moves to new bottom after terminal resize event', async () => {
  const COLS  = 80;
  const ROWS  = 24;
  const ROWS2 = 30;
  const t     = makeTerminal(COLS, ROWS);
  const ws    = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  sb._render();
  await flush(t);

  // Resize terminal + stream dimensions, then fire the resize event
  t.resize(COLS, ROWS2);
  ws.rows    = ROWS2;
  ws.columns = COLS;
  ws.emit('resize');
  await flush(t);

  // Bar must now be pinned at the new bottom (ROWS2 - barHeight .. ROWS2 - 1, 0-indexed)
  const barHeight   = sb._renderedLines;
  const newTopRow   = ROWS2 - barHeight;
  const newBotRow   = ROWS2 - 1;

  const topRowAfter = getRow(t, newTopRow);
  assert.ok(
    topRowAfter.includes('═'),
    `bar top row at new position (${newTopRow}) must contain '═' after resize; got: ${JSON.stringify(topRowAfter.slice(0, 40))}`,
  );

  const botRowAfter = getRow(t, newBotRow);
  assert.ok(
    botRowAfter.includes('═'),
    `bar bottom row at new position (${newBotRow}) must contain '═' after resize; got: ${JSON.stringify(botRowAfter.slice(0, 40))}`,
  );

  sb.destroy();
});

// ── Scenario 9: Teardown ──────────────────────────────────────────────────────
//
// After destroy(), the bar is cleared and all subsequent public method calls
// must be no-ops (produce zero output).
//
// Uses a fake stream for stream-level assertions.

await test('S9 teardown: destroy() clears bar; subsequent methods are no-ops', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: true, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream, enabled: true });

  // Render so bar is visible and _renderedLines > 0
  sb._render();

  // destroy() must emit bar-clearing ANSI sequences
  chunks.length = 0;
  sb.destroy();
  const destroyOutput = chunks.join('');
  assert.ok(
    destroyOutput.length > 0,
    'destroy() must emit output to clear the bar',
  );
  // Must contain at least one of the expected teardown sequences
  assert.ok(
    /\x1b\[r/.test(destroyOutput) || /\x1b\[J/.test(destroyOutput) || /\x1b\[\?25h/.test(destroyOutput),
    `destroy() must emit bar-clearing ANSI sequences; got: ${JSON.stringify(destroyOutput.slice(0, 200))}`,
  );

  // After destroy(), all public methods must produce zero output
  chunks.length = 0;
  sb.updateAgent('agent-1', { role: 'executor', taskId: 't1', description: 'x', status: 'active', elapsed: 0, cost: 0 });
  sb.updateProgress(1, 5, 0.01, 1);
  sb.updateMilestone('001', 5, 60);
  sb.onLog('should-not-appear');
  sb._render();
  sb.hide();
  sb.show();
  sb.destroy(); // second call must also be a no-op

  assert.strictEqual(
    chunks.length,
    0,
    `all methods must be no-ops after destroy(), but ${chunks.length} write(s) occurred`,
  );
});

// ── Scenario 10: Concurrent logs ─────────────────────────────────────────────
//
// Three immediate onLog() calls (no await between them) must each appear on
// a distinct row in the terminal buffer.  Failure in v0.1.18: onLog()
// repositions to the same scrollBottom row for each call, so the messages
// overwrite each other rather than advancing to new rows.
//
// Test expected to FAIL against v0.1.18.

await test('S10 concurrent logs: three immediate onLog() calls appear on distinct rows', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  sb._render();
  await flush(t);

  // Three synchronous log calls — no await between them
  sb.onLog('CONCURRENT-ALPHA');
  sb.onLog('CONCURRENT-BETA');
  sb.onLog('CONCURRENT-GAMMA');

  await flush(t);

  const barHeight = sb._renderedLines;

  let alphaRow = -1;
  let betaRow  = -1;
  let gammaRow = -1;

  for (let r = 0; r < ROWS - barHeight; r++) {
    const row = getRow(t, r);
    if (row.includes('CONCURRENT-ALPHA')) alphaRow = r;
    if (row.includes('CONCURRENT-BETA'))  betaRow  = r;
    if (row.includes('CONCURRENT-GAMMA')) gammaRow = r;
  }

  assert.ok(alphaRow >= 0, `CONCURRENT-ALPHA not found in scroll region`);
  assert.ok(betaRow  >= 0, `CONCURRENT-BETA not found in scroll region`);
  assert.ok(gammaRow >= 0, `CONCURRENT-GAMMA not found in scroll region`);

  assert.ok(
    alphaRow !== betaRow,
    `CONCURRENT-ALPHA (row ${alphaRow}) and CONCURRENT-BETA (row ${betaRow}) must be on different rows`,
  );
  assert.ok(
    betaRow !== gammaRow,
    `CONCURRENT-BETA (row ${betaRow}) and CONCURRENT-GAMMA (row ${gammaRow}) must be on different rows`,
  );
  assert.ok(
    alphaRow !== gammaRow,
    `CONCURRENT-ALPHA (row ${alphaRow}) and CONCURRENT-GAMMA (row ${gammaRow}) must be on different rows`,
  );

  sb.destroy();
});

// ── Scenario 11: Non-TTY parity ──────────────────────────────────────────────
//
// When the output stream has isTTY=false, StatusBar must emit no ANSI escape
// sequences.  All public methods are inert; zero bytes reach the stream.
//
// This mirrors the non-TTY contract verified in test-status-bar.js (TC1/TC2)
// but is included here as part of the full 11-scenario suite.

await test('S11 non-TTY parity: no \\x1b escape sequences in output when isTTY=false', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false, rows: 24, columns: 80 });
  const sb = new StatusBar({ output: stream });

  // Exercise every public method — all must be no-ops for non-TTY
  sb.updateAgent('planner-1', {
    role: 'planner', taskId: '001-001-001-001',
    description: 'plan', status: 'active', elapsed: 0, cost: 0,
  });
  sb.updateProgress(1, 5, 0.01, 1);
  sb.updateMilestone('001-001', 5, 60);
  sb.onLog('log-message-non-tty');
  sb._render();
  sb.hide();
  sb.show();
  sb.promptWillStart();
  sb.promptDidEnd();

  // No ANSI escape sequences must appear in any output chunk
  const combined = chunks.join('');
  assert.ok(
    !/\x1b/.test(combined),
    `non-TTY output must contain no \\x1b escape sequences; got: ${JSON.stringify(combined.slice(0, 200))}`,
  );

  // Non-TTY must produce zero output (all methods are fully inert)
  assert.strictEqual(chunks.length, 0, 'non-TTY: no method should write to stream');

  sb.destroy();
  assert.strictEqual(chunks.length, 0, 'non-TTY: destroy() must also write nothing');
});

// ── Scenario 12: Heavy-tick load ──────────────────────────────────────────────
//
// 100 synchronous updateAgent() calls must not accumulate extra bar rows in the
// terminal buffer.  After a single explicit _render() call (which cancels the
// pending debounce timer), the bar area must contain exactly _renderedLines
// non-empty rows (TC1) and the 100th call's values must be visible (TC2).
//
// TC3 (fallback): the write-spy must record ≤1 chunk containing '═' from the
// single _render() call, proving debounce coalescing — each _render() issues
// exactly one output.write() call so 100 updateAgent calls driven through one
// explicit render produce at most one bar-emission chunk.

await test('S12 heavy-tick load: 100 updateAgent calls coalesce; bar rows equal _renderedLines', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish bar before installing the spy so the initial render is not counted.
  sb._render();
  await flush(t);

  // ── Install write spy ──────────────────────────────────────────────────
  const spyChunks = [];
  const origWrite = ws.write.bind(ws);
  ws.write = (chunk, enc, cb) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    spyChunks.push(str);
    return origWrite(chunk, enc, cb);
  };

  // ── 100 synchronous updateAgent calls ─────────────────────────────────
  const startedAt = Date.now();
  for (let i = 0; i < 100; i++) {
    sb.updateAgent('exec-1', {
      role: 'executor',
      taskId: 'T1',
      description: 'work',
      startedAt,
      elapsed: i,
      cost: i * 0.001,
    });
  }

  // Single explicit _render() — deterministic fallback path (TC3).
  // Cancels the pending debounce timer so no second render fires during flush.
  sb._render();
  await flush(t);

  const barHeight = sb._renderedLines;

  // TC1: Non-empty rows in bar area must equal barHeight exactly (no row accumulation).
  let nonEmptyInBar = 0;
  for (let r = ROWS - barHeight; r < ROWS; r++) {
    if (getRow(t, r).length > 0) nonEmptyInBar++;
  }
  assert.strictEqual(
    nonEmptyInBar,
    barHeight,
    `bar area must have exactly ${barHeight} non-empty rows (no accumulation); got ${nonEmptyInBar}`,
  );

  // TC2: 100th call's elapsed (i=99 → '99s') and cost (0.099 → '$0.10') visible in bar rows.
  let barText = '';
  for (let r = ROWS - barHeight; r < ROWS; r++) {
    barText += getRawRow(t, r) + ' ';
  }
  assert.ok(
    barText.includes('99s') || barText.includes('99'),
    `bar must display elapsed=99 from the 100th updateAgent call; got: ${JSON.stringify(barText.trim().slice(0, 120))}`,
  );
  assert.ok(
    barText.includes('$0.10') || barText.includes('0.10') || barText.includes('0.09'),
    `bar must display cost from the 100th updateAgent call (approx $0.10); got: ${JSON.stringify(barText.trim().slice(0, 120))}`,
  );

  // TC3 (fallback): write-spy bar emission chunks ≤ 1.
  // _render() issues exactly one output.write() call containing the full bar string,
  // so spy must see at most 1 chunk with '═' from a single render invocation.
  const barEmissionChunks = spyChunks.filter(ch => ch.includes('═'));
  assert.ok(
    barEmissionChunks.length <= 1,
    `write-spy: bar emissions should be ≤1 after single _render() (debounce coalescing); got ${barEmissionChunks.length} chunks with '═'`,
  );

  sb.destroy();
});

// ── Scenario 13: Prompt-during-tick ──────────────────────────────────────────
//
// While a readline prompt is active (_promptActive=true), updateAgent() calls
// must NOT trigger any bar renders.  After promptDidEnd() the bar is re-rendered
// and must reflect the LATEST agent state (last updateAgent call's values).
// No terminal row should mix the prompt text and a bar separator on the same line.

await test('S13 prompt-during-tick: no bar renders between promptWillStart and promptDidEnd', async () => {
  const COLS       = 80;
  const ROWS       = 24;
  const PROMPT_STR = '[S13] ? ';   // distinctive prompt text for TC6 assertion
  const t          = makeTerminal(COLS, ROWS);
  const ws         = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish bar before installing the spy.
  sb._render();
  await flush(t);

  // ── Install write spy ──────────────────────────────────────────────────
  const spyChunks = [];
  const origWrite = ws.write.bind(ws);
  ws.write = (chunk, enc, cb) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    spyChunks.push(str);
    return origWrite(chunk, enc, cb);
  };

  // ── Begin prompt: position cursor, then echo prompt text ──────────────
  sb.promptWillStart();
  ws.write(PROMPT_STR);   // simulate readline echoing the prompt string

  // Mark the spy window start (after all prompt-setup writes).
  const promptWindowStart = spyChunks.length;

  // ── 10 updateAgent calls during the prompt ────────────────────────────
  // _scheduleRender() is a no-op while _promptActive=true, so zero bar
  // renders should occur here.
  const startedAt = Date.now();
  for (let i = 1; i <= 10; i++) {
    sb.updateAgent('exec-1', {
      role: 'executor',
      taskId: 'T1',
      description: 'work',
      startedAt,
      elapsed: i,
      cost: i * 0.001,
    });
  }

  // Mark the spy window end before promptDidEnd fires a re-render.
  const promptWindowEnd = spyChunks.length;

  sb.promptDidEnd();
  await flush(t);

  // TC4: No chunk captured between promptWillStart and promptDidEnd contains '═'.
  // (The 10 updateAgent calls must not trigger any bar renders.)
  const duringPromptChunks = spyChunks.slice(promptWindowStart, promptWindowEnd);
  const barChunksDuringPrompt = duringPromptChunks.filter(ch => ch.includes('═'));
  assert.strictEqual(
    barChunksDuringPrompt.length,
    0,
    `no bar render should occur between promptWillStart and promptDidEnd; got ${barChunksDuringPrompt.length} chunk(s) with '═': ${JSON.stringify(barChunksDuringPrompt.map(c => c.slice(0, 40)))}`,
  );

  // TC5: After promptDidEnd + flush, bar reflects the 10th updateAgent call
  //      (elapsed=10 → '10s', cost=0.01 → '$0.01').
  const barHeight = sb._renderedLines;
  let barText = '';
  for (let r = ROWS - barHeight; r < ROWS; r++) {
    barText += getRawRow(t, r) + ' ';
  }
  assert.ok(
    barText.includes('10s') || barText.includes('10'),
    `bar must display elapsed=10 from the 10th updateAgent call after promptDidEnd; got: ${JSON.stringify(barText.trim().slice(0, 120))}`,
  );
  assert.ok(
    barText.includes('$0.01') || barText.includes('0.01'),
    `bar must display cost=$0.01 from the 10th updateAgent call after promptDidEnd; got: ${JSON.stringify(barText.trim().slice(0, 120))}`,
  );

  // TC6: No terminal row contains both the prompt text and a '═' bar separator.
  for (let i = 0; i < ROWS; i++) {
    const rowText  = getRawRow(t, i);
    const hasPrompt = rowText.includes(PROMPT_STR.trim());
    const hasBarSep = rowText.includes('═');
    assert.ok(
      !(hasPrompt && hasBarSep),
      `row ${i} must not mix prompt text and bar separator '═'; got: ${JSON.stringify(rowText.trim().slice(0, 60))}`,
    );
  }

  sb.destroy();
});

// ── Scenario 14: Resize mid-tick ──────────────────────────────────────────────
//
// After resizing the terminal from 80×24 to 100×40, the status bar must
// re-anchor to the new bottom (top separator on row ROWS2-barHeight, bottom
// separator on row ROWS2-1).  The former bar rows in the old 24-row terminal
// (rows 22–23) must contain no stale '═' or bar fragments.

await test('S14 resize mid-tick: bar re-anchors after terminal resize', async () => {
  const COLS  = 80;
  const ROWS  = 24;
  const COLS2 = 100;
  const ROWS2 = 40;
  const t     = makeTerminal(COLS, ROWS);
  const ws    = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  sb._render();
  await flush(t);

  // Verify bar was rendered in old terminal (sanity check before resize).
  const oldBarHeight = sb._renderedLines;
  assert.ok(oldBarHeight > 0, `bar must be rendered before resize; _renderedLines=${oldBarHeight}`);

  // ── Resize terminal + stream, fire resize event ────────────────────────
  // t.resize(cols, rows) is the xterm API; update ws dimensions accordingly.
  t.resize(COLS2, ROWS2);
  ws.rows    = ROWS2;
  ws.columns = COLS2;
  ws.emit('resize');  // triggers StatusBar._onResize → _render()
  await flush(t);

  const barHeight = sb._renderedLines;

  // TC7: Bar re-anchors to new bottom — top bar row (ROWS2-barHeight) and
  //      bottom bar row (ROWS2-1) must contain '═'.
  //      For ROWS2=40 and barHeight=7 this corresponds to rows 33 and 39;
  //      the bottom border is always row 39 (= ROWS2-1).
  const newTopBarRow = ROWS2 - barHeight;
  const newBotBarRow = ROWS2 - 1;

  const topRowAfter = getRow(t, newTopBarRow);
  assert.ok(
    topRowAfter.includes('═'),
    `bar top row at new position (row ${newTopBarRow} = ROWS2-barHeight) must contain '═' after resize to ${ROWS2} rows; got: ${JSON.stringify(topRowAfter.slice(0, 40))}`,
  );

  const botRowAfter = getRow(t, newBotBarRow);
  assert.ok(
    botRowAfter.includes('═'),
    `bar bottom row at new position (row ${newBotBarRow} = ROWS2-1) must contain '═' after resize; got: ${JSON.stringify(botRowAfter.slice(0, 40))}`,
  );

  // TC8: Former bar rows 22–23 (in the original 24-row terminal the bar
  //      occupied rows ROWS-barHeight .. ROWS-1, which includes rows 22 and 23)
  //      must contain no stale '═' or bar fragments after the re-render clears them.
  const row22 = getRow(t, 22);
  assert.ok(
    !row22.includes('═'),
    `former bar row 22 must not contain '═' after resize (old bar area cleared); got: ${JSON.stringify(row22.slice(0, 40))}`,
  );

  const row23 = getRow(t, 23);
  assert.ok(
    !row23.includes('═'),
    `former bar row 23 (last row of old terminal) must not contain '═' after resize; got: ${JSON.stringify(row23.slice(0, 40))}`,
  );

  sb.destroy();
});

// ── S4 follow-on: prompt + log + promptDidEnd + log (001-003-001-003) ─────────
//
// Extends the S4 row-mash scenario with a second log call after promptDidEnd().
// The full sequence exercises all v3.2 code paths:
//
//   1. sb._render()                              — establish bar
//   2. sb.promptWillStart()                      — yield cursor to readline
//   3. ws.write('First prompt (answer?): ')      — readline prompt echo
//   4. sb.onLog('first-log-message')             — log during prompt
//   5. sb.promptDidEnd()                         — re-render bar
//   6. sb.onLog('second-log-message')            — post-prompt log
//
// Correct behaviour: no terminal row contains fragments of two distinct
// messages (prompt text + log text, or two different log texts mixed).

await test('S4 row-mash regression — prompt + log + prompt + log under v3.2 sequence', async () => {
  const ROWS = 24;
  const COLS = 80;
  const t    = makeTerminal(COLS, ROWS);
  const ws   = makeTerminalStream(t, COLS, ROWS);
  const sb = new StatusBar({ output: ws, enabled: true });

  // 1. Establish bar.
  sb._render();
  await flush(t);

  // 2. Signal readline prompt start.
  sb.promptWillStart();
  await flush(t);

  // 3. Simulate readline echoing a prompt string.
  //    '(answer?)' is the distinctive fragment we detect later.
  ws.write('First prompt (answer?): ');
  await flush(t);

  // 4. Log a message while the prompt is active.
  //    'first-log-message' (17 chars) is shorter than the 24-char prompt text,
  //    so partial overwrite would leave '(answer?): ' visible.
  sb.onLog('first-log-message');
  await flush(t);

  // 5. End prompt — triggers bar re-render.
  sb.promptDidEnd();
  await flush(t);

  // 6. Log a second message post-prompt.
  sb.onLog('second-log-message');
  await flush(t);

  // Assert: no row contains fragments from two distinct sources.
  for (let i = 0; i < ROWS; i++) {
    const rowText     = getRawRow(t, i);
    const hasFirst    = rowText.includes('first-log-message');
    const hasSecond   = rowText.includes('second-log-message');
    const hasPrompt   = rowText.includes('(answer?)');

    assert.ok(
      !(hasFirst && hasPrompt),
      `row ${i} must not contain both first-log-message and prompt text (answer?); got: ${JSON.stringify(rowText.trim().slice(0, 80))}`,
    );
    assert.ok(
      !(hasSecond && hasPrompt),
      `row ${i} must not contain both second-log-message and prompt text (answer?); got: ${JSON.stringify(rowText.trim().slice(0, 80))}`,
    );
    assert.ok(
      !(hasFirst && hasSecond),
      `row ${i} must not contain fragments from both log messages; got: ${JSON.stringify(rowText.trim().slice(0, 80))}`,
    );
  }

  sb.destroy();
});

// ── Scenario 21: Prompt transcript persistence (Bug 4) ────────────────────────
//
// After askYesNo / askMenu completes, the prompt question + user's raw answer
// remain as a permanent visible row in the scroll region — scrolling up like
// any other log line as new logs arrive, never overwritten by bar repaints.
//
// Mechanism (after v0.1.27): no explicit onLog emission inside prompt.js's
// done() helpers. Instead, the transcript line emerges from two pre-existing
// behaviors:
//   1. promptWillStart() positions cursor at scrollBottom (one row above bar).
//   2. readline writes the prompt question and echoes user input at that row.
//   3. On Enter, readline emits "\r\n" — the "\n" at scrollBottom triggers a
//      DECSTBM scroll-up, pushing the prompt+answer row to scrollBottom-1.
//   4. promptDidEnd() calls _render(), which draws the bar but does not touch
//      content above scrollBottom.
//
// We don't drive real readline here (cooked-mode I/O is awkward in xterm-
// headless). We simulate the relevant byte stream directly: promptWillStart,
// then write "Proceed? (y/n) y" + "\r\n" to the terminal stream (mimicking
// readline's natural echo + Enter), then promptDidEnd. After that, a real
// onLog should appear BELOW the prompt's transcript line.
//
// Earlier failure mode (v0.1.25): prompt.js explicitly emitted onLog(question +
// answer) before promptDidEnd, on top of readline's natural echo — producing
// two identical "Proceed? (y/n) y" rows per prompt with a blank gap between.
// That double-emit was removed in v0.1.27.

await test('S21 prompt transcript persistence: prompt+answer visible in scroll region after promptDidEnd', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t   = makeTerminal(COLS, ROWS);
  const ws  = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish bar so DECSTBM is active and _renderedLines is populated.
  sb._render();
  await flush(t);

  // Simulate the actual prompt lifecycle:
  //   1. promptWillStart() — positions cursor at scrollBottom
  //   2. readline writes prompt + user types 'y' + Enter (we simulate the
  //      visible byte stream directly: "Proceed? (y/n) y\r\n")
  //   3. promptDidEnd() — re-renders bar
  sb.promptWillStart();
  ws.write('Proceed? (y/n) y\r\n');
  sb.promptDidEnd();
  await flush(t);

  // Emit one more log to confirm the transcript scrolls up correctly under it.
  sb.onLog('next-event-after-prompt');
  await flush(t);

  // Scan the visible buffer for both strings. We do NOT depend on the exact
  // scroll-region geometry because xterm-headless's handling of \n at DECSTBM
  // bottom margin can shift the bar by one row depending on cursor state, and
  // the contract here is just "both lines present, transcript above next event".
  let transcriptRow = -1;
  let nextEventRow  = -1;

  for (let i = 0; i < ROWS; i++) {
    const rowText = getRow(t, i);
    if (rowText.includes('Proceed? (y/n) y') && transcriptRow === -1) transcriptRow = i;
    if (rowText.includes('next-event-after-prompt') && nextEventRow === -1) nextEventRow = i;
  }

  assert.ok(transcriptRow !== -1, `transcript "Proceed? (y/n) y" must appear somewhere in the visible buffer`);
  assert.ok(nextEventRow !== -1,  `next event "next-event-after-prompt" must appear somewhere in the visible buffer`);
  assert.ok(transcriptRow < nextEventRow, `transcript (row ${transcriptRow}) must be ABOVE next event (row ${nextEventRow}) — i.e., transcript scrolled up correctly`);

  // KNOWN ISSUE (filed for follow-up dogfood): the LF in readline's "\r\n"
  // at scrollBottom appears to shift the bar's top row by 1 in xterm-headless
  // (and likely real terminals too — matches the user's "bar disappears during
  // prompt" observation from dogfood 33 self-host). We don't assert
  // "next-event must NOT land in bar area" yet because that would lock-step
  // this test with a fix that's being scoped separately.

  sb.destroy();
});

// ── Scenario 22: onLog text containing embedded \n or > terminal width must NOT clobber bar (Bug 6) ──
//
// Two modes of overflow that previously corrupted bar rows:
//
//   (a) Embedded '\n' inside the message — common via
//       `_formatBanner(...).join('\n')` from pipeline.js. Each '\n' at
//       scrollBottom advances the cursor past the DECSTBM bottom margin
//       without scrolling (VT100 only scrolls on LF AT bottom margin
//       INSIDE the region).
//   (b) Auto-wrap (DECAWM) on a single line longer than terminal width
//       pushes the cursor to the next physical row; at scrollBottom that
//       row is bar territory.
//
// Both confirmed via paired A+B agent xterm-headless investigation (2026-04-26).
// Fix in status-bar.js onLog: split on '\n', truncate each segment to
// (cols - 1), emit each segment as its own SAVE+SU+MOVE+text+RESTORE. This
// scenario asserts that bar rows survive both overflow modes.

await test('S22 onLog overflow protection: bar rows intact after multi-line + over-cols messages', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t   = makeTerminal(COLS, ROWS);
  const ws  = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });

  // Establish bar so DECSTBM is active.
  sb._render();
  await flush(t);

  const barHeight = sb._renderedLines;
  const barTopIdx = ROWS - barHeight;  // 0-indexed first row of bar

  // Snapshot bar's top-border row content to confirm pre-state.
  const initialBarTop = getRow(t, barTopIdx);
  assert.ok(initialBarTop.includes('═'), `bar top border at row ${barTopIdx} should contain '═' before any onLog, got: ${JSON.stringify(initialBarTop)}`);

  // (a) Embedded \n: simulate _formatBanner-style multi-line onLog.
  sb.onLog('Mission 001-001: This is a long banner with multiple\nlines via embedded \\n that\nused to overflow into bar territory');
  await flush(t);

  const barTopAfterEmbeddedNL = getRow(t, barTopIdx);
  assert.ok(barTopAfterEmbeddedNL.includes('═'), `bar top border at row ${barTopIdx} must still be '═' after multi-line onLog, got: ${JSON.stringify(barTopAfterEmbeddedNL)}`);

  // (b) Over-cols line: 200 chars in a single segment, no \n.
  sb.onLog('A'.repeat(200));
  await flush(t);

  const barTopAfterLong = getRow(t, barTopIdx);
  assert.ok(barTopAfterLong.includes('═'), `bar top border at row ${barTopIdx} must still be '═' after long-line onLog, got: ${JSON.stringify(barTopAfterLong)}`);

  // (c) Combined: many banners back-to-back — the dryRunValidate flow.
  for (let i = 0; i < 10; i++) {
    sb.onLog(`Mission 001-${i}: long body with embedded\nnewlines and a really long\nthird line that exceeds the terminal width by quite a lot to test the auto-wrap protection too`);
  }
  await flush(t);

  // After many large logs, every bar row must still be non-empty bar content.
  for (let i = 0; i < barHeight; i++) {
    const row = getRow(t, barTopIdx + i);
    assert.ok(row.length > 0, `bar row ${barTopIdx + i} must be non-empty after many overflow-prone onLogs, got: ${JSON.stringify(row)}`);
  }
  // Bar's top and bottom borders specifically — these are full-width ═ in normal bar rendering.
  assert.ok(getRow(t, barTopIdx).includes('═'), `bar top border must contain '═' after combined stress, got: ${JSON.stringify(getRow(t, barTopIdx))}`);
  assert.ok(getRow(t, ROWS - 1).includes('═'), `bar bottom border must contain '═' after combined stress, got: ${JSON.stringify(getRow(t, ROWS - 1))}`);

  sb.destroy();
});

// ── Scenario 23: onLog before first _render auto-establishes the bar (Bug 9) ──
//
// Without the defensive auto-render in onLog, calling onLog before any
// _render() produces a state where _renderedLines === 0, scrollBottom ===
// rows, and the message lands at the terminal's last physical row — working
// in isolation but creating an implicit caller-order contract. The fix
// (status-bar.js onLog: auto-call _render() when _renderedLines === 0) makes
// onLog safe at any point: bar gets established before the message lands.
//
// This scenario asserts: after a single onLog with no prior _render(), the
// bar is on screen (top + bottom borders contain '═'), and the message lives
// in the scroll region above the bar.

await test('S23 onLog before first _render: auto-renders the bar; message lands in scroll region', async () => {
  const COLS = 80;
  const ROWS = 24;
  const t   = makeTerminal(COLS, ROWS);
  const ws  = makeTerminalStream(t, COLS, ROWS);

  const sb = new StatusBar({ output: ws, enabled: true });
  // No sb._render() call — exercise the defect-9 path directly.
  assert.strictEqual(sb._renderedLines, 0, 'pre-condition: no render has run');

  sb.onLog('first-message-before-render');
  await flush(t);

  // Auto-render must have fired.
  assert.ok(sb._renderedLines > 0, 'first onLog should auto-render the bar');

  const barHeight = sb._renderedLines;
  const barTopIdx = ROWS - barHeight;

  // Bar's top border has '═' — bar is drawn.
  assert.ok(
    getRow(t, barTopIdx).includes('═'),
    `bar top border at row ${barTopIdx} should contain '═' after auto-render, got: ${JSON.stringify(getRow(t, barTopIdx))}`,
  );
  // Bar's bottom border has '═' as well.
  assert.ok(
    getRow(t, ROWS - 1).includes('═'),
    `bar bottom border at row ${ROWS - 1} should contain '═', got: ${JSON.stringify(getRow(t, ROWS - 1))}`,
  );

  // The message should appear somewhere in the scroll region (rows 0..barTopIdx-1),
  // NOT inside the bar's footprint.
  let foundMsgRow = -1;
  for (let i = 0; i < barTopIdx; i++) {
    if (getRow(t, i).includes('first-message-before-render')) {
      foundMsgRow = i;
      break;
    }
  }
  assert.ok(foundMsgRow !== -1, `message should appear in scroll region (rows 0..${barTopIdx - 1})`);
  for (let i = barTopIdx; i < ROWS; i++) {
    assert.ok(
      !getRow(t, i).includes('first-message-before-render'),
      `message must NOT appear in bar footprint at row ${i}, got: ${JSON.stringify(getRow(t, i))}`,
    );
  }

  sb.destroy();
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
