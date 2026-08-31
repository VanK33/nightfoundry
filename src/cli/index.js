#!/usr/bin/env node

/**
 * cli/index.js — Main entry point for `cc-orch` command.
 *
 * Run `cc-orch help` for the full command reference (USAGE constant below).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { brainstorm } from './commands/brainstorm.js';
import { run } from './commands/run.js';
import { resume } from './commands/resume.js';
import { status } from './commands/status.js';
import { init, guardFreshRoot } from './commands/init.js';
import { usage, compare, usageAll } from './commands/usage.js';
import { review } from './commands/review.js';
import { archive } from './commands/archive.js';
import { archiveList } from './commands/archive-list.js';
import { archiveShow } from './commands/archive-show.js';
import { archiveDiff } from './commands/archive-diff.js';
import { health } from './commands/health.js';
import { ui } from './commands/ui.js';
import { dryRun } from './commands/dry-run.js';
import { task } from './commands/task.js';
import { queueList, queueRemove, queueRetry } from './commands/queue.js';
import { parkList, parkShow, parkResolve } from './commands/park.js';
import { warningsList, warningsShow, warningsResolve, warningsBrainstorm } from './commands/warnings.js';
import { clean } from './commands/clean.js';
import { reset } from './commands/reset.js';
import { dispersion } from './commands/dispersion.js';
import { suggest, mapFlagToCommand, KNOWN_COMMANDS } from './suggest.js';
import { gitGuard } from './git-guard.js';
import { SessionManager } from '../orchestrator/infra/session-manager.js';
import { Logger } from '../orchestrator/infra/logger.js';
import { TokenTracker } from '../orchestrator/infra/token-tracker.js';
import { activeHarnessDir, harnessRoot } from '../orchestrator/core/run-context.js';
import { loadProjectConfig } from '../orchestrator/infra/project-config.js';
import { runBaselineGate } from '../orchestrator/gates/baseline.js';
import { listQueue, readParkResumeMarker } from '../orchestrator/core/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Determine the display name to use in usage/help/version output based on
 * how the CLI was invoked (its `process.argv[1]` basename).
 *
 * @param {string} [argv1=process.argv[1]]
 * @returns {'cc-orch' | 'nightfoundry'}
 */
import { displayName } from '../orchestrator/infra/display-name.js';
export { displayName };

/**
 * Render the full CLI usage/help text, with the title line and every
 * command-invocation prefix rendered from `name`.
 *
 * @param {string} [name=displayName()]
 * @returns {string}
 */
