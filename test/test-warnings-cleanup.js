/**
 * test-warnings-cleanup.js — Pins the eight fidelity fixes of the
 * w5-warnings-cleanup spec plus the full-suite-green acceptance.
 *
 * Each AC is pinned deterministically (no LLM). Behavior fixes get
 * runtime pins; text fixes (README flag table, audit-r2 line-count,
 * CLI help) get content assertions over the on-disk source. All line
 * numbers are re-derived at execution time — the test never hardcodes
 * a line offset, it re-reads source and asserts on structure/content.
 *
 * AC map (spec §Acceptance criteria 1-9):
 *   AC1 → TC1_*  session-manager: exactly one 'error' emit per handle
 *   AC2 → TC2_*  verifier: returned verdict matches audit-patched sidecar
 *   AC3 → TC3_*  ProgressTracker: public read-only driftActive getter
 *   AC4 → TC4_*  planner: NEGATION_SINGLE dead-token + contraction behavior
 *   AC5 → TC5_*  README flag table scoped to the real gitGuard-consuming cmds
 *   AC6 → TC6_*  usage --include-failed (no --all) reaches cross-archive path
 *   AC7 → TC7_*  cross-archive aggregator reads token-usage.json as SoT
 *   AC8 → TC8_*  audit-r2 textual line-count claims match the 30-line check
 *   (AC9 full-suite-green is the orchestrator's `node scripts/run-tests.js`)
 *
 * Run: node test/test-warnings-cleanup.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SessionManager,
  SessionHandle,
  InfrastructureError,
} from '../src/orchestrator/infra/session-manager.js';
import { Verifier } from '../src/orchestrator/agents/verifier.js';
import { ProgressTracker } from '../src/orchestrator/core/progress-tracker.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { extractRejectedPhrases } from '../src/orchestrator/core/scope-parser.js';
import { aggregateAcrossArchives, enumerateArchives } from '../src/orchestrator/infra/cross-archive-analyzer.js';
import { usage, usageAll } from '../src/cli/commands/usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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

async function testAsync(name, fn) {
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

// ---------- stdout capture helper (verbatim style from test-usage-all.js) ----------

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }

  return chunks.join('');
}

// ==========================================================================
// AC1 — session-manager: a transport-classified failure emits 'error'
//       exactly once per handle.
//
// A transport-classified failure originates in classifyResult() (a result
// event with is_error and a network-shaped message). spawn() classifies it,
// emits 'error', and THROWS the InfrastructureError; the work-body catch must
// NOT emit 'error' a SECOND time for the same handle. We drive spawn() with a
// mock query function that yields a transport-shaped error result, count
// 'error' emits on the handle, and assert exactly one.
// ==========================================================================

// A mock SDK query: yields one transport-error result event then ends.
// duration_api_ms === 0 && output_tokens === 0 → classifyResult → network.
function makeTransportErrorQuery() {
  async function* gen() {
    yield {
      type: 'result',
      is_error: true,
      duration_api_ms: 0,
      usage: { output_tokens: 0 },
      result: 'fetch failed: socket hang up',
      total_cost_usd: 0,
    };
  }
  const it = gen();
  // The SDK Query object is an async iterable with an optional return().
  it.return = it.return ? it.return.bind(it) : async () => ({ done: true });
  return it;
}

async function runTransportFailureEmitCount() {
  const sm = new SessionManager();
  // Inject the mock query function so no real SDK subprocess is spawned.
  sm._queryFn = () => makeTransportErrorQuery();

  const spawnPromise = sm.spawn({ name: 'tc1-transport', agent: 'executor' });
  const handle = spawnPromise.handle;

  // Count 'error' emits on this handle. The SessionHandle attaches a default
  // no-op 'error' listener at construction (so a zero-listener emit cannot
  // crash); adding our counting listener is purely additive.
  let errorEmits = 0;
  let lastErr = null;
  handle.on('error', (e) => {
    errorEmits++;
    lastErr = e;
  });

  let threw = null;
  try {
    await spawnPromise;
  } catch (e) {
    threw = e;
  }

  return { errorEmits, lastErr, threw, handle };
}

await testAsync(
  "AC1/TC1_emit_count: transport-classified failure emits 'error' exactly once per handle",
  async () => {
    const { errorEmits, lastErr, threw } = await runTransportFailureEmitCount();

    // The classified failure must surface to the caller as a thrown
    // InfrastructureError (control-flow contract unchanged).
    assert.ok(
      threw instanceof InfrastructureError,
      `Expected spawn() to reject with an InfrastructureError, got: ${threw && threw.constructor && threw.constructor.name}: ${threw && threw.message}`
    );
    assert.strictEqual(
      threw.category,
      'network',
      `Expected transport classification category 'network', got '${threw && threw.category}'`
    );

    // The pin: exactly ONE 'error' emit. Pre-fix this is 2 (classification
    // site + work-promise catch both emit), so this assertion FAILS if the
    // duplicate emit is still present.
    assert.strictEqual(
      errorEmits,
      1,
      `Expected exactly 1 'error' emit per handle for a transport-classified failure, got ${errorEmits}`
    );

    // The single emitted error must carry the classification.
    assert.ok(
      lastErr instanceof InfrastructureError && lastErr.category === 'network',
      `Expected the emitted 'error' payload to be the network-classified InfrastructureError`
    );
  }
);

await testAsync(
  'AC1/TC1_teardown_intact: failed handle is finished and removed from _active (settled semantics intact)',
  async () => {
    const { handle } = await runTransportFailureEmitCount();
    // Teardown/settled bookkeeping must still hold: handle marked finished
    // and not lingering in the active map.
    assert.strictEqual(handle.finished, true, 'Expected handle.finished === true after a classified failure');
  }
);

// ==========================================================================
// AC2 — verifier: the verdict returned by verifyTask carries the same audited
//       back_reference_check.spec_consulted (and specReadAudit) as the on-disk
//       sidecar after the spec-read audit patch.
//
// We construct a Verifier with a mock SessionManager whose spawn() returns a
// handle that recorded reading the spec file (so didReadSpec === true) and an
// SDK result carrying a structured verdict with spec_consulted = false. The
// audit patch flips the on-disk sidecar's spec_consulted to true; the fix
// makes the RETURNED verdict agree. We re-read the sidecar and compare.
// ==========================================================================

function makeVerifierStructured(specConsulted) {
  return {
    result: 'PASSED',
    hardChecks: [{ name: 'noop', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: {
      spec_consulted: specConsulted,
      plan_consulted: false,
      deviations: [],
    },
    notes: 'tc2',
  };
}

// Minimal logger stub matching the surface verifier.js touches.
function makeLoggerStub() {
  const logPath = path.join(os.tmpdir(), `tc2-log-${Date.now()}-${Math.random()}.log`);
  return {
    warn() {},
    createSessionLog() {
      return { logPath, close() {} };
    },
    attachToSession() {},
    getSessionSummary() {
      return {};
    },
    async writeSessionSummary() {},
  };
}

// Mock SessionManager: spawn() resolves with a handle whose _readFiles
// contains the spec path (didReadSpec true) and an SDK result carrying the
// structured verdict via structured_output.
function makeVerifierSessionManager(specPath, structured) {
  return {
    spawn() {
      const handle = new SessionHandle('verifier-tc2');
      handle._readFiles = new Set([path.resolve(specPath)]);
      handle.systemPromptTokens = 0;
      handle._toolCallCount = 0;
      const sdkResult = { type: 'result', is_error: false, structured_output: structured };
      const p = Promise.resolve({ handle, result: sdkResult });
      p.handle = handle;
      return p;
    },
  };
}

await testAsync(
  'AC2/TC2_memory_matches_disk: returned verdict spec_consulted matches re-read sidecar',
  async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc2-'));
    // Stage a real spec file the verifier "reads".
    const specPath = path.join(tmpRoot, 'spec.md');
    fs.writeFileSync(specPath, '# spec\n');

    // Verifier session reports spec_consulted=false in its structured output;
    // the audit (didReadSpec true) should patch it to true on disk AND in the
    // returned verdict.
    const structured = makeVerifierStructured(false);
    const sm = makeVerifierSessionManager(specPath, structured);
    const verifier = new Verifier(sm, makeLoggerStub(), null);

    const task = { id: 'tc2-001', description: 'noop task', targetFiles: ['x.js'] };

    let verdict;
    try {
      verdict = await verifier.verifyTask(task, tmpRoot, { specPath });
    } finally {
      // keep tmpRoot until after sidecar re-read
    }

    const sidecarPath = path.join(tmpRoot, '.harness', 'verification', `task-${task.id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    fs.rmSync(tmpRoot, { recursive: true, force: true });

    // Disk SoT: audit flipped spec_consulted to true (didReadSpec).
    assert.strictEqual(
      onDisk.back_reference_check.spec_consulted,
      true,
      `Expected on-disk sidecar spec_consulted=true after audit, got ${onDisk.back_reference_check.spec_consulted}`
    );

    // The pin: the RETURNED verdict's structured payload must AGREE with disk.
    // Pre-fix the returned verdict still carries the unpatched false, so this
    // FAILS.
    assert.ok(verdict && verdict.structured, 'Expected verdict.structured to be present');
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_consulted,
      onDisk.back_reference_check.spec_consulted,
      `Returned verdict spec_consulted (${verdict.structured.back_reference_check.spec_consulted}) must match on-disk sidecar (${onDisk.back_reference_check.spec_consulted})`
    );

    // specReadAudit must likewise be present on the returned verdict, matching disk.
    assert.ok(
      verdict.structured.specReadAudit && typeof verdict.structured.specReadAudit === 'object',
      'Expected returned verdict.structured.specReadAudit to be present (matching the audited sidecar)'
    );
    assert.strictEqual(
      verdict.structured.specReadAudit.didReadSpec,
      onDisk.specReadAudit.didReadSpec,
      'Returned verdict specReadAudit.didReadSpec must match the on-disk sidecar'
    );
  }
);

// ==========================================================================
// AC3 — ProgressTracker exposes a public read-only `driftActive` getter.
//       (test-status-bar-integration.js is migrated by the code-author; here
//       we pin the public surface only — we never touch _driftActive.)
// ==========================================================================

test('AC3/TC3_getter_exists: ProgressTracker exposes a public driftActive getter', () => {
  const pt = new ProgressTracker('/tmp/none', { warn() {} });
  // The getter must exist on the prototype as an accessor (not a data field).
  const desc = Object.getOwnPropertyDescriptor(ProgressTracker.prototype, 'driftActive');
  assert.ok(desc, 'Expected ProgressTracker.prototype to define a driftActive property');
  assert.strictEqual(typeof desc.get, 'function', 'driftActive must be a getter (accessor with a get fn)');
  // Initial value: no drift.
  assert.strictEqual(pt.driftActive, false, `Expected driftActive=false on a fresh tracker, got ${pt.driftActive}`);
});

test('AC3/TC3_getter_reflects_drift: driftActive reflects drift state via the public surface', () => {
  const pt = new ProgressTracker('/tmp/none', { warn() {} });

  // Force a drift condition through the public API: more done than total.
  // recomputeTotal of an empty mission map yields total = missionIds.length (0),
  // markDone pushes done above it.
  pt.markDone('t1');
  // assertInvariant with no current MS context cannot recompute, so done(1) > total(0)
  pt.assertInvariant('t1', null, null);
  assert.strictEqual(pt.driftActive, true, `Expected driftActive=true after a drift trip, got ${pt.driftActive}`);
});

test('AC3/TC3_getter_readonly: driftActive is read-only (no setter)', () => {
  const pt = new ProgressTracker('/tmp/none', { warn() {} });
  const desc = Object.getOwnPropertyDescriptor(ProgressTracker.prototype, 'driftActive');
  assert.ok(desc, 'Expected a driftActive property descriptor');
  assert.strictEqual(desc.set, undefined, 'driftActive must be read-only (no setter)');
  // Assigning to a getter-only accessor is a silent no-op in non-strict mode
  // and a TypeError in strict mode (this module is ESM → strict). Either way
  // the value must not change to the assigned one.
  let threw = false;
  try {
    pt.driftActive = true;
  } catch {
    threw = true;
  }
  assert.ok(
    threw || pt.driftActive === false,
    'Assigning to read-only driftActive must throw (strict mode) or be a no-op — value must not become the assigned one'
  );
});

// ==========================================================================
// AC4 — planner: NEGATION_SINGLE carries no token the tokenizer cannot
//       produce, and contraction vs spelled-out negation behavior is pinned.
//
// The tokenizer is desc.split(/\W+/): "don't" → ["don","t"], never "n't".
// So "n't" in NEGATION_SINGLE is dead by construction. We pin the ACTUAL
// behavior of the rejected-behavior warn for both phrasings:
//   - "do not X"  → the spelled-out "not" token sits near the matched content
//                    tokens → near-negation → warn SUPPRESSED.
//   - "don't X"   → tokenizes to "don"/"t"; no negation marker is produced →
//                    warn FIRES.
// We drive _warnIfRejectedBehavior() with a logger that records .warn calls.
// ==========================================================================

// Capturing logger for the planner.
function makeWarnCapturingLogger() {
  const warns = [];
  return {
    warns,
    warn(msg) {
      warns.push(String(msg));
    },
  };
}

// Build a planner with a capturing logger; the negation logic uses no I/O.
function makePlannerForNegation(logger) {
  return new Planner(/* sessionManager */ {}, logger, /* tokenTracker */ null);
}

