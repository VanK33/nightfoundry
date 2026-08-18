/**
 * test-init-onboarding.js — Unit + CLI-wiring tests for `cc-orch init`'s
 * onboarding scaffold (src/cli/commands/init.js) and the shipped guidance
 * template it deploys (src/cli/templates/nightfoundry-guidance.md).
 *
 * No Claude auth, no SDK, no network. Pure fs + temp directories
 * (fs.mkdtempSync fixture roots, realpathed immediately — os.tmpdir() is
 * symlinked on macOS, /tmp -> /private/tmp) plus a handful of non-TTY
 * spawnSync CLI invocations for the wiring legs. Every fixture root is
 * fresh and cleaned up in a finally block.
 *
 * Acceptance cases:
 *   (A) scaffold creation — four verbatim anchor-sentence pins, a negative
 *       pin ('TC-PIN' never appears), and the template size ceiling
 *       (<=30 lines, exactly four headings), read from the shipped
 *       template asset.
 *   (B) create-only/idempotence — a second init produces a byte-identical
 *       nightfoundry-guidance.md; a pre-seeded CLAUDE.local.md (no trailing
 *       newline) and a pre-seeded user .gitignore have their bytes
 *       preserved, with the append-newline clause exercised.
 *   (C) .gitignore managed block — both markers, the eight patterns, and
 *       the archives/ directory not being blanket-excluded (only its two
 *       cross-run ledger files are).
 *   (D) non-git fixture — init completes fail-soft, no throw.
 *   (E) guardFreshRoot unit legs — in-process, stubbing
 *       process.stdout.isTTY and process.exit (restored in `finally`).
 *   (F) CLI wiring legs — non-TTY spawnSync invocations of run/dry-run/
 *       brainstorm/the .md shortcut/status, never passing --auto/-a.
 *   (G) loadProjectConfig inertness — init never writes a live
 *       .nightfoundry.json (nor a legacy .cc-orch.json), so loadProjectConfig
 *       stays a no-op against an init-only root.
 *   (H) freshness legs — refresh, opt-out, dangling, staleness,
 *       fresh-stamp silence, bare-harness, opt-out-with-residue, and
 *       fail-soft EISDIR.
 *   (I) old-surface (pre-rename) migration legs — a pre-seeded marked
 *       legacy .claude/skills/cc-orch-operator/ is removed while the new
 *       nightfoundry-operator/ deploy lands; an unmarked legacy skill dir
 *       is preserved byte-identical; a stamped legacy cc-orch-guidance.md
 *       is removed while nightfoundry-guidance.md is written; an unstamped
 *       legacy guidance file is preserved byte-identical; a pre-seeded
 *       CLAUDE.local.md carrying the old '@cc-orch-guidance.md' import
 *       line has only that line rewritten (surrounding bytes preserved,
 *       exactly one import line surviving); a second init on that root is
 *       byte-identical.
 *   (J) dual-read config precedence — loadProjectConfig against fresh temp
 *       roots: a root holding only .nightfoundry.json applies its override;
 *       a root holding only the legacy .cc-orch.json applies its override;
 *       a root holding BOTH resolves to the .nightfoundry.json value and
 *       emits exactly one captured console line naming the shadowed
 *       .cc-orch.json, never throwing. config.execution.testCommand/
 *       testAllCommand are restored to their pre-leg values after each leg.
 *
 * Run: node test/test-init-onboarding.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync as childSpawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { init, guardFreshRoot } from '../src/cli/commands/init.js';
import { loadProjectConfig } from '../src/orchestrator/infra/project-config.js';
import config from '../src/orchestrator/infra/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failCount++;
  }
}

// ── fixture helpers (mirrors test-git-excludes.js) ─────────────────────────

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-init-onboard-')));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── guardFreshRoot in-process stub harness ──────────────────────────────────

class ExitSentinel extends Error {
  constructor(code) {
    super(`process.exit(${code}) called`);
    this.code = code;
  }
}

/**
 * Runs `fn` with process.stdout.isTTY forced to `isTTY`, process.exit
 * replaced with a throwing sentinel, and console.error captured — all
 * three restored in a finally block regardless of outcome.
 * @returns {{ stderrLines: string[], threwSentinel: ExitSentinel|null, threwOther: Error|null }}
 */
