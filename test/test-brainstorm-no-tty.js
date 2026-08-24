/**
 * test-brainstorm-no-tty.js — Tests for the brainstorm --no-tty honesty +
 * resume-safety contracts (spec: brainstorm-no-tty.spec.md, W2-F1).
 *
 * Written FROM THE SPEC by an independent test-author. Cases map 1:1 to the
 * spec's acceptance criteria 1-7:
 *
 *   TC1  no-tty NEW prints an explicit outcome block (criterion 1)
 *   TC2  no-tty RESUME is read-only: zero factory calls, bytes untouched (criterion 2)
 *   TC3  no-tty RESUME of a cancelled draft does not revive it (criterion 3)
 *   TC4a nonexistent slug rejects honestly in no-tty mode (criterion 4)
 *   TC4b nonexistent slug rejects honestly in TTY mode (criterion 4)
 *   TC5  TTY resume of a cancelled draft still revives to in-progress (criterion 5)
 *   TC6  generateSlug word-boundary truncation + 6-segment cap (criterion 6)
 *   TC7a CLI top-level catch surfaces error details on stderr (criterion 7, subprocess)
 *   TC7b CLI top-level catch consults err.errors (criterion 7, structural pin)
 *
 * Discrimination instrument: a RECORDING brainstormerFactory that counts and
 * arg-captures every initialize()/revise() call (spec constraint: "a factory
 * whose initialize/revise record their invocations is the discrimination
 * instrument for 'resume never re-initializes'").
 *
 * Run: node test/test-brainstorm-no-tty.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import {
  generateSlug,
  getBrainstormDir,
  readState,
  brainstorm,
} from '../src/cli/commands/brainstorm.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_INDEX = path.join(REPO_ROOT, 'src', 'cli', 'index.js');

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-no-tty-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Capture everything written to a PassThrough as a single string getter. */
function captureOutput(stream) {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c.toString()));
  return () => chunks.join('');
}

// ── Recording Brainstormer factory ────────────────────────────────────────────
//
// Counts + arg-captures every call. Per the spec, this is the discrimination
// instrument: a read-only resume must leave BOTH arrays empty.

function recordingFactory(spec, specMd) {
  const calls = { initialize: [], revise: [] };
  function factory() {
    return {
      initialize(userInput) {
        calls.initialize.push({ userInput });
        return Promise.resolve({ spec, specMd });
      },
      revise(currentSpec, feedback, mode) {
        calls.revise.push({ currentSpec, feedback, mode });
        return Promise.resolve({ spec, specMd });
      },
    };
  }
  return { factory, calls };
}

// Fixture spec: 3 acceptance criteria, 2 target files (TC1 counts assertion).
const FIXTURE_SPEC = {
  goal: 'fixture goal',
  target_files: ['src/a.js', 'src/b.js'],
  acceptance_criteria: [
    { description: 'c1', verification: { kind: 'command', command: 'node t1', targetFile: 'src/a.js' } },
    { description: 'c2', verification: { kind: 'file-check', targetFile: 'src/b.js' } },
    { description: 'c3', verification: { kind: 'command', command: 'node t2', targetFile: 'src/a.js' } },
  ],
};
const FIXTURE_SPEC_MD = '# Fixture Spec\n\nA short fixture spec body.';

// A deliberately DIFFERENT spec for resume-overwrite discrimination: if a
// buggy resume re-initializes, the draft bytes change to this and the
// byte-identical assertion catches it (live 4→1 criteria regression family).
const OTHER_SPEC = {
  goal: 'other goal',
  target_files: ['src/z.js'],
  acceptance_criteria: [
    { description: 'z1', verification: { kind: 'file-check', targetFile: 'src/z.js' } },
  ],
};
const OTHER_SPEC_MD = '# Other Spec\n\nDifferent body — must never land on a resumed draft.';

/**
 * Hand-write a draft bundle matching the shapes brainstorm.js itself writes
 * (writeState / writeBundle / appendHistory).
 */