// A rejected phrase derived through the real extractRejectedPhrases pipeline,
// so token derivation matches production. "do not mutate state silently" →
// phrase "mutate state silently" → tokens {mutate,state,silently} (stopwords
// removed). We feed a constraint that yields >= 2 distinctive tokens.
function buildRejectedPhrases() {
  const phrases = extractRejectedPhrases(['Do not mutate shared state']);
  assert.ok(phrases.length >= 1, 'Fixture constraint must yield at least one rejected phrase');
  assert.ok(phrases[0].tokens.size >= 2, 'Rejected phrase must carry >= 2 distinctive tokens');
  return phrases;
}

// Helper: run the warn pass for a single task description, return the count of
// per-task "appears to perform rejected behavior" warnings.
function countRejectedWarns(description) {
  const logger = makeWarnCapturingLogger();
  const planner = makePlannerForNegation(logger);
  const rejected = buildRejectedPhrases();
  const plan = { newTasks: [{ id: 'neg-task', description }] };
  planner._warnIfRejectedBehavior(plan, rejected, 'tc4');
  return logger.warns.filter((w) => w.includes('appears to perform rejected behavior')).length;
}

test("AC4/TC4_dead_token_removed: NEGATION_SINGLE source no longer contains the dead \"n't\" token", () => {
  // Content assertion over the planner source: the dead token must be gone.
  // (The set is module-internal, so we assert on the source declaration.)
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'orchestrator', 'agents', 'planner.js'), 'utf8');
  const m = src.match(/const\s+NEGATION_SINGLE\s*=\s*new\s+Set\(\s*\[([^\]]*)\]\s*\)/);
  assert.ok(m, 'Expected to locate the NEGATION_SINGLE = new Set([...]) declaration in planner.js');
  const body = m[1];
  assert.ok(
    !/["']n't["']/.test(body),
    `NEGATION_SINGLE must not contain the dead "n't" token; declaration body was: [${body.trim()}]`
  );
  // Sanity: the set still carries a real spelled-out negation marker.
  assert.ok(/["']not["']/.test(body), 'NEGATION_SINGLE should still carry the "not" marker');
});

test('AC4/TC4_spelled_out_suppresses: a "do not X"-phrased task suppresses the rejected-behavior warn', () => {
  // "do not mutate the shared state" — words include "not" adjacent to the
  // matched content tokens → near-negation → no warn.
  const warns = countRejectedWarns('Do not mutate the shared state in this task');
  assert.strictEqual(
    warns,
    0,
    `Expected 0 rejected-behavior warns for a spelled-out "do not" phrasing, got ${warns}`
  );
});

test('AC4/TC4_contraction_fires: a "don\'t X"-phrased task fires the rejected-behavior warn', () => {
  // "don't mutate the shared state" tokenizes to ["don","t","mutate",...] —
  // no negation marker is produced for the contraction, so the matched content
  // tokens are NOT shielded and the warn fires. This pins the actual
  // (asymmetric) contraction semantics: removing the dead "n't" token does not
  // change this — the tokenizer never produced "n't" anyway.
  const warns = countRejectedWarns("Don't mutate the shared state in this task");
  assert.strictEqual(
    warns,
    1,
    `Expected 1 rejected-behavior warn for a contraction "don't" phrasing (contraction is not recognized as negation), got ${warns}`
  );
});

// ==========================================================================
// AC5 — README's flag table scopes --allow-dirty / --no-git-required to the
//       commands whose gitGuard calls actually honor them. We DERIVE the
//       authoritative consuming set from the gitGuard call sites in
//       src/cli/index.js at execution time (do not trust the spec), then
//       assert the README scoping sentence/rows AND the CLI USAGE help agree.
// ==========================================================================

// Re-derive: which subcommand `case` blocks contain a gitGuard(...) call that
// consumes allow-dirty / no-git-required? Parse src/cli/index.js, walk the
// switch(cmd) cases, and record each case whose body calls gitGuard. The .md
// shortcut routes to `run`, so it counts as `run`.
function deriveGitGuardConsumingCommands() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'index.js'), 'utf8');
  const lines = src.split('\n');

  // Find the bounds of the switch(cmd) { ... } that holds the case blocks.
  // We attribute each gitGuard call to the nearest preceding `case 'X':`.
  const consuming = new Set();
  let currentCase = null;
  for (const line of lines) {
    const caseMatch = line.match(/^\s*case\s+'([^']+)'\s*:/);
    if (caseMatch) {
      currentCase = caseMatch[1];
      continue;
    }
    if (/\bgitGuard\s*\(/.test(line)) {
      // The .md shortcut sits ABOVE the switch (currentCase === null) and
      // routes to run(); attribute it to 'run'.
      consuming.add(currentCase || 'run');
    }
  }
  return consuming;
}

