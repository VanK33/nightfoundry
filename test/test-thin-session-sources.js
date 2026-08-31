/**
 * test-thin-session-sources.js — T3: the settingSources override seam on
 * the session manager's SDK option builder (M1 blueprint v3 §范围-in
 * item 1: the thin executor aligns with the bare baseline by loading the
 * PROJECT-level CLAUDE.md; every v0.2 caller keeps today's full isolation).
 * Run: node test/test-thin-session-sources.js
 */
import assert from 'assert';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';

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

const build = (options) => SessionManager.prototype._buildSdkOptions.call({}, options);

test('TC1: default stays FULL isolation — settingSources: [] (v0.2 regression pin)', () => {
  const o = build({});
  assert.deepStrictEqual(o.settingSources, []);
});

test('TC2: settingSourcesOverride passes through verbatim', () => {
  const o = build({ settingSourcesOverride: ['project'] });
  assert.deepStrictEqual(o.settingSources, ['project']);
});

test('TC3: an empty override array yields [] (indistinguishable from absence at this seam — both mean full isolation)', () => {
  const o = build({ settingSourcesOverride: [] });
  assert.deepStrictEqual(o.settingSources, []);
});

test('TC4: non-array override is ignored and falls back to full isolation', () => {
  const o = build({ settingSourcesOverride: 'project' });
  assert.deepStrictEqual(o.settingSources, []);
});

test('TC5: the override does not disturb the other worker-session invariants', () => {
  const o = build({ settingSourcesOverride: ['project'] });
  assert.strictEqual(o.persistSession, false, 'workers never persist sessions');
  assert.ok(o.env && typeof o.env === 'object', 'run-marker env still stamped');
});

test('TC6: the NO-override (v0.2) path keeps persistSession:false and the run-marker env (invariant pin)', () => {
  const o = build({});
  assert.strictEqual(o.persistSession, false);
  assert.ok(o.env && typeof o.env === 'object');
});

test('TC7: a multi-element override passes through verbatim, uncropped', () => {
  const o = build({ settingSourcesOverride: ['project', 'user'] });
  assert.deepStrictEqual(o.settingSources, ['project', 'user']);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
