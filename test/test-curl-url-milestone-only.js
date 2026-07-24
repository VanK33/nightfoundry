/**
 * test-curl-url-milestone-only.js — integration test proving a
 * `curl http://localhost:3000/health` criterion classifies as milestone-only
 * and routes through the drain instead of causing a plan-fatal IncompleteScopeError.
 *
 * The URL token `http://localhost:3000/health` contains `://` and is excluded
 * by extractPathTokens, leaving zero qualifying path tokens → milestone-only.
 *
 * Cases:
 *   TC1  isMilestoneOnlyCheck({name:'health',command:'curl http://localhost:3000/health'},
 *        ['src/app.js']) returns true — URL token excluded, zero path tokens remain.
 *   TC2  findOrphanedSpecHardChecks does NOT return the curl check (milestone-only
 *        checks are never orphans).
 *   TC3  scopeSpecHardChecks assigns the curl check to no task (excluded as
 *        milestone-only).
 *   TC4  findUnassignedSpecHardChecks does NOT return the curl check.
 *   TC5  Backward-compat pin: isMilestoneOnlyCheck({name:'x',command:'node test/foo.js'},
 *        ['test/foo.js']) returns false (path token matches target_file).
 *
 * Run: node test/test-curl-url-milestone-only.js
 */
import assert from 'assert';
import {
  isMilestoneOnlyCheck,
  scopeSpecHardChecks,
  findUnassignedSpecHardChecks,
  findOrphanedSpecHardChecks,
} from '../src/orchestrator/agents/planner.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const CURL_CMD = 'curl http://localhost:3000/health';
const curlCheck = () => ({ name: 'health', command: CURL_CMD });
const SPEC_TARGET_FILES = ['src/app.js'];

// ═════════════════════════════════════════════════════════════════════════════
// TC1 — URL token excluded → zero path tokens → milestone-only
// ═════════════════════════════════════════════════════════════════════════════

test('TC1: isMilestoneOnlyCheck with curl URL command and non-empty specTargetFiles returns true', () => {
  const result = isMilestoneOnlyCheck(curlCheck(), SPEC_TARGET_FILES);
  assert.strictEqual(
    result,
    true,
    `expected isMilestoneOnlyCheck('${CURL_CMD}', ['src/app.js']) === true — ` +
    `URL token 'http://localhost:3000/health' contains '://' and is excluded, ` +
    `leaving zero qualifying path tokens, so the check must be milestone-only`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// TC2 — findOrphanedSpecHardChecks does NOT return the curl check
// ═════════════════════════════════════════════════════════════════════════════

test('TC2: findOrphanedSpecHardChecks does not return the curl check (milestone-only → never orphan)', () => {
  const checks = [curlCheck()];
  const tasks = [{ id: 't1', targetFiles: SPEC_TARGET_FILES }];
  const scopedMap = scopeSpecHardChecks(checks, tasks, SPEC_TARGET_FILES);
  const orphans = findOrphanedSpecHardChecks(checks, scopedMap, SPEC_TARGET_FILES);
  assert.ok(Array.isArray(orphans), 'expected an array from findOrphanedSpecHardChecks');
  const found = orphans.some(c => c.command === CURL_CMD);
  assert.strictEqual(
    found,
    false,
    `expected the curl check NOT to appear in orphans (milestone-only checks are never orphans), ` +
    `got ${orphans.length} orphan(s): ${JSON.stringify(orphans)}`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// TC3 — scopeSpecHardChecks assigns the curl check to no task
// ═════════════════════════════════════════════════════════════════════════════

test('TC3: scopeSpecHardChecks assigns the curl check to no task (excluded as milestone-only)', () => {
  const checks = [curlCheck()];
  const tasks = [{ id: 't1', targetFiles: SPEC_TARGET_FILES }];
  const result = scopeSpecHardChecks(checks, tasks, SPEC_TARGET_FILES);
  assert.ok(result instanceof Map, 'expected a Map from scopeSpecHardChecks');
  const taskChecks = result.get('t1') || [];
  const found = taskChecks.some(c => c.command === CURL_CMD);
  assert.strictEqual(
    found,
    false,
    `expected the curl check NOT to be scoped to any task (milestone-only checks go to the drain), ` +
    `t1 has ${taskChecks.length} check(s): ${JSON.stringify(taskChecks)}`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// TC4 — findUnassignedSpecHardChecks does NOT return the curl check
// ═════════════════════════════════════════════════════════════════════════════

test('TC4: findUnassignedSpecHardChecks does not return the curl check (milestone-only → not unassigned)', () => {
  const result = findUnassignedSpecHardChecks(
    [curlCheck()],
    new Set(),
    SPEC_TARGET_FILES
  );
  assert.ok(Array.isArray(result), 'expected an array from findUnassignedSpecHardChecks');
  const found = result.some(c => c.command === CURL_CMD);
  assert.strictEqual(
    found,
    false,
    `expected the curl check NOT to appear in unassigned checks (it is milestone-only), ` +
    `got ${result.length} unassigned check(s): ${JSON.stringify(result)}`
  );
  assert.strictEqual(
    result.length,
    0,
    `expected 0 unassigned checks, got ${result.length}: ${JSON.stringify(result)}`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// TC5 — Backward-compat pin: path token matching target_file → NOT milestone-only
// ═════════════════════════════════════════════════════════════════════════════

test('TC5: backward-compat pin — node test/foo.js with [\'test/foo.js\'] returns false (path token matches target_file)', () => {
  const check = { name: 'x', command: 'node test/foo.js' };
  const result = isMilestoneOnlyCheck(check, ['test/foo.js']);
  assert.strictEqual(
    result,
    false,
    `expected isMilestoneOnlyCheck({command:'node test/foo.js'}, ['test/foo.js']) === false — ` +
    `'test/foo.js' is a path token that matches the target_file entry, so the check must NOT be milestone-only`
  );
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