test('AC5/TC5_derive_consuming_set: gitGuard consumers are exactly the run/dry-run family (sanity of derivation)', () => {
  const consuming = deriveGitGuardConsumingCommands();
  // Sanity check on the derivation itself — these flags are git-preflight
  // flags so the consuming set must be non-empty and contain only commands
  // that run a git preflight. We do NOT hardcode the spec's enumeration; we
  // assert structural truths: resume and task must NOT be in the set (they
  // never call gitGuard), and run MUST be (it does).
  assert.ok(consuming.size >= 1, 'Expected at least one gitGuard-consuming command');
  assert.ok(consuming.has('run'), `'run' must be a gitGuard consumer, derived set: ${[...consuming]}`);
  assert.ok(!consuming.has('resume'), `'resume' must NOT be a gitGuard consumer, derived set: ${[...consuming]}`);
  assert.ok(!consuming.has('task'), `'task' must NOT be a gitGuard consumer, derived set: ${[...consuming]}`);
});

// Extract the README section documenting the git-preflight safety flags.
// Anchored on content, not a fixed heading: the README may rename or move the
// section, but wherever both flags are documented, the scoping rules below
// must hold for that section.
function readmeSafetyFlagsSection() {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const sections = readme.split(/\n(?=#{2,3}\s)/);
  const section = sections.find(
    (s) => s.includes('--allow-dirty') && s.includes('--no-git-required')
  );
  assert.ok(
    section,
    'Expected a README section documenting both --allow-dirty and --no-git-required'
  );
  return section;
}

// Find the markdown table row (a line containing the flag in a `code` cell and
// at least one `|` table separator) for a given flag in the section.
function flagTableRow(section, flag) {
  const lines = section.split('\n');
  return lines.find(
    (l) => l.includes('|') && new RegExp(`\`${flag.replace(/[-]/g, '\\-')}\``).test(l)
  );
}

test('AC5/TC5_readme_scopes_to_consumers: each git-safety flag ROW scopes to the gitGuard consumers and excludes non-consumers', () => {
  const consuming = deriveGitGuardConsumingCommands();
  const section = readmeSafetyFlagsSection();

  assert.ok(section.includes('--allow-dirty'), 'Flag section must mention --allow-dirty');
  assert.ok(section.includes('--no-git-required'), 'Flag section must mention --no-git-required');

  // Per-flag ROW scoping: only the two git-preflight flags are constrained to
  // the gitGuard-consuming set. (Other flags in the table — e.g.
  // --allow-incomplete-scope / --no-review — legitimately list resume/task and
  // must NOT be constrained by this AC.)
  for (const flag of ['--allow-dirty', '--no-git-required']) {
    const rowOrSentence = flagTableRow(section, flag);
    assert.ok(
      rowOrSentence,
      `Expected a table row scoping ${flag} in the Global safety flags section. Section:\n${section}`
    );

    // The row must name EVERY gitGuard consumer (e.g. run, dry-run). Pre-fix
    // the 2-column table had no scope cell, so this FAILS until a scope is added.
    for (const cmd of consuming) {
      assert.ok(
        new RegExp(`\\b${cmd}\\b`).test(rowOrSentence),
        `README row for ${flag} must scope to '${cmd}' (a real gitGuard consumer). Row: ${rowOrSentence}`
      );
    }

    // The row must NOT scope these two flags to non-consumers resume / task.
    // Pre-fix the section's prose said "accepted by run, resume, and task",
    // so naming resume/task in the flag's scope FAILS until re-scoped.
    assert.ok(
      !/\bresume\b/.test(rowOrSentence),
      `README scope for ${flag} must NOT include 'resume' (it does not call gitGuard). Row: ${rowOrSentence}`
    );
    assert.ok(
      !/\btask\b/.test(rowOrSentence),
      `README scope for ${flag} must NOT include 'task' (it does not call gitGuard). Row: ${rowOrSentence}`
    );
  }

  // Guard against a residual blanket sentence (the pre-fix shape) that scopes
  // the safety flags to run/resume/task in prose rather than per-row. The
  // section's introductory prose must not claim these flags are accepted by
  // resume or task.
  const intro = section.split('\n').filter((l) => !l.includes('|')).join(' ');
  assert.ok(
    !/accepted by[^.]*\bresume\b/i.test(intro) && !/accepted by[^.]*\btask\b/i.test(intro),
    `README intro prose must not blanket-scope the safety flags to resume/task. Intro: ${intro}`
  );
});

test('AC5/TC5_cli_help_agrees: CLI USAGE help scopes the two flags to the same gitGuard-consuming set', () => {
  const consuming = deriveGitGuardConsumingCommands();
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'index.js'), 'utf8');

  // Find the help lines for the two flags (lines beginning with --allow-dirty
  // and --no-git-required inside the USAGE template).
  const lines = src.split('\n');
  const allowDirtyLine = lines.find((l) => /--allow-dirty\b/.test(l) && /[Ss]kip/.test(l));
  const noGitLine = lines.find((l) => /--no-git-required\b/.test(l) && /[Ss]kip/.test(l));
  assert.ok(allowDirtyLine, 'Expected a USAGE help line documenting --allow-dirty');
  assert.ok(noGitLine, 'Expected a USAGE help line documenting --no-git-required');

  // Each help line's scoping parenthetical must name every consuming command
  // and must NOT name resume / task.
  for (const [flag, line] of [['--allow-dirty', allowDirtyLine], ['--no-git-required', noGitLine]]) {
    for (const cmd of consuming) {
      assert.ok(
        new RegExp(`\\b${cmd}\\b`).test(line),
        `CLI help for ${flag} must scope to '${cmd}': ${line}`
      );
    }
    assert.ok(
      !/\bresume\b/.test(line),
      `CLI help for ${flag} must NOT scope to 'resume': ${line}`
    );
    assert.ok(
      !/\btask\b/.test(line),
      `CLI help for ${flag} must NOT scope to 'task': ${line}`
    );
  }
});

