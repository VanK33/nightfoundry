/**
 * test-brainstorm-digest-channel.js — AC2 for brainstormer understanding-playback
 * digest.
 *
 * Scope-out, assumptions, and risks ride a STRUCTURED digest channel from the
 * brainstormer (the wrapper schema gains an optional `digest`), persisted as a
 * sidecar `digest.json` in the brainstorm session directory — NEVER copied to
 * the project root, NEVER fed to the planner. spec.json fields and
 * brainstormSpecSchema are unchanged (frozen).
 *
 * This file asserts:
 *   (a) extractBrainstormResult returns the digest from the structured channel
 *       when present, and `undefined` (no throw) when absent;
 *   (b) brainstormSpecSchema has NO digest/scopeOut/assumptions/risks property
 *       (proves spec.json contract frozen);
 *   (c) the digest is persisted as `digest.json` in the brainstorm dir and is
 *       NOT written to the project root;
 *   (d) backward-compat — with withDigest absent, buildBrainstormerPrompt's
 *       initialize prompt is byte-identical to the legacy path (the digest
 *       capability did not change the batch draft prompt).
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-digest-channel.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  extractBrainstormResult,
  buildBrainstormerPrompt,
} from '../src/orchestrator/agents/brainstormer.js';
import { brainstormSpecSchema } from '../src/orchestrator/agents/_schemas.js';
import { brainstorm, syncDigest, writeState } from '../src/cli/commands/brainstorm.js';

let passCount = 0;
let failCount = 0;
const allTests = [];

function test(name, fn) {
  const p = (async () => {
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
  })();
  allTests.push(p);
  return p;
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-digest-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPEC = {
  goal: 'Add a memoization cache to reduce redundant API calls.',
  target_files: ['src/cache.js', 'test/'],
  acceptance_criteria: [
    {
      description: 'cache returns the memoized value on a repeat call',
      verification: { kind: 'command', command: 'node test/cache.test.js', targetFile: 'src/cache.js' },
    },
  ],
};

const DIGEST = {
  scopeOut: ['Distributed cache across processes'],
  assumptions: ['API responses are deterministic for identical inputs'],
  risks: ['Stale cache entries on upstream data change'],
};

// ── (a) extractBrainstormResult returns the digest when present ──────────────

test('AC2(a): extractBrainstormResult returns the digest from the structured channel when present', () => {
  const sdkResult = { structured_output: { spec: SPEC, specMd: '# stub', digest: DIGEST } };
  const result = extractBrainstormResult(sdkResult);
  assert.ok(result, 'extractBrainstormResult must return a result');
  assert.deepStrictEqual(result.spec, SPEC, 'spec must pass through unchanged');
  assert.strictEqual(result.specMd, '# stub', 'specMd must pass through unchanged');
  assert.deepStrictEqual(result.digest, DIGEST, 'digest object must be returned from the structured channel');
});

// ── (a) extractBrainstormResult returns undefined (no throw) when digest absent ──

test('AC2(a): extractBrainstormResult returns digest undefined (no throw) when the digest is absent', () => {
  const sdkResult = { structured_output: { spec: SPEC, specMd: '# stub' } };
  let result;
  assert.doesNotThrow(() => {
    result = extractBrainstormResult(sdkResult);
  }, 'absence of a digest must NOT throw');
  assert.deepStrictEqual(result.spec, SPEC, 'spec must still extract when the digest is absent');
  assert.strictEqual(result.specMd, '# stub', 'specMd must still extract when the digest is absent');
  assert.strictEqual(result.digest, undefined, 'digest must be undefined when the channel is absent');
});

// ── (b) brainstormSpecSchema is frozen — no digest / scopeOut / assumptions / risks ──

test('AC2(b): brainstormSpecSchema has NO digest/scopeOut/assumptions/risks property (spec.json contract frozen)', () => {
  const props = brainstormSpecSchema.properties ?? {};
  for (const forbidden of ['digest', 'scopeOut', 'assumptions', 'risks']) {
    assert.ok(
      !(forbidden in props),
      `brainstormSpecSchema must NOT carry a "${forbidden}" property — the spec.json contract is frozen`,
    );
  }
  // The schema's required list must likewise not demand any digest field.
  const required = Array.isArray(brainstormSpecSchema.required) ? brainstormSpecSchema.required : [];
  for (const forbidden of ['digest', 'scopeOut', 'assumptions', 'risks']) {
    assert.ok(!required.includes(forbidden), `brainstormSpecSchema.required must not include "${forbidden}"`);
  }
});

// ── (c) digest persisted as digest.json in the brainstorm dir, NOT project root ──

test('AC2(c): the digest is persisted as digest.json in the brainstorm dir and NOT at the project root', async () => {
  const d = tempDir();
  try {
    // A brainstormer stub whose initialize emits a digest alongside spec/specMd
    // and whose proposeQuestions drives the TTY elicitation phase (so the CLY
    // takes the withDigest TTY path).
    function digestFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'A paraphrase.', evidence: ['src/cache.js'], unknowns: ['the cap'] },
            questions: [],
            assessedComplexity: 'small',
          });
        },
        // withDigest-GATED: emit a digest ONLY when the CLI opts in via
        // opts.withDigest. If the TTY path ever stopped passing withDigest:true,
        // this stub would return NO digest → no digest.json → the assertions
        // below fail. This makes the test genuinely verify the TTY withDigest
        // wiring instead of passing vacuously.
        initialize(_userInput, opts = {}) {
          return Promise.resolve(
            opts.withDigest
              ? { spec: SPEC, specMd: '# stub', digest: DIGEST }
              : { spec: SPEC, specMd: '# stub' },
          );
        },
        revise(_currentSpec, _feedback, _mode, opts = {}) {
          return Promise.resolve(
            opts.withDigest
              ? { spec: SPEC, specMd: '# stub', digest: DIGEST }
              : { spec: SPEC, specMd: '# stub' },
          );
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // No questions to answer (questions: []). 'y' confirms the frame, then 'a'
    // accepts and exits.
    inputStream.write('y\na\n');

    const result = await brainstorm(d, ['Add caching'], {}, {
      brainstormerFactory: digestFactory,
      input: inputStream,
      output: outputStream,
    });

    const { dir, slug } = result;

    // digest.json must exist in the brainstorm session dir, carrying the digest.
    const digestPath = path.join(dir, 'digest.json');
    assert.ok(fs.existsSync(digestPath), 'digest.json must be persisted in the brainstorm session dir');
    const persisted = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    assert.deepStrictEqual(persisted, DIGEST, 'persisted digest.json must contain the digest content');

    // The digest must NEVER be copied to the project root (the planner boundary).
    assert.ok(!fs.existsSync(path.join(d, 'digest.json')), 'digest.json must NOT exist at the project root');
    assert.ok(!fs.existsSync(path.join(d, `${slug}.digest.json`)), 'a slug-named digest must NOT exist at the project root');
  } finally {
    cleanup(d);
  }
});

// ── (c') non-TTY / batch path never writes a digest.json ──────────────────────

test('AC2(c): non-TTY / batch path does NOT persist a digest.json (TTY-only behavior)', async () => {
  const d = tempDir();
  try {
    function digestFactory() {
      return {
        initialize(_userInput, _opts = {}) {
          // Even if the stub were to emit a digest, the batch path passes no
          // withDigest and must not render/persist it.
          return Promise.resolve({ spec: SPEC, specMd: '# stub', digest: DIGEST });
        },
        revise(_currentSpec, _feedback, _mode) {
          return Promise.resolve({ spec: SPEC, specMd: '# stub' });
        },
      };
    }

    const output = new PassThrough();
    const result = await brainstorm(d, ['Add caching'], { 'no-tty': true }, {
      brainstormerFactory: digestFactory,
      output,
    });

    assert.ok(!fs.existsSync(path.join(result.dir, 'digest.json')), 'non-TTY path must NOT persist digest.json');
  } finally {
    cleanup(d);
  }
});

// ── (d) backward-compat: withDigest absent ⇒ initialize prompt byte-identical ──

test('AC2(d): withDigest absent ⇒ initialize prompt is byte-identical to the legacy path', () => {
  const args = { mode: 'initialize', userInput: 'Add a rate limiter to the HTTP client' };

  // Legacy call: no withDigest key at all.
  const legacy = buildBrainstormerPrompt({ ...args });
  // Explicitly-falsy withDigest must also reproduce the legacy prompt.
  const withFalse = buildBrainstormerPrompt({ ...args, withDigest: false });
  const withUndefined = buildBrainstormerPrompt({ ...args, withDigest: undefined });

  assert.strictEqual(withFalse, legacy, 'withDigest:false must yield the byte-identical legacy initialize prompt');
  assert.strictEqual(withUndefined, legacy, 'withDigest:undefined must yield the byte-identical legacy initialize prompt');

  // And the digest capability MUST change the prompt when switched on — proving
  // withDigest:true is the only thing that alters the draft prompt.
  const withTrue = buildBrainstormerPrompt({ ...args, withDigest: true });
  assert.notStrictEqual(withTrue, legacy, 'withDigest:true must change the prompt (asks for the digest channel)');
});

// ── FIX#2: malformed digest is coerced to safe arrays in extractBrainstormResult ──

test('FIX#2: a malformed digest.assumptions (string, not array) is coerced to [] without throwing', () => {
  const sdkResult = {
    structured_output: {
      spec: SPEC,
      specMd: '# stub',
      // assumptions arrives as a STRING — a malformed agent payload.
      digest: { scopeOut: ['ok'], assumptions: 'not an array', risks: ['r'] },
    },
  };
  let result;
  assert.doesNotThrow(() => {
    result = extractBrainstormResult(sdkResult);
  }, 'a malformed digest must NOT throw — it is coerced');
  assert.ok(result.digest, 'a digest must still be returned');
  assert.deepStrictEqual(
    result.digest.assumptions,
    [],
    'digest.assumptions must be coerced to [] (not the raw string)',
  );
  assert.notStrictEqual(result.digest.assumptions, 'not an array', 'the raw string must not survive');
  // The well-formed array fields pass through untouched.
  assert.deepStrictEqual(result.digest.scopeOut, ['ok'], 'a well-formed scopeOut passes through');
  assert.deepStrictEqual(result.digest.risks, ['r'], 'a well-formed risks passes through');
});

test('FIX#2: an absent digest returns undefined (no coercion, no throw)', () => {
  const sdkResult = { structured_output: { spec: SPEC, specMd: '# stub' } };
  let result;
  assert.doesNotThrow(() => {
    result = extractBrainstormResult(sdkResult);
  }, 'an absent digest must not throw');
  assert.strictEqual(result.digest, undefined, 'an absent digest stays undefined');
});

// ── FIX#1: digest.json sidecar is kept in sync — stale digest removed when a ──
//          turn produces none; written when a digest is produced.

test('FIX#1: syncDigest removes a pre-existing digest.json when the turn produces NO digest', () => {
  const d = tempDir();
  try {
    const digestPath = path.join(d, 'digest.json');
    // Seed a stale digest.json from a prior turn.
    syncDigest(d, DIGEST);
    assert.ok(fs.existsSync(digestPath), 'precondition: digest.json exists after seeding');

    // A subsequent turn produces NO digest → the stale sidecar must be removed.
    syncDigest(d, undefined);
    assert.ok(!fs.existsSync(digestPath), 'digest.json must be REMOVED when no digest is produced (not left stale)');

    // null is treated the same as undefined (no digest).
    syncDigest(d, DIGEST);
    assert.ok(fs.existsSync(digestPath), 'digest.json re-seeded');
    syncDigest(d, null);
    assert.ok(!fs.existsSync(digestPath), 'digest.json must be REMOVED when the digest is null');
  } finally {
    cleanup(d);
  }
});

test('FIX#1: syncDigest writes digest.json with the produced digest content', () => {
  const d = tempDir();
  try {
    syncDigest(d, DIGEST);
    const persisted = JSON.parse(fs.readFileSync(path.join(d, 'digest.json'), 'utf8'));
    assert.deepStrictEqual(persisted, DIGEST, 'digest.json must contain the produced digest content');
  } finally {
    cleanup(d);
  }
});

test('FIX#1: a revise turn that produces NO digest removes the stale digest.json from the initial draft', async () => {
  const d = tempDir();
  try {
    function staleDigestFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'P.', evidence: ['src/cache.js'], unknowns: ['x'] },
            questions: [],
            assessedComplexity: 'small',
          });
        },
        // Initial draft emits a digest → digest.json written.
        initialize(_userInput, _opts = {}) {
          return Promise.resolve({ spec: SPEC, specMd: '# stub', digest: DIGEST });
        },
        // The revise turn produces NO digest → the stale digest.json must go.
        revise(_currentSpec, _feedback, _mode, _opts = {}) {
          return Promise.resolve({ spec: SPEC, specMd: '# stub' });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // 'y' confirms (no questions); 'r' + feedback regenerates (no digest); 'a' accepts.
    inputStream.write('y\nr drop the digest\na\n');

    const result = await brainstorm(d, ['Add caching'], {}, {
      brainstormerFactory: staleDigestFactory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(
      !fs.existsSync(path.join(result.dir, 'digest.json')),
      'a revise turn with no digest must remove the stale digest.json from the initial draft',
    );
  } finally {
    cleanup(d);
  }
});

// ── FIX#3: resuming a TTY draft renders the digest read-back before the menu ──

test('FIX#3: TTY resume renders the persisted digest read-back BEFORE any menu interaction', async () => {
  const d = tempDir();
  try {
    const slug = 'resume-me';
    const dir = path.join(d, '.harness', 'brainstorm', slug);
    fs.mkdirSync(dir, { recursive: true });

    // Seed an existing draft: state.json + spec.json + spec.md + digest.json.
    const now = new Date().toISOString();
    writeState(dir, { slug, createdAt: now, lastUpdatedAt: now, status: 'in-progress' });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(SPEC, null, 2));
    fs.writeFileSync(path.join(dir, 'spec.md'), '# stub');
    const assumption = 'API responses are deterministic for identical inputs';
    fs.writeFileSync(
      path.join(dir, 'digest.json'),
      JSON.stringify({ scopeOut: ['Distributed cache'], assumptions: [assumption], risks: ['Stale entries'] }, null, 2),
    );

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Capture all output to inspect ordering.
    let captured = '';
    outputStream.on('data', (chunk) => { captured += chunk.toString(); });

    // 'a' accepts immediately so the only render before any menu choice is the
    // read-back digest. The resume path must not call initialize/revise.
    inputStream.write('a\n');

    await brainstorm(d, [], { resume: slug }, {
      // A factory whose initialize/revise would THROW — proving resume renders
      // the read-back from disk without re-drafting.
      brainstormerFactory: () => ({
        initialize() { throw new Error('resume must not call initialize'); },
        revise() { throw new Error('resume must not call revise'); },
      }),
      input: inputStream,
      output: outputStream,
    });

    // The persisted assumption (a digest-only field) must surface on resume.
    assert.ok(captured.includes(assumption), 'TTY resume must render the persisted digest assumption');
    // And it must appear BEFORE the menu / before the accept confirmation.
    const assumptionIdx = captured.indexOf(assumption);
    const menuIdx = captured.indexOf('Brainstorm Menu');
    assert.ok(menuIdx !== -1, 'the menu must render on resume');
    assert.ok(
      assumptionIdx < menuIdx,
      'the digest read-back must render BEFORE the menu on TTY resume',
    );
  } finally {
    cleanup(d);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
