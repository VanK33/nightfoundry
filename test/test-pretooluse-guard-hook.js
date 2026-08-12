/**
 * test-pretooluse-guard-hook.js — The tool-use guard's PreToolUse-hook
 * enforcement path.
 *
 * Background: the session guard (_guardToolUse — targetFiles boundary,
 * read-before-edit, dangerous-Bash denial) was historically wired ONLY as
 * the SDK's canUseTool callback. Under permissionMode 'bypassPermissions'
 * the agent-sdk 0.3 line auto-approves every tool call BEFORE consulting
 * that callback (emitting CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), so the
 * upgrade silently disabled the guard at runtime. The fix wires the SAME
 * guard as a PreToolUse hook — which runs regardless of permission mode —
 * and strips canUseTool from the options actually handed to query()
 * (_toQueryOptions), so the SDK never sees a shadowed callback.
 *
 * These cases pin that wiring: the hook exists, translates guard verdicts
 * into the hook output contract (permissionDecision deny/allow +
 * updatedInput), shares read-tracking state with the guard, and
 * _toQueryOptions strips exactly canUseTool while keeping hooks.
 *
 * Run: node test/test-pretooluse-guard-hook.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';

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
    failCount++;
  }
}

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pretooluse-guard-'));
}

/** Build sdkOptions for a session rooted at cwd with the given targetFiles. */
function buildOpts(cwd, targetFiles, readFiles = new Set()) {
  const sm = new SessionManager();
  return sm._buildSdkOptions({ cwd, targetFiles }, readFiles);
}

/** Fetch the single PreToolUse hook callback off a _buildSdkOptions result. */
function hookOf(sdkOpts) {
  const matchers = sdkOpts.hooks?.PreToolUse;
  assert.ok(Array.isArray(matchers) && matchers.length === 1, 'Expected exactly one PreToolUse matcher');
  const hooks = matchers[0].hooks;
  assert.ok(Array.isArray(hooks) && hooks.length === 1 && typeof hooks[0] === 'function', 'Expected exactly one hook callback');
  return hooks[0];
}