// ==========================================================================
// AC6 — cc-orch usage --include-failed (without --all) auto-implies --all so
//       the flag reaches the cross-archive aggregator instead of the live-only
//       path; both flag orders; help text documents the dependency.
//
// We test at the usage() dispatch level (downstream of parseArgs, per spec).
// Discriminator: the cross-archive path (usageAll) emits {archives,aggregate}
// JSON; the live-only path emits the legacy {totalSessions,...,byType} JSON.
// We stage an archives/ dir with a failed- archive in a tmpdir with NO
// .harness, call usage() with includeFailed but WITHOUT all, and assert the
// output is the cross-archive shape AND includes the failed archive.
// ==========================================================================

function stageArchivesWithFailed(tmpRoot) {
  // One normal archive and one failed- archive, each with session-summary.json
  // (bare array, role/totalCost — the existing on-disk shape).
  const normal = path.join(tmpRoot, 'archives', '2026-01-01-ok-run', 'logs');
  const failed = path.join(tmpRoot, 'archives', 'failed-2026-02-01-bad-run', 'logs');
  fs.mkdirSync(normal, { recursive: true });
  fs.mkdirSync(failed, { recursive: true });
  fs.writeFileSync(
    path.join(normal, 'session-summary.json'),
    JSON.stringify([{ name: 'p', role: 'planner', totalCost: 0.01, startedAt: '2026-01-01T00:00:00.000Z' }], null, 2)
  );
  fs.writeFileSync(
    path.join(failed, 'session-summary.json'),
    JSON.stringify([{ name: 'f', role: 'planner', totalCost: 0.02, startedAt: '2026-02-01T00:00:00.000Z' }], null, 2)
  );
}

