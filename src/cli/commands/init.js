/**
 * init.js — Bootstrap the flat shared .harness/ surface in a project, then
 * scaffold the onboarding surface (AI guidance + config template + ignore
 * rules) with strict ownership discipline.
 *
 * Pure JS — no shell scripts. Wraps ensureSharedSkeleton() and preflight()
 * (in sharedOnly mode) directly. Does not call the flat bootstrap() — that
 * would also write a per-invocation state.json/PER_RUN_SUBDIRS, which init
 * no longer owns; runs now provision their own per-run harness dir.
 *
 * Onboarding scaffold (deployed AFTER the existing preflight-OK point, once
 * the shared skeleton is confirmed healthy):
 *   - nightfoundry-guidance.md   MACHINE-OWNED — overwritten unconditionally
 *     on every init (the refresh path). Content is the shipped template asset
 *     prefixed with a stamp line ('<!-- cc-orch-guidance-hash: <12 hex> -->')
 *     computed as the first 12 hex chars of sha256(shipped template bytes).
 *   - CLAUDE.local.md       USER-OWNED, append-only, single-touch. Created
 *     with the marker comment + '@nightfoundry-guidance.md' import line when
 *     absent; when present, those two lines are appended ONCE, iff the
 *     import line is not already present, byte-preserving all existing
 *     content (adding a newline first if the file doesn't already end in
 *     one); left byte-untouched when the import line is already present.
 *     Deleting the import line is an opt-out — no automatic path re-adds
 *     it, only an explicit re-init.
 *   - .nightfoundry.json.example CREATE-ONLY — never overwritten, and init
 *     never writes a live .nightfoundry.json (loadProjectConfig is fail-loud
 *     on unknown keys, so a guessed live config would break every later run).
 *   - .gitignore            USER-OWNED managed block, delimited by
 *     '# >>> cc-orch >>>' / '# <<< cc-orch <<<' markers. Created (file
 *     absent) or appended once (markers absent — byte-preserving existing
 *     content); left byte-untouched once both markers are present (no
 *     refresh, no dedup). Patterns mirror git-excludes.js's builder exactly
 *     plus '/CLAUDE.local.md' and '/nightfoundry-guidance.md' (ten patterns
 *     total); 'archives/' is intentionally absent, mirroring that module's
 *     documented decision. Written even on a non-git root (harmless
 *     pre-git, takes effect on a later `git init`).
 *   - .claude/skills/nightfoundry-operator/  MACHINE-OWNED — the shipped
 *     nightfoundry-operator skill (SKILL.md + references/*.md), resolved from
 *     src/cli/skills/nightfoundry-operator/ via import.meta.url (never the
 *     target repo's own copy) and refreshed unconditionally on every init.
 *     Every source file is read into memory then written — NEVER
 *     fs.cpSync/fs.copyFileSync — so the self-hosted case (this repo
 *     running its own `cc-orch init`) degrades to a byte-identical rewrite
 *     rather than a same-path copy failure. A sidecar JSON
 *     ('.cc-orch-skill.json', keys: version, releaseChannel, hash) is
 *     written alongside the deployed files; releaseChannel comes from the
 *     injectable `opts.readChannel` seam, whose default reads the shipped
 *     package.json (resolved via import.meta.url — never the target repo's)
 *     — the same seam feeds both the printed channel line and the sidecar.
 *     init prints one line per deployed file, the release channel, and a
 *     recommendation to commit the deployed skill to version control. Never
 *     touches the .gitignore managed block (no '.claude' pattern is added).
 *
 * guardFreshRoot(projectRoot, opts) gates the interactive spend verbs on a
 * fresh (un-initialized) project root. Fail-soft by contract: on a non-git
 * root, or any fs/hash failure encountered while checking scaffold
 * freshness, it never throws and never blocks the calling verb.
 */
import fs from 'fs';
import { displayName } from '../../orchestrator/infra/display-name.js';
import path from 'path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { ensureSharedSkeleton } from '../../orchestrator/core/bootstrap.js';
import { preflight } from '../../orchestrator/core/preflight.js';
import { harnessRoot } from '../../orchestrator/core/run-context.js';
import { assertNoReentrantLiveRun } from '../../orchestrator/core/reentrancy-guard.js';
import { ensureGitExcludes } from '../../orchestrator/core/git-excludes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The shipped template asset — the single source of truth for both the
// deployed nightfoundry-guidance.md content and its freshness stamp.
const TEMPLATE_PATH = path.resolve(__dirname, '..', 'templates', 'nightfoundry-guidance.md');