// ── TC1: wiring shape — hook present alongside canUseTool ────────────────
await test('TC1 _buildSdkOptions carries both the PreToolUse hook and the canUseTool callback', () => {
  const root = makeTmpRoot();
  try {
    const sdkOpts = buildOpts(root, ['a.js']);
    assert.strictEqual(typeof sdkOpts.canUseTool, 'function', 'canUseTool must remain for non-bypass modes and direct-drive tests');
    hookOf(sdkOpts); // asserts shape internally
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC2: hook denies an out-of-root Write with the guard's message ───────
await test('TC2 hook denies an out-of-root Write with permissionDecision deny and the guard reason', async () => {
  const root = makeTmpRoot();
  const other = makeTmpRoot();
  try {
    const sdkOpts = buildOpts(root, ['auto/x.py']);
    const hook = hookOf(sdkOpts);
    const outOfRoot = path.join(other, 'auto', 'x.py');
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: outOfRoot }, tool_use_id: 't1' }, 't1', {});
    assert.strictEqual(out?.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.strictEqual(out?.hookSpecificOutput?.permissionDecision, 'deny', `Expected deny, got ${JSON.stringify(out)}`);
    assert.ok(/outside the project root/.test(out.hookSpecificOutput.permissionDecisionReason), `Expected the guard's boundary reason, got: ${out.hookSpecificOutput.permissionDecisionReason}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

// ── TC3: read-then-write through the hook shares readFiles state ─────────
await test('TC3 a Read through the hook satisfies read-before-edit for a later Edit through the hook', async () => {
  const root = makeTmpRoot();
  try {
    const target = path.join(root, 'a.js');
    fs.writeFileSync(target, 'x');
    const sdkOpts = buildOpts(root, ['a.js']);
    const hook = hookOf(sdkOpts);

    // Edit BEFORE any Read → read-before-edit denial.
    const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target }, tool_use_id: 't2' }, 't2', {});
    assert.strictEqual(denied?.hookSpecificOutput?.permissionDecision, 'deny', `Expected deny before Read, got ${JSON.stringify(denied)}`);
    assert.ok(/has not been Read/.test(denied.hookSpecificOutput.permissionDecisionReason), `Expected the read-before-edit reason, got: ${denied.hookSpecificOutput.permissionDecisionReason}`);

    // Read, then the same Edit → allow, with updatedInput carried through.
    const read = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: target }, tool_use_id: 't3' }, 't3', {});
    assert.strictEqual(read?.hookSpecificOutput?.permissionDecision, 'allow');
    const allowed = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target }, tool_use_id: 't4' }, 't4', {});
    assert.strictEqual(allowed?.hookSpecificOutput?.permissionDecision, 'allow', `Expected allow after Read, got ${JSON.stringify(allowed)}`);
    assert.strictEqual(allowed.hookSpecificOutput.updatedInput?.file_path, target, 'updatedInput must carry the (normalized) tool input through');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC4: dangerous Bash denied through the hook ──────────────────────────
await test('TC4 hook denies a dangerous Bash command', async () => {
  const root = makeTmpRoot();
  try {
    const sdkOpts = buildOpts(root, []);
    const hook = hookOf(sdkOpts);
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 't5' }, 't5', {});
    assert.strictEqual(out?.hookSpecificOutput?.permissionDecision, 'deny', `Expected deny for dangerous Bash, got ${JSON.stringify(out)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC5: _toQueryOptions strips exactly canUseTool ───────────────────────
await test('TC5 _toQueryOptions strips canUseTool but keeps hooks and every other key', () => {
  const root = makeTmpRoot();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions({ cwd: root, targetFiles: ['a.js'] }, new Set());
    const forSdk = sm._toQueryOptions(sdkOpts);
    assert.ok(!('canUseTool' in forSdk), 'canUseTool must not reach query() — a shadowed callback only triggers the SDK warning');
    assert.strictEqual(forSdk.hooks, sdkOpts.hooks, 'hooks must be passed through untouched');
    for (const key of Object.keys(sdkOpts)) {
      if (key === 'canUseTool') continue;
      assert.ok(key in forSdk, `Expected key "${key}" to survive _toQueryOptions`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC6: symlinked project root — two spellings of one file are one file ─
await test('TC6 a symlinked root alias does not false-deny in-root writes (archive-226 regression)', async () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-'));
  const alias = realRoot + '-alias';
  fs.symlinkSync(realRoot, alias);
  try {
    const target = path.join(realRoot, 'a.js');
    fs.writeFileSync(target, 'x');
    // Session rooted at the SYMLINK spelling; tool calls use the REAL spelling.
    const sdkOpts = buildOpts(alias, ['a.js']);
    const hook = hookOf(sdkOpts);

    // Read via the ALIAS spelling, then Edit via the REAL spelling: one file.
    const read = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(alias, 'a.js') }, tool_use_id: 's1' }, 's1', {});
    assert.strictEqual(read?.hookSpecificOutput?.permissionDecision, 'allow');
    const edit = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: target }, tool_use_id: 's2' }, 's2', {});
    assert.strictEqual(edit?.hookSpecificOutput?.permissionDecision, 'allow',
      `Cross-spelling Edit must pass D1+D2+read-before-edit, got ${JSON.stringify(edit)}`);

    // A brand-new file (Write, not on disk yet) via the real spelling too.
    const sdkOpts2 = buildOpts(alias, ['b.js']);
    const hook2 = hookOf(sdkOpts2);
    const write = await hook2({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(realRoot, 'b.js') }, tool_use_id: 's3' }, 's3', {});
    assert.strictEqual(write?.hookSpecificOutput?.permissionDecision, 'allow',
      `New-file Write through the other spelling must pass, got ${JSON.stringify(write)}`);
  } finally {
    fs.rmSync(alias, { force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

// ── TC7: canonicalization must not over-allow — true out-of-root still denied
await test('TC7 out-of-root writes stay denied under a symlinked root', async () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-'));
  const alias = realRoot + '-alias';
  fs.symlinkSync(realRoot, alias);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-other-'));
  try {
    const sdkOpts = buildOpts(alias, ['a.js']);
    const hook = hookOf(sdkOpts);
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(other, 'a.js') }, tool_use_id: 's4' }, 's4', {});
    assert.strictEqual(out?.hookSpecificOutput?.permissionDecision, 'deny', `Expected deny, got ${JSON.stringify(out)}`);
    assert.ok(/outside the project root/.test(out.hookSpecificOutput.permissionDecisionReason));
  } finally {
    fs.rmSync(alias, { force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