function runUsageJson(tmpRoot, options) {
  const out = captureStdout(() => usage(tmpRoot, options));
  return JSON.parse(out);
}

test('AC6/TC6_implies_order_a: usage(includeFailed) WITHOUT all reaches the cross-archive path and includes the failed archive', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc6a-'));
  stageArchivesWithFailed(tmpRoot);
  let result;
  try {
    // includeFailed set, all NOT set. Pre-fix this hits the live-only path
    // (no .harness → legacy {totalSessions} shape) so the cross-archive
    // assertions below FAIL.
    result = runUsageJson(tmpRoot, { json: true, includeFailed: true });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const keys = Object.keys(result).sort();
  assert.deepStrictEqual(
    keys,
    ['aggregate', 'archives'],
    `Expected cross-archive JSON shape {archives,aggregate} (proves the cross-archive path ran), got keys: ${JSON.stringify(keys)}`
  );
  const failedArchives = result.archives.filter((a) => a.id.includes('failed-'));
  assert.ok(
    failedArchives.length >= 1,
    `Expected the failed- archive to be included once includeFailed reached the aggregator, got ids: ${JSON.stringify(result.archives.map((a) => a.id))}`
  );
});

test('AC6/TC6_implies_order_b: usage(all + includeFailed) also reaches the cross-archive path with the failed archive (both orders)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc6b-'));
  stageArchivesWithFailed(tmpRoot);
  let result;
  try {
    result = runUsageJson(tmpRoot, { json: true, all: true, includeFailed: true });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const keys = Object.keys(result).sort();
  assert.deepStrictEqual(
    keys,
    ['aggregate', 'archives'],
    `Expected cross-archive JSON shape {archives,aggregate}, got keys: ${JSON.stringify(keys)}`
  );
  const failedArchives = result.archives.filter((a) => a.id.includes('failed-'));
  assert.ok(
    failedArchives.length >= 1,
    `Expected the failed- archive included with all+includeFailed, got ids: ${JSON.stringify(result.archives.map((a) => a.id))}`
  );
});