function writeDraftFixture(projectRoot, slug, status) {
  const dir = getBrainstormDir(projectRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    slug,
    createdAt: now,
    lastUpdatedAt: now,
    status,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(FIXTURE_SPEC, null, 2));
  fs.writeFileSync(path.join(dir, 'spec.md'), FIXTURE_SPEC_MD);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({
    turn: 1, ts: now, mode: 'initialize', input: 'fixture prose', specHash: 'sha256:0000000000000000',
  }) + '\n');
  return dir;
}

const BUNDLE_FILES = ['spec.json', 'spec.md', 'state.json', 'history.jsonl'];

function snapshotBundle(dir) {
  const snap = {};
  for (const f of BUNDLE_FILES) {
    snap[f] = fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
  }
  return snap;
}

/** Assert some output line mentions both the keyword and the count. */
function assertLineWithCount(out, keywordRe, count, label) {
  const hit = out.split('\n').some((l) => keywordRe.test(l) && new RegExp(`\\b${count}\\b`).test(l));
  assert.ok(hit, `output must contain a line with ${keywordRe} and the count ${count} (${label})`);
}

// ── TC1: no-tty NEW prints an explicit outcome block (criterion 1) ───────────

await test('TC1: no-tty NEW prints outcome block (dir, in-progress, counts, --resume) and writes bundle', async () => {
  const d = tempDir();
  try {
    const { factory, calls } = recordingFactory(FIXTURE_SPEC, FIXTURE_SPEC_MD);
    const output = new PassThrough();
    const getOut = captureOutput(output);

    const result = await brainstorm(d, ['Add caching layer'], { 'no-tty': true }, {
      brainstormerFactory: factory,
      output,
    });

    // Returned status + bundle on disk (existing behavior, unchanged)
    assert.strictEqual(result.status, 'in-progress', 'returned status must be in-progress');
    for (const f of BUNDLE_FILES) {
      assert.ok(fs.existsSync(path.join(result.dir, f)), `${f} missing under session dir`);
    }
    assert.strictEqual(calls.initialize.length, 1, 'NEW run must initialize exactly once');

    // Outcome block (criterion 1) — red at pre-fix HEAD (prints nothing)
    const out = getOut();
    const slug = result.slug;
    assert.ok(
      out.includes(path.join('.harness', 'brainstorm', slug)),
      `output must contain the draft dir path .harness/brainstorm/${slug}`,
    );
    assert.ok(out.includes('in-progress'), 'output must state the status in-progress');
    assertLineWithCount(out, /criteri/i, 3, 'acceptance criteria count');
    assertLineWithCount(out, /target/i, 2, 'target file count');
    assert.ok(
      /(cc-orch|nightfoundry) brainstorm --resume /.test(out),
      `output must contain the brainstorm --resume next-step instruction`,
    );
    assert.ok(out.includes('spec.md'), 'output must mention the spec.md path for direct inspection');
  } finally {
    cleanup(d);
  }
});

// ── TC2: no-tty RESUME is read-only (criterion 2) ─────────────────────────────

