/**
 * test-wrap.js — Unit tests for src/orchestrator/infra/wrap.js.
 *
 * Covers wrapLine and getTerminalWidth behaviour.
 *
 * Run: node test/test-wrap.js
 */
import assert from 'assert';
import { wrapLine, getTerminalWidth } from '../src/orchestrator/infra/wrap.js';

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

async function run() {

// ── TC1: short input unchanged ───────────────────────────────────────

await test('TC1: wrapLine returns input unchanged when length <= effective width', () => {
  // width=20, margin=2 → effectiveWidth=16; 'hello world' is 11 chars
  const input = 'hello world';
  const result = wrapLine(input, { width: 20 });
  assert.strictEqual(result, input, `expected unchanged input, got: ${JSON.stringify(result)}`);
});

// ── TC2: long input wraps with each row <= effective width ────────────

await test('TC2: wrapLine wraps long input into rows each <= effective width', () => {
  // width=20 → effectiveWidth=16
  const input = 'one two three four five six seven eight';
  const result = wrapLine(input, { width: 20 });
  const rows = result.split('\n');
  assert.ok(rows.length > 1, 'expected multiple rows from long input');
  for (const row of rows) {
    // Strip any hangingIndent/rail prefixes – none used here, check raw length
    assert.ok(
      row.length <= 16,
      `row "${row}" has length ${row.length}, expected <= 16`,
    );
  }
});

// ── TC3: embedded \n preserved AND each row independently wrapped ─────

await test('TC3: embedded \\n preserved AND each row independently wrapped', () => {
  // width=20 → effectiveWidth=16
  // 'aaa' is short; 'long long long ...' wraps
  const input = 'aaa\nlong long long ...';
  const result = wrapLine(input, { width: 20 });

  // Must contain at least two top-level segments split by the original \n
  assert.ok(result.startsWith('aaa\n'), `result should start with 'aaa\\n', got: ${JSON.stringify(result)}`);

  const rows = result.split('\n');
  // 'aaa' preserved as-is
  assert.strictEqual(rows[0], 'aaa', `first row should be 'aaa', got: ${JSON.stringify(rows[0])}`);
  // All rows <= effectiveWidth=16
  for (const row of rows) {
    assert.ok(
      row.length <= 16,
      `row "${row}" has length ${row.length}, exceeds effectiveWidth 16`,
    );
  }
  // Second part wrapped → more than 2 total rows
  assert.ok(rows.length > 2, `expected >2 rows after wrapping, got ${rows.length}`);
});

// ── TC4: hangingIndent applied to continuation rows only ─────────────

await test('TC4: hangingIndent applied to continuation rows only', () => {
  // width=20 → effectiveWidth=16; hangingIndent='    ' (4 spaces)
  const indent = '    ';
  const input = 'one two three four five six';
  const result = wrapLine(input, { width: 20, hangingIndent: indent });

  const rows = result.split('\n');
  assert.ok(rows.length > 1, 'expected multiple rows');

  // First row must NOT start with indent
  assert.ok(
    !rows[0].startsWith(indent),
    `first row should not start with hangingIndent, got: ${JSON.stringify(rows[0])}`,
  );

  // Every continuation row must start with the indent
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i].startsWith(indent),
      `continuation row ${i} should start with hangingIndent, got: ${JSON.stringify(rows[i])}`,
    );
  }
});

// ── TC5: railPrefix preserved on every continuation row ──────────────

await test('TC5: railPrefix preserved on every continuation row', () => {
  // width=20 → effectiveWidth=16; railPrefix='│ '
  const rail = '│ ';
  const input = 'one two three four five six';
  const result = wrapLine(input, { width: 20, railPrefix: rail });

  const rows = result.split('\n');
  assert.ok(rows.length > 1, 'expected multiple rows');

  // First row must NOT start with rail
  assert.ok(
    !rows[0].startsWith(rail),
    `first row should not have railPrefix, got: ${JSON.stringify(rows[0])}`,
  );

  // Every continuation row must start with the rail prefix
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i].startsWith(rail),
      `continuation row ${i} should start with railPrefix '│ ', got: ${JSON.stringify(rows[i])}`,
    );
  }
});

// ── TC6: getTerminalWidth fallback determinism ───────────────────────

await test('TC6: getTerminalWidth falls back to opts.fallback when stream.columns is undefined', () => {
  const width = getTerminalWidth({ stream: {}, fallback: 42 });
  assert.strictEqual(width, 42, `expected fallback 42, got ${width}`);
});

await test('TC6: getTerminalWidth returns stream.columns when it is a positive integer', () => {
  const width = getTerminalWidth({ stream: { columns: 80 }, fallback: 42 });
  assert.strictEqual(width, 80, `expected stream.columns 80, got ${width}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