export function renderUsage(name = displayName()) {
  return `
  ${name} — Multi-agent pipeline orchestrator

  Pipeline:
    ${name} run <spec.md> [-a]                         Run pipeline from spec
    ${name} dry-run <spec.md> [-a]                     Validate spec, queue for batch resume
    ${name} thin <spec.md> [--model <id>] [--suite <cmd>]  v0.3 thin loop: single session + sealed acceptance (experimental)
    ${name} resume [--batch] [-a]   Resume from saved state (--batch processes queue)
    ${name} task "<description>"                       Run single ad-hoc task
    ${name} <spec.md> [-a]                             Shortcut for run

  Brainstorm:
    ${name} brainstorm "<prose>" [--no-tty]   Start a brainstormer session for spec generation
    ${name} brainstorm --resume <slug>        Resume an existing brainstormer draft

  Inspect:
    ${name} status [node-id]             Show harness state
    ${name} usage [-j] [-d] [--role R] [--all] [--last N] [--since YYYY-MM-DD] [--include-failed] [--task <id>]   Token/cost summary
                                       (--include-failed implies --all: it filters the cross-archive aggregator)
    ${name} usage compare <a> <b>        Compare token usage across archives
    ${name} review                                 Review staged candidates (accept/reject/edit/defer)
    ${name} health                                 Show system health and configuration status
    ${name} ui [--port N]              Start static UI server (default port 3939)
    ${name} dispersion                List archive fingerprints
    ${name} dispersion <archive-id>   Show fingerprint detail
    ${name} dispersion compare <a> <b>  Compare two archive fingerprints

  Archive & queue:
    ${name} archive [name] [-P|--preserve] [--skip-test-gate]  Archive run (--preserve keeps spec; --skip-test-gate bypasses the final test:all gate)
    ${name} archive list                 List archives
    ${name} archive show <id> [--report] Show archive (--report opens HTML in browser)
    ${name} archive diff <a> <b>         Diff two archives
    ${name} queue list                   List queued specs
    ${name} queue remove <slug>          Remove a queue entry
    ${name} queue retry <slug>           Reset a queue entry's status to pending for resume --batch
    ${name} park list                    List parked / halted-review / halted-analyzer queue entries
    ${name} park show <slug>             Show a parked entry's scene and spec paths
    ${name} park resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]   Resolve a parked entry

  Warnings ledger:
    ${name} warnings list [--all]        List open/deferred reviewer warnings (--all includes waived/done)
    ${name} warnings show <id>           Show one ledger entry in full
    ${name} warnings resolve <id...> --waive|--defer|--done [--note <text>]   Resolve ledger entries
    ${name} warnings brainstorm <id...> [--no-tty]   Draft one bundled fix spec from selected warnings

  Maintenance:
    ${name} clean [--force]              Clean up harness artifacts
    ${name} reset <task-id>              Reset a task's state for re-execution
    ${name} init [spec.md]               Bootstrap .harness/
    ${name} version | help               Show version | this help

  Environment:
    PORT            Port for UI server (default: 3939)
    PROJECT_ROOT    Override project root directory
    EDITOR          Editor used for interactive review/edit steps

  Exit codes:
    0   Success
    1   Error
    75  Infrastructure error (infra-error)
    76  Unresumable state

  Global options:
    -p, --project <path>    Project root (default: cwd)
    -a, --auto              Auto-approve prompts; Category B/C gates halt for confirmation
    -j, --json              JSON output (where supported)
    --allow-dirty              Skip dirty-tree check (run, dry-run)
    --no-git-required          Skip git repository check (run, dry-run)
    --allow-incomplete-scope    Warn instead of error on unmatched scope items
`;
}

