/**
 * whole-suite-bash.js — Pure predicate: does a Bash command string run the
 * project's whole test suite?
 *
 * Used by session-manager's per-session `denyWholeSuiteBash` guard (opt-in at
 * spawn time — currently only the reviewer passes it). Lives in its own pure
 * module so session-manager can import it without creating an import cycle
 * with planner.js (which holds the exact-match `isWholeSuiteCommand` used for
 * hardCheck scoping — a DIFFERENT consumer with different semantics: that one
 * classifies declared check commands, this one inspects raw Bash invocations,
 * which may chain segments and carry redirections).
 *
 * Matching is deliberately segment-wise and exact-after-normalization:
 *   - the command is split on shell chaining operators (&&, ||, ;, |, newline)
 *   - each segment is trimmed and stripped of trailing redirections
 *     (`> f`, `>> f`, `2>&1`, `2> f`, `&> f`) and a trailing `&`
 *   - a segment matches iff it equals config.execution.testCommand or
 *     config.execution.testAllCommand exactly
 *
 * This catches `cd x && npm run test:all`, `npm test 2>&1`, and
 * `npm run test:all > /tmp/out.txt`, while NOT matching commands that merely
 * mention the suite command as data (`grep "npm test" file`, `echo 'npm run
 * test:all'`) — those segments are not equal to the suite command after
 * normalization. Flag-decorated variants (`npm test -- --grep x`) do not
 * match; the guard is defense-in-depth behind the prompt rule, not a sandbox.
 *
 * Public API:
 *   bashCommandRunsWholeSuite(command, cfg) → boolean
 */

/**
 * @param {string} command - Raw Bash command string from a tool call.
 * @param {object} cfg - Orchestrator config (uses cfg.execution.{testCommand,testAllCommand}).
 * @returns {boolean}
 */
export function bashCommandRunsWholeSuite(command, cfg) {
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  if (!cfg || !cfg.execution) return false;

  const suiteCommands = [cfg.execution.testCommand, cfg.execution.testAllCommand]
    .filter((c) => typeof c === 'string' && c.trim().length > 0)
    .map((c) => c.trim());
  if (suiteCommands.length === 0) return false;

  const segments = command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => normalizeSegment(s))
    .filter((s) => s.length > 0);

  return segments.some((seg) => suiteCommands.includes(seg));
}

/**
 * Trim a shell segment and strip trailing redirections / background markers
 * so `npm test 2>&1` and `npm run test:all > /tmp/x` normalize to the bare
 * suite command. Quoted strings are left intact — a segment like
 * `grep "npm test" file` keeps its arguments and therefore never equals the
 * bare suite command.
 *
 * @param {string} segment
 * @returns {string}
 */
function normalizeSegment(segment) {
  let s = segment.trim();
  // Repeatedly strip a trailing redirection (`> f`, `>> f`, `2> f`, `2>&1`,
  // `&> f`) or a trailing `&`.
  const TRAILING_REDIRECT = /\s*(?:[012&]?>>?\s*\S+|2>&1|&)\s*$/;
  let prev;
  do {
    prev = s;
    s = s.replace(TRAILING_REDIRECT, '').trim();
  } while (s !== prev);
  return s;
}