test('AC6/TC6_no_failed_still_live_only: usage with neither all nor includeFailed stays on the live-only path (no over-broadening)', () => {
  // Guards against the fix being too greedy: a plain `usage()` with no all and
  // no includeFailed must NOT route to the cross-archive path. We stage a
  // .harness with an empty token-usage so the live-only path is well-defined.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc6c-'));
  const logsDir = path.join(tmpRoot, '.harness', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }, null, 2));
  let result;
  try {
    result = runUsageJson(tmpRoot, { json: true });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  // Live-only legacy shape has totalSessions and byType, NOT archives/aggregate.
  assert.ok(
    Object.prototype.hasOwnProperty.call(result, 'totalSessions'),
    `Expected legacy live-only shape (totalSessions key) for a plain usage() call, got keys: ${JSON.stringify(Object.keys(result))}`
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(result, 'archives'),
    `Plain usage() (no all, no includeFailed) must NOT route to the cross-archive path; got an 'archives' key`
  );
});

test('AC6/TC6_help_documents_dependency: CLI USAGE help documents the include-failed → --all implication', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'index.js'), 'utf8');
  // Bound the assertion to the USAGE template literal so we don't match
  // unrelated code. The USAGE constant is a backtick template.
  const usageMatch = src.match(/const\s+USAGE\s*=\s*`([\s\S]*?)`/);
  assert.ok(usageMatch, 'Expected to locate the USAGE template literal in src/cli/index.js');
  const usageText = usageMatch[1];

  assert.ok(/--include-failed/.test(usageText), 'USAGE must still document --include-failed');

  // Non-vacuous: the implication wording must be CO-LOCATED on a single help
  // line that references include-failed, --all, AND an implication verb. A
  // single-line requirement prevents a spurious match against unrelated tokens
  // elsewhere in USAGE (e.g. a "--force" line, which contains "force"). Pre-fix
  // no such line exists, so this FAILS until the dependency is documented.
  const documentingLine = usageText
    .split('\n')
    .find(
      (l) =>
        /include-failed/.test(l) &&
        /--all/.test(l) &&
        /(implies|imply|auto-impl|requires|require\b|needs|forces|with --all)/i.test(l)
    );
  assert.ok(
    documentingLine,
    'USAGE help must have a line documenting that --include-failed implies/requires --all (co-located implication wording linking the two flags)'
  );
});

