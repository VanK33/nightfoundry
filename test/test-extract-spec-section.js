#!/usr/bin/env node

/**
 * test-extract-spec-section.js — Unit tests for Pipeline#_extractSpecSection
 * added to Pipeline in task 001-002-001-002.
 *
 * Uses Object.create(Pipeline.prototype) to exercise the method without
 * invoking the heavy constructor (same pattern as test-agent-ticker.js).
 *
 * Run: node test/test-extract-spec-section.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────

function makeStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);
  const logCalls = [];
  stub.onLog = (msg) => logCalls.push(msg);
  stub._logCalls = logCalls;
  Object.assign(stub, overrides);
  return stub;
}

/**
 * Write content to a temp file and return its path.
 * The file is cleaned up automatically via the returned cleanup fn.
 */
function writeTempSpec(content) {
  const tmpDir = os.tmpdir();
  const specPath = path.join(tmpDir, `test-extract-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(specPath, content, 'utf8');
  return {
    specPath,
    cleanup: () => { try { fs.unlinkSync(specPath); } catch { /* ignore */ } },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

await test('TC1: markdown ## heading exact match returns section content', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Goal\nThis is the goal content.\n\n## Other\nOther content.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Goal');
    assert.ok(result !== null, 'result should not be null');
    assert.ok(result.includes('## Goal'), 'result should include the heading');
    assert.ok(result.includes('This is the goal content.'), 'result should include the section body');
  } finally {
    cleanup();
  }
});

await test('TC2: bullet-bold "- **Goal:** ..." exact match returns content', () => {
  const { specPath, cleanup } = writeTempSpec(
    '- **Goal:** Deliver a working prototype.\n- **Scenarios:** Many scenarios here.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Goal');
    assert.ok(result !== null, 'result should not be null');
    assert.ok(result.includes('**Goal:**'), 'result should include the bullet-bold heading');
    assert.ok(result.includes('Deliver a working prototype.'), 'result should include the bullet content');
  } finally {
    cleanup();
  }
});

await test('TC3: bullet-bold substring match — "Session API" matches "- **Session API design:**"', () => {
  const { specPath, cleanup } = writeTempSpec(
    '- **Session API design:** Describes how the session API works.\n- **Other:** Something else.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Session API');
    assert.ok(result !== null, 'result should not be null for substring match');
    assert.ok(result.includes('**Session API design:**'), 'result should include the matched bullet heading');
    assert.ok(result.includes('Describes how the session API works.'), 'result should include bullet content');
  } finally {
    cleanup();
  }
});

await test('TC4: miss triggers onLog warning containing "[extractSpecSection]", sectionName and specPath', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Introduction\nSome intro text.\n\n## Background\nBackground info.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'NonExistentSection');
    assert.strictEqual(result, null, 'result should be null on miss');
    assert.ok(stub._logCalls.length > 0, 'onLog should have been called');
    const warningMsg = stub._logCalls.find((msg) => msg.includes('[extractSpecSection]'));
    assert.ok(warningMsg !== undefined, 'onLog should have been called with a message containing "[extractSpecSection]"');
    assert.ok(warningMsg.includes('NonExistentSection'), 'warning should include the sectionName');
    assert.ok(warningMsg.includes(specPath), 'warning should include the specPath');
  } finally {
    cleanup();
  }
});

await test('TC5: nonexistent file returns null without throwing', () => {
  const stub = makeStub();
  const fakeSpecPath = path.join(os.tmpdir(), 'does-not-exist-ever-12345.md');
  let result;
  assert.doesNotThrow(() => {
    result = stub._extractSpecSection(fakeSpecPath, 'Goal');
  }, 'should not throw for nonexistent file');
  assert.strictEqual(result, null, 'result should be null for nonexistent file');
});

// ── Numbered-bold family (scope-parser dialect) ─────────────────────────────

await test('TC6: numbered-bold exact label match returns the item body incl. sublist, not the next item', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Scope — in\n' +
    '1. **Alpha endpoint** — does A things.\n' +
    '   - src/alpha/path.js\n' +
    '2. **Beta page** — does B things.\n' +
    '3. **Gamma knobs** — does C things.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Alpha endpoint');
    assert.ok(result !== null, 'result should not be null for exact numbered-bold match');
    assert.ok(result.includes('**Alpha endpoint**'), 'result should include the numbered-bold label');
    assert.ok(result.includes('does A things.'), 'result should include the item-1 inline body');
    assert.ok(result.includes('src/alpha/path.js'), 'result should include the indented sublist line');
    assert.ok(!result.includes('does B things.'), 'result should NOT include item-2 body');
  } finally {
    cleanup();
  }
});

await test('TC7: numbered-bold boundary stops before the next markdown heading', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Scope — in\n' +
    '1. **Alpha endpoint** — does A things.\n' +
    '2. **Gamma knobs** — does C things.\n' +
    '   - src/gamma/path.js\n' +
    '\n' +
    '## Scope — out\n' +
    'Things that are explicitly out of scope.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Gamma knobs');
    assert.ok(result !== null, 'result should not be null');
    assert.ok(result.includes('**Gamma knobs**'), 'result should include the last item label');
    assert.ok(result.includes('src/gamma/path.js'), 'result should include the last item body');
    assert.ok(!result.includes('## Scope — out'), 'result should stop before the next heading');
    assert.ok(!result.includes('Things that are explicitly out of scope.'), 'result should not spill into the next section');
  } finally {
    cleanup();
  }
});

await test('TC8: numbered-bold substring match — "Beta" matches "2. **Beta page**"', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Scope — in\n' +
    '1. **Alpha endpoint** — does A things.\n' +
    '2. **Beta page** — does B things.\n' +
    '3. **Gamma knobs** — does C things.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Beta');
    assert.ok(result !== null, 'result should not be null for substring numbered-bold match');
    assert.ok(result.includes('**Beta page**'), 'result should include the matched item label');
    assert.ok(result.includes('does B things.'), 'result should include item-2 body');
    assert.ok(!result.includes('does A things.'), 'result should not include item-1 body');
  } finally {
    cleanup();
  }
});

await test('TC9: numbered-bold word-overlap match — "endpoint aggregation Alpha" matches "Alpha endpoint"', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Scope — in\n' +
    '1. **Alpha endpoint** — does A things.\n' +
    '2. **Beta page** — does B things.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'endpoint aggregation Alpha');
    assert.ok(result !== null, 'result should not be null for word-overlap numbered-bold match');
    assert.ok(result.includes('**Alpha endpoint**'), 'result should include the word-overlap-matched item label');
    assert.ok(result.includes('does A things.'), 'result should include item-1 body');
    assert.ok(!result.includes('does B things.'), 'result should not include item-2 body');
  } finally {
    cleanup();
  }
});

await test('TC10: precedence — a real ## heading wins over a same-named numbered-bold item', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Alpha endpoint\n' +
    'This is the real heading-section body.\n' +
    '\n' +
    '## Scope — in\n' +
    '1. **Alpha endpoint** — numbered-item body.\n' +
    '2. **Beta page** — does B things.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Alpha endpoint');
    assert.ok(result !== null, 'result should not be null');
    assert.ok(result.includes('This is the real heading-section body.'), 'heading family should win');
    assert.ok(!result.includes('numbered-item body.'), 'result should NOT be the numbered-bold item');
  } finally {
    cleanup();
  }
});

await test('TC11: total miss warning names all three families incl. "N. **Label**"', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Scope — in\n' +
    '1. **Alpha endpoint** — does A things.\n' +
    '2. **Beta page** — does B things.\n'
  );
  try {
    const stub = makeStub();
    const result = stub._extractSpecSection(specPath, 'Zeta nonexistent');
    assert.strictEqual(result, null, 'result should be null when all three families miss');
    const warningMsg = stub._logCalls.find((msg) => msg.includes('[extractSpecSection]'));
    assert.ok(warningMsg !== undefined, 'onLog should have been called with an extractSpecSection warning');
    assert.ok(warningMsg.includes('N. **Label**'), 'warning should name the numbered-bold family');
  } finally {
    cleanup();
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
