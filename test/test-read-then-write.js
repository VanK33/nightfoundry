/**
 * test-read-then-write.js — Unit tests for read-before-write guard in session-manager.js.
 *
 * Covers:
 *   1. Edit on existing file without prior Read → denied ({ behavior: 'deny' })
 *   2. Edit on existing file after Read → allowed ({ behavior: 'allow' })
 *   3. Write to non-existent file → allowed without Read
 *   4. canUseTool('Read') closure adds file_path to SessionHandle._readFiles
 *   5. Sequential canUseTool('Read') then canUseTool('Edit') on same path → Edit allowed
 *
 * Mocks fs.existsSync to control whether files appear to exist on disk.
 *
 * Run: node test/test-read-then-write.js
 */
import assert from 'assert';
import { createRequire } from 'module';
import { SessionHandle, SessionManager } from '../src/orchestrator/infra/session-manager.js';

// --- Mock fs.existsSync ---
// We monkey-patch the 'fs' module that session-manager.js imports at runtime.
// Node caches require() calls, so modifying the cached exports object is the
// standard way to stub synchronous CommonJS-style calls from ESM. If
// session-manager uses `import { existsSync } from 'fs'` (a live binding),
// we instead reach into the module via createRequire and mutate the property.
// The guard tests flip this per-scenario.
const require = createRequire(import.meta.url);
const fsModule = require('fs');
const _originalExistsSync = fsModule.existsSync;

function mockExistsSync(result) {
  fsModule.existsSync = () => result;
}

function restoreExistsSync() {
  fsModule.existsSync = _originalExistsSync;
}

// --- Test harness ---
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

// ---------------------------------------------------------------------------
// Test 1: Edit on existing file without Read → denied
//
// NB (write-boundary contract update): the previous fixture paired
// targetFiles ['src/foo.js'] with file_path '/project/src/foo.js' and
// relied on the old substring/suffix acceptance to reach the
// read-before-write leg. The new D2 requires exact resolved equality,
// so the fixture uses the same absolute path for both the declared
// targetFile and the tool call — the read-before-write denial still
// short-circuits, but via the correct semantics.
// ---------------------------------------------------------------------------
await test('Edit on existing file without Read → { behavior: "deny" }', () => {
  mockExistsSync(true); // file exists on disk
  try {
    const sm = new SessionManager();
    const readFiles = new Set(); // empty — nothing has been read
    const filePath = '/project/src/foo.js';
    const result = sm._guardToolUse(
      'Edit',
      { file_path: filePath },
      /* targetFiles */ [filePath],
      readFiles,
    );
    assert.strictEqual(
      result?.behavior,
      'deny',
      `Expected behavior 'deny', got ${JSON.stringify(result)}`,
    );
  } finally {
    restoreExistsSync();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Edit on existing file after Read → allowed
// (see Test 1 note re: absolute-matching update for D2 exact-equality.)
// ---------------------------------------------------------------------------
await test('Edit on existing file after Read → { behavior: "allow" }', () => {
  mockExistsSync(true); // file exists on disk
  try {
    const sm = new SessionManager();
    const filePath = '/project/src/foo.js';
    const readFiles = new Set([filePath]); // already read
    const result = sm._guardToolUse(
      'Edit',
      { file_path: filePath },
      /* targetFiles */ [filePath],
      readFiles,
    );
    assert.strictEqual(
      result?.behavior,
      'allow',
      `Expected behavior 'allow', got ${JSON.stringify(result)}`,
    );
  } finally {
    restoreExistsSync();
  }
});

// ---------------------------------------------------------------------------
// Test 3: Write to non-existent file → allowed without Read
// (see Test 1 note re: absolute-matching update for D2 exact-equality.)
// ---------------------------------------------------------------------------
await test('Write to non-existent file → { behavior: "allow" } without prior Read', () => {
  mockExistsSync(false); // file does NOT exist on disk
  try {
    const sm = new SessionManager();
    const readFiles = new Set(); // nothing read
    const filePath = '/project/src/new-file.js';
    const result = sm._guardToolUse(
      'Write',
      { file_path: filePath },
      /* targetFiles */ [filePath],
      readFiles,
    );
    assert.strictEqual(
      result?.behavior,
      'allow',
      `Expected behavior 'allow' for new file, got ${JSON.stringify(result)}`,
    );
  } finally {
    restoreExistsSync();
  }
});

// ---------------------------------------------------------------------------
// Test 4: canUseTool('Read') closure adds file_path to SessionHandle._readFiles
// ---------------------------------------------------------------------------
await test('canUseTool("Read") adds file_path to SessionHandle._readFiles', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-read-tracking');

  // _buildSdkOptions wires up canUseTool; we pass the handle's _readFiles Set
  const sdkOpts = sm._buildSdkOptions(
    { targetFiles: ['src/bar.js'] },
    handle._readFiles,
  );

  assert.strictEqual(
    typeof sdkOpts.canUseTool,
    'function',
    'canUseTool should be a function on sdkOpts',
  );

  assert.strictEqual(handle._readFiles.size, 0, 'Should start with empty _readFiles');

  // Simulate the SDK calling canUseTool for a Read
  sdkOpts.canUseTool('Read', { file_path: '/project/src/bar.js' });

  assert.ok(
    handle._readFiles.has('/project/src/bar.js'),
    `Expected '/project/src/bar.js' in _readFiles; got: ${JSON.stringify([...handle._readFiles])}`,
  );
});

// ---------------------------------------------------------------------------
// Test 5: Sequential canUseTool('Read') then canUseTool('Edit') → Edit allowed
// ---------------------------------------------------------------------------
await test('Sequential canUseTool("Read") then canUseTool("Edit") on same path → Edit allowed', () => {
  mockExistsSync(true); // file exists on disk
  try {
    const sm = new SessionManager();
    const handle = new SessionHandle('test-read-then-edit');

    // Pass an explicit cwd so the fixture path resolves INSIDE the session
    // root — the write-boundary guard (D1) now denies Edit/Write whose
    // resolved abs path is outside `cwd`. The previous form
    // (targetFiles: ['src/baz.js'], no cwd, file_path: '/project/src/baz.js')
    // pinned the old substring/suffix looseness that accepted an
    // out-of-cwd absolute path via `endsWith`; the new contract requires
    // in-root + exact resolved equality.
    const sdkOpts = sm._buildSdkOptions(
      { targetFiles: ['src/baz.js'], cwd: '/project' },
      handle._readFiles,
    );

    const filePath = '/project/src/baz.js';

    // Step 1: Read the file — closure should add it to _readFiles
    const readResult = sdkOpts.canUseTool('Read', { file_path: filePath });
    // Read itself should be allowed
    assert.strictEqual(
      readResult?.behavior,
      'allow',
      `Expected Read to be allowed; got ${JSON.stringify(readResult)}`,
    );
    assert.ok(
      handle._readFiles.has(filePath),
      'File should be tracked in _readFiles after Read',
    );

    // Step 2: Edit the same file — now pre-approved because it was read
    const editResult = sdkOpts.canUseTool('Edit', { file_path: filePath });
    assert.strictEqual(
      editResult?.behavior,
      'allow',
      `Expected Edit to be allowed after Read; got ${JSON.stringify(editResult)}`,
    );
  } finally {
    restoreExistsSync();
  }
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
