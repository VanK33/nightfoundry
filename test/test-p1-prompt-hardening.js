/**
 * test-p1-prompt-hardening.js — Tests for the P1 prompt-hardening pair
 * (spec: p1-prompt-hardening): verifier back_reference_check becomes REQUIRED
 * (schema + prompt) and the reviewer cosmetic-tier definition loses the
 * latent-bug downgrade license.
 *
 * No Claude auth, no live sessions. Mock sessionManager/logger/tokenTracker;
 * prompts are captured via the stubbed spawn() through the REAL verifyTask /
 * reviewMilestone (mirrors test-verifier-spec-read-audit.js and
 * test-reviewer-acceptance-criteria.js).
 *
 * Coverage (designed from the spec contract, not the in-progress diff):
 *   TC1a — validateStructured(verdict, verifierSchema) rejects a verdict that
 *          omits back_reference_check (the field is now in `required`).
 *   TC1b — the same verdict + explicit-false back_reference_check
 *          ({ spec_consulted: false, plan_consulted: false, deviations: [] })
 *          is accepted (honest non-consultation stays conformant).
 *   TC2  — verifier prompt (real verifyTask, stubbed spawn) contains the pinned
 *          REQUIRED wording and no longer contains the optional license.
 *   TC3  — reviewer prompt (real reviewMilestone, stubbed spawn) contains the
 *          pinned cosmetic-tier phrases and no longer contains the
 *          'no consumer is actually affected today' license.
 *   TC4a — behavior unchanged: canned SDK result WITH the field and
 *          result 'PASSED' → verifyTask returns verified: true.
 *   TC4b — behavior unchanged: SDK result with NO structured_output →
 *          extractVerdict returns the field-less stub (verified: false,
 *          isStub: true) without throwing, and writes the sidecar.
 *
 * Run: node test/test-p1-prompt-hardening.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { verifierSchema, validateStructured } from '../src/orchestrator/agents/_schemas.js';
import { Verifier, extractVerdict } from '../src/orchestrator/agents/verifier.js';
import { Reviewer } from '../src/orchestrator/agents/reviewer.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Pinned phrases (from the spec's Constraints — exact replacement texts) ──

const VERIFIER_REQUIRED_PHRASE = 'back_reference_check is REQUIRED';
const VERIFIER_HONEST_PHRASE = 'Honest non-consultation is allowed; omitting the field is not.';
const VERIFIER_OLD_OPTIONAL_PHRASE = 'back_reference_check is optional';

const REVIEWER_STRICT_PHRASE = 'STRICTLY naming, style, or comment-only';
const REVIEWER_REACHABLE_PHRASE = 'ANY reachable configuration';
const REVIEWER_WARNING_FLOOR_PHRASE = "at least 'warning'";
const REVIEWER_LATENT_PHRASE = 'latent is not cosmetic';
const REVIEWER_OLD_LICENSE_PHRASE = 'no consumer is actually affected today';

// ── Shared fixtures ─────────────────────────────────────────────────────────

// A minimal schema-conformant verdict EXCEPT for back_reference_check
// (required keys at baseline: result, hardChecks, taskScopeChecks).
const baseVerdict = {
  result: 'PASSED',
  hardChecks: [],
  taskScopeChecks: [],
};

const explicitFalseBrc = {
  spec_consulted: false,
  plan_consulted: false,
  deviations: [],
};

const noop = () => {};

function makeLogger(warnSpy) {
  return {
    createSessionLog: () => ({ logPath: '/tmp/test-p1-prompt-hardening.log', close: noop }),
    attachToSession: noop,
    warn: (msg) => { if (warnSpy) warnSpy.calls.push(msg); },
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
}

function makeTokenTracker() {
  return { recordSession: async () => {} };
}

/**
 * Mock sessionManager whose spawn() captures the options object (including
 * opts.prompt) and returns a thenable exposing .handle synchronously AND
 * resolving to { handle, result } (mirrors test-verifier-spec-read-audit.js).
 */
function makeSessionManager({ readFiles = [], sdkResult }) {
  const spawnSpy = { calls: [] };
  const handle = {
    _readFiles: readFiles,
    _toolCallCount: 0,
    systemPromptTokens: 0,
  };
  const thenable = Object.assign(Promise.resolve({ handle, result: sdkResult }), { handle });
  const sessionManager = {
    spawn: (spawnOpts) => {
      spawnSpy.calls.push(spawnOpts);
      return thenable;
    },
  };
  return { sessionManager, spawnSpy };
}

/**
 * Drive the REAL verifyTask with a stubbed spawn returning a canned PASSED
 * verdict that INCLUDES back_reference_check (so post-fix schema validation
 * passes). Returns { prompt, verdict }.
 */