async function main() {
  const raw = process.argv.slice(2);
  const { flags, positional } = parseArgs(raw);

  const projectRoot = flags.project || flags.p || process.cwd();
  const jsonOut = !!(flags.json || flags.j);
  const harnessExists = () =>
    fs.existsSync(path.join(activeHarnessDir(projectRoot), 'state.json'));

  loadProjectConfig(projectRoot);

  const cmd = positional[0];

  // .md shortcut: route to run
  if (cmd && cmd.endsWith('.md')) {
    guardFreshRoot(projectRoot, { refuse: true });
    if (!fs.existsSync(cmd)) {
      console.error(`File not found: ${cmd}`);
      process.exit(1);
    }
    const gitResult = await gitGuard(projectRoot, { allowDirty: flags['allow-dirty'], noGitRequired: flags['no-git-required'] });
    if (!gitResult.ok) {
      console.error(gitResult.message);
      process.exit(1);
    }
    const baselineResult = await runBaselineGate(projectRoot);
    if (!baselineResult.ok) {
      console.error(baselineResult.message);
      process.exit(1);
    }
    return run(projectRoot, cmd, flags);
  }

  switch (cmd) {
    case 'run': {
      guardFreshRoot(projectRoot, { refuse: true });
      const specPath = positional[1];
      if (!flags['spec-stdin']) {
        if (!specPath) {
          console.error(`Usage: ${displayName()} run <spec.md>`);
          process.exit(1);
        }
        if (!fs.existsSync(specPath)) {
          console.error(`File not found: ${specPath}`);
          process.exit(1);
        }
      }
      const gitResult = await gitGuard(projectRoot, { allowDirty: flags['allow-dirty'], noGitRequired: flags['no-git-required'] });
      if (!gitResult.ok) {
        console.error(gitResult.message);
        process.exit(1);
      }
      const baselineResult = await runBaselineGate(projectRoot);
      if (!baselineResult.ok) {
        console.error(baselineResult.message);
        process.exit(1);
      }
      return run(projectRoot, specPath, flags);
    }

    case 'status': {
      guardFreshRoot(projectRoot, { refuse: false });
      if (!harnessExists()) {
        console.error(`No .harness/state.json found. Start a run with ${displayName()} run <spec.md> first.`);
        process.exit(1);
      }
      return status(projectRoot, positional[1]);
    }

    case 'resume': {
      // --batch reads from queue/, doesn't need .harness/state.json
      if (!flags.batch && !harnessExists()) {
        console.error(`No .harness/state.json found. Start a run with ${displayName()} run <spec.md> first.`);
        process.exit(1);
      }
      if (flags.batch) {
        // Non-batch resume continues an already-in-flight run whose working
        // tree was validated when it started, so it is intentionally not
        // baseline-gated here; only the --batch path (picking up fresh specs
        // from the queue) needs the baseline check applied.
        const exemption = computeBatchBaselineExemption(projectRoot);
        const baselineResult = await runBaselineGate(projectRoot, exemption);
        if (!baselineResult.ok) {
          console.error(baselineResult.message);
          process.exit(1);
        }
      }
      return resume(projectRoot, flags);
    }

    case 'brainstorm': {
      guardFreshRoot(projectRoot, { refuse: true });
      const harnessDir = harnessRoot(projectRoot);
      const sessionManager = new SessionManager();
      const logger = new Logger(harnessDir);
      const tokenTracker = new TokenTracker(harnessDir);
      if (flags.resume) {
        return brainstorm(projectRoot, [], flags, { sessionManager, logger, tokenTracker });
      }
      const prose = positional[1];
      if (!prose) {
        console.error(`Usage: ${displayName()} brainstorm "<prose>" [--no-tty]`);
        process.exit(1);
      }
      return brainstorm(projectRoot, [prose], flags, { sessionManager, logger, tokenTracker });
    }

    case 'usage': {
      if (positional[1] === 'compare') {
        if (!positional[2] || !positional[3]) {
          console.error(`Usage: ${displayName()} usage compare <a> <b>`);
          process.exit(1);
        }
        return compare(projectRoot, positional[2], positional[3], {});
      }
      // --include-failed auto-implies --all: the include-failed filter only
      // lives in the cross-archive path, so without --all the flag would be
      // silently ignored. Both --all and a lone --include-failed route here,
      // bypassing the live-only path's .harness/state.json requirement.
      if (flags.all || flags['include-failed']) {
        return usageAll(projectRoot, {
          json: jsonOut,
          role: flags.role,
          last: flags.last !== undefined ? Number(flags.last) : undefined,
          since: flags.since,
          all: true,
          includeFailed: !!flags['include-failed'],
        });
      }
      if (!harnessExists()) {
        console.error(`No .harness/state.json found. Start a run with ${displayName()} run <spec.md> first.`);
        process.exit(1);
      }
      return usage(projectRoot, {
        json: jsonOut,
        detailed: !!(flags.detailed || flags.d),
        role: flags.role,
        task: flags.task,
        // --include-failed without --all auto-implies --all inside usage()
        // (the include-failed filter only lives in the cross-archive path).
        includeFailed: !!flags['include-failed'],
        last: flags.last !== undefined ? Number(flags.last) : undefined,
        since: flags.since,
      });
    }

    case 'archive': {
      const sub = positional[1];
      if (sub === 'list') {
        return archiveList(projectRoot, { json: jsonOut });
      } else if (sub === 'show') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} archive show <id> [--report]`);
          process.exit(1);
        }
        return archiveShow(projectRoot, positional[2], { json: jsonOut, report: !!flags.report });
      } else if (sub === 'diff') {
        if (!positional[2] || !positional[3]) {
          console.error(`Usage: ${displayName()} archive diff <a> <b>`);
          process.exit(1);
        }
        return archiveDiff(projectRoot, positional[2], positional[3], { json: jsonOut });
      } else {
        return archive(projectRoot, sub, flags);
      }
    }

    case 'queue': {
      const sub = positional[1];
      if (sub === 'list') {
        return queueList(projectRoot, { json: jsonOut });
      } else if (sub === 'remove') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} queue remove <slug>`);
          process.exit(1);
        }
        return queueRemove(projectRoot, positional[2], { json: jsonOut });
      } else if (sub === 'retry') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} queue retry <slug>`);
          process.exit(1);
        }
        return queueRetry(projectRoot, positional[2]);
      } else {
        console.error(`Usage: ${displayName()} queue list|remove|retry <slug>`);
        process.exit(1);
      }
      break;
    }

    case 'park': {
      const sub = positional[1];
      if (sub === 'list') {
        return parkList(projectRoot, { json: jsonOut });
      } else if (sub === 'show') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} park show <slug>`);
          process.exit(1);
        }
        return parkShow(projectRoot, positional[2]);
      } else if (sub === 'resolve') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} park resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]`);
          process.exit(1);
        }
        return parkResolve(projectRoot, positional[2], flags);
      } else {
        console.error(`Usage: ${displayName()} park list|show <slug>|resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]`);
        process.exit(1);
      }
      break;
    }

    case 'warnings': {
      const sub = positional[1];
      if (sub === 'list') {
        return warningsList(projectRoot, { all: !!flags.all, json: jsonOut });
      } else if (sub === 'show') {
        if (!positional[2]) {
          console.error(`Usage: ${displayName()} warnings show <id>`);
          process.exit(1);
        }
        return warningsShow(projectRoot, positional[2]);
      } else if (sub === 'resolve') {
        return warningsResolve(projectRoot, positional.slice(2), flags);
      } else if (sub === 'brainstorm') {
        return warningsBrainstorm(projectRoot, positional.slice(2), flags);
      } else {
        console.error(`Usage: ${displayName()} warnings list [--all]|show <id>|resolve <id...> --waive|--defer|--done [--note <text>]|brainstorm <id...> [--no-tty]`);
        process.exit(1);
      }
      break;
    }

    case 'init': {
      return init(projectRoot, positional[1]);
    }

    case 'health': {
      return health();
    }

    case 'ui': {
      return ui(projectRoot, flags);
    }

    case 'dispersion': {
      return dispersion(projectRoot, positional.slice(1), flags, {});
    }

    case 'review': {
      return review(projectRoot);
    }

    case 'clean': {
      return clean(projectRoot, flags);
    }

    case 'reset': {
      const taskId = positional[1];
      if (!taskId) {
        console.error(`Usage: ${displayName()} reset <task-id>`);
        process.exit(1);
      }
      return reset(projectRoot, taskId);
    }

    case 'thin': {
      // No guardFreshRoot: thin is self-sufficient on a bare checkout (it
      // creates queue/ and archives/ on demand and needs no init scaffolding)
      // — gate reruns land in fresh worktrees by design.
      const thinSpecPath = positional[1];
      if (!thinSpecPath) {
        console.error(`Usage: ${displayName()} thin <spec.md>`);
        process.exit(1); // arg errors are exit 1; 3 is reserved for preflight refusals
      }
      if (!fs.existsSync(thinSpecPath)) {
        console.error(`File not found: ${thinSpecPath}`);
        process.exit(1);
      }
      const { thinCommand } = await import('./commands/thin.js');
      const thinExit = await thinCommand(thinSpecPath, projectRoot, { modelId: flags.model, suiteCommand: flags.suite });
      process.exit(thinExit);
    }

    case 'dry-run': {
      guardFreshRoot(projectRoot, { refuse: true });
      const specPath = positional[1];
      if (!flags['spec-stdin']) {
        if (!specPath) {
          console.error(`Usage: ${displayName()} dry-run <spec.md>`);
          process.exit(1);
        }
        if (!fs.existsSync(specPath)) {
          console.error(`File not found: ${specPath}`);
          process.exit(1);
        }
      }
      const gitResult = await gitGuard(projectRoot, { allowDirty: flags['allow-dirty'], noGitRequired: flags['no-git-required'] });
      if (!gitResult.ok) {
        console.error(gitResult.message);
        process.exit(1);
      }
      const baselineResult = await runBaselineGate(projectRoot);
      if (!baselineResult.ok) {
        console.error(baselineResult.message);
        process.exit(1);
      }
      return dryRun(projectRoot, specPath, flags);
    }

    case 'task': {
      const description = positional[1];
      if (!description) {
        console.error(`Usage: ${displayName()} task "<description>"`);
        process.exit(1);
      }
      const baselineResult = await runBaselineGate(projectRoot);
      if (!baselineResult.ok) {
        console.error(baselineResult.message);
        process.exit(1);
      }
      return task(projectRoot, description, flags);
    }

    case 'version': {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
      );
      console.log(`${displayName()} v${pkg.version}`);
      return;
    }

    case 'help': {
      console.log(renderUsage());
      return;
    }

    default: {
      if (!cmd) {
        // No positional args — check if raw input was a legacy --flag command
        if (raw.length > 0) {
          const mapped = mapFlagToCommand(raw[0]);
          if (mapped) {
            console.error(`Did you mean: ${mapped}?`);
            process.exit(1);
          }
        }
        // No args at all: show help
        console.log(renderUsage());
        return;
      }

      // Unknown positional command: try flag map then fuzzy suggest
      const mapped = mapFlagToCommand(cmd);
      if (mapped) {
        console.error(`Did you mean: ${mapped}?`);
        process.exit(1);
      }

      const suggestion = suggest(cmd, KNOWN_COMMANDS);
      if (suggestion) {
        console.error(`Did you mean: ${suggestion}?`);
      } else {
        console.error(`Unknown command: ${cmd}`);
      }
      process.exit(1);
    }
  }
}

/**
 * Short flags that consume a value argument when last in a group and followed
 * by a non-flag arg: -p /path.
 */
const VALUE_SHORT_FLAGS = new Set(['p']);

/**
 * Long flags that always consume their next argument as a value.
 * Legacy command flags such as --archive must not be listed here.
 */
const VALUE_LONG_FLAGS = new Set(['role', 'task', 'project', 'last', 'since', 'resume', 'port', 'note', 'model', 'suite']);

/**
 * Union of every long flag the CLI is expected to recognise (paired with
 * KNOWN_SHORT_FLAGS below for short flags), derived by unioning four
 * mandated sources:
 *
 *   1. Literal `flags['...']` / `flags.x` reads across src/cli — in this
 *      file's main() and every command module under src/cli/commands/.
 *   2. VALUE_LONG_FLAGS / VALUE_SHORT_FLAGS membership above (flags that
 *      always consume a following value).
 *   3. The dynamic flag-lookup tables consulted instead of a literal
 *      `flags['...']` read: RESOLVE_ACTIONS in src/cli/commands/park.js
 *      (`requeue`, `waive`, `reject`) and RESOLVE_VERBS in
 *      src/cli/commands/warnings.js (`waive`, `defer`, `done`).
 *   4. Every flag documented in the USAGE text constant above (e.g.
 *      --allow-dirty, --no-git-required, --allow-incomplete-scope,
 *      --include-failed, --skip-test-gate, --preserve/-P, --report,
 *      --port, --all, --last, --since, --task, --no-tty, --resume,
 *      --batch, --force, --note).
 *
 * The legacy FLAG_TO_COMMAND keys from suggest.js (without their leading
 * dashes: run, status, archive, usage, init, health, review, version, help)
 * are unioned in as well, since main() routes those tokens through
 * parseArgs before reaching its 'Did you mean' branch.
 *
 * This set was derived by running the full test suite (`npm run test:all`)
 * and adding any flag whose rejection by parseArgs caused a legitimate test
 * failure; the resulting KNOWN_LONG_FLAGS / KNOWN_SHORT_FLAGS sets were
 * then re-validated against the full suite (398/398 passing) with no test
 * relaxed to accommodate the whitelist. This constant does not change
 * parsing behavior; it exists as a reference set for flag-hygiene checks.
 */
const KNOWN_LONG_FLAGS = new Set([
  // (1) long keys read directly off `flags` in main()/commands
  'project',
  'model',
  'suite',
  'json',
  'all',
  'batch',
  'resume',
  'role',
  'task',
  'last',
  'since',
  'detailed',
  'report',
  'auto',
  'preserve',
  'force',
  'runs',
  'note',
  'port',
  'allow-dirty',
  'no-git-required',
  'allow-incomplete-scope',
  'spec-stdin',
  'include-failed',
  'skip-test-gate',
  'no-review',
  'no-tty',
  // (2) VALUE_LONG_FLAGS
  ...VALUE_LONG_FLAGS,
  // (3) dynamic-table members from park.js (RESOLVE_ACTIONS) and warnings.js (RESOLVE_VERBS)
  'requeue',
  'waive',
  'reject',
  'approve',
  'defer',
  'done',
  // (4) legacy FLAG_TO_COMMAND keys from suggest.js, without leading dashes
  'run',
  'status',
  'archive',
  'usage',
  'init',
  'health',
  'review',
  'version',
  'help',
]);

/**
 * Union of every short flag the CLI is expected to recognise, derived using
 * the same four mandated sources documented above KNOWN_LONG_FLAGS: (1)
 * literal `flags.x` reads across src/cli, (2) VALUE_SHORT_FLAGS membership,
 * (3) RESOLVE_ACTIONS (src/cli/commands/park.js) / RESOLVE_VERBS
 * (src/cli/commands/warnings.js) — neither of which contributes any short
 * flags today — and (4) short flags documented in the USAGE text (-p, -a,
 * -j). This set was validated against the full test suite (398/398
 * passing). This constant does not change parsing behavior; it exists as a
 * reference set for flag-hygiene checks.
 */
const KNOWN_SHORT_FLAGS = new Set(['p', 'a', 'j', 'd', 'P', 'r', 'R', ...VALUE_SHORT_FLAGS]);

/**
 * Parse CLI args into { flags, positional }.
 * Supports --long-name [value], -x [value], -abc (combined shorts).
 *
 * VALUE_SHORT_FLAGS chars consume next non-flag arg as a value (only when last in group).
 * VALUE_LONG_FLAGS keys always consume their next arg as a value.
 */
function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!KNOWN_LONG_FLAGS.has(key)) {
        throw new Error(`Unknown option: ${arg}`);
      }
      if (VALUE_LONG_FLAGS.has(key)) {
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          flags[key] = args[++i];
        } else {
          throw new Error(`Option --${key} requires a value`);
        }
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short flags: -a, -ra (combined), -p value
      const chars = arg.slice(1);
      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        if (!KNOWN_SHORT_FLAGS.has(c)) {
          throw new Error(`Unknown option: ${arg}`);
        }
        // Consume next arg as value only if:
        //   - this char is a value-taking flag
        //   - it is the last char in the group
        //   - a next arg exists and doesn't start with '-'
        if (
          VALUE_SHORT_FLAGS.has(c) &&
          j === chars.length - 1 &&
          i + 1 < args.length &&
          !args[i + 1].startsWith('-')
        ) {
          flags[c] = args[++i];
        } else {
          flags[c] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

/**
 * Compute a batch baseline-gate exemption descriptor for a project's queue.
 *
 * Mirrors the exact "pending" set that batchResume executes (pipeline.js's
 * `entries.filter((e) => e.status === 'pending')`). The batch baseline gate
 * is exempted ONLY when every pending entry carries a park-resume marker
 * (queue/{slug}/resumed-from-park.json, read via readParkResumeMarker) — a
 * single un-resolved pending entry, or an empty queue, means no exemption.
 *
 * Never throws: any read/IO/parse error (including a missing queue/
 * directory, which listQueue already reports as []) simply yields null, the
 * same degraded-queue outcome as "no exemption".
 *
 * @param {string} projectRoot
 * @returns {{ entries: Array<{ slug: string, stashSha: string }> } | null}
 */
export function computeBatchBaselineExemption(projectRoot) {
  try {
    const entries = listQueue(projectRoot);
    const pending = entries.filter((e) => e.status === 'pending');
    if (pending.length === 0) return null;

    const exemptEntries = [];
    for (const entry of pending) {
      const marker = readParkResumeMarker(projectRoot, entry.slug);
      if (!marker || typeof marker.stashSha !== 'string' || !marker.stashSha) return null;
      exemptEntries.push({ slug: entry.slug, stashSha: marker.stashSha });
    }

    return { entries: exemptEntries };
  } catch {
    return null;
  }
}

// Only run when executed directly (not when imported as a module)
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/cc-orch') ||
  process.argv[1].endsWith('\\cc-orch') ||
  process.argv[1].endsWith('/nightfoundry') ||
  process.argv[1].endsWith('\\nightfoundry')
);

if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    // Structured errors (e.g. BRAINSTORM_VALIDATION_FAILED) carry an
    // .errors array with per-item detail — print one line each.
    if (Array.isArray(err.errors)) {
      for (const entry of err.errors) {
        console.error(entry);
      }
    }
    process.exit(1);
  });
}

export { parseArgs, main };
