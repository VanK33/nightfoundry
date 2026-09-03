/**
 * thin-acceptance.js — The thin loop's mechanical grading step
 * (M1 blueprint v3 §范围-in item 2). Three $0 sub-steps, one combined
 * result:
 *
 *   1. Exam — run the externally provided `<spec>.accept.*` file from the
 *      PROJECT ROOT. Contract: any executable (interpreter dispatched by
 *      extension), exit 0 = green, stdout lines `PASS <label>` /
 *      `FAIL <label>` give the per-assert record. FAIL lines override a
 *      lying exit code; an unrunnable exam is an explicit error, never a
 *      silent green.
 *   2. Suite — the project's configured full-test command; exit code is
 *      the verdict, the output tail is kept for the red list. A missing
 *      command is an explicit skip (never counted as green).
 *   3. Scope — files changed vs the preflight base sha (tracked diff +
 *      untracked), compared against the spec's target_files. Benign
 *      ADDITIONS are whitelisted per the blueprint's adjudication policy:
 *      new `test*` files and new `*.md` files are recorded but not red.
 *      Modifications of existing out-of-target files are always red.
 *
 * Known bounded risk (recorded): an exam that floods stdout and then calls
 * process.exit(0) can truncate its own late output at the pipe buffer; a
 * truncated FAIL line would then be missed. Requires an exam-author bug plus
 * huge output — accepted and documented rather than defended.
 *
 * All subprocess execution goes through injectable seams (`runArgv` for the
 * exam, `runShell` for suite/git; legacy `run` feeds both) so unit
 * tests never spawn real children (the two real-exec TCs cover the
 * contract end to end). Pure result objects; no writes, no model calls.
 */
import { spawnSync } from 'child_process';
import path from 'path';

/** Default exam timeout: a hung exam must never block an unattended run. */
export const EXAM_TIMEOUT_MS = 10 * 60 * 1000;
/** Default full-suite timeout. */
export const SUITE_TIMEOUT_MS = 60 * 60 * 1000;

function finish(r) {
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`killed by ${r.signal} (timeout?)`);
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Default runner: argv array -> {status, stdout, stderr}. */
function defaultRun(argv, opts = {}) {
  return finish(spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? EXAM_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }));
}

/** Shell-string runner for the configured suite command. */
function defaultRunShell(cmd, opts = {}) {
  return finish(spawnSync(cmd, {
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? SUITE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  }));
}

/**
 * Parse exam stdout into per-assert records.
 * @param {string} stdout
 * @returns {{pass: number, fail: number, lines: Array<{status: string, label: string}>}}
 */
export function parseExamOutput(stdout) {
  const lines = [];
  for (const raw of String(stdout).split(/\r?\n/)) {
    const m = raw.match(/^(PASS|FAIL)\s+(.*?)\r?$/);
    if (m) lines.push({ status: m[1], label: m[2].trim() });
  }
  return {
    pass: lines.filter((l) => l.status === 'PASS').length,
    fail: lines.filter((l) => l.status === 'FAIL').length,
    lines,
  };
}

/** Interpreter dispatch by extension. */
function examArgv(acceptPath) {
  const ext = path.extname(acceptPath);
  if (ext === '.mjs' || ext === '.js') return ['node', acceptPath];
  if (ext === '.py') return ['python3', acceptPath];
  if (ext === '.sh') return ['bash', acceptPath];
  return [acceptPath];
}

/**
 * Run the exam. Never throws; an unrunnable exam returns an explicit
 * error result.
 * @returns {{ok: boolean, pass: number, fail: number, lines: Array,
 *            failLabels: string[], exitCode?: number, error?: string}}
 */
export function runAcceptance(acceptPath, projectRoot, deps = {}) {
  const run = deps.runArgv ?? deps.run ?? defaultRun;
  let res;
  try {
    res = run(examArgv(acceptPath), { cwd: projectRoot, timeoutMs: deps.examTimeoutMs });
  } catch (err) {
    return {
      ok: false,
      pass: 0,
      fail: 0,
      lines: [],
      failLabels: [],
      error: `exam unrunnable: ${err.message}`,
    };
  }
  const parsed = parseExamOutput(res.stdout);
  if (res.status === 0 && parsed.pass === 0 && parsed.fail === 0) {
    // Zero-assertion floor: an exam that exits 0 without emitting a single
    // PASS/FAIL line is treated as broken, never as a silent green (the
    // unattended loop must not deliver on an empty exam).
    return {
      ok: false, pass: 0, fail: 0, lines: [], failLabels: [],
      exitCode: res.status,
      error: 'exam produced no PASS/FAIL assertions (zero-assertion floor)',
    };
  }
  const ok = res.status === 0 && parsed.fail === 0;
  return {
    ok,
    ...parsed,
    failLabels: parsed.lines.filter((l) => l.status === 'FAIL').map((l) => l.label),
    exitCode: res.status,
    stderrTail: String(res.stderr || '').split('\n').slice(-10).join('\n'),
  };
}

