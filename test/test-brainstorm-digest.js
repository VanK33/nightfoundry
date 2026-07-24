/**
 * test-brainstorm-digest.js — AC1 for brainstormer understanding-playback digest.
 *
 * `renderDigest(spec, digest, { style })` is a pure CLI helper that produces a
 * one-page read-back of the agent's understanding. The rendered page MUST
 * contain ALL of:
 *   - the goal
 *   - scope-in (derived from the spec: target_files + acceptance-criteria
 *     descriptions)
 *   - scope-out (from digest.scopeOut)
 *   - each acceptance criterion paired with HOW it is verified (description +
 *     verification kind/command/targetFile)
 *   - key assumptions (from digest.assumptions)
 *   - risks (from digest.risks)
 *
 * `style.digestVerbosity` ('terse' | 'normal') tunes brevity and MUST change
 * the output (verbosity is style-controlled, not a hardcoded literal). The
 * helper degrades gracefully when the digest is null/undefined: spec-derived
 * sections still render; digest-only sections show a placeholder rather than
 * throwing.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-digest.js
 */
import assert from 'node:assert';

import { renderDigest } from '../src/cli/commands/brainstorm.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// A spec with ≥2 acceptance criteria, each carrying a distinct verification
// shape so the render can pair every criterion with how it is verified.
const SPEC = {
  goal: 'Add a configurable rate limiter to the HTTP client that caps outbound requests per second.',
  target_files: ['src/http/client.js', 'src/http/rate-limiter.js', 'test/'],
  acceptance_criteria: [
    {
      description: 'HTTP client enforces the configured requests-per-second cap',
      verification: { kind: 'command', command: 'node test/rate-limiter.test.js', targetFile: 'src/http/rate-limiter.js' },
    },
    {
      description: 'Rate limiter is configurable via constructor options',
      verification: { kind: 'file-check', targetFile: 'src/http/rate-limiter.js' },
    },
  ],
  constraints: ['Must not add any runtime npm dependencies.'],
  architecture_notes: 'Consider a token-bucket algorithm for burst tolerance.',
};

const DIGEST = {
  scopeOut: [
    'Server-side throttling on the API gateway',
    'Retry/backoff policy for 429 responses',
  ],
  assumptions: [
    'The vendor cap is 5 requests per second',
    'A single process owns the rate limiter (no cross-process coordination)',
  ],
  risks: [
    'Bursts beyond the cap may queue unbounded under load',
    'Clock skew could misalign the sliding window',
  ],
};

const STYLE = { digestVerbosity: 'normal' };

// ── AC1: full render contains every section's content ────────────────────────

test('AC1: renderDigest output contains the goal', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  assert.strictEqual(typeof out, 'string', 'renderDigest must return a string');
  assert.ok(out.includes(SPEC.goal), 'render must contain the goal');
});

test('AC1: renderDigest output contains scope-in derived from the spec', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  // Scope-in is built from target_files + criteria descriptions. At minimum the
  // target files and each criterion's description must surface as in-scope.
  for (const tf of SPEC.target_files) {
    assert.ok(out.includes(tf), `scope-in must reference target file "${tf}"`);
  }
  for (const c of SPEC.acceptance_criteria) {
    assert.ok(out.includes(c.description), `scope-in / criteria must reference "${c.description}"`);
  }
});

test('AC1: renderDigest output contains scope-out from digest.scopeOut', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  for (const s of DIGEST.scopeOut) {
    assert.ok(out.includes(s), `scope-out must contain "${s}"`);
  }
});

test('AC1: renderDigest pairs each acceptance criterion with how it is verified', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  for (const c of SPEC.acceptance_criteria) {
    assert.ok(out.includes(c.description), `must render criterion description "${c.description}"`);
  }
  // The verification "how" must be visible: kinds, and the concrete
  // command / targetFile that prove each criterion.
  assert.ok(out.includes('command'), 'must surface the command verification kind');
  assert.ok(out.includes('file-check'), 'must surface the file-check verification kind');
  assert.ok(out.includes('node test/rate-limiter.test.js'), 'must surface the verification command');
  assert.ok(out.includes('src/http/rate-limiter.js'), 'must surface the verification targetFile');
});

test('AC1: renderDigest output contains key assumptions from digest.assumptions', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  for (const a of DIGEST.assumptions) {
    assert.ok(out.includes(a), `assumptions must contain "${a}"`);
  }
});

