/**
 * test-phantom-write-readonly-sentinel.js — Deterministic unit test for the
 * phantom-write NO-OP diagnostic sentinel formatter (mission 001-002).
 *
 * Tests the pure formatter `formatZeroDeltaLog(taskId, unchangedFiles)`
 * exported from src/orchestrator/core/pipeline.js. No live agent pipeline
 * is spawned; all assertions are synchronous and deterministic.
 *
 * TC1: Formatter(taskId, unchangedFiles) return string contains the literal token '[zero-delta-task]'
 * TC2: Returned string contains the supplied task id
 * TC3: Returned string contains each supplied unchanged file path
 * TC4: pipeline.js source contains '[zero-delta-task]' exactly once (single-emission guard)
 * TC5: node test/test-phantom-write-readonly-sentinel.js exits 0 deterministically with no agent spawn
 *
 * Run: node test/test-phantom-write-readonly-sentinel.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatZeroDeltaLog } from '../src/orchestrator/core/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

const SAMPLE_TASK_ID = '001-002-003-004';
const SAMPLE_UNCHANGED_FILES = ['src/a.js', 'src/b.js'];

await test('TC1: formatter return string contains the literal token [zero-delta-task]', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  assert.ok(
    result.includes('[zero-delta-task]'),
    `Expected result to contain '[zero-delta-task]', got: ${result}`
  );
});

await test('TC2: returned string contains the supplied task id', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  assert.ok(
    result.includes(SAMPLE_TASK_ID),
    `Expected result to contain task id '${SAMPLE_TASK_ID}', got: ${result}`
  );
});

await test('TC3: returned string contains each supplied unchanged file path', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  for (const filePath of SAMPLE_UNCHANGED_FILES) {
    assert.ok(
      result.includes(filePath),
      `Expected result to contain file path '${filePath}', got: ${result}`
    );
  }
});

await test('TC4: pipeline.js source contains [zero-delta-task] exactly once (single-emission guard)', async () => {
  const pipelinePath = path.resolve(__dirname, '../src/orchestrator/core/pipeline.js');
  const source = fs.readFileSync(pipelinePath, 'utf8');
  const token = '[zero-delta-task]';
  const occurrences = source.split(token).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `Expected '[zero-delta-task]' to appear exactly once in pipeline.js, but found ${occurrences} occurrence(s)`
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
