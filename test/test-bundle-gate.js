/**
 * test-bundle-gate.js — Unit tests for bundle path derivation and
 * bundle.json reading/validation in src/orchestrator/gates/bundle-gate.js,
 * plus the bundle-carriage behavior of the dry-run queue finalize path
 * (src/orchestrator/core/pipeline.js) and the archive copy path
 * (src/cli/commands/archive.js#copySpecToArchive).
 *
 * Contract under test:
 *   1. deriveBundlePath(specFilePath): maps '<dir>/<slug>.spec.json' →
 *      '<dir>/<slug>.bundle.json' and '<dir>/spec.json' → '<dir>/bundle.json';
 *      returns null for any other basename and for falsy/non-string input.
 *   2. readBundle(specFilePath, projectRoot) against a schema-valid v0
 *      bundle.json whose evidence anchors resolve returns a non-null bundle,
 *      every source entry in `entries`, an empty `dropped` array, and a null
 *      `rejectionReason`.
 *   3. readBundle against a bundle.json whose entry violates the v0 entry
 *      shape (evidence not an array) rejects the bundle WHOLE: bundle null,
 *      entries [], a non-null rejectionReason, and at least one
 *      console.warn call.
 *   4. readBundle drops an entry whose evidence file is missing (per-entry
 *      drop with {id, reason} + warn), keeping resolving siblings.
 *   5. readBundle drops an entry whose evidence symbol no longer occurs in
 *      the (existing) file, keeping resolving siblings.
 *   6. readBundle rejects an oversized bundle WHOLE (no truncation), naming
 *      config.architect.bundleMaxBytes in the rejection reason.
 *   7. readBundle rejects unparseable JSON whole, fail-open (no throw).
 *   8. readBundle rejects schemaVersion !== 1 whole.
 *   9. readBundle with no bundle file returns the silent no-bundle shape
 *      with ZERO warns (the normal no-Pro path).
 *   10. buildArchitectContextSection renders [kind] text + evidence anchors,
 *       and contributes the EMPTY STRING for absent/empty/non-surviving input.
 *   11. planGlobal (fake session manager) injects the section into the USER
 *       prompt only; absent-vs-[] prompts are byte-identical.
 *   12. planMission (fake reusable session) injects the section into the
 *       turn prompt; absent-vs-[] prompts are byte-identical.
 *   13. dryRunValidate (mocked planner), spec with a sibling bundle file:
 *       queue/<slug>/bundle.json exists and is byte-identical to the source.
 *   14. dryRunValidate (mocked planner), spec with NO sibling bundle file:
 *       no queue/<slug>/bundle.json is created; no error is thrown.
 *   15. copySpecToArchive, spec with a sibling bundle file: writes
 *       <archiveDir>/bundle.json byte-identical to the sibling bundle.
 *   16. copySpecToArchive, spec with NO sibling bundle file: no
 *       <archiveDir>/bundle.json is created; nothing thrown.
 *
 * Run: node test/test-bundle-gate.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveBundlePath, readBundle } from '../src/orchestrator/gates/bundle-gate.js';
import { buildArchitectContextSection } from '../src/orchestrator/agents/planner-prompts.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { copySpecToArchive } from '../src/cli/commands/archive.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

// ── TC1: deriveBundlePath filename-derivation rule ──────────────────────

await test('TC1: deriveBundlePath maps slug.spec.json / spec.json, and null otherwise', async () => {
  assert.strictEqual(
    deriveBundlePath('/some/dir/foo.spec.json'),
    '/some/dir/foo.bundle.json',
    "'<dir>/foo.spec.json' should map to '<dir>/foo.bundle.json'",
  );
  assert.strictEqual(
    deriveBundlePath('/some/dir/spec.json'),
    '/some/dir/bundle.json',
    "'<dir>/spec.json' should map to '<dir>/bundle.json'",
  );

  // Non-'spec.json' basename → null.
  assert.strictEqual(
    deriveBundlePath('/some/dir/foo.json'),
    null,
    "a basename not ending in 'spec.json' should return null",
  );
  assert.strictEqual(
    deriveBundlePath('/some/dir/spec.json.bak'),
    null,
    "a basename that does not end with the literal 'spec.json' should return null",
  );

  // Falsy / non-string input → null.
  assert.strictEqual(deriveBundlePath(null), null, 'null input should return null');
  assert.strictEqual(deriveBundlePath(undefined), null, 'undefined input should return null');
  assert.strictEqual(deriveBundlePath(''), null, 'empty string input should return null');
  assert.strictEqual(deriveBundlePath(0), null, '0 input should return null');
  assert.strictEqual(deriveBundlePath(123), null, 'non-string (number) input should return null');
  assert.strictEqual(deriveBundlePath({}), null, 'non-string (object) input should return null');
});

// ── TC2: schema-valid v0 bundle with resolving evidence anchors ─────────

await test('TC2: readBundle returns a schema-valid v0 bundle with all entries, no drops, null rejectionReason', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc2-'));
  try {
    const specPath = path.join(tmpDir, 'foo.spec.json');
    const bundlePath = path.join(tmpDir, 'foo.bundle.json');
    const evidenceRelPath = 'evidence.js';
    const evidenceAbsPath = path.join(tmpDir, evidenceRelPath);

    fs.writeFileSync(specPath, JSON.stringify({ id: 'foo' }, null, 2));
    fs.writeFileSync(evidenceAbsPath, 'function foo() {}\n');

    const sourceBundle = {
      schemaVersion: 1,
      generatedBy: 'test-harness',
      baseCommit: 'abc123',
      entries: [
        {
          id: 'e1',
          kind: 'note',
          text: 'Something worth recording',
          evidence: [{ file: evidenceRelPath, symbol: 'function foo' }],
          lastScannedCommit: 'abc123',
        },
        {
          id: 'e2',
          kind: 'note',
          text: 'Another entry with no symbol anchor',
          evidence: [{ file: evidenceRelPath }],
        },
      ],
    };
    fs.writeFileSync(bundlePath, JSON.stringify(sourceBundle, null, 2));

    const result = readBundle(specPath, tmpDir);

    assert.ok(result.bundle !== null, 'bundle should be non-null for a schema-valid v0 bundle');
    assert.deepStrictEqual(result.bundle, sourceBundle, 'bundle should equal the parsed source bundle');
    assert.strictEqual(result.entries.length, sourceBundle.entries.length, 'entries should contain every source entry');
    for (const sourceEntry of sourceBundle.entries) {
      assert.ok(
        result.entries.some((e) => e.id === sourceEntry.id),
        `entries should contain the source entry with id '${sourceEntry.id}'`,
      );
    }
    assert.deepStrictEqual(result.dropped, [], 'dropped should be an empty array');
    assert.strictEqual(result.rejectionReason, null, 'rejectionReason should be null');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC3: entry violates the v0 entry shape → whole-bundle rejection ─────

await test('TC3: readBundle rejects the whole bundle when an entry violates the v0 entry shape, and warns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc3-'));
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => {
    warnCalls.push(args);
  };
  try {
    const specPath = path.join(tmpDir, 'bad.spec.json');
    const bundlePath = path.join(tmpDir, 'bad.bundle.json');

    fs.writeFileSync(specPath, JSON.stringify({ id: 'bad' }, null, 2));

    const invalidBundle = {
      schemaVersion: 1,
      generatedBy: 'test-harness',
      baseCommit: 'abc123',
      entries: [
        {
          id: 'e1',
          kind: 'note',
          text: 'Malformed entry',
          // Violates the v0 entry shape: evidence must be an array.
          evidence: 'not-an-array',
        },
      ],
    };
    fs.writeFileSync(bundlePath, JSON.stringify(invalidBundle, null, 2));

    const result = readBundle(specPath, tmpDir);

    assert.strictEqual(result.bundle, null, 'bundle should be null when an entry violates the v0 entry shape');
    assert.deepStrictEqual(result.entries, [], 'entries should be an empty array');
    assert.ok(
      typeof result.rejectionReason === 'string' && result.rejectionReason.length > 0,
      'rejectionReason should be a non-null, non-empty string',
    );
    assert.ok(warnCalls.length >= 1, 'console.warn should be called at least once');
  } finally {
    console.warn = originalWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Shared fixture helper for TC4-TC9 (gate behavior against a tmp root) ─

function writeGateFixture(tmpDir, bundleObjOrRaw) {
  const specPath = path.join(tmpDir, 'g.spec.json');
  const bundlePath = path.join(tmpDir, 'g.bundle.json');
  fs.writeFileSync(specPath, JSON.stringify({ id: 'g' }, null, 2));
  if (bundleObjOrRaw !== undefined) {
    const raw = typeof bundleObjOrRaw === 'string' ? bundleObjOrRaw : JSON.stringify(bundleObjOrRaw, null, 2);
    fs.writeFileSync(bundlePath, raw);
  }
  return { specPath, bundlePath };
}

function withCapturedWarn(fn) {
  const originalWarn = console.warn;
  const warnCalls = [];
  console.warn = (...args) => { warnCalls.push(args.join(' ')); };
  const restore = () => { console.warn = originalWarn; };
  return fn(warnCalls, restore);
}

// ── TC4: evidence anchor to a missing file → that entry dropped, sibling survives ──

await test('TC4: readBundle drops an entry whose evidence file is missing, keeps the resolving sibling, records {id, reason}, warns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc4-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      fs.writeFileSync(path.join(tmpDir, 'present.js'), 'function present() {}\n');
      const { specPath } = writeGateFixture(tmpDir, {
        schemaVersion: 1,
        generatedBy: 'test-harness',
        baseCommit: 'abc123',
        entries: [
          { id: 'keep', kind: 'note', text: 'anchored to a real file', evidence: [{ file: 'present.js' }] },
          { id: 'drop', kind: 'note', text: 'anchored to a ghost', evidence: [{ file: 'nonexistent.js' }] },
        ],
      });

      const result = readBundle(specPath, tmpDir);

      assert.ok(result.bundle !== null, 'a per-entry drop must NOT reject the bundle whole');
      assert.strictEqual(result.rejectionReason, null, 'rejectionReason must stay null on a per-entry drop');
      assert.strictEqual(result.entries.length, 1, 'exactly the resolving entry should survive');
      assert.strictEqual(result.entries[0].id, 'keep', "the surviving entry should be 'keep'");
      assert.strictEqual(result.dropped.length, 1, 'exactly one entry should be dropped');
      assert.strictEqual(result.dropped[0].id, 'drop', "the dropped record should carry id 'drop'");
      assert.ok(
        typeof result.dropped[0].reason === 'string' && result.dropped[0].reason.includes('nonexistent.js'),
        'the dropped reason should name the unresolvable evidence file',
      );
      assert.ok(warnCalls.some((w) => w.includes('drop')), 'a console.warn should name the dropped entry id');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC5: evidence anchor whose symbol no longer matches → entry dropped ──

await test('TC5: readBundle drops an entry whose evidence symbol is absent from the (existing) file, keeps the sibling', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc5-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      fs.writeFileSync(path.join(tmpDir, 'code.js'), 'function realSymbol() {}\n');
      const { specPath } = writeGateFixture(tmpDir, {
        schemaVersion: 1,
        generatedBy: 'test-harness',
        baseCommit: 'abc123',
        entries: [
          { id: 'keep', kind: 'note', text: 'symbol still present', evidence: [{ file: 'code.js', symbol: 'realSymbol' }] },
          { id: 'stale', kind: 'note', text: 'symbol was renamed away', evidence: [{ file: 'code.js', symbol: 'vanishedSymbol' }] },
        ],
      });

      const result = readBundle(specPath, tmpDir);

      assert.ok(result.bundle !== null, 'a symbol-miss drop must NOT reject the bundle whole');
      assert.strictEqual(result.entries.length, 1, 'exactly the symbol-resolving entry should survive');
      assert.strictEqual(result.entries[0].id, 'keep', "the surviving entry should be 'keep'");
      assert.strictEqual(result.dropped.length, 1, 'exactly one entry should be dropped');
      assert.strictEqual(result.dropped[0].id, 'stale', "the dropped record should carry id 'stale'");
      assert.ok(
        result.dropped[0].reason.includes('vanishedSymbol'),
        'the dropped reason should name the missing symbol',
      );
      assert.ok(warnCalls.length >= 1, 'console.warn should be called for the dropped entry');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC6: oversized bundle → whole rejection, never truncated ─────────────

await test('TC6: readBundle rejects an oversized bundle WHOLE (no truncation), naming bundleMaxBytes, and warns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc6-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      const cap = config.architect.bundleMaxBytes;
      assert.ok(Number.isFinite(cap) && cap > 0, 'config.architect.bundleMaxBytes should be a positive finite number');
      // A file strictly larger than the cap; content validity is irrelevant —
      // the size check must fire before any parse.
      const oversized = '{"schemaVersion":1,"generatedBy":"x","baseCommit":"y","entries":[]}' + ' '.repeat(cap);
      const { specPath } = writeGateFixture(tmpDir, oversized);

      const result = readBundle(specPath, tmpDir);

      assert.strictEqual(result.bundle, null, 'oversized bundle must be rejected whole');
      assert.deepStrictEqual(result.entries, [], 'no entries may survive an oversized rejection (no truncation)');
      assert.ok(
        result.rejectionReason.includes('bundleMaxBytes'),
        'rejectionReason should name the bundleMaxBytes cap',
      );
      assert.ok(warnCalls.length >= 1, 'console.warn should be called for the oversized rejection');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC7: unparseable JSON → whole rejection, fail-open shape ─────────────

await test('TC7: readBundle rejects an unparseable-JSON bundle whole, returning the no-bundle result shape without throwing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc7-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      const { specPath } = writeGateFixture(tmpDir, '{ this is not JSON ]');

      let result;
      let thrown = null;
      try {
        result = readBundle(specPath, tmpDir);
      } catch (err) {
        thrown = err;
      }

      assert.strictEqual(thrown, null, 'readBundle must not throw on unparseable JSON (fail-open)');
      assert.strictEqual(result.bundle, null, 'bundle must be null');
      assert.deepStrictEqual(result.entries, [], 'entries must be empty');
      assert.ok(
        result.rejectionReason.toLowerCase().includes('parseable'),
        'rejectionReason should say the file is not parseable JSON',
      );
      assert.ok(warnCalls.length >= 1, 'console.warn should be called');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC8: wrong schemaVersion → whole rejection ───────────────────────────

await test('TC8: readBundle rejects a bundle with schemaVersion !== 1 whole, naming schemaVersion in the reason', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc8-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      const { specPath } = writeGateFixture(tmpDir, {
        schemaVersion: 2,
        generatedBy: 'future-architect',
        baseCommit: 'abc123',
        entries: [],
      });

      const result = readBundle(specPath, tmpDir);

      assert.strictEqual(result.bundle, null, 'unknown schemaVersion must reject the bundle whole');
      assert.deepStrictEqual(result.entries, [], 'entries must be empty');
      assert.ok(
        result.rejectionReason.includes('schemaVersion'),
        'rejectionReason should name schemaVersion',
      );
      assert.ok(warnCalls.length >= 1, 'console.warn should be called');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC9: no bundle file at all → silent no-bundle result, zero warns ─────

await test('TC9: readBundle with no bundle file present returns the silent no-bundle shape with zero warns', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gate-tc9-'));
  await withCapturedWarn(async (warnCalls, restore) => {
    try {
      const { specPath } = writeGateFixture(tmpDir, undefined); // no bundle written

      const result = readBundle(specPath, tmpDir);

      assert.strictEqual(result.bundle, null, 'bundle must be null when no file exists');
      assert.deepStrictEqual(result.entries, [], 'entries must be empty');
      assert.deepStrictEqual(result.dropped, [], 'dropped must be empty');
      assert.strictEqual(result.rejectionReason, null, 'a missing file is NOT a rejection');
      assert.strictEqual(warnCalls.length, 0, 'a missing bundle file must not warn — it is the normal no-Pro path');
    } finally {
      restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TC10: buildArchitectContextSection rendering + zero-character emptiness ──

await test('TC10: buildArchitectContextSection renders surviving entries with anchors, and contributes ZERO characters for absent/empty input', async () => {
  const section = buildArchitectContextSection([
    { id: 'e1', kind: 'semantic', text: 'The config loader is fail-loud', evidence: [{ file: 'src/orchestrator/infra/project-config.js', symbol: 'TOP_LEVEL_KEYS' }] },
    { id: 'e2', kind: 'note', text: 'No anchors on this one' },
  ]);

  assert.ok(section.includes('## Architect context'), 'section should carry the Architect context heading');
  assert.ok(section.includes('ADVISORY'), 'section should frame entries as advisory');
  assert.ok(section.includes('[semantic] The config loader is fail-loud'), 'entry line should render [kind] text');
  assert.ok(
    section.includes('src/orchestrator/infra/project-config.js (TOP_LEVEL_KEYS)'),
    'evidence anchor should render as file (symbol)',
  );
  assert.ok(section.includes('[note] No anchors on this one'), 'an entry without evidence should still render');

  // Byte-identity root: every empty-ish input contributes the EMPTY STRING —
  // zero characters, not an empty heading.
  assert.strictEqual(buildArchitectContextSection(undefined), '', 'undefined → empty string');
  assert.strictEqual(buildArchitectContextSection(null), '', 'null → empty string');
  assert.strictEqual(buildArchitectContextSection([]), '', 'empty array → empty string');
  assert.strictEqual(buildArchitectContextSection('nope'), '', 'non-array → empty string');
  assert.strictEqual(
    buildArchitectContextSection([{ notAnEntry: true }]),
    '',
    'array with no surviving element → empty string',
  );
});

// ── Fake session plumbing for TC11/TC12 (mirrors test-planner-constraints-injection.js) ──

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-bundle-gate-planner.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

function makeFakeGlobalSessionManager(capturedSystem, capturedUser) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      milestones: [
        {
          id: '001',
          description: 'Deliver the feature',
          missions: [
            { id: '001-001', description: 'Implement the module', targetFiles: ['src/foo.js'] },
          ],
        },
      ],
      assumptions: [],
    },
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
  };
  return {
    spawn(opts) {
      capturedSystem.push(opts.systemPrompt);
      capturedUser.push(opts.prompt);
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      capturedSystem.push(opts.systemPrompt);
      let turnCount = 0;
      return {
        handle: fakeHandle,
        get turnCount() { return turnCount; },
        sendPrompt: async (prompt) => {
          capturedUser.push(prompt);
          turnCount++;
          return fakeResult;
        },
        close: async () => {},
      };
    },
  };
}

function makeFakeReusableSessionManager(capturedTurnPrompts) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: { subMissions: [], milestones: [] },
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
  };
  return {
    spawn() {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable() {
      let turnCount = 0;
      return {
        handle: fakeHandle,
        get turnCount() { return turnCount; },
        sendPrompt: async (prompt) => {
          capturedTurnPrompts.push(prompt);
          turnCount++;
          return fakeResult;
        },
        close: async () => {},
      };
    },
  };
}

const ARCHITECT_ENTRIES = [
  { id: 'a1', kind: 'semantic', text: 'planGlobal should see this claim', evidence: [] },
];

// ── TC11: planGlobal — injection reaches the real user prompt; no-bundle byte-identity ──

await test('TC11: planGlobal with architectEntries injects the section into the USER prompt only; absent vs [] prompts are byte-identical', async () => {
  // With entries: section present in the user prompt, absent from the system prompt.
  const sysWith = [];
  const userWith = [];
  const withPlanner = new Planner(makeFakeGlobalSessionManager(sysWith, userWith), makeFakeLogger(), { recordSession: async () => {} });
  await withPlanner.planGlobal('test goal', '/fake/root', { architectEntries: ARCHITECT_ENTRIES });

  assert.ok(userWith.length >= 1, 'planGlobal should have sent a user prompt');
  assert.ok(userWith[0].includes('## Architect context'), 'user prompt should contain the Architect context section');
  assert.ok(userWith[0].includes('planGlobal should see this claim'), 'user prompt should contain the entry text');
  assert.ok(!sysWith[0].includes('## Architect context'), 'system prompt must NOT contain the Architect context section');

  // Byte-identity: opts WITHOUT the field vs opts with an EMPTY array.
  const sysAbsent = [];
  const userAbsent = [];
  const absentPlanner = new Planner(makeFakeGlobalSessionManager(sysAbsent, userAbsent), makeFakeLogger(), { recordSession: async () => {} });
  await absentPlanner.planGlobal('test goal', '/fake/root');

  const sysEmpty = [];
  const userEmpty = [];
  const emptyPlanner = new Planner(makeFakeGlobalSessionManager(sysEmpty, userEmpty), makeFakeLogger(), { recordSession: async () => {} });
  await emptyPlanner.planGlobal('test goal', '/fake/root', { architectEntries: [] });

  assert.strictEqual(userAbsent[0], userEmpty[0], 'user prompts with the field absent vs [] must be byte-identical');
  assert.ok(!userAbsent[0].includes('## Architect context'), 'no-bundle user prompt must not contain the section');
});

// ── TC12: planMission — injection reaches the real turn prompt; no-bundle byte-identity ──

await test('TC12: planMission with context.architectEntries injects the section into the turn prompt; absent vs [] prompts are byte-identical', async () => {
  const withPrompts = [];
  const withPlanner = new Planner(makeFakeReusableSessionManager(withPrompts), makeFakeLogger(), { recordSession: async () => {} });
  await withPlanner.planMission('001-001', '/fake/root', {
    missionPlan: 'The mission plan text',
    architectEntries: ARCHITECT_ENTRIES,
  });

  assert.equal(withPrompts.length, 1, 'sendPrompt() should have been called exactly once');
  assert.ok(withPrompts[0].includes('## Architect context'), 'turn prompt should contain the Architect context section');
  assert.ok(withPrompts[0].includes('planGlobal should see this claim'), 'turn prompt should contain the entry text');

  const absentPrompts = [];
  const absentPlanner = new Planner(makeFakeReusableSessionManager(absentPrompts), makeFakeLogger(), { recordSession: async () => {} });
  await absentPlanner.planMission('001-001', '/fake/root', { missionPlan: 'The mission plan text' });

  const emptyPrompts = [];
  const emptyPlanner = new Planner(makeFakeReusableSessionManager(emptyPrompts), makeFakeLogger(), { recordSession: async () => {} });
  await emptyPlanner.planMission('001-001', '/fake/root', { missionPlan: 'The mission plan text', architectEntries: [] });

  assert.strictEqual(absentPrompts[0], emptyPrompts[0], 'turn prompts with the field absent vs [] must be byte-identical');
  assert.ok(!absentPrompts[0].includes('## Architect context'), 'no-bundle turn prompt must not contain the section');
});

// ── Fixture data for TC13/TC14 (dryRunValidate bundle carriage) ─────────
// Mirrors the mocked-planner Pipeline.dryRunValidate fixture idiom of
// test/test-queue-spec-json.js TC3a.

const SPEC_MD = `# Test Spec

This is a test spec for the bundle carriage gate.

## Goals
- Build something useful
`;

const cannedGlobalPlan = {
  milestones: [
    {
      id: '001',
      description: 'Test milestone',
      missions: [{ id: '001-001', description: 'Test mission one' }],
    },
  ],
  assumptions: [],
  scopeItems: [],
  scopeMapping: [],
};

function makeTmpRoot(prefix = 'cc-orch-bundle-gate-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Mirrors makeDryRunPipeline() in test/test-queue-spec-json.js — a mocked-
// planner Pipeline wired for dryRunValidate, with an optional sibling
// spec.json and/or sibling bundle.json written alongside the spec.md.
function makeDryRunPipeline(opts = {}) {
  const tmpDir = makeTmpRoot();

  const specFilename = opts.specFilename || 'gated.spec.md';
  const specPath = path.join(tmpDir, specFilename);
  fs.writeFileSync(specPath, opts.specContent || SPEC_MD);

  const specJsonPath = specPath.replace(/\.md$/, '.json');
  fs.writeFileSync(specJsonPath, opts.specJsonContent || '{"goal": "bundle carriage"}\n');

  const bundlePath = specJsonPath.replace(/spec\.json$/, 'bundle.json');
  if (opts.bundleContent !== undefined) {
    fs.writeFileSync(bundlePath, opts.bundleContent);
  }

  const logs = [];
  const pipeline = new Pipeline(tmpDir, {
    dryRun: true,
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  pipeline.planner.planGlobal = async () => JSON.parse(JSON.stringify(cannedGlobalPlan));
  pipeline.planner.planMission = async () => {
    throw new Error('planMission must NOT be called in dryRunValidate');
  };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};

  return { tmpDir, specPath, specJsonPath, bundlePath, pipeline, logs };
}

// ── TC13: dry-run finalize copies the bundle sibling byte-identically ───

await test('TC13: dryRunValidate (mocked planner) copies the sibling bundle into queue/<slug>/bundle.json byte-identically', async () => {
  const distinctiveBundleJson = '{\n  "schemaVersion": 1,\n  "generatedBy": "test-harness",\n  "baseCommit": "abc123",\n  "entries":  []\n}\n';
  const { tmpDir, pipeline } = makeDryRunPipeline({
    specFilename: 'gated.spec.md',
    bundleContent: distinctiveBundleJson,
  });
  try {
    const result = await pipeline.dryRunValidate('Implement gated spec', { prdPath: path.join(tmpDir, 'gated.spec.md') });
    assert.ok(!result || result.queued !== false, 'dryRunValidate should not report a rejected queue');

    const slug = 'gated.spec';
    const queueBundle = path.join(tmpDir, 'queue', slug, 'bundle.json');
    assert.ok(fs.existsSync(queueBundle), `queue/${slug}/bundle.json should exist`);
    assert.strictEqual(
      fs.readFileSync(queueBundle, 'utf8'),
      distinctiveBundleJson,
      'queue bundle.json must be byte-identical to the source sibling bundle file'
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC14: dry-run finalize with no sibling bundle is a silent no-op ─────

await test('TC14: dryRunValidate (mocked planner) with no sibling bundle creates no queue/<slug>/bundle.json and throws nothing', async () => {
  const { tmpDir, pipeline } = makeDryRunPipeline({
    specFilename: 'nobundle.spec.md',
    // No bundleContent — no sibling bundle file is written.
  });
  try {
    let thrown = null;
    let result;
    try {
      result = await pipeline.dryRunValidate('Implement spec with no bundle', { prdPath: path.join(tmpDir, 'nobundle.spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, null, 'dryRunValidate must not throw when there is no sibling bundle');
    assert.ok(!result || result.queued !== false, 'dryRunValidate should not report a rejected queue');

    const slug = 'nobundle.spec';
    const queueBundle = path.join(tmpDir, 'queue', slug, 'bundle.json');
    assert.strictEqual(fs.existsSync(queueBundle), false, `queue/${slug}/bundle.json should NOT exist`);
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC15: copySpecToArchive carries the sibling bundle byte-identically ─

await test('TC15: copySpecToArchive writes <archiveDir>/bundle.json byte-identical to the sibling bundle', async () => {
  const tmpDir = makeTmpRoot();
  try {
    const specPath = path.join(tmpDir, 'archived.spec.md');
    const specJsonPath = path.join(tmpDir, 'archived.spec.json');
    const bundlePath = path.join(tmpDir, 'archived.bundle.json');
    const distinctiveBundleJson = '{\n  "schemaVersion": 1,\n  "generatedBy": "archive-test",\n  "baseCommit": "abc123",\n  "entries":  []\n}\n';

    fs.writeFileSync(specPath, SPEC_MD);
    fs.writeFileSync(specJsonPath, '{"goal": "archive carriage"}\n');
    fs.writeFileSync(bundlePath, distinctiveBundleJson);

    const archiveDir = path.join(tmpDir, 'archives', '001-archived');
    fs.mkdirSync(archiveDir, { recursive: true });

    copySpecToArchive(specPath, tmpDir, archiveDir, /* preserveMode */ true);

    const archivedBundle = path.join(archiveDir, 'bundle.json');
    assert.ok(fs.existsSync(archivedBundle), 'archiveDir/bundle.json should exist');
    assert.strictEqual(
      fs.readFileSync(archivedBundle, 'utf8'),
      distinctiveBundleJson,
      'archived bundle.json must be byte-identical to the source sibling bundle file'
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC16: copySpecToArchive with no sibling bundle is a silent no-op ────

await test('TC16: copySpecToArchive with no sibling bundle creates no <archiveDir>/bundle.json and throws nothing', async () => {
  const tmpDir = makeTmpRoot();
  try {
    const specPath = path.join(tmpDir, 'nobundle-archived.spec.md');
    const specJsonPath = path.join(tmpDir, 'nobundle-archived.spec.json');

    fs.writeFileSync(specPath, SPEC_MD);
    fs.writeFileSync(specJsonPath, '{"goal": "no bundle here"}\n');
    // Deliberately no sibling bundle file written.

    const archiveDir = path.join(tmpDir, 'archives', '002-nobundle');
    fs.mkdirSync(archiveDir, { recursive: true });

    let thrown = null;
    try {
      copySpecToArchive(specPath, tmpDir, archiveDir, /* preserveMode */ true);
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, null, 'copySpecToArchive must not throw when there is no sibling bundle');

    const archivedBundle = path.join(archiveDir, 'bundle.json');
    assert.strictEqual(fs.existsSync(archivedBundle), false, 'archiveDir/bundle.json should NOT exist');
  } finally {
    cleanup(tmpDir);
  }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