test('AC1: renderDigest output contains risks from digest.risks', () => {
  const out = renderDigest(SPEC, DIGEST, { style: STYLE });
  for (const r of DIGEST.risks) {
    assert.ok(out.includes(r), `risks must contain "${r}"`);
  }
});

// ── AC1: verbosity is style-controlled (terse vs normal differ) ──────────────

test("AC1: digestVerbosity 'terse' vs 'normal' produce DIFFERENT output", () => {
  const terse = renderDigest(SPEC, DIGEST, { style: { digestVerbosity: 'terse' } });
  const normal = renderDigest(SPEC, DIGEST, { style: { digestVerbosity: 'normal' } });
  assert.strictEqual(typeof terse, 'string', 'terse render must be a string');
  assert.strictEqual(typeof normal, 'string', 'normal render must be a string');
  assert.notStrictEqual(
    terse,
    normal,
    'terse and normal verbosity must produce different output (verbosity is style-controlled, not hardcoded)',
  );
});

test("AC1: both terse and normal still carry the load-bearing content (goal + a criterion + an assumption + a risk)", () => {
  for (const verbosity of ['terse', 'normal']) {
    const out = renderDigest(SPEC, DIGEST, { style: { digestVerbosity: verbosity } });
    assert.ok(out.includes(SPEC.goal), `${verbosity}: must still contain the goal`);
    assert.ok(
      out.includes(SPEC.acceptance_criteria[0].description),
      `${verbosity}: must still contain a criterion description`,
    );
    assert.ok(out.includes(DIGEST.assumptions[0]), `${verbosity}: must still contain an assumption`);
    assert.ok(out.includes(DIGEST.risks[0]), `${verbosity}: must still contain a risk`);
  }
});

test("FIX#7: terse always shortens vs normal even for a spec with ZERO acceptance_criteria", () => {
  // The AC1 verbosity test uses a 2-criteria spec, so 'terse' can differ from
  // 'normal' merely by dropping per-criterion verification lines — passing
  // vacuously over a criteria-less spec. With ZERO acceptance_criteria there are
  // no per-criterion verification lines to drop, so terse must STILL shorten the
  // output some other way; otherwise verbosity collapses to a no-op here.
  const zeroCriteriaSpec = {
    goal: SPEC.goal,
    target_files: SPEC.target_files,
    acceptance_criteria: [],
    constraints: SPEC.constraints,
  };
  const terse = renderDigest(zeroCriteriaSpec, DIGEST, { style: { digestVerbosity: 'terse' } });
  const normal = renderDigest(zeroCriteriaSpec, DIGEST, { style: { digestVerbosity: 'normal' } });
  assert.notStrictEqual(
    terse,
    normal,
    'terse must differ from normal even with zero acceptance_criteria (terse always shortens)',
  );
  assert.ok(
    terse.length < normal.length,
    'terse output must be SHORTER than normal even with zero acceptance_criteria',
  );
});

// ── AC1: graceful degrade when digest is undefined / null ────────────────────

test('AC1: renderDigest degrades gracefully when digest is undefined (no throw, spec sections render)', () => {
  let out;
  assert.doesNotThrow(() => {
    out = renderDigest(SPEC, undefined, { style: STYLE });
  }, 'renderDigest must not throw when digest is undefined');
  assert.strictEqual(typeof out, 'string', 'must still return a string');
  // Spec-derived sections still render.
  assert.ok(out.includes(SPEC.goal), 'spec-derived goal must render even without a digest');
  assert.ok(out.includes(SPEC.acceptance_criteria[0].description), 'criteria must render even without a digest');
  assert.ok(out.includes(SPEC.target_files[0]), 'scope-in target files must render even without a digest');
});

test('AC1: renderDigest degrades gracefully when digest is null (no throw)', () => {
  let out;
  assert.doesNotThrow(() => {
    out = renderDigest(SPEC, null, { style: STYLE });
  }, 'renderDigest must not throw when digest is null');
  assert.strictEqual(typeof out, 'string', 'must still return a string');
  assert.ok(out.includes(SPEC.goal), 'spec-derived goal must render with a null digest');
});

test('AC1: digest-only sections show a placeholder when the digest is absent (not a stray "undefined")', () => {
  const out = renderDigest(SPEC, undefined, { style: STYLE });
  // The digest-only sections (scope-out / assumptions / risks) must not leak the
  // literal string "undefined" into the rendered page — a placeholder is shown.
  assert.ok(!/\bundefined\b/.test(out), 'render must not contain the literal "undefined" when the digest is absent');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
