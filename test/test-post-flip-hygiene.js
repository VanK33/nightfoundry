/**
 * test-post-flip-hygiene.js — Post-runId-flip hygiene tests.
 *
 * Covers:
 *   (a) ensureSharedSkeleton(root) creates harnessRoot with EXACTLY
 *       SHARED_SUBDIRS, no flat state.json, and none of PER_RUN_SUBDIRS
 *       present under harnessRoot.
 *   (b) preflight(harnessRoot, { sharedOnly: true }) on that skeleton
 *       returns ok===true with empty errors.
 *   (c) preflight(harnessRoot, { sharedOnly: true }) after removing one
 *       shared subdir returns ok===false with an error naming it.
 *   (d) preflight(harnessRoot) without sharedOnly on a full legacy flat
 *       bootstrap() layout still returns ok===true (current behavior
 *       preserved).
 *   (e) infraErrorHint({ batch: true, projectRoot }) names
 *       'resume --batch'.
 *   (f) infraErrorHint({ batch: false, projectRoot }) with a claimed +
 *       bootstrapped active run names bare 'cc-orch resume' and NOT
 *       'resume --batch'.
 *   (g) infraErrorHint({ batch: false, projectRoot }) with no active run
 *       does NOT name bare 'cc-orch resume'.
 *   (h) Scheduler constructed over a harnessDir with no state.json logs no
 *       '[Scheduler] Warning: could not hydrate' line; over a harnessDir
 *       whose state.json is corrupt (non-JSON), it DOES log that warning.
 *
 * No Claude auth, no SDK. Pure fs + temp directories + real production
 * bootstrap/claim/preflight/infraErrorHint/Scheduler shapes.
 *
 * Run: node test/test-post-flip-hygiene.js
 */

// See scripts/run-tests.js for why this is cleared at module top: the suite
// may itself be launched from inside a live run, and CC_ORCH_ACTIVE_RUN
// would otherwise be inherited and trip assertNoReentrantLiveRun on the
// mkdtemp fixture roots this file bootstraps against.
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  ensureSharedSkeleton,
  SHARED_SUBDIRS,
  PER_RUN_SUBDIRS,
  bootstrap,
} from '../src/orchestrator/core/bootstrap.js';
import { preflight } from '../src/orchestrator/core/preflight.js';
import { infraErrorHint } from '../src/cli/infra-hint.js';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { claimActiveRun, harnessRoot } from '../src/orchestrator/core/run-context.js';

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

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'post-flip-hygiene-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Case (a) ---------------------------------------------------------

test('(a) ensureSharedSkeleton creates harnessRoot with exactly SHARED_SUBDIRS, no flat state.json, no PER_RUN_SUBDIRS', () => {
  const root = mkRoot();
  try {
    ensureSharedSkeleton(root);
    const hRoot = harnessRoot(root);

    assert.ok(fs.existsSync(hRoot), 'harnessRoot(root) should exist after ensureSharedSkeleton');

    const dirNames = fs.readdirSync(hRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.deepStrictEqual(
      dirNames,
      [...SHARED_SUBDIRS].sort(),
      `expected exactly SHARED_SUBDIRS directories under harnessRoot, got ${JSON.stringify(dirNames)}`
    );

    assert.ok(
      !fs.existsSync(path.join(hRoot, 'state.json')),
      'no flat state.json should exist directly under harnessRoot'
    );

    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(
        !fs.existsSync(path.join(hRoot, sub)),
        `PER_RUN_SUBDIRS entry "${sub}" should not exist under harnessRoot`
      );
    }
  } finally {
    cleanup(root);
  }
});

// --- Case (b) ---------------------------------------------------------