/**
 * Run the project's full-test command (shell string, e.g. from
 * `.nightfoundry.json`'s testAllCommand). Missing command = explicit skip.
 * @returns {{ok: boolean|undefined, skipped?: boolean, exitCode?: number, tail?: string, error?: string}}
 */
export function runSuite(projectRoot, testAllCommand, deps = {}) {
  if (!testAllCommand) {
    return { ok: undefined, skipped: true };
  }
  const run = deps.runShell ?? deps.run ?? defaultRunShell;
  let res;
  try {
    res = run(testAllCommand, { cwd: projectRoot, timeoutMs: deps.suiteTimeoutMs });
  } catch (err) {
    return { ok: false, error: `suite unrunnable: ${err.message}` };
  }
  const tail = (String(res.stdout) + '\n' + String(res.stderr))
    .split('\n')
    .filter(Boolean)
    .slice(-15)
    .join('\n');
  return { ok: res.status === 0, exitCode: res.status, tail };
}

/**
 * Scope diff vs the preflight base sha.
 *
 * changed     = tracked diff names + untracked files (sorted, deduped)
 * whitelisted = ADDED files whose basename starts with `test` or ends
 *               with `.md` (recorded, never red)
 * outOfScope  = changed − target_files − whitelisted
 *
 * @param {string} projectRoot
 * @param {string} baseSha
 * @param {string[]} targetFiles - spec target_files (project-relative)
 * @param {object} [deps] - { run? } shell-string runner seam
 */
export function scopeDiff(projectRoot, baseSha, targetFiles, deps = {}) {
  const run = deps.runShell ?? deps.run ?? defaultRunShell;
  const sh = (cmd) => String(run(cmd, { cwd: projectRoot }).stdout || '');

  // -c core.quotePath=false: non-ASCII paths (中文文件名) must come back
  // verbatim, or target matching and the whitelist silently break (false
  // reds). --no-renames: a rename surfaces as A+D so the old target path is
  // visible and the new path can enter the additions whitelist.
  const G = 'git -c core.quotePath=false';
  const tracked = sh(`${G} diff --no-renames --name-only ${baseSha}`).split('\n').filter(Boolean);
  const added = new Set(sh(`${G} diff --no-renames --diff-filter=A --name-only ${baseSha}`).split('\n').filter(Boolean));
  const untracked = sh(`${G} ls-files --others --exclude-standard`).split('\n').filter(Boolean);
  for (const u of untracked) added.add(u);

  const changed = [...new Set([...tracked, ...untracked])].sort();
  const targets = new Set(targetFiles || []);
  const whitelisted = [];
  const outOfScope = [];
  for (const f of changed) {
    if (targets.has(f)) continue;
    const base = path.basename(f);
    if (added.has(f) && (base.startsWith('test') || base.endsWith('.md'))) {
      whitelisted.push(f);
    } else {
      outOfScope.push(f);
    }
  }
  return { changed, whitelisted, outOfScope };
}

/**
 * Combined mechanical grading. `green` is the single verdict the red loop
 * consumes; `redList` is the exact text handed back to the executor on a
 * retry (FAIL labels + suite tail + out-of-scope names).
 *
 * @param {object} p - { acceptPath, projectRoot, baseSha, targetFiles,
 *                       testAllCommand, deps? }
 */
export function assembleGrade({ acceptance, suite, scope }) {
  const redList = [];
  for (const label of acceptance.failLabels) redList.push(`acceptance FAIL: ${label}`);
  if (acceptance.error) redList.push(`acceptance error: ${acceptance.error}`);
  if (suite.ok === false) redList.push(`test suite red:\n${suite.tail || suite.error || ''}`);
  for (const f of scope.outOfScope) redList.push(`out-of-scope edit: ${f}`);

  const green = acceptance.ok && suite.ok !== false && scope.outOfScope.length === 0;
  // An exam-level ERROR (crash, timeout, zero-assertion floor) is carried as
  // a synthetic fail label so the suspected-acceptance-defect channel can
  // fire on it: the same error in every round is exactly the "the exam
  // itself is broken" signature — the executor cannot fix the harness.
  const failLabels = [...(acceptance.failLabels ?? [])];
  if (acceptance.error) failLabels.push(`exam-error: ${acceptance.error}`);
  return {
    acceptance,
    suite,
    scope,
    green,
    redList,
    failLabels,
  };
}

export function runAll(p) {
  const deps = p.deps ?? {};
  const acceptance = runAcceptance(p.acceptPath, p.projectRoot, deps);
  const suite = runSuite(p.projectRoot, p.testAllCommand, deps);
  const scope = scopeDiff(p.projectRoot, p.baseSha, p.targetFiles, deps);
  return assembleGrade({ acceptance, suite, scope });
}