await test('TC2: no-tty RESUME never calls initialize/revise and leaves all draft files byte-identical', async () => {
  const d = tempDir();
  try {
    // First, create a real draft via a no-tty NEW run (same code path users hit).
    const first = recordingFactory(FIXTURE_SPEC, FIXTURE_SPEC_MD);
    await brainstorm(d, ['Resume safety target'], { 'no-tty': true }, {
      brainstormerFactory: first.factory,
      output: new PassThrough(),
    });
    const slug = 'resume-safety-target';
    const dir = getBrainstormDir(d, slug);
    assert.ok(fs.existsSync(path.join(dir, 'state.json')), 'precondition: draft must exist');

    const before = snapshotBundle(dir);

    // Resume with a factory that would return DIFFERENT content if invoked —
    // so a buggy re-initialize both fires the counter AND changes bytes.
    const second = recordingFactory(OTHER_SPEC, OTHER_SPEC_MD);
    const output = new PassThrough();
    const getOut = captureOutput(output);

    await brainstorm(d, [], { resume: slug, 'no-tty': true }, {
      brainstormerFactory: second.factory,
      output,
    });

    // Discrimination instrument: read-only resume → zero LLM calls.
    assert.strictEqual(second.calls.initialize.length, 0, 'no-tty resume must NEVER call initialize');
    assert.strictEqual(second.calls.revise.length, 0, 'no-tty resume must NEVER call revise');

    // Bytes untouched (spec: "touches NOTHING on disk").
    const after = snapshotBundle(dir);
    for (const f of BUNDLE_FILES) {
      assert.strictEqual(after[f], before[f], `${f} must be byte-identical before/after no-tty resume`);
    }

    // Status view + instructions on output.
    const out = getOut();
    assert.ok(out.includes('in-progress'), 'output must show the draft status in-progress');
    assert.ok(out.includes(slug), 'output must name the resumed slug');
    assert.ok(out.includes('Spec Preview'), 'output must include the spec preview (printSpecPreview)');
    assert.ok(out.includes(`--resume ${slug}`), 'output must include the resume instruction');
  } finally {
    cleanup(d);
  }
});

// ── TC3: no-tty RESUME of a cancelled draft does not revive it (criterion 3) ──

await test('TC3: no-tty RESUME of a cancelled draft leaves state.json status=cancelled', async () => {
  const d = tempDir();
  try {
    const slug = 'cancelled-draft';
    const dir = writeDraftFixture(d, slug, 'cancelled');
    const before = snapshotBundle(dir);

    const { factory, calls } = recordingFactory(OTHER_SPEC, OTHER_SPEC_MD);
    const output = new PassThrough();
    const getOut = captureOutput(output);

    await brainstorm(d, [], { resume: slug, 'no-tty': true }, {
      brainstormerFactory: factory,
      output,
    });

    const st = readState(dir);
    assert.strictEqual(st.status, 'cancelled', 'no-tty resume must NOT revive cancelled→in-progress');
    assert.strictEqual(snapshotBundle(dir)['state.json'], before['state.json'],
      'state.json must be byte-identical (read-only path)');
    assert.strictEqual(calls.initialize.length, 0, 'no-tty resume must NEVER call initialize');
    assert.strictEqual(calls.revise.length, 0, 'no-tty resume must NEVER call revise');
    assert.ok(getOut().includes('cancelled'), 'status view must honestly show cancelled');
  } finally {
    cleanup(d);
  }
});

// ── TC4a: nonexistent slug, no-tty mode (criterion 4) ─────────────────────────

await test('TC4a: no-tty resume of nonexistent slug rejects naming the slug, lists available drafts, creates nothing', async () => {
  const d = tempDir();
  try {
    // One real draft so the error can list available slugs.
    writeDraftFixture(d, 'existing-draft', 'in-progress');

    const { factory, calls } = recordingFactory(OTHER_SPEC, OTHER_SPEC_MD);
    const output = new PassThrough();

    let rejection = null;
    try {
      await brainstorm(d, [], { resume: 'ghost', 'no-tty': true }, {
        brainstormerFactory: factory,
        output,
      });
    } catch (err) {
      rejection = err;
    }

    assert.ok(rejection, 'resume of a nonexistent slug must reject (pre-fix it fabricates a new spec)');
    assert.ok(/ghost/.test(rejection.message), `error message must name the slug "ghost"; got: ${rejection.message}`);

    // Available-slug listing may live in the message or in err.errors — accept either.
    const errText = rejection.message + ' '
      + (Array.isArray(rejection.errors) ? rejection.errors.join(' ') : '');
    assert.ok(errText.includes('existing-draft'),
      `error must list available drafts (existing-draft); got: ${errText}`);

    assert.strictEqual(calls.initialize.length, 0, 'must NOT initialize (no fabrication)');
    assert.strictEqual(calls.revise.length, 0, 'must NOT revise');
    assert.ok(!fs.existsSync(getBrainstormDir(d, 'ghost')), 'no ghost draft dir may be created');
  } finally {
    cleanup(d);
  }
});