async function runVerifyTask() {
  const projectRoot = tempDir('p1-hardening-verifier-');
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const task = { id: 'p1-hardening-task', description: 'test', targetFiles: [] };

    // verify.json fixture for the task (referenced by the prompt).
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${task.id}.json`),
      JSON.stringify({ hardChecks: [], testCases: [] }, null, 2),
    );

    const { sessionManager, spawnSpy } = makeSessionManager({
      // Session "read" the spec → the spec-read audit stays quiet.
      readFiles: [specPath],
      sdkResult: {
        structured_output: {
          ...baseVerdict,
          back_reference_check: { ...explicitFalseBrc },
        },
      },
    });

    const verifier = new Verifier(sessionManager, makeLogger(), makeTokenTracker());
    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'spawn was called with a string prompt');
    return { prompt, verdict };
  } finally {
    cleanup(projectRoot);
  }
}

/**
 * Drive the REAL reviewMilestone with a stubbed spawn (mirrors
 * test-reviewer-acceptance-criteria.js). Returns the captured prompt.
 */
async function captureReviewerPrompt() {
  const projectRoot = tempDir('p1-hardening-reviewer-');
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
    fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });

    const { sessionManager, spawnSpy } = makeSessionManager({
      sdkResult: {
        structured_output: { result: 'PASSED', findings: [], notes: 'No issues found.' },
      },
    });

    const reviewer = new Reviewer(sessionManager, makeLogger(), makeTokenTracker());
    await reviewer.reviewMilestone(
      'ms-p1-hardening',
      ['src/foo.js'],
      ['Task t1: implement feature'],
      'importGraph data',
      projectRoot,
      harnessDir,
    );

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'spawn was called with a string prompt');
    return prompt;
  } finally {
    cleanup(projectRoot);
  }
}

// ── TC1a: schema rejects a verdict omitting back_reference_check ────────────

await test('TC1a: verifierSchema requires back_reference_check — verdict omitting it is rejected', () => {
  assert.ok(
    Array.isArray(verifierSchema.required) && verifierSchema.required.includes('back_reference_check'),
    `verifierSchema.required must include 'back_reference_check', got: ${JSON.stringify(verifierSchema.required)}`,
  );

  const r = validateStructured({ ...baseVerdict }, verifierSchema);
  assert.strictEqual(
    r.ok,
    false,
    `validateStructured must reject a verdict omitting back_reference_check, got: ${JSON.stringify(r)}`,
  );
});

// ── TC1b: explicit honest non-consultation stays conformant ─────────────────

await test('TC1b: verdict with explicit-false back_reference_check is accepted', () => {
  const r = validateStructured(
    { ...baseVerdict, back_reference_check: { ...explicitFalseBrc } },
    verifierSchema,
  );
  assert.strictEqual(
    r.ok,
    true,
    `validateStructured must accept a verdict with explicit { spec_consulted: false, plan_consulted: false, deviations: [] }, got: ${JSON.stringify(r)}`,
  );
});

// ── TC2: verifier prompt carries the pinned REQUIRED wording ────────────────

await test('TC2: verifier prompt contains the pinned REQUIRED wording and not the optional license', async () => {
  const { prompt } = await runVerifyTask();

  assert.ok(
    prompt.includes(VERIFIER_REQUIRED_PHRASE),
    `verifier prompt must contain "${VERIFIER_REQUIRED_PHRASE}"`,
  );
  assert.ok(
    prompt.includes(VERIFIER_HONEST_PHRASE),
    `verifier prompt must contain "${VERIFIER_HONEST_PHRASE}"`,
  );
  assert.ok(
    !prompt.includes(VERIFIER_OLD_OPTIONAL_PHRASE),
    `verifier prompt must NOT contain "${VERIFIER_OLD_OPTIONAL_PHRASE}"`,
  );
});

// ── TC3: reviewer prompt carries the pinned cosmetic-tier wording ───────────

await test('TC3: reviewer prompt contains the pinned cosmetic-tier phrases and not the latent-downgrade license', async () => {
  const prompt = await captureReviewerPrompt();

  assert.ok(
    prompt.includes(REVIEWER_STRICT_PHRASE),
    `reviewer prompt must contain "${REVIEWER_STRICT_PHRASE}"`,
  );
  assert.ok(
    prompt.includes(REVIEWER_REACHABLE_PHRASE),
    `reviewer prompt must contain "${REVIEWER_REACHABLE_PHRASE}"`,
  );
  assert.ok(
    prompt.includes(REVIEWER_WARNING_FLOOR_PHRASE),
    `reviewer prompt must contain "${REVIEWER_WARNING_FLOOR_PHRASE}"`,
  );
  assert.ok(
    prompt.includes(REVIEWER_LATENT_PHRASE),
    `reviewer prompt must contain "${REVIEWER_LATENT_PHRASE}"`,
  );
  assert.ok(
    !prompt.includes(REVIEWER_OLD_LICENSE_PHRASE),
    `reviewer prompt must NOT contain "${REVIEWER_OLD_LICENSE_PHRASE}"`,
  );
});

// ── TC4a: behavior unchanged — PASSED + field present → verified: true ──────

await test('TC4a: canned PASSED result WITH back_reference_check → verifyTask returns verified: true', async () => {
  const { verdict } = await runVerifyTask();
  assert.strictEqual(
    verdict.verified,
    true,
    `expected verdict.verified === true for a PASSED result carrying back_reference_check, got ${verdict.verified}`,
  );
});

// ── TC4b: behavior unchanged — no structured_output → field-less stub ───────

await test('TC4b: no structured_output → extractVerdict returns the field-less stub without throwing', () => {
  const dir = tempDir('p1-hardening-stub-');
  try {
    const warnSpy = { calls: [] };
    let out;
    assert.doesNotThrow(() => {
      // Empty SDK result — no structured_output → the stub path.
      out = extractVerdict({}, 'p1-hardening-stub', dir, { warn: (msg) => warnSpy.calls.push(msg) });
    }, 'extractVerdict must not throw on a result with no structured_output');

    assert.strictEqual(out.verified, false, `stub verdict must have verified === false, got ${out.verified}`);
    assert.strictEqual(out.isStub, true, `stub verdict must have isStub === true, got ${out.isStub}`);
    assert.ok(
      !('back_reference_check' in out.structured),
      'the stub stays field-less by design — back_reference_check must NOT be synthesized',
    );

    const sidecarPath = path.join(dir, 'verification', 'task-p1-hardening-stub.json');
    assert.ok(fs.existsSync(sidecarPath), 'sidecar file must be written for the stub verdict');
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.strictEqual(parsed.isStub, true, 'persisted stub sidecar must carry isStub: true');
  } finally {
    cleanup(dir);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