function withGuardStubs({ isTTY }, fn) {
  const originalExit = process.exit;
  const originalIsTTY = process.stdout.isTTY;
  const originalConsoleError = console.error;
  const stderrLines = [];
  let threwSentinel = null;
  let threwOther = null;

  process.stdout.isTTY = isTTY;
  process.exit = (code) => { throw new ExitSentinel(code); };
  console.error = (...args) => { stderrLines.push(args.join(' ')); };

  try {
    fn();
  } catch (err) {
    if (err instanceof ExitSentinel) {
      threwSentinel = err;
    } else {
      threwOther = err;
    }
  } finally {
    process.exit = originalExit;
    process.stdout.isTTY = originalIsTTY;
    console.error = originalConsoleError;
  }

  return { stderrLines, threwSentinel, threwOther };
}

// ── CLI spawn helper (mirrors test-cli-router.js) ───────────────────────────

const cliPath = path.resolve(__dirname, '../src/cli/index.js');

function spawnCli(args, opts = {}) {
  return childSpawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env },
    timeout: 10000,
    encoding: 'utf8',
    ...opts,
  });
}

// ── shared constants ─────────────────────────────────────────────────────

const TEMPLATE_PATH = path.resolve(__dirname, '../src/cli/templates/nightfoundry-guidance.md');

// Verbatim anchor sentences, one per heading, read from the shipped
// template asset (src/cli/templates/nightfoundry-guidance.md) at the time
// this test was written. A real content edit to the template is expected to
// update these pins deliberately, not silently.
const ANCHOR_SENTENCES = [
  'This file is machine-managed by nightfoundry; re-running nightfoundry init refreshes it.',
  'Runs live under .harness/, pending work under queue/, delivered runs under archives/.',
  "Record this project's lessons, decisions, and TODOs in this project's own files.",
  'This repo ships the nightfoundry operator skill at .claude/skills/nightfoundry-operator/ — your session loads project skills automatically; read references/spec-authoring.md before hand-writing a spec and references/debugging.md when a run stops.',
];

const GITIGNORE_PATTERNS = [
  '/.harness/',
  '/queue/',
  '/spec-*.md',
  '/*.spec.md',
  '/*.spec.json',
  '/*.uspec.json',
  '/archives/candidates.jsonl',
  '/archives/warnings.jsonl',
  '/CLAUDE.local.md',
  '/nightfoundry-guidance.md',
];

const FRESH_HINT = 'fresh project — run `cc-orch init` first for scaffolding + AI guidance';
const REFUSAL_TEXT = 'Refusing:';

// ── (A) scaffold creation: anchors, negative pin, size ceiling ─────────────