// The shipped nightfoundry-operator skill source — the single source of truth
// for the deployed .claude/skills/nightfoundry-operator/ copy (SKILL.md +
// references). Agent sessions cannot edit files under a repo's .claude/, so
// the canonical source lives on this ordinary (non-.claude) path instead.
const SKILL_SRC_DIR = path.resolve(__dirname, '..', 'skills', 'nightfoundry-operator');
const SKILL_DEPLOY_RELPATH = path.join('.claude', 'skills', 'nightfoundry-operator');
const SKILL_SIDECAR_FILENAME = '.cc-orch-skill.json';

// The shipped package.json — resolved via import.meta.url, NEVER the target
// repo's own package.json — is the single source of truth for both the
// printed/sidecar release channel and the sidecar version.
const SHIPPED_PACKAGE_JSON_PATH = path.resolve(__dirname, '..', '..', '..', 'package.json');

const GUIDANCE_FILENAME = 'nightfoundry-guidance.md';
const CLAUDE_LOCAL_FILENAME = 'CLAUDE.local.md';
const IMPORT_LINE = '@nightfoundry-guidance.md';
const CLAUDE_LOCAL_MARKER =
  '<!-- cc-orch: the next line imports machine-managed cc-orch guidance; delete it to opt out -->';
const GITIGNORE_BEGIN = '# >>> cc-orch >>>';
const GITIGNORE_END = '# <<< cc-orch <<<';
const CONFIG_EXAMPLE_FILENAME = '.nightfoundry.json.example';

// --- Old-surface (pre-rename) migration constants -------------------------
// These three legs clean up artifacts from the previous 'cc-orch' branding
// so a project that ran the old init isn't left with duplicate/stale
// surfaces after upgrading. Each leg acts ONLY on artifacts it can prove are
// machine-owned (a marker file or a machine-computed stamp line), and is a
// byte-preserving no-op on anything it can't prove ownership of, including
// on a second init() call against an already-migrated root.
const OLD_SKILL_DEPLOY_RELPATH = path.join('.claude', 'skills', 'cc-orch-operator');
const OLD_GUIDANCE_FILENAME = 'cc-orch-guidance.md';
const OLD_GUIDANCE_STAMP_REGEX = /^<!-- cc-orch-guidance-hash: [0-9a-f]{12} -->$/;
const OLD_IMPORT_LINE = '@cc-orch-guidance.md';

// The projectRoot-anchored patterns for the committed .gitignore managed
// block — mirrors git-excludes.js's builder exactly, plus the two local-only
// onboarding files. The archives/ DIRECTORY is never excluded (forensic
// archives are meant to be committable), but the cross-run ledger FILES
// under it (candidates.jsonl, warnings.jsonl, usage-ledger.jsonl) are — they
// are written on failure legs and would otherwise read as untracked dirt
// that trips the next run's clean-tree guard.
function gitignoreBlockLines() {
  return [
    GITIGNORE_BEGIN,
    '/.harness/',
    '/queue/',
    '/spec-*.md',
    '/*.spec.md',
    '/*.spec.json',
    '/*.uspec.json',
    '/archives/candidates.jsonl',
    '/archives/warnings.jsonl',
    '/archives/usage-ledger.jsonl',
    '/CLAUDE.local.md',
    '/nightfoundry-guidance.md',
    GITIGNORE_END,
  ];
}

