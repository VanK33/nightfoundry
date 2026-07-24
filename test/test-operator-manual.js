/**
 * test-operator-manual.js — Tests for the shipped cc-orch-operator skill
 * package (src/cli/skills/cc-orch-operator/) and its deployment via
 * `cc-orch init` (src/cli/commands/init.js).
 *
 * No Claude auth, no SDK, no network. Pure fs + temp directories
 * (fs.mkdtempSync fixture roots, realpathed immediately — mirrors
 * test-init-onboarding.js). Every fixture root is fresh and cleaned up in a
 * finally block. This file asserts only its own target content/behavior —
 * no tree-state (whole-repo) assertions.
 *
 * Acceptance cases:
 *   (1) DRIFT — the CLI verb list is re-derived at runtime from
 *       src/cli/index.js (never hand-copied) and every verb is asserted to
 *       appear in references/commands.md.
 *   (2) Init deployment legs — byte-identical deploy of the skill package
 *       into a temp-root .claude/skills/cc-orch-operator/, a re-init
 *       refresh, the sidecar {version, releaseChannel, hash} shape, an
 *       explicit-init-deploys-regardless-of-channel leg, and the absence of
 *       any '.claude' pattern in the managed .gitignore block.
 *   (3) Template pins — the four anchor sections (headings) and the
 *       section-(iv) deployed-skill pointer sentence in the shipped
 *       cc-orch-guidance.md template.
 *   (4) Chapter pins — spec-authoring.md sections (a)-(g) (including the
 *       .claude/** target-files exclusion rule) and debugging.md flows
 *       (a)-(f).
 *   (5) SKILL pins — golden rule 6 (with the reentrancy sentence) and one
 *       Intent-table row.
 *   (6) Public-safety sweep — no internal repo absolute path or OS username
 *       leaks into any deployed/shipped skill artifact.
 *
 * Run: node test/test-operator-manual.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { init, guardFreshRoot } from '../src/cli/commands/init.js';

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

// ── fixture helpers (mirrors test-init-onboarding.js) ───────────────────────

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-operator-manual-')));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

class ExitSentinel extends Error {
  constructor(code) {
    super(`process.exit(${code}) called`);
    this.code = code;
  }
}

/**
 * Runs `fn` with console.log/console.error captured and process.exit
 * replaced with a throwing sentinel — all restored in a finally block.
 * @returns {{ stdoutLines: string[], stderrLines: string[], threwSentinel: ExitSentinel|null, threwOther: Error|null }}
 */
function withCapture(fn) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const stdoutLines = [];
  const stderrLines = [];
  let threwSentinel = null;
  let threwOther = null;

  process.exit = (code) => { throw new ExitSentinel(code); };
  console.log = (...args) => { stdoutLines.push(args.join(' ')); };
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
    console.log = originalLog;
    console.error = originalError;
  }

  return { stdoutLines, stderrLines, threwSentinel, threwOther };
}

/**
 * Recursively list files under dir, returned as baseDir-relative paths,
 * sorted for deterministic iteration order. Mirrors init.js's private
 * walkFiles helper (duplicated here — this test only reads, never imports
 * internals not exported by init.js).
 * @param {string} dir
 * @param {string} [baseDir]
 * @returns {string[]}
 */
function walkFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, baseDir));
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, full));
    }
  }
  return out.sort();
}

// ── shared paths ─────────────────────────────────────────────────────────

const CLI_INDEX_PATH = path.resolve(__dirname, '../src/cli/index.js');
const SKILL_SRC_DIR = path.resolve(__dirname, '../src/cli/skills/cc-orch-operator');
const SKILL_MD_PATH = path.join(SKILL_SRC_DIR, 'SKILL.md');
const COMMANDS_MD_PATH = path.join(SKILL_SRC_DIR, 'references', 'commands.md');
const SPEC_AUTHORING_PATH = path.join(SKILL_SRC_DIR, 'references', 'spec-authoring.md');
const DEBUGGING_PATH = path.join(SKILL_SRC_DIR, 'references', 'debugging.md');
const TEMPLATE_PATH = path.resolve(__dirname, '../src/cli/templates/cc-orch-guidance.md');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '../package.json');

const SKILL_DEPLOY_RELPATH = path.join('.claude', 'skills', 'cc-orch-operator');
const SKILL_SIDECAR_FILENAME = '.cc-orch-skill.json';

// ── (1) DRIFT — runtime-derived CLI verb list ⊆ commands.md ───────────────

/**
 * Derive the top-level CLI verb list at runtime by regex-scanning the
 * router's `switch (cmd) { case '<verb>': ... }` block in src/cli/index.js.
 * Never hand-copied — this is the whole point of the drift test: if a verb
 * is added/removed in the router, this list changes with it.
 * @returns {string[]}
 */