// ── TC4b: nonexistent slug, TTY mode (criterion 4) ────────────────────────────

await test('TC4b: TTY resume of nonexistent slug rejects naming the slug and creates nothing', async () => {
  const d = tempDir();
  try {
    const { factory, calls } = recordingFactory(OTHER_SPEC, OTHER_SPEC_MD);
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Pre-buffer 'c\n' so the PRE-FIX interactive loop (which fabricates a
    // draft then prompts) terminates instead of hanging; post-fix the guard
    // rejects before any prompt is read.
    inputStream.write('c\n');

    let rejection = null;
    try {
      await brainstorm(d, [], { resume: 'ghost' }, {
        brainstormerFactory: factory,
        input: inputStream,
        output: outputStream,
      });
    } catch (err) {
      rejection = err;
    }

    assert.ok(rejection, 'TTY resume of a nonexistent slug must reject (pre-fix it fabricates a new spec)');
    assert.ok(/ghost/.test(rejection.message), `error message must name the slug "ghost"; got: ${rejection.message}`);
    assert.strictEqual(calls.initialize.length, 0, 'must NOT initialize (no fabrication)');
    assert.ok(!fs.existsSync(getBrainstormDir(d, 'ghost')), 'no ghost draft dir may be created');
  } finally {
    cleanup(d);
  }
});

// ── TC5: TTY resume of a cancelled draft still revives it (criterion 5) ───────

await test('TC5: TTY resume of a cancelled draft revives state to in-progress (moved, not dropped)', async () => {
  const d = tempDir();
  try {
    const slug = 'revive-me';
    const dir = writeDraftFixture(d, slug, 'cancelled');

    const { factory, calls } = recordingFactory(OTHER_SPEC, OTHER_SPEC_MD);
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Start the interactive resume WITHOUT pre-buffered input so we can
    // observe the revived state while the menu waits for a choice.
    const pending = brainstorm(d, [], { resume: slug }, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    let observed = null;
    for (let i = 0; i < 125; i++) {           // up to ~2.5s
      const st = readState(dir);
      if (st && st.status === 'in-progress') { observed = st.status; break; }
      await delay(20);
    }

    // Unblock the interactive loop before asserting, so a failure cannot hang.
    inputStream.write('c\n');
    await pending;

    assert.strictEqual(observed, 'in-progress',
      'interactive resume must revive cancelled→in-progress before the menu loop');
    assert.strictEqual(calls.initialize.length, 0,
      'resume with an existing spec.json must not re-initialize');
  } finally {
    cleanup(d);
  }
});

// ── TC6: generateSlug word-boundary truncation + segment cap (criterion 6) ────

await test('TC6: generateSlug truncates >50-char prose at a word boundary (no mid-word cut, no trailing dash)', () => {
  // 5 words x 12 chars → joined slug is 64 chars; char-50 lands mid-word
  // inside the 4th segment, so the old slice(0,50) discriminates.
  const prose = 'Aaaaaaaaaaaa Bbbbbbbbbbbb Cccccccccccc Dddddddddddd Eeeeeeeeeeee';
  const fullSlug = 'aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc-dddddddddddd-eeeeeeeeeeee';
  const slug = generateSlug(prose);

  assert.ok(slug.length <= 50, `slug must be <= 50 chars; got ${slug.length}`);
  assert.ok(!slug.endsWith('-'), 'slug must not end with a dash');
  // Word-boundary property: slug is a prefix of the full slug that ends
  // exactly at a hyphen boundary (no mid-word cut).
  assert.ok(fullSlug.startsWith(slug), `slug must be a prefix of ${fullSlug}; got ${slug}`);
  assert.ok(slug === fullSlug || fullSlug[slug.length] === '-',
    `slug must end at a word boundary; got "${slug}" (next char "${fullSlug[slug.length]}")`);
  // Greedy fit: w1-w2-w3 = 38 chars fits; adding w4 = 51 chars does not.
  assert.strictEqual(slug, 'aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc',
    'slug must keep the most whole words that fit within 50 chars');
});

await test('TC6: generateSlug caps prose with >6 words at exactly 6 segments', () => {
  const slug = generateSlug('one two three four five six seven eight');
  assert.strictEqual(slug.split('-').length, 6, `slug must have exactly 6 segments; got "${slug}"`);
  assert.strictEqual(slug, 'one-two-three-four-five-six');
});

await test('TC6: generateSlug leaves short prose and the untitled fallback unchanged', () => {
  assert.strictEqual(generateSlug('Add Rate Limiter!!'), 'add-rate-limiter');
  assert.strictEqual(generateSlug(''), 'untitled');
  assert.strictEqual(generateSlug('   '), 'untitled');
});

// ── TC7: CLI top-level catch prints err.errors (criterion 7) ──────────────────
//
// HONEST-COVERAGE NOTE: the only error that carries .errors today is the
// brainstormer's BRAINSTORM_VALIDATION_FAILED, which cannot be produced
// without a real LLM session. The spec sanctions a subprocess against "a tiny
// failing path" — the nonexistent-slug rejection is the cheapest real
// rejection that flows through main().catch. TC7a asserts the catch surfaces
// the full error detail (slug name + available-draft listing, whether carried
// in .message or .errors) on stderr with a non-zero exit. TC7b is a flagged
// STRUCTURAL pin that the catch consults err.errors at all (index.js has no
// .errors reference at pre-fix HEAD). Neither fakes a green: both are red
// pre-fix.

await test('TC7a: CLI subprocess `brainstorm --resume ghost --no-tty` exits non-zero with the slug + available drafts on stderr', () => {
  const d = tempDir();
  try {
    writeDraftFixture(d, 'tc7-available', 'in-progress');

    // Hostile env: no credentials, no claude on PATH — a PRE-FIX run (which
    // would fabricate via a REAL brainstormer) fails fast instead of starting
    // a real LLM session. Post-fix the guard rejects before any spawn.
    const cfgDir = path.join(d, '.claude-cfg-empty');
    fs.mkdirSync(cfgDir, { recursive: true });
    const env = { ...process.env, HOME: d, CLAUDE_CONFIG_DIR: cfgDir, PATH: '/usr/bin:/bin' };
    delete env.ANTHROPIC_API_KEY;

    const res = spawnSync(process.execPath, [
      CLI_INDEX, 'brainstorm', '--resume', 'ghost-tc7', '--no-tty', '--project', d,
    ], { cwd: d, env, timeout: 20000, encoding: 'utf8' });

    assert.notStrictEqual(res.status, 0,
      `CLI must not exit 0 for a nonexistent slug (status=${res.status}, signal=${res.signal})`);
    const stderr = res.stderr || '';
    assert.ok(stderr.includes('ghost-tc7'),
      `stderr must name the slug ghost-tc7; got:\n${stderr.slice(0, 500)}`);
    assert.ok(stderr.includes('tc7-available'),
      `stderr must list the available draft tc7-available (catch must print full error detail incl. .errors); got:\n${stderr.slice(0, 500)}`);
    assert.ok(!fs.existsSync(getBrainstormDir(d, 'ghost-tc7')), 'no ghost draft dir may be created');
  } finally {
    cleanup(d);
  }
});

await test('TC7b: index.js top-level catch references err.errors (structural pin — behavioral path covered by TC7a)', () => {
  const src = fs.readFileSync(CLI_INDEX, 'utf8');
  // Pre-fix HEAD has zero ".errors" references in index.js; the spec requires
  // the main().catch to print err.errors entries (one line each) when present.
  assert.ok(/\.errors\b/.test(src),
    'src/cli/index.js must consult err.errors in the top-level catch (spec: diagnostics hardening)');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
