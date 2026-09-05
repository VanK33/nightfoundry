#!/usr/bin/env node

/**
 * cli/index.js — Main entry point for the `nightfoundry` command.
 *
 * Run `nightfoundry help` for the full command reference (USAGE constant below).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { usage, compare, usageAll } from './commands/usage.js';
import { health } from './commands/health.js';
import { queueList, queueRemove, queueRetry } from './commands/queue.js';
import { parkList, parkShow, parkResolve } from './commands/park.js';
import { suggest, mapFlagToCommand, KNOWN_COMMANDS } from './suggest.js';
import { activeHarnessDir } from '../orchestrator/core/run-context.js';
import { loadProjectConfig } from '../orchestrator/infra/project-config.js';
import { displayName } from '../orchestrator/infra/display-name.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  ${name} — Spec-driven coding harness

  Run:
    ${name} run <spec.md> [--model <id>] [--suite <cmd>]   Run a spec: single session + sealed acceptance + mechanical grading

  Inspect:
    ${name} usage [-j] [-d] [--role R] [--all] [--last N] [--since YYYY-MM-DD] [--include-failed] [--task <id>]   Token/cost summary
                                       (--include-failed implies --all: it filters the cross-archive aggregator)
    ${name} usage compare <a> <b>        Compare token usage across archives
    ${name} health                       Show system health and configuration status

  Queue & park:
    ${name} queue list                   List queued specs
    ${name} queue remove <slug>          Remove a queue entry
    ${name} queue retry <slug>           Reset a queue entry's status to pending
    ${name} park list                    List parked / halted queue entries
    ${name} park show <slug>             Show a parked entry's scene and spec paths
    ${name} park resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]   Resolve a parked entry

  Maintenance:
    ${name} version | help               Show version | this help

  Environment:
    PROJECT_ROOT    Override project root directory

  Exit codes:
    0   Success / delivered
    1   Error
    2   Parked (red loop exhausted without a green grade)
    3   Preflight refusal

  Global options:
    -p, --project <path>    Project root (default: cwd)
    -j, --json              JSON output (where supported)
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

  switch (cmd) {
    case 'run': {
      // The v0.3 loop (formerly `thin`). Self-sufficient on a bare checkout:
      // it creates queue/ and archives/ on demand and needs no init
      // scaffolding — gate reruns land in fresh worktrees by design.
      const specPath = positional[1];
      if (!specPath) {
        console.error(`Usage: ${displayName()} run <spec.md>`);
        process.exit(1); // arg errors are exit 1; 3 is reserved for preflight refusals
      }
      if (!fs.existsSync(specPath)) {
        console.error(`File not found: ${specPath}`);
        process.exit(1);
      }
      const { thinCommand } = await import('./commands/thin.js');
      const runExit = await thinCommand(specPath, projectRoot, { modelId: flags.model, suiteCommand: flags.suite });
      process.exit(runExit);
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
        console.error(`No .harness/state.json found. Use ${displayName()} usage --all to aggregate archived runs.`);
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

    case 'health': {
      return health();
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
 */
const VALUE_LONG_FLAGS = new Set(['role', 'task', 'project', 'last', 'since', 'note', 'model', 'suite']);

/**
 * Union of every long flag the CLI is expected to recognise (paired with
 * KNOWN_SHORT_FLAGS below for short flags), derived by unioning three
 * sources:
 *
 *   1. Literal `flags['...']` / `flags.x` reads across src/cli — in this
 *      file's main() and the surviving command modules (usage, queue, park).
 *   2. VALUE_LONG_FLAGS / VALUE_SHORT_FLAGS membership above (flags that
 *      always consume a following value).
 *   3. The dynamic flag-lookup table consulted instead of a literal
 *      `flags['...']` read: RESOLVE_ACTIONS in src/cli/commands/park.js
 *      (`requeue`, `waive`, `reject`, `approve`).
 *
 * The legacy FLAG_TO_COMMAND keys from suggest.js (without their leading
 * dashes) are unioned in as well, since main() routes those tokens through
 * parseArgs before reaching its 'Did you mean' branch.
 *
 * `allow-incomplete-scope` is retained temporarily: a registered test pins
 * its parseArgs behavior; it is scheduled for removal with the stage-4
 * zombie-test cleanup of the v0.2 removal.
 *
 * This constant does not change parsing behavior beyond gating unknown
 * options; it is also the reference set for flag-hygiene checks.
 */
const KNOWN_LONG_FLAGS = new Set([
  // (1) long keys read directly off `flags` in main()/commands
  'project',
  'model',
  'suite',
  'json',
  'all',
  'role',
  'task',
  'last',
  'since',
  'detailed',
  'note',
  'include-failed',
  'allow-incomplete-scope',
  // (2) VALUE_LONG_FLAGS
  ...VALUE_LONG_FLAGS,
  // (3) dynamic-table members from park.js (RESOLVE_ACTIONS)
  'requeue',
  'waive',
  'reject',
  'approve',
  // legacy FLAG_TO_COMMAND keys from suggest.js, without leading dashes
  'run',
  'usage',
  'health',
  'version',
  'help',
]);

/**
 * Union of every short flag the CLI is expected to recognise, derived using
 * the same sources documented above KNOWN_LONG_FLAGS: literal `flags.x`
 * reads across src/cli (-j, -d), VALUE_SHORT_FLAGS membership (-p), and the
 * short flags documented in the USAGE text. This constant is also the
 * reference set for flag-hygiene checks.
 */
const KNOWN_SHORT_FLAGS = new Set(['p', 'j', 'd', ...VALUE_SHORT_FLAGS]);

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
      // Short flags: -j, -jd (combined), -p value
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

// Only run when executed directly (not when imported as a module)
const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/nightfoundry') ||
  process.argv[1].endsWith('\\nightfoundry')
);

if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    if (Array.isArray(err.errors)) {
      for (const entry of err.errors) {
        console.error(entry);
      }
    }
    process.exit(1);
  });
}

export { parseArgs, main };