function deriveCliVerbsAtRuntime() {
  const src = fs.readFileSync(CLI_INDEX_PATH, 'utf8');
  const re = /case '([a-zA-Z][a-zA-Z-]*)':/g;
  const verbs = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    verbs.push(m[1]);
  }
  return verbs;
}

function ac1_driftVerbList() {
  console.log('\n=== (1) DRIFT — runtime-derived CLI verb list ⊆ references/commands.md ===\n');
  const verbs = deriveCliVerbsAtRuntime();

  assert(`drift: at least one verb derived from src/cli/index.js (got ${verbs.length})`, verbs.length > 0);
  assert(`drift: exactly 19 top-level verbs derived (today's count; got ${verbs.length})`, verbs.length === 19);

  const commandsMd = fs.readFileSync(COMMANDS_MD_PATH, 'utf8');
  for (const verb of verbs) {
    assert(`drift: verb '${verb}' documented in references/commands.md ('cc-orch ${verb}')`,
      commandsMd.includes(`cc-orch ${verb}`));
  }
}

// ── (2) init deployment legs ─────────────────────────────────────────────

function ac2_initDeploymentLegs() {
  console.log('\n=== (2) init deployment legs — byte-identical deploy, refresh, sidecar, gitignore ===\n');
  const root = makeTmpRoot();
  try {
    const srcRelPaths = walkFiles(SKILL_SRC_DIR);
    assert(`deployment: shipped skill package has six files (got ${srcRelPaths.length})`,
      srcRelPaths.length === 6);

    init(root);

    const deployDir = path.join(root, SKILL_DEPLOY_RELPATH);
    for (const relPath of srcRelPaths) {
      const srcBytes = fs.readFileSync(path.join(SKILL_SRC_DIR, relPath));
      const deployedPath = path.join(deployDir, relPath);
      assert(`deployment: ${relPath} deployed`, fs.existsSync(deployedPath));
      const deployedBytes = fs.readFileSync(deployedPath);
      assert(`deployment: ${relPath} byte-identical to shipped source`,
        Buffer.compare(srcBytes, deployedBytes) === 0);
    }

    const sidecarPath = path.join(deployDir, SKILL_SIDECAR_FILENAME);
    assert('deployment: sidecar .cc-orch-skill.json written', fs.existsSync(sidecarPath));
    const sidecarFirst = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert('deployment: sidecar has a version key', 'version' in sidecarFirst);
    assert('deployment: sidecar has a releaseChannel key', 'releaseChannel' in sidecarFirst);
    assert('deployment: sidecar has a hash key', 'hash' in sidecarFirst);
    assert('deployment: sidecar hash is 12 hex chars', /^[0-9a-f]{12}$/.test(sidecarFirst.hash));

    // Re-init refresh — byte-identical again (self-hosted-style rewrite,
    // not a same-path copy failure), sidecar unchanged in shape/value.
    init(root);
    for (const relPath of srcRelPaths) {
      const srcBytes = fs.readFileSync(path.join(SKILL_SRC_DIR, relPath));
      const deployedBytes = fs.readFileSync(path.join(deployDir, relPath));
      assert(`refresh: ${relPath} still byte-identical after re-init`,
        Buffer.compare(srcBytes, deployedBytes) === 0);
    }
    const sidecarSecond = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert('refresh: sidecar hash unchanged after re-init (shipped source unchanged)',
      sidecarSecond.hash === sidecarFirst.hash);
    assert('refresh: sidecar version unchanged after re-init',
      sidecarSecond.version === sidecarFirst.version);
    assert('refresh: sidecar releaseChannel unchanged after re-init',
      sidecarSecond.releaseChannel === sidecarFirst.releaseChannel);

    // No '.claude' pattern added to the managed .gitignore block.
    const gitignoreText = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert("deployment: managed .gitignore block adds no '.claude' pattern",
      !gitignoreText.includes('.claude'));
  } catch (err) {
    assert(`(2): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

function ac2_explicitInitDeploysRegardlessOfChannel() {
  console.log('\n=== (2) explicit init deploys regardless of channel + prints the channel ===\n');
  const root = makeTmpRoot();
  try {
    const { stdoutLines, threwSentinel, threwOther } = withCapture(() => {
      init(root, undefined, { readChannel: () => undefined });
    });
    assert('explicit init: no exception with an unresolved (undefined) channel',
      threwSentinel === null && threwOther === null);

    const deployDir = path.join(root, SKILL_DEPLOY_RELPATH);
    assert('explicit init: SKILL.md deployed even with no channel resolved',
      fs.existsSync(path.join(deployDir, 'SKILL.md')));

    const sidecar = JSON.parse(fs.readFileSync(path.join(deployDir, SKILL_SIDECAR_FILENAME), 'utf8'));
    assert('explicit init: sidecar releaseChannel is null when the seam resolves no channel',
      sidecar.releaseChannel === null);

    assert('explicit init: a release-channel line was printed',
      stdoutLines.some((l) => l.includes('cc-orch-operator skill release channel:')));
  } catch (err) {
    assert(`(2 explicit init): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── (3) template pins ────────────────────────────────────────────────────

// Verbatim anchor sentences, one per heading, read from the shipped
// template asset (src/cli/templates/cc-orch-guidance.md) at the time this
// test was written. Section (iv) is the deployed-skill pointer sentence.
const TEMPLATE_ANCHOR_SENTENCES = [
  'This file is machine-managed by cc-orch; re-running cc-orch init refreshes it.',
  'Runs live under .harness/, pending work under queue/, delivered runs under archives/.',
  "Record this project's lessons, decisions, and TODOs in this project's own files.",
  'This repo ships the cc-orch operator skill at .claude/skills/cc-orch-operator/ — your session loads project skills automatically; read references/spec-authoring.md before hand-writing a spec and references/debugging.md when a run stops.',
];

function ac3_templatePins() {
  console.log('\n=== (3) template pins — four anchor sections + section-(iv) sentence ===\n');
  const templateText = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const rawLines = templateText.split('\n');
  const lineCount = rawLines[rawLines.length - 1] === '' ? rawLines.length - 1 : rawLines.length;
  const headingCount = rawLines.filter((l) => l.startsWith('# ')).length;

  assert(`template: exactly four headings (got ${headingCount})`, headingCount === 4);
  assert(`template: size ceiling — <=30 lines (got ${lineCount})`, lineCount <= 30);

  for (const [i, sentence] of TEMPLATE_ANCHOR_SENTENCES.entries()) {
    assert(`template: anchor sentence (section ${i + 1}) present — "${sentence}"`,
      templateText.includes(sentence));
  }

  assert('template: section (iv) is the deployed-skill pointer sentence',
    templateText.includes(TEMPLATE_ANCHOR_SENTENCES[3]));
}

// ── (4) chapter pins ─────────────────────────────────────────────────────

const SPEC_AUTHORING_SECTIONS = [
  '## (a) The six-section spec skeleton',
  '## (b) Sibling `.spec.md` / `.spec.json` naming',
  '## (c) The declared-set contract',
  '## (d) Ripple files',
  '## (e) The `plan_structure` field',
  '## (f) Check-shape',
  '## (g) Smoke vs full test-run semantics and assumption-safe wording',
];

const DEBUGGING_FLOWS = [
  '## Flow a: run looks stalled, no visible progress',
  '## Flow b: run is waiting on a human review gate',
  '## Flow c: run escalated after repeated task failures',
  '## Flow d: a queued spec never seems to advance',
  '## Flow e: reported cost or usage looks wrong',
  '## Flow f: a command exits cleanly but nothing changed',
];

function ac4_chapterPins() {
  console.log('\n=== (4) chapter pins — spec-authoring (a)-(g) + debugging flows (a)-(f) ===\n');
  const specText = fs.readFileSync(SPEC_AUTHORING_PATH, 'utf8');
  for (const heading of SPEC_AUTHORING_SECTIONS) {
    assert(`spec-authoring: heading present — "${heading}"`, specText.includes(heading));
  }
  assert('spec-authoring: .claude/** target-files exclusion rule present',
    specText.includes('Hard rule: `target_files` must never include a `.claude/**` path.'));

  const debugText = fs.readFileSync(DEBUGGING_PATH, 'utf8');
  for (const heading of DEBUGGING_FLOWS) {
    assert(`debugging: heading present — "${heading}"`, debugText.includes(heading));
  }
}

// ── (5) SKILL pins ───────────────────────────────────────────────────────

function ac5_skillPins() {
  console.log('\n=== (5) SKILL pins — golden rule 6 + intent row ===\n');
  const skillText = fs.readFileSync(SKILL_MD_PATH, 'utf8');

  assert('SKILL: golden rule 6 heading text present ("Respect read-only mode.")',
    skillText.includes('6. **Respect read-only mode.**'));
  assert('SKILL: golden rule 6 reentrancy sentence present',
    skillText.includes(
      "never invoke `cc-orch` from inside a session that `cc-orch` itself spawned — a live run stamps its child processes, and re-entering against the same project root can corrupt that run's state."
    ));

  assert('SKILL: Intent-table row — hand-write-a-spec routes to spec-authoring.md',
    skillText.includes(
      '| Hand-write a spec without brainstorm | [references/spec-authoring.md](references/spec-authoring.md) | `cc-orch dry-run <spec.md>` (validates it), then `cc-orch run <spec.md>` |'
    ));
}

// ── (6) public-safety sweep ──────────────────────────────────────────────

function ac6_publicSafetySweep() {
  console.log('\n=== (6) public-safety sweep — no internal repo path / username leak ===\n');
  const root = makeTmpRoot();
  try {
    init(root);

    const repoRootAbsPath = path.resolve(__dirname, '..');
    const username = os.userInfo().username;

    const deployDir = path.join(root, SKILL_DEPLOY_RELPATH);
    const filesToSweep = [
      ...walkFiles(SKILL_SRC_DIR).map((rel) => path.join(SKILL_SRC_DIR, rel)),
      ...walkFiles(deployDir).map((rel) => path.join(deployDir, rel)),
      TEMPLATE_PATH,
      path.join(root, 'cc-orch-guidance.md'),
    ];

    for (const filePath of filesToSweep) {
      const text = fs.readFileSync(filePath, 'utf8');
      const label = path.relative(path.resolve(__dirname, '..'), filePath);
      assert(`public-safety: ${label} contains no internal repo absolute path`,
        !text.includes(repoRootAbsPath));
      if (username) {
        assert(`public-safety: ${label} contains no OS username ('${username}')`,
          !text.includes(username));
      }
    }
  } catch (err) {
    assert(`(6): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── packaging pins (releaseChannel enum membership, files whitelist) ──────

function acX_packagingPins() {
  console.log('\n=== packaging pins — releaseChannel membership + files whitelist ===\n');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  assert(`packaging: releaseChannel is one of alpha|beta|stable (got '${pkg.releaseChannel}')`,
    ['alpha', 'beta', 'stable'].includes(pkg.releaseChannel));
  assert("packaging: files whitelist includes 'src/'",
    Array.isArray(pkg.files) && pkg.files.includes('src/'));
}

function makeStaleGuidanceRoot() {
  // A fully-initialized fixture root whose guidance stamp is then tampered —
  // the canonical "stale" precondition for the channel-gate legs.
  const root = makeTmpRoot();
  withCapture(() => { init(root, undefined, { readChannel: () => undefined }); });
  const guidancePath = path.join(root, 'cc-orch-guidance.md');
  const original = fs.readFileSync(guidancePath, 'utf8');
  fs.writeFileSync(
    guidancePath,
    original.replace(/<!-- cc-orch-guidance-hash: [0-9a-f]{12} -->/, '<!-- cc-orch-guidance-hash: 000000000000 -->'),
    'utf8'
  );
  return root;
}

function ac7_channelGate() {
  console.log('\n=== (7) channel gate — stable hints, alpha silence, shipped-default seam ===\n');

  // (a) stable + stale stamp → the outdated hint fires.
  let root = makeStaleGuidanceRoot();
  try {
    const { stderrLines } = withCapture(() => {
      guardFreshRoot(root, { refuse: true, readChannel: () => 'stable' });
    });
    assert("channel gate (stable): stale stamp → one 'outdated' hint on stderr",
      stderrLines.some((l) => l.includes('outdated')));
  } finally {
    cleanup(root);
  }

  // (b) alpha + the same stale stamp → silence.
  root = makeStaleGuidanceRoot();
  try {
    const { stderrLines } = withCapture(() => {
      guardFreshRoot(root, { refuse: true, readChannel: () => 'alpha' });
    });
    assert('channel gate (alpha): same stale stamp → zero stderr output',
      stderrLines.length === 0);
  } finally {
    cleanup(root);
  }

  // (c) default seam reads the SHIPPED package.json, never the target's:
  // the fixture's OWN package.json claims 'stable', no seam injection —
  // the shipped channel is alpha, so the gate stays closed and the stale
  // stamp produces no hint.
  root = makeStaleGuidanceRoot();
  try {
    fs.writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', releaseChannel: 'stable' }), 'utf8');
    const { stderrLines } = withCapture(() => {
      guardFreshRoot(root, { refuse: true });
    });
    assert("channel gate (default seam): target repo claiming 'stable' does NOT open the gate — shipped channel rules",
      stderrLines.length === 0);
  } finally {
    cleanup(root);
  }
}

// ── main ─────────────────────────────────────────────────────────────────

function main() {
  console.log('=== operator-manual (cc-orch-operator skill package + init deployment) Tests ===\n');

  ac1_driftVerbList();
  ac2_initDeploymentLegs();
  ac2_explicitInitDeploysRegardlessOfChannel();
  ac3_templatePins();
  ac4_chapterPins();
  ac5_skillPins();
  ac6_publicSafetySweep();
  ac7_channelGate();
  acX_packagingPins();

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
