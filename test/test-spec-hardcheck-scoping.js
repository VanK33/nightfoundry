// Verified compatible with w4-gate-predicate-fidelity.
/**
 * test-spec-hardcheck-scoping.js — Tests for extractPathTokens and scopeSpecHardChecks.
 *
 * Covers:
 *   TC1: extractPathTokens extracts from ls command
 *   TC2: extractPathTokens extracts from grep command
 *   TC3: extractPathTokens returns empty for npm run
 *   TC4: scopeSpecHardChecks matches task with overlapping targetFiles
 *   TC5: scopeSpecHardChecks excludes non-overlapping targetFiles
 *   TC6: scopeSpecHardChecks excludes no-path checks (milestone-only)
 *   TC7: integration through writeVerifyJson → runHardChecks
 *   TC8: findOrphanedSpecHardChecks returns a path-bearing check assigned to no task
 *   TC9: findOrphanedSpecHardChecks does NOT return a check assigned to some task
 *   TC10: findOrphanedSpecHardChecks never returns a no-path-token (milestone-only) check
 *   TC11: findUnassignedSpecHardChecks returns a path-bearing check whose command is NOT in the assigned set
 *   TC12: findUnassignedSpecHardChecks does NOT return a check whose command IS in the assigned set
 *   TC13: findUnassignedSpecHardChecks never returns a no-path-token (milestone-only) check
 *
 * Run: node test/test-spec-hardcheck-scoping.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { extractPathTokens, scopeSpecHardChecks, findOrphanedSpecHardChecks, findUnassignedSpecHardChecks } from '../src/orchestrator/agents/planner.js';
import { writeVerifyJson } from '../src/orchestrator/core/state.js';
import { runHardChecks } from '../src/orchestrator/gates/hard-checks.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      failCount++;
    }
  );
}

// ---------- Fixture helpers ----------

function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-hardcheck-scoping-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// ---------- Tests ----------

async function main() {
  // TC1: extractPathTokens extracts from ls command
  await test('TC1: extractPathTokens("ls test/X.js") returns ["test/X.js"]', () => {
    const tokens = extractPathTokens('ls test/X.js');
    assert.deepStrictEqual(tokens, ['test/X.js']);
  });

  // TC2: extractPathTokens extracts from grep command
  await test('TC2: extractPathTokens("grep -q Y test/Z.js") returns path containing test/Z.js', () => {
    const tokens = extractPathTokens('grep -q Y test/Z.js');
    assert.ok(tokens.includes('test/Z.js'), `Expected tokens to contain "test/Z.js", got: ${JSON.stringify(tokens)}`);
  });

  // TC3: extractPathTokens returns empty for npm run test:all
  await test('TC3: extractPathTokens("npm run test:all") returns []', () => {
    const tokens = extractPathTokens('npm run test:all');
    assert.deepStrictEqual(tokens, []);
  });

  // TC4: scopeSpecHardChecks matches task with overlapping targetFiles
  await test('TC4: scopeSpecHardChecks([{name:"check",command:"ls test/X.js"}], [{id:"t1",targetFiles:["test/X.js"]}]) → Map has t1→[the check]', () => {
    const checks = [{ name: 'check', command: 'ls test/X.js' }];
    const tasks = [{ id: 't1', targetFiles: ['test/X.js'] }];
    const result = scopeSpecHardChecks(checks, tasks);
    assert.ok(result instanceof Map, 'Expected a Map');
    assert.ok(result.has('t1'), 'Expected t1 in map');
    const taskChecks = result.get('t1');
    assert.strictEqual(taskChecks.length, 1, 'Expected 1 check for t1');
    assert.strictEqual(taskChecks[0].name, 'check');
  });

  // TC5: scopeSpecHardChecks excludes non-overlapping targetFiles
  await test('TC5: scopeSpecHardChecks([{name:"check",command:"ls test/X.js"}], [{id:"t1",targetFiles:["test/Y.js"]}]) → Map has no entry for t1', () => {
    const checks = [{ name: 'check', command: 'ls test/X.js' }];
    const tasks = [{ id: 't1', targetFiles: ['test/Y.js'] }];
    const result = scopeSpecHardChecks(checks, tasks);
    assert.ok(result instanceof Map, 'Expected a Map');
    // t1 is in the map but with empty checks array (no overlap)
    if (result.has('t1')) {
      const taskChecks = result.get('t1');
      assert.strictEqual(taskChecks.length, 0, 'Expected no checks for t1 (no overlap)');
    }
  });

  // TC6: scopeSpecHardChecks excludes no-path checks (milestone-only)
  await test('TC6: scopeSpecHardChecks([{name:"audit",command:"npm run audit:r2"}], [{id:"t1",targetFiles:["src/foo.js"]}]) → no checks for t1', () => {
    const checks = [{ name: 'audit', command: 'npm run audit:r2' }];
    const tasks = [{ id: 't1', targetFiles: ['src/foo.js'] }];
    const result = scopeSpecHardChecks(checks, tasks);
    assert.ok(result instanceof Map, 'Expected a Map');
    if (result.has('t1')) {
      const taskChecks = result.get('t1');
      assert.strictEqual(taskChecks.length, 0, 'Expected no checks for t1 (no-path check is milestone-only)');
    }
  });

  // TC7: integration — create temp harnessDir, build task with scoped hardChecks,
  //       call writeVerifyJson, call runHardChecks, assert correct pass/fail behavior
  await test('TC7: integration — scoped hardCheck that passes executes via writeVerifyJson → runHardChecks', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      // Create a file in projectRoot so an ls check can find it
      const targetRelPath = 'test/scoped-file.js';
      const targetAbsPath = path.join(projectRoot, targetRelPath);
      fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
      fs.writeFileSync(targetAbsPath, '// placeholder');

      // Use scopeSpecHardChecks to get the scoped checks for our task
      const allChecks = [
        { name: 'check scoped file', command: `ls ${targetRelPath}` },
        { name: 'npm milestone check', command: 'npm run test:all' }, // no path → milestone-only, excluded
      ];
      const tasks = [{ id: '001-001-001-003', targetFiles: [targetRelPath] }];
      const scopedMap = scopeSpecHardChecks(allChecks, tasks);
      const scopedChecks = scopedMap.get('001-001-001-003') || [];

      // Only the ls check should be scoped in (npm run has no path tokens)
      assert.strictEqual(scopedChecks.length, 1, `Expected 1 scoped check, got ${scopedChecks.length}`);
      assert.strictEqual(scopedChecks[0].name, 'check scoped file');

      // Build task with these scoped checks
      const task = {
        id: '001-001-001-003',
        targetFiles: [targetRelPath],
        hardChecks: scopedChecks,
        testCases: ['TC7: integration scoping check'],
      };

      writeVerifyJson(harnessDir, task);
      const result = await runHardChecks(harnessDir, '001-001-001-003', projectRoot);

      assert.strictEqual(result.passed, true, `Expected passed=true, got passed=${result.passed}`);
      assert.strictEqual(result.results.length, 1, `Expected 1 result, got ${result.results.length}`);
      assert.strictEqual(result.results[0].passed, true, 'Expected the ls check to pass');
    } finally { cleanup(projectRoot); }
  });

  // TC8: findOrphanedSpecHardChecks returns a path-bearing check assigned to no task.
  //      The scopedMap is produced by scopeSpecHardChecks; the check's path token
  //      (test/orphan.js) overlaps no task's targetFiles, so it lands nowhere.
  await test('TC8: findOrphanedSpecHardChecks returns a path-bearing check assigned to no task', () => {
    const orphan = { name: 'orphan check', command: 'node test/orphan.js' };
    const checks = [orphan];
    const tasks = [{ id: 't1', targetFiles: ['src/foo.js'] }];
    const scopedMap = scopeSpecHardChecks(checks, tasks);
    const orphans = findOrphanedSpecHardChecks(checks, scopedMap);
    assert.ok(Array.isArray(orphans), 'Expected an array');
    assert.strictEqual(orphans.length, 1, `Expected 1 orphan, got ${orphans.length}`);
    assert.strictEqual(orphans[0].command, orphan.command);
  });

  // TC9: findOrphanedSpecHardChecks does NOT return a check that IS assigned to some task.
  //      The check's path token (test/X.js) overlaps t1's targetFiles, so it is present
  //      in a scopedMap value and is therefore not an orphan.
  await test('TC9: findOrphanedSpecHardChecks does NOT return a check assigned to some task', () => {
    const assigned = { name: 'assigned check', command: 'ls test/X.js' };
    const checks = [assigned];
    const tasks = [{ id: 't1', targetFiles: ['test/X.js'] }];
    const scopedMap = scopeSpecHardChecks(checks, tasks);
    // Sanity: the check really was assigned to t1.
    assert.strictEqual((scopedMap.get('t1') || []).length, 1, 'Expected the check assigned to t1');
    const orphans = findOrphanedSpecHardChecks(checks, scopedMap);
    assert.strictEqual(orphans.length, 0, `Expected 0 orphans, got ${orphans.length}`);
  });

  // TC10: findOrphanedSpecHardChecks never returns a no-path-token (milestone-only) check,
  //       even when it is assigned to no task in the scopedMap.
  await test('TC10: findOrphanedSpecHardChecks never returns a no-path-token (milestone-only) check', () => {
    const milestone = { name: 'milestone check', command: 'npm run test:all' };
    const checks = [milestone];
    const tasks = [{ id: 't1', targetFiles: ['src/foo.js'] }];
    const scopedMap = scopeSpecHardChecks(checks, tasks);
    // Sanity: the no-path check is assigned to nobody (scopeSpecHardChecks skips it).
    assert.strictEqual((scopedMap.get('t1') || []).length, 0, 'Expected the no-path check assigned to nobody');
    const orphans = findOrphanedSpecHardChecks(checks, scopedMap);
    assert.strictEqual(orphans.length, 0, `Expected 0 orphans (no-path check is never an orphan), got ${orphans.length}`);
  });

  // TC11: findUnassignedSpecHardChecks returns a path-bearing check whose
  //       command is NOT in the assigned-commands set.
  await test('TC11: findUnassignedSpecHardChecks returns a path-bearing check whose command is not in the assigned set', () => {
    const unassigned = { name: 'unassigned check', command: 'node test/unassigned.js' };
    const result = findUnassignedSpecHardChecks([unassigned], new Set());
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 1, `Expected 1 unassigned check, got ${result.length}`);
    assert.strictEqual(result[0].command, unassigned.command);
  });

  // TC12: findUnassignedSpecHardChecks does NOT return a check whose command
  //       IS in the assigned-commands set.
  await test('TC12: findUnassignedSpecHardChecks does NOT return a check whose command is in the assigned set', () => {
    const assigned = { name: 'assigned check', command: 'node test/assigned.js' };
    const result = findUnassignedSpecHardChecks([assigned], new Set(['node test/assigned.js']));
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 0, `Expected 0 unassigned checks, got ${result.length}`);
  });

  // TC13: findUnassignedSpecHardChecks never returns a no-path-token
  //       (milestone-only) check, even when its command is not in the set.
  await test('TC13: findUnassignedSpecHardChecks never returns a no-path-token (milestone-only) check', () => {
    const milestone = { name: 'milestone check', command: 'npm run test:all' };
    const result = findUnassignedSpecHardChecks([milestone], new Set());
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 0, `Expected 0 unassigned checks (no-path check is never unassigned), got ${result.length}`);
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