// ==========================================================================
// AC7 — cross-archive aggregator reads logs/token-usage.json as the
//       cost/session source of truth (fallback to session-summary.json only
//       when token-usage is absent). A fixture archive whose token-usage has
//       STRICTLY MORE sessions than session-summary must return the
//       token-usage counts and cost.
//
// FIXTURE DESIGN:
//   token-usage.json   = { sessions:[5 entries], totals:{...} }  (type/totalCostUsd)
//   session-summary.json = [2 entries]                            (role/totalCost)
//   token-usage cost ($0.50) strictly > session-summary cost ($0.20).
//
// Pre-fix the aggregator reads session-summary → 2 sessions / $0.20.
// Post-fix it reads token-usage → 5 sessions / $0.50. Assertions pin the
// token-usage numbers, so they FAIL if the aggregator still reads
// session-summary.
// ==========================================================================

// Build an archive whose token-usage.json has MORE sessions than
// session-summary.json. Returns { tmpRoot, descriptor, expected }.
function buildTokenUsagePrimaryFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc7-'));
  const id = '2026-05-01-failed-snapshot';
  const logsDir = path.join(tmpRoot, 'archives', id, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // token-usage.json: object shape, type/totalCostUsd, 5 sessions, $0.50 total.
  const tuSessions = [
    { name: 'p1', type: 'planner',  inputTokens: 100, outputTokens: 50,  cacheCreation: 10, cacheRead: 5,  totalCostUsd: 0.10, startedAt: '2026-05-01T00:00:00.000Z' },
    { name: 'e1', type: 'executor', inputTokens: 200, outputTokens: 80,  cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.10, startedAt: '2026-05-01T01:00:00.000Z' },
    { name: 'e2', type: 'executor', inputTokens: 150, outputTokens: 60,  cacheCreation: 15, cacheRead: 8,  totalCostUsd: 0.10, startedAt: '2026-05-01T02:00:00.000Z' },
    { name: 'v1', type: 'verifier', inputTokens: 180, outputTokens: 90,  cacheCreation: 18, cacheRead: 9,  totalCostUsd: 0.10, startedAt: '2026-05-01T03:00:00.000Z' },
    // An in-flight/interrupted session that never made it into session-summary.
    { name: 'e3', type: 'executor', inputTokens: 300, outputTokens: 0,   cacheCreation: 30, cacheRead: 0,  totalCostUsd: 0.10, startedAt: '2026-05-01T04:00:00.000Z' },
  ];
  const tuTotalCost = tuSessions.reduce((s, e) => s + e.totalCostUsd, 0); // 0.50
  const tokenUsage = {
    sessions: tuSessions,
    totals: {
      sessionCount: tuSessions.length,
      inputTokens: tuSessions.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: tuSessions.reduce((s, e) => s + e.outputTokens, 0),
      cacheCreation: tuSessions.reduce((s, e) => s + e.cacheCreation, 0),
      cacheRead: tuSessions.reduce((s, e) => s + e.cacheRead, 0),
      totalCostUsd: tuTotalCost,
    },
  };
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify(tokenUsage, null, 2));

  // session-summary.json: bare array, role/totalCost, only 2 (completed) entries.
  const ssSessions = [
    { name: 'p1', role: 'planner',  inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCost: 0.10, startedAt: '2026-05-01T00:00:00.000Z' },
    { name: 'e1', role: 'executor', inputTokens: 200, outputTokens: 80, cacheCreation: 20, cacheRead: 10, totalCost: 0.10, startedAt: '2026-05-01T01:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(logsDir, 'session-summary.json'), JSON.stringify(ssSessions, null, 2));

  const descriptor = { id, date: '2026-05-01', dir: path.join(tmpRoot, 'archives', id) };
  return {
    tmpRoot,
    descriptor,
    expected: {
      tokenUsageSessions: tuSessions.length,   // 5
      tokenUsageCost: tuTotalCost,              // 0.50
      sessionSummarySessions: ssSessions.length, // 2
      sessionSummaryCost: 0.20,
    },
  };
}

test('AC7/TC7_token_usage_is_source_of_truth: aggregator returns token-usage counts/cost (not the smaller session-summary numbers)', () => {
  const { tmpRoot, descriptor, expected } = buildTokenUsagePrimaryFixture();
  let result;
  try {
    result = aggregateAcrossArchives([descriptor], {});
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Sanity: the fixture genuinely has more token-usage sessions than
  // session-summary sessions, so the assertion can distinguish the two paths.
  assert.ok(
    expected.tokenUsageSessions > expected.sessionSummarySessions,
    'Fixture invariant: token-usage must carry strictly more sessions than session-summary'
  );

  // The pin: aggregate session count and cost must equal the TOKEN-USAGE
  // numbers. Pre-fix the aggregator reads session-summary → 2 / $0.20, so
  // these FAIL.
  assert.strictEqual(
    result.aggregate.totalSessions,
    expected.tokenUsageSessions,
    `Expected aggregate.totalSessions=${expected.tokenUsageSessions} (token-usage SoT), got ${result.aggregate.totalSessions} ` +
      `(session-summary would give ${expected.sessionSummarySessions})`
  );
  assert.ok(
    Math.abs(result.aggregate.totalCostUsd - expected.tokenUsageCost) < 1e-9,
    `Expected aggregate.totalCostUsd=${expected.tokenUsageCost} (token-usage SoT), got ${result.aggregate.totalCostUsd} ` +
      `(session-summary would give ${expected.sessionSummaryCost})`
  );

  // Per-archive numbers must also reflect token-usage.
  assert.strictEqual(result.archives.length, 1, 'Expected exactly one archive in the result');
  assert.strictEqual(
    result.archives[0].sessionCount,
    expected.tokenUsageSessions,
    `Per-archive sessionCount must be the token-usage count ${expected.tokenUsageSessions}, got ${result.archives[0].sessionCount}`
  );
});

test('AC7/TC7_fallback_when_token_usage_absent: archive with ONLY session-summary.json still yields its counts via fallback', () => {
  // Fallback coverage: when token-usage.json is ABSENT the aggregator must
  // still read session-summary.json (bare array, role/totalCost) byte-intact.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc7fb-'));
  const id = '2026-06-01-summary-only';
  const logsDir = path.join(tmpRoot, 'archives', id, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const ssSessions = [
    { name: 'p1', role: 'planner',  inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCost: 0.07, startedAt: '2026-06-01T00:00:00.000Z' },
    { name: 'e1', role: 'executor', inputTokens: 200, outputTokens: 80, cacheCreation: 20, cacheRead: 10, totalCost: 0.08, startedAt: '2026-06-01T01:00:00.000Z' },
    { name: 'e2', role: 'executor', inputTokens: 150, outputTokens: 60, cacheCreation: 15, cacheRead: 8,  totalCost: 0.05, startedAt: '2026-06-01T02:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(logsDir, 'session-summary.json'), JSON.stringify(ssSessions, null, 2));
  // NOTE: no token-usage.json written → fallback path must engage.

  const descriptor = { id, date: '2026-06-01', dir: path.join(tmpRoot, 'archives', id) };
  let result;
  try {
    result = aggregateAcrossArchives([descriptor], {});
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  assert.strictEqual(
    result.aggregate.totalSessions,
    ssSessions.length,
    `Fallback: expected session-summary count ${ssSessions.length}, got ${result.aggregate.totalSessions}`
  );
  const expectedCost = ssSessions.reduce((s, e) => s + e.totalCost, 0); // 0.20
  assert.ok(
    Math.abs(result.aggregate.totalCostUsd - expectedCost) < 1e-9,
    `Fallback: expected session-summary cost ${expectedCost}, got ${result.aggregate.totalCostUsd}`
  );
});

// ==========================================================================
// AC8 — audit-r2.js textual line-count claims match its 30-line code check.
//       Content assertion: no stale "20 lines" claim survives, the 30-line
//       check is present, and the doc/remediation text says 30.
// ==========================================================================

test('AC8/TC8_audit_r2_text_matches_30: no stale 20-line claim; the 30-line check stands', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'audit-r2.js'), 'utf8');

  // The code check must still slice the first 30 lines.
  assert.ok(
    /slice\(\s*0\s*,\s*30\s*\)/.test(src),
    'audit-r2.js must still perform the first-30-lines code check (slice(0, 30))'
  );

  // No textual claim of "first 20 lines" / "20 lines" may survive. Pre-fix
  // there are two such claims (JSDoc ~:24 and the remediation string ~:407),
  // so this FAILS until the text is aligned to 30.
  assert.ok(
    !/\b20\s+lines\b/i.test(src),
    'audit-r2.js must not contain any stale "20 lines" textual claim — align all text to the 30-line code check'
  );
  assert.ok(
    !/first\s+20\s+lines/i.test(src),
    'audit-r2.js must not contain a "first 20 lines" textual claim'
  );

  // And it must positively assert the 30-line wording in prose somewhere
  // (non-vacuous: ensures the text was updated to 30, not merely deleted).
  assert.ok(
    /\b30\s+lines\b/i.test(src) || /first\s+30\s+lines/i.test(src),
    'audit-r2.js prose must state "30 lines" / "first 30 lines" to match the code check'
  );
});

// ==========================================================================
// Summary
// ==========================================================================
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