test('(b) preflight(harnessRoot, { sharedOnly: true }) on the skeleton returns ok===true with empty errors', () => {
  const root = mkRoot();
  try {
    ensureSharedSkeleton(root);
    const result = preflight(harnessRoot(root), { sharedOnly: true });
    assert.strictEqual(result.ok, true, `expected ok===true, errors: ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(result.errors, []);
  } finally {
    cleanup(root);
  }
});

// --- Case (c) ---------------------------------------------------------

test('(c) preflight(harnessRoot, { sharedOnly: true }) with a removed shared subdir returns ok===false naming it', () => {
  const root = mkRoot();
  try {
    ensureSharedSkeleton(root);
    fs.rmSync(path.join(harnessRoot(root), 'learning'), { recursive: true, force: true });

    const result = preflight(harnessRoot(root), { sharedOnly: true });
    assert.strictEqual(result.ok, false, 'expected ok===false after removing a shared subdir');
    assert.ok(
      result.errors.some((e) => e.includes('learning')),
      `expected an error naming the missing "learning" subdir, got ${JSON.stringify(result.errors)}`
    );
  } finally {
    cleanup(root);
  }
});

// --- Case (d) ---------------------------------------------------------

test('(d) preflight(harnessRoot) without sharedOnly on a full flat bootstrap layout returns ok===true (legacy behavior preserved)', () => {
  const root = mkRoot();
  try {
    const { harnessDir } = bootstrap(root);
    const result = preflight(harnessDir);
    assert.strictEqual(result.ok, true, `expected ok===true, errors: ${JSON.stringify(result.errors)}`);
  } finally {
    cleanup(root);
  }
});

// --- Case (e) ---------------------------------------------------------

test("(e) infraErrorHint({ batch: true, projectRoot }) returns a string containing 'resume --batch'", () => {
  const root = mkRoot();
  try {
    const hint = infraErrorHint({ batch: true, projectRoot: root });
    assert.ok(hint.includes('resume --batch'), `expected hint to include "resume --batch", got: ${hint}`);
  } finally {
    cleanup(root);
  }
});

// --- Case (f) ---------------------------------------------------------

test("(f) infraErrorHint({ batch: false, projectRoot }) with a claimed+bootstrapped active run names 'cc-orch resume' and not 'resume --batch'", () => {
  const root = mkRoot();
  try {
    const runId = 'run-20260101T000000-hygienef-abcd';
    const claimed = claimActiveRun(root, { runId, slug: 'hygiene-f', kind: 'test' });
    assert.strictEqual(claimed, true, 'expected claimActiveRun to succeed on a fresh fixture root');
    bootstrap(root, { runId });

    const hint = infraErrorHint({ batch: false, projectRoot: root });
    assert.ok(hint.includes('cc-orch resume'), `expected hint to name "cc-orch resume", got: ${hint}`);
    assert.ok(!hint.includes('resume --batch'), `expected hint to NOT name "resume --batch", got: ${hint}`);
  } finally {
    cleanup(root);
  }
});

// --- Case (g) ---------------------------------------------------------

test("(g) infraErrorHint({ batch: false, projectRoot }) with no active run does NOT name bare 'cc-orch resume'", () => {
  const root = mkRoot();
  try {
    const hint = infraErrorHint({ batch: false, projectRoot: root });
    assert.ok(
      !hint.includes('cc-orch resume'),
      `expected hint to NOT name bare "cc-orch resume" (no active run branch), got: ${hint}`
    );
  } finally {
    cleanup(root);
  }
});

// --- Case (h) ---------------------------------------------------------

test("(h) Scheduler over a harnessDir with no state.json logs NO '[Scheduler] Warning: could not hydrate' line", () => {
  const root = mkRoot();
  try {
    const harnessDir = path.join(root, 'no-state-harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const logs = [];
    new Scheduler({
      harnessDir,
      projectRoot: root,
      maxConcurrent: 1,
      runTask: async () => {},
      onLog: (msg) => logs.push(msg),
    });

    assert.ok(
      !logs.some((l) => l.includes('[Scheduler] Warning: could not hydrate')),
      `expected no hydrate warning, got logs: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(root);
  }
});

test("(h) Scheduler over a harnessDir with a corrupt state.json DOES log '[Scheduler] Warning: could not hydrate replanAttempts from state.json'", () => {
  const root = mkRoot();
  try {
    const harnessDir = path.join(root, 'corrupt-state-harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(path.join(harnessDir, 'state.json'), 'not valid json {{{');

    const logs = [];
    new Scheduler({
      harnessDir,
      projectRoot: root,
      maxConcurrent: 1,
      runTask: async () => {},
      onLog: (msg) => logs.push(msg),
    });

    assert.ok(
      logs.some((l) => l.includes('[Scheduler] Warning: could not hydrate replanAttempts from state.json')),
      `expected hydrate warning, got logs: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(root);
  }
});

// --- Summary ------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`Total: ${passCount + failCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log('='.repeat(60) + '\n');

process.exit(failCount > 0 ? 1 : 0);