function acA_scaffoldAnchorsNegativePinSizeCeiling() {
  console.log('\n=== (A) scaffold creation — anchors, negative pin, size ceiling ===\n');
  const root = makeTmpRoot();
  try {
    init(root);

    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    assert('scaffold: nightfoundry-guidance.md created', fs.existsSync(guidancePath));

    const deployed = fs.readFileSync(guidancePath, 'utf8');
    for (const sentence of ANCHOR_SENTENCES) {
      assert(`scaffold: anchor sentence present — "${sentence}"`, deployed.includes(sentence));
    }

    assert("scaffold negative pin: deployed guidance contains no literal 'TC-PIN'",
      !deployed.includes('TC-PIN'));

    const templateText = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const rawLines = templateText.split('\n');
    // A single trailing newline produces one trailing empty element; that
    // element is not itself a "line" of content, so it is excluded from
    // the ceiling count.
    const lineCount = rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length;
    assert(`scaffold: template size ceiling — <=30 lines (got ${lineCount})`, lineCount <= 30);

    const headingCount = rawLines.filter((l) => l.startsWith('# ')).length;
    assert(`scaffold: template has exactly four headings (got ${headingCount})`, headingCount === 4);
  } catch (err) {
    assert(`(A): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (B) create-only / idempotence ───────────────────────────────────────────

function acB_createOnlyAndIdempotence() {
  console.log('\n=== (B) create-only / idempotence ===\n');
  const root = makeTmpRoot();
  try {
    const claudeLocalPath = path.join(root, 'CLAUDE.local.md');
    const preSeededClaudeLocal = '# My project notes\nSome existing content, no trailing newline';
    fs.writeFileSync(claudeLocalPath, preSeededClaudeLocal, 'utf8');

    const gitignorePath = path.join(root, '.gitignore');
    const preSeededGitignore = 'node_modules/\ndist/\n';
    fs.writeFileSync(gitignorePath, preSeededGitignore, 'utf8');

    init(root);

    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    const guidanceAfterFirst = fs.readFileSync(guidancePath);

    const claudeLocalAfterFirst = fs.readFileSync(claudeLocalPath, 'utf8');
    assert('create-only: pre-existing CLAUDE.local.md content preserved verbatim',
      claudeLocalAfterFirst.startsWith(preSeededClaudeLocal));
    assert('create-only: a newline was inserted after the no-trailing-newline pre-existing content',
      claudeLocalAfterFirst.charAt(preSeededClaudeLocal.length) === '\n');
    assert('create-only: import line appended to CLAUDE.local.md',
      claudeLocalAfterFirst.includes('@nightfoundry-guidance.md'));

    const gitignoreAfterFirst = fs.readFileSync(gitignorePath, 'utf8');
    assert('create-only: pre-existing user .gitignore content preserved verbatim',
      gitignoreAfterFirst.startsWith(preSeededGitignore));

    // Second init — idempotence.
    init(root);

    const guidanceAfterSecond = fs.readFileSync(guidancePath);
    assert('idempotence: nightfoundry-guidance.md byte-identical after second init',
      Buffer.compare(guidanceAfterFirst, guidanceAfterSecond) === 0);

    const claudeLocalAfterSecond = fs.readFileSync(claudeLocalPath, 'utf8');
    assert('idempotence: CLAUDE.local.md byte-identical after second init (import already present)',
      claudeLocalAfterSecond === claudeLocalAfterFirst);

    const gitignoreAfterSecond = fs.readFileSync(gitignorePath, 'utf8');
    assert('idempotence: .gitignore byte-identical after second init (markers already present)',
      gitignoreAfterSecond === gitignoreAfterFirst);
  } catch (err) {
    assert(`(B): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (C) .gitignore managed block ────────────────────────────────────────────

function acC_gitignoreManagedBlock() {
  console.log('\n=== (C) .gitignore managed block ===\n');
  const root = makeTmpRoot();
  try {
    init(root);

    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const lines = content.split('\n').map((l) => l.trim());

    assert('gitignore: begin marker present', lines.includes('# >>> cc-orch >>>'));
    assert('gitignore: end marker present', lines.includes('# <<< cc-orch <<<'));

    for (const p of GITIGNORE_PATTERNS) {
      assert(`gitignore: pattern present — ${p}`, lines.includes(p));
    }

    // The archives/ DIRECTORY is never blanket-excluded (forensic archives
    // stay committable); only the two cross-run ledger FILES are — the loop
    // above already asserts those two patterns are present.
    assert("gitignore: archives/ directory itself NOT excluded (only ledger files)",
      !lines.some((l) => l === 'archives/' || l === '/archives/'));
  } catch (err) {
    assert(`(C): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (D) non-git fail-soft leg ────────────────────────────────────────────────

function acD_nonGitFailSoft() {
  console.log('\n=== (D) non-git fail-soft leg ===\n');
  const root = makeTmpRoot(); // NOT a git repo — no `git init`.
  try {
    let threw = false;
    try {
      init(root);
    } catch {
      threw = true;
    }
    assert('non-git: init() does not throw on a non-git fixture root', threw === false);
    assert('non-git: no .git directory materialized as a side effect',
      !fs.existsSync(path.join(root, '.git')));
    assert('non-git: nightfoundry-guidance.md still deployed',
      fs.existsSync(path.join(root, 'nightfoundry-guidance.md')));
  } finally {
    cleanup(root);
  }
}

// ── (E) guardFreshRoot unit legs ─────────────────────────────────────────────

function acE_guardFreshRootUnitLegs() {
  console.log('\n=== (E) guardFreshRoot unit legs (in-process stubs) ===\n');
  const root = makeTmpRoot();
  try {
    // Refuse + fresh TTY → process.exit(1) sentinel thrown, refusal on stderr.
    {
      const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: true }, () => {
        guardFreshRoot(root, { refuse: true });
      });
      assert('unit: refuse+isTTY on fresh root throws the process.exit sentinel',
        threwSentinel !== null);
      assert('unit: no exception other than the sentinel', threwOther === null);
      assert('unit: process.exit called with code 1', threwSentinel && threwSentinel.code === 1);
      assert('unit: refusal text (naming cc-orch init) printed to stderr',
        stderrLines.some((l) => l.includes(REFUSAL_TEXT) && l.includes('cc-orch init')));
    }

    // Fail-soft paths: refuse+non-TTY and refuse:false+isTTY both proceed
    // with a hint, never exit.
    {
      const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
        guardFreshRoot(root, { refuse: true });
      });
      assert('unit: refuse+non-TTY does not exit (fail-soft)',
        threwSentinel === null && threwOther === null);
      assert('unit: refuse+non-TTY prints the fresh-project hint',
        stderrLines.some((l) => l.includes(FRESH_HINT)));
      assert('unit: refuse+non-TTY does not print the refusal text',
        !stderrLines.some((l) => l.includes(REFUSAL_TEXT)));
    }
    {
      const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: true }, () => {
        guardFreshRoot(root, { refuse: false });
      });
      assert('unit: refuse:false+isTTY does not exit',
        threwSentinel === null && threwOther === null);
      assert('unit: refuse:false+isTTY prints the fresh-project hint',
        stderrLines.some((l) => l.includes(FRESH_HINT)));
    }

    // Stubs must be fully restored after each call.
    assert('unit: process.exit restored to a real function after stubbing',
      typeof process.exit === 'function' && !(process.exit instanceof ExitSentinel));
  } catch (err) {
    assert(`(E): unexpected exception escaped the stub harness — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (F) CLI wiring legs (non-TTY spawnSync) ─────────────────────────────────

function acF_cliWiringFreshHint() {
  console.log('\n=== (F) CLI wiring — run/dry-run/brainstorm fresh-project hint ===\n');
  for (const args of [['run'], ['dry-run'], ['brainstorm']]) {
    const root = makeTmpRoot();
    try {
      // Deliberately never pass --auto/-a — these legs exercise the guard,
      // not agent execution.
      const result = spawnCli(args, { cwd: root });
      const combined = `${result.stdout || ''}${result.stderr || ''}`;

      assert(`CLI wiring (${args[0]}): fresh-project hint printed`,
        combined.includes(FRESH_HINT));
      assert(`CLI wiring (${args[0]}): no refusal-exit text present`,
        !combined.includes(REFUSAL_TEXT));
      assert(`CLI wiring (${args[0]}): process exited cleanly (non-null status)`,
        result.status !== null);
    } finally {
      cleanup(root);
    }
  }
}

function acF_cliWiringMdShortcutFileNotFound() {
  console.log('\n=== (F) CLI wiring — .md shortcut on nonexistent spec ===\n');
  const root = makeTmpRoot();
  try {
    const specRel = 'nonexistent-spec.md';
    const result = spawnCli([specRel], { cwd: root });
    const combined = `${result.stdout || ''}${result.stderr || ''}`;

    assert('.md shortcut: fresh-project hint printed', combined.includes(FRESH_HINT));
    assert('.md shortcut: no refusal-exit text present', !combined.includes(REFUSAL_TEXT));
    assert('.md shortcut: File-not-found error printed (guard ran before existsSync)',
      combined.includes(`File not found: ${specRel}`));
    assert('.md shortcut: exits non-zero', result.status !== 0);
  } finally {
    cleanup(root);
  }
}

function acF_cliWiringStatus() {
  console.log('\n=== (F) CLI wiring — status ===\n');
  const root = makeTmpRoot();
  try {
    const result = spawnCli(['status'], { cwd: root });
    const combined = `${result.stdout || ''}${result.stderr || ''}`;

    assert('status: fresh-project hint printed', combined.includes(FRESH_HINT));
    assert("status: 'No .harness/state.json found' error printed",
      combined.includes('No .harness/state.json found'));
    assert('status: exits 1', result.status === 1);
  } finally {
    cleanup(root);
  }
}

// ── (G) loadProjectConfig inertness pin ─────────────────────────────────────

function acG_loadProjectConfigInertness() {
  console.log('\n=== (G) loadProjectConfig inertness pin ===\n');
  const root = makeTmpRoot();
  try {
    init(root);

    assert('inertness: init does not write a live .nightfoundry.json',
      !fs.existsSync(path.join(root, '.nightfoundry.json')));
    assert('inertness: init does not write a live legacy .cc-orch.json',
      !fs.existsSync(path.join(root, '.cc-orch.json')));
    assert('inertness: init writes only .nightfoundry.json.example',
      fs.existsSync(path.join(root, '.nightfoundry.json.example')));

    const before = {
      testCommand: config.execution.testCommand,
      testAllCommand: config.execution.testAllCommand,
    };

    let threw = false;
    try {
      loadProjectConfig(root);
    } catch {
      threw = true;
    }

    assert('inertness: loadProjectConfig does not throw against an init-only root', threw === false);
    assert('inertness: config.execution.testCommand left untouched',
      config.execution.testCommand === before.testCommand);
    assert('inertness: config.execution.testAllCommand left untouched',
      config.execution.testAllCommand === before.testAllCommand);
  } catch (err) {
    assert(`(G): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (H) freshness legs ───────────────────────────────────────────────────────

function acH_freshStampSilence() {
  console.log('\n=== (H) freshness — fresh-stamp silence ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true });
    });
    assert('fresh-stamp: no exception', threwSentinel === null && threwOther === null);
    assert('fresh-stamp: silent — no stderr output right after init', stderrLines.length === 0);
  } catch (err) {
    assert(`(H fresh-stamp): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_staleness() {
  console.log('\n=== (H) freshness — staleness (stamp mismatch) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    const original = fs.readFileSync(guidancePath, 'utf8');
    const tampered = original.replace(
      /<!-- cc-orch-guidance-hash: [0-9a-f]{12} -->/,
      '<!-- cc-orch-guidance-hash: 000000000000 -->'
    );
    assert('staleness fixture: stamp line actually mutated', tampered !== original);
    fs.writeFileSync(guidancePath, tampered, 'utf8');

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true, readChannel: () => 'stable' });
    });
    assert('staleness: no exception', threwSentinel === null && threwOther === null);
    assert('staleness: outdated hint printed',
      stderrLines.some((l) => l.includes('nightfoundry-guidance.md is outdated') && l.includes('cc-orch init')));
  } catch (err) {
    assert(`(H staleness): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_refresh() {
  console.log('\n=== (H) freshness — refresh (re-init silences a stale stamp) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    const original = fs.readFileSync(guidancePath, 'utf8');
    const tampered = original.replace(
      /<!-- cc-orch-guidance-hash: [0-9a-f]{12} -->/,
      '<!-- cc-orch-guidance-hash: 000000000000 -->'
    );
    fs.writeFileSync(guidancePath, tampered, 'utf8');

    const stale = withGuardStubs({ isTTY: false }, () => guardFreshRoot(root, { refuse: true, readChannel: () => 'stable' }));
    assert('refresh precondition: stale stamp produces the outdated hint',
      stale.stderrLines.some((l) => l.includes('outdated')));

    // The remediation the hint advertises: re-running init refreshes it.
    init(root);
    const refreshed = withGuardStubs({ isTTY: false }, () => guardFreshRoot(root, { refuse: true }));
    assert('refresh: no exception on the refreshed check',
      refreshed.threwSentinel === null && refreshed.threwOther === null);
    assert('refresh: re-running init silences the outdated hint', refreshed.stderrLines.length === 0);
  } catch (err) {
    assert(`(H refresh): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_dangling() {
  console.log('\n=== (H) freshness — dangling (guidance missing) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    fs.rmSync(path.join(root, 'nightfoundry-guidance.md'));

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true, readChannel: () => 'stable' });
    });
    assert('dangling: no exception', threwSentinel === null && threwOther === null);
    assert('dangling: hint printed',
      stderrLines.some((l) => l.includes('nightfoundry-guidance.md is missing') && l.includes('CLAUDE.local.md still imports it')));
  } catch (err) {
    assert(`(H dangling): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_optOut() {
  console.log('\n=== (H) freshness — opt-out (import line deleted) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    // Simulate the user deleting the import line — a clean opt-out.
    fs.writeFileSync(path.join(root, 'CLAUDE.local.md'), '# My own notes, no import\n', 'utf8');
    fs.rmSync(path.join(root, 'nightfoundry-guidance.md'));

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true });
    });
    assert('opt-out: no exception', threwSentinel === null && threwOther === null);
    assert('opt-out: silent — absent import line silences all checks', stderrLines.length === 0);
  } catch (err) {
    assert(`(H opt-out): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_optOutWithResidue() {
  console.log('\n=== (H) freshness — opt-out-with-residue (stale guidance file left behind) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    const residue = fs.readFileSync(guidancePath, 'utf8');
    // Delete the import line but leave nightfoundry-guidance.md on disk.
    fs.writeFileSync(path.join(root, 'CLAUDE.local.md'), '# My own notes, no import\n', 'utf8');

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true });
    });
    assert('opt-out-with-residue: no exception', threwSentinel === null && threwOther === null);
    assert('opt-out-with-residue: silent — a stale guidance file never nags a user who opted out',
      stderrLines.length === 0);
    assert('opt-out-with-residue: residue file left byte-untouched on disk',
      fs.readFileSync(guidancePath, 'utf8') === residue);
  } catch (err) {
    assert(`(H opt-out-with-residue): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_bareHarness() {
  console.log('\n=== (H) freshness — bare-harness (.harness present, never onboarded) ===\n');
  const root = makeTmpRoot();
  try {
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true });
    });
    assert('bare-harness: no exception', threwSentinel === null && threwOther === null);
    assert('bare-harness: silent — no CLAUDE.local.md means no import line to react to',
      stderrLines.length === 0);
  } catch (err) {
    assert(`(H bare-harness): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acH_failSoftEISDIR() {
  console.log('\n=== (H) freshness — fail-soft EISDIR (guidance is a directory) ===\n');
  const root = makeTmpRoot();
  try {
    init(root);
    const guidancePath = path.join(root, 'nightfoundry-guidance.md');
    fs.rmSync(guidancePath);
    fs.mkdirSync(guidancePath);

    const { stderrLines, threwSentinel, threwOther } = withGuardStubs({ isTTY: false }, () => {
      guardFreshRoot(root, { refuse: true });
    });
    assert('fail-soft EISDIR: no exception escapes even though guidance path is a directory',
      threwSentinel === null && threwOther === null);
    assert('fail-soft EISDIR: silent — the fs error is swallowed, no stderr output',
      stderrLines.length === 0);
  } catch (err) {
    assert(`(H fail-soft EISDIR): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (I) old-surface (pre-rename) migration legs ─────────────────────────────

// TC1: a pre-seeded marked legacy skill dir (SKILL.md + the sidecar marker
// '.cc-orch-skill.json') is removed entirely by init, while the new
// nightfoundry-operator/ deploy lands alongside it.
function acI_tc1_markedLegacySkillDirRemoved() {
  console.log('\n=== (I) TC1 — marked legacy skill dir removed, new deploy present ===\n');
  const root = makeTmpRoot();
  try {
    const oldSkillDir = path.join(root, '.claude', 'skills', 'cc-orch-operator');
    fs.mkdirSync(oldSkillDir, { recursive: true });
    fs.writeFileSync(path.join(oldSkillDir, 'SKILL.md'), '# legacy skill\n', 'utf8');
    fs.writeFileSync(
      path.join(oldSkillDir, '.cc-orch-skill.json'),
      JSON.stringify({ version: '0.0.0', releaseChannel: 'stable', hash: '000000000000' }, null, 2) + '\n',
      'utf8'
    );

    init(root);

    assert('TC1: legacy .claude/skills/cc-orch-operator/ absent after init',
      !fs.existsSync(oldSkillDir));
    assert('TC1: new .claude/skills/nightfoundry-operator/SKILL.md exists after init',
      fs.existsSync(path.join(root, '.claude', 'skills', 'nightfoundry-operator', 'SKILL.md')));
  } catch (err) {
    assert(`(I TC1): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// TC2: a legacy skill dir with the SAME name but NO sidecar marker is
// user/foreign-owned as far as init can prove, so it must be left
// byte-identical.
function acI_tc2_unmarkedLegacySkillDirPreserved() {
  console.log('\n=== (I) TC2 — unmarked legacy skill dir preserved byte-identical ===\n');
  const root = makeTmpRoot();
  try {
    const oldSkillDir = path.join(root, '.claude', 'skills', 'cc-orch-operator');
    fs.mkdirSync(oldSkillDir, { recursive: true });
    const skillMdPath = path.join(oldSkillDir, 'SKILL.md');
    fs.writeFileSync(skillMdPath, '# my own skill, not machine-owned\n', 'utf8');

    const before = fs.readFileSync(skillMdPath);

    init(root);

    assert('TC2: unmarked legacy skill dir still present after init', fs.existsSync(skillMdPath));
    const after = fs.readFileSync(skillMdPath);
    assert('TC2: unmarked legacy SKILL.md byte-identical after init',
      Buffer.compare(before, after) === 0);
    assert('TC2: no sidecar marker was introduced into the unmarked legacy dir',
      !fs.existsSync(path.join(oldSkillDir, '.cc-orch-skill.json')));
  } catch (err) {
    assert(`(I TC2): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// TC3: a stamped legacy cc-orch-guidance.md (first line matches the machine
// stamp format) is removed by init, while nightfoundry-guidance.md is written.
function acI_tc3_stampedLegacyGuidanceRemoved() {
  console.log('\n=== (I) TC3 — stamped legacy guidance removed, nightfoundry-guidance.md written ===\n');
  const root = makeTmpRoot();
  try {
    const oldGuidancePath = path.join(root, 'cc-orch-guidance.md');
    fs.writeFileSync(
      oldGuidancePath,
      '<!-- cc-orch-guidance-hash: 000000000000 -->\n# Legacy guidance\nOld content.\n',
      'utf8'
    );

    init(root);

    assert('TC3: legacy cc-orch-guidance.md absent after init', !fs.existsSync(oldGuidancePath));
    assert('TC3: nightfoundry-guidance.md written after init',
      fs.existsSync(path.join(root, 'nightfoundry-guidance.md')));
  } catch (err) {
    assert(`(I TC3): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// TC4: an unstamped (user-authored) cc-orch-guidance.md — first line does
// not match the machine stamp format — is left byte-identical.
function acI_tc4_unstampedLegacyGuidancePreserved() {
  console.log('\n=== (I) TC4 — unstamped legacy guidance preserved byte-identical ===\n');
  const root = makeTmpRoot();
  try {
    const oldGuidancePath = path.join(root, 'cc-orch-guidance.md');
    const preSeeded = '# My own notes named cc-orch-guidance.md\nNot machine-owned.\n';
    fs.writeFileSync(oldGuidancePath, preSeeded, 'utf8');

    const before = fs.readFileSync(oldGuidancePath);

    init(root);

    assert('TC4: unstamped legacy guidance still present after init', fs.existsSync(oldGuidancePath));
    const after = fs.readFileSync(oldGuidancePath);
    assert('TC4: unstamped legacy guidance byte-identical after init',
      Buffer.compare(before, after) === 0);
  } catch (err) {
    assert(`(I TC4): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// TC5 + TC6: a pre-seeded CLAUDE.local.md holding user prose plus the old
// '@cc-orch-guidance.md' import line has ONLY that line rewritten to
// '@nightfoundry-guidance.md' — every surrounding byte preserved, exactly
// one import line surviving, no old import line remaining (TC5). A second
// init on that same root then leaves CLAUDE.local.md byte-identical (TC6).
function acI_tc5tc6_claudeLocalImportLineRewrite() {
  console.log('\n=== (I) TC5/TC6 — CLAUDE.local.md legacy import-line rewrite + idempotence ===\n');
  const root = makeTmpRoot();
  try {
    const claudeLocalPath = path.join(root, 'CLAUDE.local.md');
    const preSeeded =
      '# My project notes\n' +
      'Some prose before the import.\n' +
      '@cc-orch-guidance.md\n' +
      'Some prose after the import.\n';
    fs.writeFileSync(claudeLocalPath, preSeeded, 'utf8');

    init(root);

    const afterFirst = fs.readFileSync(claudeLocalPath, 'utf8');
    const expected = preSeeded.replace('@cc-orch-guidance.md', '@nightfoundry-guidance.md');

    assert('TC5: rewritten CLAUDE.local.md matches expected (only the import line changed)',
      afterFirst === expected);

    const newImportOccurrences = afterFirst.split('\n').filter((l) => l === '@nightfoundry-guidance.md').length;
    assert('TC5: exactly one new import line present', newImportOccurrences === 1);

    assert('TC5: no legacy @cc-orch-guidance.md import line remains',
      !afterFirst.includes('@cc-orch-guidance.md'));

    assert('TC5: surrounding prose before the import preserved',
      afterFirst.includes('Some prose before the import.'));
    assert('TC5: surrounding prose after the import preserved',
      afterFirst.includes('Some prose after the import.'));

    // TC6 — a second init on the same (already-migrated) root leaves
    // CLAUDE.local.md byte-identical.
    init(root);
    const afterSecond = fs.readFileSync(claudeLocalPath, 'utf8');
    assert('TC6: CLAUDE.local.md byte-identical after a second init',
      afterSecond === afterFirst);
  } catch (err) {
    assert(`(I TC5/TC6): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function acI_migrationLegs() {
  console.log('\n=== (I) old-surface (pre-rename) migration legs ===\n');
  acI_tc1_markedLegacySkillDirRemoved();
  acI_tc2_unmarkedLegacySkillDirPreserved();
  acI_tc3_stampedLegacyGuidanceRemoved();
  acI_tc4_unstampedLegacyGuidancePreserved();
  acI_tc5tc6_claudeLocalImportLineRewrite();
}

// ── (J) dual-read config precedence (.nightfoundry.json vs legacy .cc-orch.json) ─

/**
 * Runs `fn` with console.warn captured (restored in a finally block).
 * Mirrors withGuardStubs' capture-and-restore style, scoped to console.warn
 * only — this leg exercises loadProjectConfig's dual-read shadow warning,
 * not process.exit/console.error.
 * @param {() => void} fn
 * @returns {{ warnLines: string[] }}
 */
function withWarnCapture(fn) {
  const originalWarn = console.warn;
  const warnLines = [];
  console.warn = (...args) => { warnLines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return { warnLines };
}

// TC1: a root holding only .nightfoundry.json applies its override.
function acJ_tc1_nightfoundryOnlyApplies() {
  console.log('\n=== (J) TC1 — .nightfoundry.json alone applies its override ===\n');
  const root = makeTmpRoot();
  const before = {
    testCommand: config.execution.testCommand,
    testAllCommand: config.execution.testAllCommand,
  };
  try {
    fs.writeFileSync(
      path.join(root, '.nightfoundry.json'),
      JSON.stringify({ execution: { testCommand: 'nf-only' } }, null, 2) + '\n',
      'utf8'
    );

    let threw = false;
    try {
      loadProjectConfig(root);
    } catch {
      threw = true;
    }

    assert('TC1: loadProjectConfig does not throw with only .nightfoundry.json present', threw === false);
    assert("TC1: .nightfoundry.json alone applies its override — config.execution.testCommand === 'nf-only'",
      config.execution.testCommand === 'nf-only');
  } catch (err) {
    assert(`(J TC1): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
    config.execution.testCommand = before.testCommand;
    config.execution.testAllCommand = before.testAllCommand;
  }
}

// TC2: a root holding only the legacy .cc-orch.json applies its override.
function acJ_tc2_legacyOnlyApplies() {
  console.log('\n=== (J) TC2 — legacy .cc-orch.json alone applies its override ===\n');
  const root = makeTmpRoot();
  const before = {
    testCommand: config.execution.testCommand,
    testAllCommand: config.execution.testAllCommand,
  };
  try {
    fs.writeFileSync(
      path.join(root, '.cc-orch.json'),
      JSON.stringify({ execution: { testCommand: 'legacy-only' } }, null, 2) + '\n',
      'utf8'
    );

    let threw = false;
    try {
      loadProjectConfig(root);
    } catch {
      threw = true;
    }

    assert('TC2: loadProjectConfig does not throw with only .cc-orch.json present', threw === false);
    assert("TC2: legacy .cc-orch.json alone applies its override — config.execution.testCommand === 'legacy-only'",
      config.execution.testCommand === 'legacy-only');
  } catch (err) {
    assert(`(J TC2): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
    config.execution.testCommand = before.testCommand;
    config.execution.testAllCommand = before.testAllCommand;
  }
}

// TC3: a root holding BOTH files resolves to the .nightfoundry.json value
// and emits exactly one captured console line naming the shadowed
// '.cc-orch.json', with loadProjectConfig not throwing.
function acJ_tc3_bothPresentNightfoundryWinsOneWarning() {
  console.log('\n=== (J) TC3 — both files present: .nightfoundry.json wins, one shadow warning ===\n');
  const root = makeTmpRoot();
  const before = {
    testCommand: config.execution.testCommand,
    testAllCommand: config.execution.testAllCommand,
  };
  try {
    fs.writeFileSync(
      path.join(root, '.nightfoundry.json'),
      JSON.stringify({ execution: { testCommand: 'nf-wins' } }, null, 2) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, '.cc-orch.json'),
      JSON.stringify({ execution: { testCommand: 'legacy-shadowed' } }, null, 2) + '\n',
      'utf8'
    );

    let threw = false;
    const { warnLines } = withWarnCapture(() => {
      try {
        loadProjectConfig(root);
      } catch {
        threw = true;
      }
    });

    assert('TC3: loadProjectConfig does not throw when both files are present', threw === false);
    assert("TC3: .nightfoundry.json value wins — config.execution.testCommand === 'nf-wins'",
      config.execution.testCommand === 'nf-wins');
    assert('TC3: exactly one captured console line is emitted', warnLines.length === 1);
    assert("TC3: the captured warning line names the shadowed '.cc-orch.json'",
      warnLines.length === 1 && warnLines[0].includes('.cc-orch.json'));
  } catch (err) {
    assert(`(J TC3): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
    config.execution.testCommand = before.testCommand;
    config.execution.testAllCommand = before.testAllCommand;
  }
}

function acJ_dualReadPrecedence() {
  console.log('\n=== (J) dual-read config precedence (.nightfoundry.json vs legacy .cc-orch.json) ===\n');
  acJ_tc1_nightfoundryOnlyApplies();
  acJ_tc2_legacyOnlyApplies();
  acJ_tc3_bothPresentNightfoundryWinsOneWarning();
}

// ── main ─────────────────────────────────────────────────────────────────

function main() {
  console.log('=== init-onboarding (cc-orch init scaffold + guardFreshRoot) Tests ===\n');

  assert('module-top: CC_ORCH_ACTIVE_RUN cleared before imports ran',
    process.env.CC_ORCH_ACTIVE_RUN === undefined);

  acA_scaffoldAnchorsNegativePinSizeCeiling();
  acB_createOnlyAndIdempotence();
  acC_gitignoreManagedBlock();
  acD_nonGitFailSoft();
  acE_guardFreshRootUnitLegs();
  acF_cliWiringFreshHint();
  acF_cliWiringMdShortcutFileNotFound();
  acF_cliWiringStatus();
  acG_loadProjectConfigInertness();
  acH_freshStampSilence();
  acH_staleness();
  acH_refresh();
  acH_dangling();
  acH_optOut();
  acH_optOutWithResidue();
  acH_bareHarness();
  acH_failSoftEISDIR();
  acI_migrationLegs();
  acJ_dualReadPrecedence();

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
