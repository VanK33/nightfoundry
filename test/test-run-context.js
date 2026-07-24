/**
 * test-run-context.js — Unit tests for run-context.js: the runId generator,
 * the two path handles (harnessRoot / runHarnessDir), the active-run pointer
 * lifecycle (claim / read / clear), and the "signpost not truth" resolver.
 *
 * No Claude auth, no SDK. Uses temp directories (fs.mkdtempSync) + a local
 * test()/pass-fail harness like the other test files in this repo.
 *
 * Coverage:
 *   TC1  generateRunId shape (run-{ts}-{slug}-{4hex})
 *   TC2  generateRunId same-second same-slug uniqueness
 *   TC3  generateRunId sanitizes/lowercases the slug
 *   TC4  harnessRoot / runHarnessDir / activeRunPointerPath path shapes
 *   TC5  claimActiveRun succeeds on a fresh root, writing the pointer contents
 *   TC6  claimActiveRun is an O_EXCL lock: a second claim returns false and
 *        does NOT overwrite the first claimant's contents
 *   TC7  claimActiveRun creates .harness/ when absent
 *   TC8  readActiveRunPointer round-trips a claimed pointer; returns null when
 *        absent; returns null on corrupt (non-JSON) contents
 *   TC9  clearActiveRunPointer removes the pointer and is idempotent
 *   TC10 resolveActiveHarnessDir returns the run dir on the happy path
 *   TC11 resolveActiveHarnessDir returns null on every miss: no pointer,
 *        torn/corrupt pointer, pointer without runId, dangling run dir
 *        (no state.json)
 *   TC12 resolveActiveHarnessDir never throws even on a garbage projectRoot
 *   TC16-19 activeHarnessDir: harnessRoot fallback (no pointer / dangling
 *        pointer / nonexistent projectRoot), runHarnessDir on the happy path
 *
 * Run: node test/test-run-context.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import {
  generateRunId,
  harnessRoot,
  runHarnessDir,
  activeRunPointerPath,
  claimActiveRun,
  readActiveRunPointer,
  clearActiveRunPointer,
  resolveActiveHarnessDir,
  activeHarnessDir,
} from '../src/orchestrator/core/run-context.js';

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

// ---------- Fixture helpers ----------

function createTempRoot(prefix = 'run-context-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// Seed a run-{id}/state.json so the resolver's second hop can pass.
function seedRunStateJson(root, runId, contents = '{"globalStatus":"active"}') {
  const dir = runHarnessDir(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), contents);
  return dir;
}

// ---------- Tests ----------

async function main() {
  // --- TC1: generateRunId shape ---
  await test("TC1: generateRunId('My Feature!') matches run-{timestamp}-{slug}-{4hex} shape", () => {
    const id = generateRunId('My Feature!');
    assert.ok(
      /^run-\d{8}T\d{6}-[a-z0-9-]+-[0-9a-f]{4}$/.test(id),
      `Expected id to match the run-id shape, got: ${id}`
    );
  });

  // --- TC2: same-second same-slug uniqueness ---
  await test('TC2: two generateRunId calls with the same slug return different ids', () => {
    const id1 = generateRunId('same-slug');
    const id2 = generateRunId('same-slug');
    assert.notStrictEqual(id1, id2, `Expected distinct ids, got the same twice: ${id1}`);
  });

  // --- TC3: slug is sanitized + lowercased ---
  await test('TC3: generateRunId sanitizes and lowercases the slug', () => {
    const id = generateRunId('My Feature!!  Ver_2');
    // The slug segment sits between the timestamp and the 4-hex suffix.
    const m = id.match(/^run-\d{8}T\d{6}-(.+)-[0-9a-f]{4}$/);
    assert.ok(m, `id did not match the expected shape: ${id}`);
    const slugSegment = m[1];
    assert.strictEqual(slugSegment, 'my-feature-ver-2',
      `Expected sanitized slug 'my-feature-ver-2', got: ${slugSegment}`);
  });

  // --- TC4: path-handle shapes ---
  await test('TC4: harnessRoot / runHarnessDir / activeRunPointerPath path shapes', () => {
    const root = '/tmp/proj';
    assert.strictEqual(harnessRoot(root), path.join('/tmp/proj', '.harness'));
    assert.strictEqual(runHarnessDir(root, 'run-x'), path.join('/tmp/proj', '.harness', 'run-x'));
    assert.strictEqual(activeRunPointerPath(root), path.join('/tmp/proj', '.harness', 'active-run'));
  });

  // --- TC5: claimActiveRun succeeds + writes contents ---
  await test('TC5: claimActiveRun succeeds on a fresh root and writes the pointer contents', () => {
    const root = createTempRoot();
    try {
      const ok = claimActiveRun(root, { runId: 'run-a', slug: 'a', kind: 'run' });
      assert.strictEqual(ok, true, 'expected the first claim to return true');
      assert.ok(fs.existsSync(activeRunPointerPath(root)), 'pointer file should exist after a claim');
      const parsed = JSON.parse(fs.readFileSync(activeRunPointerPath(root), 'utf8'));
      assert.strictEqual(parsed.runId, 'run-a');
      assert.strictEqual(parsed.slug, 'a');
      assert.strictEqual(parsed.kind, 'run');
      assert.ok(typeof parsed.startedAt === 'string' && parsed.startedAt.length > 0,
        'pointer should carry a startedAt timestamp');
    } finally {
      cleanup(root);
    }
  });

  // --- TC6: second claim is refused and does not clobber the incumbent ---
  // NOTE: this proves the observable contract in cc-orch's serial model
  // (sequential refusal + no-clobber). True cross-process atomicity comes from
  // the O_EXCL 'wx' open flag (single syscall, no check-then-write window) and
  // is a property of the code, not something an in-process test can force.
  await test('TC6: a second claimActiveRun is refused (false) and leaves the first claimant intact', () => {
    const root = createTempRoot();
    try {
      const first = claimActiveRun(root, { runId: 'run-first', slug: 'first', kind: 'run' });
      const second = claimActiveRun(root, { runId: 'run-second', slug: 'second', kind: 'run' });
      assert.strictEqual(first, true, 'first claim should succeed');
      assert.strictEqual(second, false, 'second claim must be refused (lock held)');
      const parsed = JSON.parse(fs.readFileSync(activeRunPointerPath(root), 'utf8'));
      assert.strictEqual(parsed.runId, 'run-first',
        'the first claimant\'s contents must be intact — a rejected claim must not clobber');
    } finally {
      cleanup(root);
    }
  });

  // --- TC7: claimActiveRun creates .harness/ when absent ---
  await test('TC7: claimActiveRun creates .harness/ when absent', () => {
    const root = createTempRoot();
    try {
      assert.ok(!fs.existsSync(harnessRoot(root)), 'fixture: .harness must not exist yet');
      const ok = claimActiveRun(root, { runId: 'run-b', slug: 'b', kind: 'dry-run' });
      assert.strictEqual(ok, true);
      assert.ok(fs.existsSync(harnessRoot(root)), '.harness/ should have been created');
    } finally {
      cleanup(root);
    }
  });

  // --- TC8: readActiveRunPointer round-trip / absent / corrupt ---
  await test('TC8: readActiveRunPointer round-trips a claim, null when absent, null on corrupt', () => {
    const root = createTempRoot();
    try {
      assert.strictEqual(readActiveRunPointer(root), null, 'absent pointer should read as null');

      claimActiveRun(root, { runId: 'run-c', slug: 'c', kind: 'run' });
      const p = readActiveRunPointer(root);
      assert.ok(p && p.runId === 'run-c', 'claimed pointer should round-trip');

      fs.writeFileSync(activeRunPointerPath(root), 'not-json{{{');
      assert.strictEqual(readActiveRunPointer(root), null, 'corrupt pointer should read as null');
    } finally {
      cleanup(root);
    }
  });

  // --- TC9: clearActiveRunPointer removes + idempotent ---
  await test('TC9: clearActiveRunPointer removes the pointer and is idempotent', () => {
    const root = createTempRoot();
    try {
      claimActiveRun(root, { runId: 'run-d', slug: 'd', kind: 'run' });
      assert.ok(fs.existsSync(activeRunPointerPath(root)), 'pointer should exist before clear');
      clearActiveRunPointer(root);
      assert.ok(!fs.existsSync(activeRunPointerPath(root)), 'pointer should be gone after clear');
      // idempotent: a second clear on an already-absent pointer must not throw
      clearActiveRunPointer(root);
      assert.ok(!fs.existsSync(activeRunPointerPath(root)), 'still absent after a second clear');
    } finally {
      cleanup(root);
    }
  });

  // --- TC10: resolver happy path ---
  await test('TC10: resolveActiveHarnessDir returns the run dir when pointer + state.json exist', () => {
    const root = createTempRoot();
    try {
      const runId = 'run-happy';
      claimActiveRun(root, { runId, slug: 'happy', kind: 'run' });
      const expected = seedRunStateJson(root, runId);
      assert.strictEqual(resolveActiveHarnessDir(root), expected,
        'resolver should return the run harness dir on the happy path');
    } finally {
      cleanup(root);
    }
  });

  // --- TC11: resolver miss matrix ---
  await test('TC11: resolveActiveHarnessDir returns null on every miss', () => {
    // (a) no pointer at all
    {
      const root = createTempRoot();
      try {
        assert.strictEqual(resolveActiveHarnessDir(root), null, 'no pointer → null');
      } finally { cleanup(root); }
    }
    // (b) torn / corrupt pointer
    {
      const root = createTempRoot();
      try {
        fs.mkdirSync(harnessRoot(root), { recursive: true });
        fs.writeFileSync(activeRunPointerPath(root), '{ half');
        assert.strictEqual(resolveActiveHarnessDir(root), null, 'corrupt pointer → null');
      } finally { cleanup(root); }
    }
    // (c) pointer without a runId
    {
      const root = createTempRoot();
      try {
        fs.mkdirSync(harnessRoot(root), { recursive: true });
        fs.writeFileSync(activeRunPointerPath(root), JSON.stringify({ slug: 'x', kind: 'run' }));
        assert.strictEqual(resolveActiveHarnessDir(root), null, 'pointer without runId → null');
      } finally { cleanup(root); }
    }
    // (d) dangling: pointer present, but the run dir has no state.json
    {
      const root = createTempRoot();
      try {
        claimActiveRun(root, { runId: 'run-dangling', slug: 'x', kind: 'run' });
        // deliberately do NOT seed state.json
        assert.strictEqual(resolveActiveHarnessDir(root), null, 'missing state.json → null');
      } finally { cleanup(root); }
    }
  });

  // --- TC12: resolver never throws on garbage input ---
  await test('TC12: resolveActiveHarnessDir never throws on a nonexistent projectRoot', () => {
    const bogus = path.join(os.tmpdir(), 'run-context-does-not-exist-' + generateRunId('x'));
    assert.strictEqual(resolveActiveHarnessDir(bogus), null, 'nonexistent root → null, no throw');
  });

  // --- TC13: resolver returns null (no throw) on a parseable non-string runId ---
  await test('TC13: resolveActiveHarnessDir returns null (never throws) on a truthy non-string runId', () => {
    const root = createTempRoot();
    try {
      fs.mkdirSync(harnessRoot(root), { recursive: true });
      // {runId: 123} is truthy but not a string — a bare `!pointer.runId`
      // guard would pass it through to path.join and throw.
      fs.writeFileSync(activeRunPointerPath(root), JSON.stringify({ runId: 123, slug: 'x', kind: 'run' }));
      let result, threw = false;
      try { result = resolveActiveHarnessDir(root); } catch { threw = true; }
      assert.strictEqual(threw, false, 'resolver must not throw on a non-string runId');
      assert.strictEqual(result, null, 'non-string runId → null');
    } finally {
      cleanup(root);
    }
  });

  // --- TC14: resolver returns null when state.json is a DIRECTORY, not a file ---
  await test('TC14: resolveActiveHarnessDir returns null when state.json is a directory', () => {
    const root = createTempRoot();
    try {
      const runId = 'run-dir-state';
      claimActiveRun(root, { runId, slug: 'x', kind: 'run' });
      // Create state.json as a DIRECTORY — existsSync would accept it; isFile must reject it.
      fs.mkdirSync(path.join(runHarnessDir(root, runId), 'state.json'), { recursive: true });
      assert.strictEqual(resolveActiveHarnessDir(root), null, 'state.json-as-directory → null');
    } finally {
      cleanup(root);
    }
  });

  // --- TC15: generateRunId on an all-symbol slug still produces a well-formed id ---
  await test('TC15: generateRunId on an all-symbol slug yields a well-formed id (slug defaults, no empty segment)', () => {
    const id = generateRunId('!!!');
    assert.ok(
      /^run-\d{8}T\d{6}-[a-z0-9-]+-[0-9a-f]{4}$/.test(id),
      `all-symbol slug must not produce a malformed id, got: ${id}`
    );
    assert.ok(!id.includes('--'), `id must not contain an empty slug segment (double hyphen): ${id}`);
  });

  // --- TC16: activeHarnessDir falls back to harnessRoot when no pointer exists ---
  await test('TC16: activeHarnessDir(root) === harnessRoot(root) when no pointer exists', () => {
    const root = createTempRoot();
    try {
      assert.strictEqual(activeHarnessDir(root), harnessRoot(root),
        'with no active-run pointer, activeHarnessDir must fall back to harnessRoot');
    } finally {
      cleanup(root);
    }
  });

  // --- TC17: activeHarnessDir returns the run dir on the happy path ---
  await test('TC17: activeHarnessDir(root) === runHarnessDir(root, runId) with a claimed pointer + state.json', () => {
    const root = createTempRoot();
    try {
      const runId = 'run-active-happy';
      claimActiveRun(root, { runId, slug: 'active-happy', kind: 'run' });
      seedRunStateJson(root, runId);
      assert.strictEqual(activeHarnessDir(root), runHarnessDir(root, runId),
        'activeHarnessDir should return the per-run harness dir on the happy path');
    } finally {
      cleanup(root);
    }
  });

  // --- TC18: activeHarnessDir falls back to harnessRoot on a dangling pointer ---
  await test('TC18: activeHarnessDir(root) === harnessRoot(root) when the pointer is dangling (no state.json)', () => {
    const root = createTempRoot();
    try {
      claimActiveRun(root, { runId: 'run-active-dangling', slug: 'x', kind: 'run' });
      // deliberately do NOT seed state.json
      assert.strictEqual(activeHarnessDir(root), harnessRoot(root),
        'a dangling pointer (no state.json) must fall back to harnessRoot');
    } finally {
      cleanup(root);
    }
  });

  // --- TC19: activeHarnessDir never throws on a nonexistent projectRoot ---
  await test('TC19: activeHarnessDir(bogus) === harnessRoot(bogus) and does not throw on a nonexistent projectRoot', () => {
    const bogus = path.join(os.tmpdir(), 'run-context-does-not-exist-' + generateRunId('x'));
    let result, threw = false;
    try { result = activeHarnessDir(bogus); } catch { threw = true; }
    assert.strictEqual(threw, false, 'activeHarnessDir must not throw on a nonexistent projectRoot');
    assert.strictEqual(result, harnessRoot(bogus), 'nonexistent root → harnessRoot(bogus) fallback');
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