function sha256Hex12(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/**
 * OLD-SURFACE MIGRATION (leg 1/3), machine-owned artifacts only: remove
 * <projectRoot>/.claude/skills/cc-orch-operator/ recursively, but ONLY when
 * it contains the machine-ownership marker file (the same sidecar filename
 * deploySkill writes, '.cc-orch-skill.json'). When the marker is absent —
 * e.g. a user-authored directory that happens to share the old skill's
 * name — the directory is left byte-untouched. Runs once per init() call;
 * a second run finds nothing left to remove and is a no-op.
 * @param {string} projectRoot
 * @returns {'removed'|'skipped'}
 */
function migrateOldSkillDir(projectRoot) {
  const oldSkillDir = path.join(projectRoot, OLD_SKILL_DEPLOY_RELPATH);
  const markerPath = path.join(oldSkillDir, SKILL_SIDECAR_FILENAME);
  if (!fs.existsSync(markerPath)) {
    return 'skipped';
  }
  fs.rmSync(oldSkillDir, { recursive: true, force: true });
  return 'removed';
}

/**
 * OLD-SURFACE MIGRATION (leg 2/3), machine-owned artifacts only: remove
 * <projectRoot>/cc-orch-guidance.md, but ONLY when its first line matches
 * the machine stamp format ('<!-- cc-orch-guidance-hash: <12 hex> -->').
 * An unstamped (user-authored) file of that name is left byte-untouched.
 * Runs once per init() call; a second run finds nothing left to remove and
 * is a no-op.
 * @param {string} projectRoot
 * @returns {'removed'|'skipped'}
 */
function migrateOldGuidanceFile(projectRoot) {
  const oldGuidancePath = path.join(projectRoot, OLD_GUIDANCE_FILENAME);
  if (!fs.existsSync(oldGuidancePath)) {
    return 'skipped';
  }
  const content = fs.readFileSync(oldGuidancePath, 'utf8');
  const firstLine = content.split('\n')[0];
  if (!OLD_GUIDANCE_STAMP_REGEX.test(firstLine)) {
    return 'skipped';
  }
  fs.rmSync(oldGuidancePath);
  return 'removed';
}

/**
 * OLD-SURFACE MIGRATION (leg 3/3): in <projectRoot>/CLAUDE.local.md, rewrite
 * the exact whole line '@cc-orch-guidance.md' to '@nightfoundry-guidance.md'
 * when present, preserving every other byte of the file (including line
 * endings, elsewhere) and NEVER deleting or creating the file. Runs before
 * deployClaudeLocal's own import-presence check (see init()) so an
 * already-migrated file gains no duplicate import line, and a second init()
 * call — which finds the new import line already present — is a no-op.
 * @param {string} projectRoot
 * @returns {'rewritten'|'unchanged'|'absent'}
 */
function migrateClaudeLocalImportLine(projectRoot) {
  const claudeLocalPath = path.join(projectRoot, CLAUDE_LOCAL_FILENAME);
  if (!fs.existsSync(claudeLocalPath)) {
    return 'absent';
  }
  const existing = fs.readFileSync(claudeLocalPath, 'utf8');
  const lines = existing.split('\n');
  let changed = false;
  const rewritten = lines.map((line) => {
    if (line === OLD_IMPORT_LINE) {
      changed = true;
      return IMPORT_LINE;
    }
    return line;
  });
  if (!changed) {
    return 'unchanged';
  }
  fs.writeFileSync(claudeLocalPath, rewritten.join('\n'), 'utf8');
  return 'rewritten';
}

/**
 * MACHINE-OWNED: write nightfoundry-guidance.md unconditionally (create or
 * overwrite) from the shipped template, prefixed with a stamp line.
 * @param {string} projectRoot
 * @returns {string} the deployed file's absolute path
 */
function deployGuidance(projectRoot) {
  const templateBytes = fs.readFileSync(TEMPLATE_PATH);
  const stamp = `<!-- cc-orch-guidance-hash: ${sha256Hex12(templateBytes)} -->`;
  const guidancePath = path.join(projectRoot, GUIDANCE_FILENAME);
  fs.writeFileSync(guidancePath, `${stamp}\n${templateBytes.toString('utf8')}`, 'utf8');
  return guidancePath;
}

/**
 * Recursively list files under dir, returned as baseDir-relative paths,
 * sorted for deterministic iteration order.
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

/**
 * Read + parse the shipped package.json (resolved via import.meta.url —
 * never the target repo's own package.json). Fail-soft: returns {} on any
 * read/parse error.
 * @returns {Record<string, unknown>}
 */
function readShippedPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(SHIPPED_PACKAGE_JSON_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Default `readChannel` seam: reads releaseChannel from the shipped
 * package.json (resolved via import.meta.url — never the target repo's).
 * Injectable so callers (and tests) can supply an alternate seam. Fail-soft:
 * returns undefined if the field is absent or the file can't be read.
 * @returns {string|undefined}
 */
function defaultReadChannel() {
  return readShippedPackageJson().releaseChannel;
}

/**
 * Combine a set of {relPath, bytes} entries into a single deterministic
 * content hash (order-independent of filesystem iteration since callers
 * pass already-sorted entries).
 * @param {{ relPath: string, bytes: Buffer }[]} entries
 * @returns {string} 12 hex chars
 */
function computeSkillHash(entries) {
  const hash = crypto.createHash('sha256');
  for (const { relPath, bytes } of entries) {
    hash.update(relPath.split(path.sep).join('/'));
    hash.update('\u0000');
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Deploy the shipped nightfoundry-operator skill (SKILL.md + references/*.md)
 * into <projectRoot>/.claude/skills/nightfoundry-operator/, plus a sidecar JSON
 * stamp file recording {version, releaseChannel, hash}.
 *
 * Read-into-memory-then-write per file — NEVER fs.cpSync/fs.copyFileSync.
 * This is deliberate: it makes the self-hosted case (this repo's own
 * src/cli/skills/ and .claude/skills/ both present) degrade to a
 * byte-identical rewrite rather than a same-path copy failure.
 *
 * @param {string} projectRoot
 * @param {{ readChannel?: () => (string|undefined) }} [opts]
 * @returns {{ deployedPaths: string[], sidecarPath: string, channel: (string|undefined), hash: string, version: (string|undefined) }}
 */
function deploySkill(projectRoot, { readChannel = defaultReadChannel } = {}) {
  const deployDir = path.join(projectRoot, SKILL_DEPLOY_RELPATH);
  const relPaths = walkFiles(SKILL_SRC_DIR);

  const entries = [];
  const deployedPaths = [];
  for (const relPath of relPaths) {
    const srcPath = path.join(SKILL_SRC_DIR, relPath);
    const bytes = fs.readFileSync(srcPath); // read into memory first
    const destPath = path.join(deployDir, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, bytes); // then write — no cpSync/copyFileSync
    entries.push({ relPath, bytes });
    deployedPaths.push(destPath);
  }

  const hash = computeSkillHash(entries);
  const channel = readChannel();
  const version = readShippedPackageJson().version;

  const sidecar = {
    version: version ?? null,
    releaseChannel: channel ?? null,
    hash,
  };
  const sidecarPath = path.join(deployDir, SKILL_SIDECAR_FILENAME);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

  return { deployedPaths, sidecarPath, channel, hash, version };
}

/**
 * USER-OWNED, append-only single-touch: ensure CLAUDE.local.md carries the
 * cc-orch import line, without ever rewriting pre-existing bytes.
 * @param {string} projectRoot
 * @returns {'created'|'appended'|'unchanged'}
 */
function deployClaudeLocal(projectRoot) {
  const claudeLocalPath = path.join(projectRoot, CLAUDE_LOCAL_FILENAME);

  if (!fs.existsSync(claudeLocalPath)) {
    fs.writeFileSync(claudeLocalPath, `${CLAUDE_LOCAL_MARKER}\n${IMPORT_LINE}\n`, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(claudeLocalPath, 'utf8');
  if (existing.includes(IMPORT_LINE)) {
    return 'unchanged';
  }

  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    claudeLocalPath,
    `${existing}${sep}${CLAUDE_LOCAL_MARKER}\n${IMPORT_LINE}\n`,
    'utf8'
  );
  return 'appended';
}

/**
 * CREATE-ONLY: deploy .nightfoundry.json.example, an inert example of the
 * recognised config shape. Never overwritten once present; init never
 * writes a live .nightfoundry.json.
 * @param {string} projectRoot
 * @returns {'created'|'skipped'}
 */
function deployConfigExample(projectRoot) {
  const examplePath = path.join(projectRoot, CONFIG_EXAMPLE_FILENAME);
  if (fs.existsSync(examplePath)) {
    return 'skipped';
  }
  // Language-neutral placeholders, NOT working npm defaults: cc-orch is
  // runner-agnostic, and a copyable npm command silently mis-runs on a
  // non-JS project. These self-evident placeholders name the two concepts
  // with cross-language examples and fail loudly if copied verbatim, so the
  // user is prompted to fill in their own commands.
  const example = {
    execution: {
      testCommand: '<fast/smoke test command — e.g. npm test, pytest tests/smoke -q, go test ./internal/...>',
      testAllCommand: '<full test-suite command — e.g. npm run test:all, pytest -q, go test ./...>',
    },
  };
  fs.writeFileSync(examplePath, `${JSON.stringify(example, null, 2)}\n`, 'utf8');
  return 'created';
}

/**
 * USER-OWNED managed block, append-only single-touch: ensure .gitignore
 * carries the cc-orch marker-delimited block, byte-preserving all existing
 * content. Idempotent at block granularity — once both markers are present
 * the file is left byte-untouched (no refresh, no dedup).
 * @param {string} projectRoot
 * @returns {'created'|'appended'|'unchanged'}
 */
function deployGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const block = gitignoreBlockLines();

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${block.join('\n')}\n`, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  if (existing.includes(GITIGNORE_BEGIN) && existing.includes(GITIGNORE_END)) {
    return 'unchanged';
  }

  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    gitignorePath,
    `${existing}${sep}\n${block.join('\n')}\n`,
    'utf8'
  );
  return 'appended';
}

export function init(projectRoot, prdPath, opts = {}) {
  const { readChannel = defaultReadChannel } = opts;
  try {
    if (prdPath) {
      console.log(
        `[WARN] init no longer records a spec path; ignoring prdPath argument: ${prdPath}`
      );
    }

    assertNoReentrantLiveRun(projectRoot);
    ensureSharedSkeleton(projectRoot);
    console.log(`Harness initialized at ${harnessRoot(projectRoot)}`);

    const check = preflight(harnessRoot(projectRoot), { sharedOnly: true });
    for (const w of check.warnings) console.log(`[WARN] ${w}`);
    if (!check.ok) {
      console.error('Preflight failed:');
      for (const e of check.errors) console.error(`  ${e}`);
      process.exit(1);
    }
    console.log('Preflight OK.');

    // Idempotent CLI-layer restatement — ensureSharedSkeleton's tail already
    // calls this transitively; fail-soft by that function's own contract.
    ensureGitExcludes(projectRoot);

    // Old-surface (pre-rename) migration legs — machine-owned artifacts
    // only, each running exactly once per init() call. The CLAUDE.local.md
    // import-line rewrite MUST precede deployClaudeLocal's import-presence
    // check below, so an already-migrated file gains no duplicate import
    // line.
    migrateOldSkillDir(projectRoot);
    migrateOldGuidanceFile(projectRoot);
    migrateClaudeLocalImportLine(projectRoot);

    const guidancePath = deployGuidance(projectRoot);
    const claudeLocalStatus = deployClaudeLocal(projectRoot);
    const configExampleStatus = deployConfigExample(projectRoot);
    const gitignoreStatus = deployGitignore(projectRoot);
    const skillResult = deploySkill(projectRoot, { readChannel });

    console.log(`nightfoundry-guidance.md: ${guidancePath} (refreshed)`);
    console.log(`CLAUDE.local.md: ${claudeLocalStatus}`);
    console.log(`.nightfoundry.json.example: ${configExampleStatus}`);
    console.log(`.gitignore: ${gitignoreStatus}`);
    for (const deployedPath of skillResult.deployedPaths) {
      console.log(`nightfoundry-operator skill: ${deployedPath} (refreshed)`);
    }
    console.log(`nightfoundry-operator skill release channel: ${skillResult.channel}`);
    console.log(
      'Recommend committing the deployed nightfoundry-operator skill ' +
      `(${SKILL_DEPLOY_RELPATH}${path.sep}) to version control.`
    );
    console.log(
      'If an AI session is already open in this repo, ask it to read nightfoundry-guidance.md now.'
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

/**
 * Gate an interactive spend verb (run / dry-run / brainstorm / the .md
 * shortcut) on the project root having been scaffolded by `cc-orch init`.
 *
 * - `.harness` present  → runs the freshness check INSTEAD of the
 *   fresh-root legs below. Fail-soft by contract: any fs read failure
 *   (including a missing/unreadable shipped template) or hashing error
 *   results in a silent return — this never throws and never blocks the
 *   calling verb. Gated on the CLAUDE.local.md import line as the ongoing
 *   consent signal:
 *     - import line absent            → silent (opt-out, including
 *       opt-out-with-residue: a stale guidance file left on disk never
 *       nags a user who deleted the line).
 *     - import line present, guidance file missing (dangling) → one
 *       stderr hint.
 *     - import line present, guidance file present but its stamp differs
 *       from sha256(SHIPPED TEMPLATE bytes) (never the deployed file's own
 *       bytes) → one stderr "outdated" hint.
 *     - import line present, guidance file present, stamp fresh → no-op.
 *   All freshness hints below the import-line opt-out check (dangling
 *   guidance, outdated guidance, dangling/outdated skill) are further gated
 *   through the injectable `opts.readChannel` seam (same seam used by
 *   `deploySkill`): if the seam resolves no channel, the gate is closed and
 *   every hint below it is silently skipped — fail-soft, same as any other
 *   fs/hash error in this block.
 * - `.harness` absent AND opts.refuse AND process.stdout.isTTY → a stderr
 *   refusal naming `cc-orch init` and process.exit(1).
 * - `.harness` absent otherwise → one stderr hint line; the verb proceeds.
 *
 * @param {string} projectRoot
 * @param {{ refuse?: boolean, readChannel?: () => (string|undefined) }} [opts]
 */
export function guardFreshRoot(projectRoot, { refuse = false, readChannel = defaultReadChannel } = {}) {
  let harnessExists = false;
  try {
    harnessExists = fs.existsSync(path.join(projectRoot, '.harness'));
  } catch {
    harnessExists = false;
  }

  if (harnessExists) {
    try {
      const claudeLocalPath = path.join(projectRoot, CLAUDE_LOCAL_FILENAME);
      const claudeLocalContent = fs.existsSync(claudeLocalPath)
        ? fs.readFileSync(claudeLocalPath, 'utf8')
        : '';

      if (!claudeLocalContent.includes(IMPORT_LINE)) {
        // Opt-out (or opt-out-with-residue) — the import line is the
        // ongoing consent signal; its absence silences everything below.
        return;
      }

      // Channel gate: every freshness hint below this point (guidance
      // dangling/outdated, skill dangling/outdated) is driven through the
      // same readChannel seam deploySkill uses. Hints fire ONLY when the
      // shipped release channel is exactly 'stable' — alpha/beta iterate
      // silently so fast Z-bumps never nag users (decision H). An
      // unresolved channel (unreadable/unset shipped package.json) also
      // stays silent, fail-soft, same as any other error in this block.
      if (readChannel() !== 'stable') {
        return;
      }

      const guidancePath = path.join(projectRoot, GUIDANCE_FILENAME);
      if (!fs.existsSync(guidancePath)) {
        console.error(
          'nightfoundry-guidance.md is missing but CLAUDE.local.md still imports it — ' +
          'run `cc-orch init` to restore it.'
        );
        return;
      }

      // Shipped template is only read+hashed once the deployed file exists.
      const deployedFirstLine = fs.readFileSync(guidancePath, 'utf8').split('\n')[0];
      const templateBytes = fs.readFileSync(TEMPLATE_PATH);
      const expectedHash = sha256Hex12(templateBytes);

      if (!deployedFirstLine.includes(expectedHash)) {
        console.error(
          'nightfoundry-guidance.md is outdated — run `cc-orch init` to refresh it.'
        );
      }

      // Third freshness leg: the deployed nightfoundry-operator skill, dangling
      // (sidecar missing) or outdated (sidecar hash stale vs. the SHIPPED
      // skill source — never the deployed copy's own bytes), collapsed into
      // one hint since the sidecar makes both conditions equally "refresh
      // needed".
      const skillDeployDir = path.join(projectRoot, SKILL_DEPLOY_RELPATH);
      const sidecarPath = path.join(skillDeployDir, SKILL_SIDECAR_FILENAME);
      let skillFresh = fs.existsSync(sidecarPath);
      if (skillFresh) {
        const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        const shippedEntries = walkFiles(SKILL_SRC_DIR).map((relPath) => ({
          relPath,
          bytes: fs.readFileSync(path.join(SKILL_SRC_DIR, relPath)),
        }));
        skillFresh = sidecar.hash === computeSkillHash(shippedEntries);
      }
      if (!skillFresh) {
        console.error(
          'nightfoundry-operator skill is missing or outdated — run `cc-orch init` to refresh it.'
        );
      }
    } catch {
      // Fail-soft by contract: any fs/hash error is a silent return, never
      // a throw and never a block on the calling verb (e.g. EISDIR when
      // nightfoundry-guidance.md is unexpectedly a directory).
    }
    return;
  }

  if (refuse && process.stdout.isTTY) {
    console.error(
      'Refusing: this project has no .harness/ yet. Run `cc-orch init` first — ' +
      'it scaffolds AI guidance + config templates before any spend verb runs.'
    );
    process.exit(1);
    return;
  }

  console.error(`fresh project — run \`${displayName()} init\` first for scaffolding + AI guidance`);
}
