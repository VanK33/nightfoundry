/**
 * reentrancy-guard.js — Refuses to let a process spawned from a LIVE
 * cc-orch run re-invoke cc-orch against the same project root while that
 * run is still active.
 *
 * Context: a live orchestrator run stamps CC_ORCH_ACTIVE_RUN into the
 * environment of any process it spawns (see run-marker.js). If that child
 * process turns around and runs cc-orch again against the SAME project
 * root — whose .harness/state.json still says globalStatus === 'active'
 * — the two runs would stomp on each other's state. This guard detects
 * exactly that situation and throws loudly before any mutation occurs.
 *
 * This module performs read-only I/O (a single defensive read of
 * state.json) and never writes or mutates any file.
 *
 * Public API:
 *   ReentrantRunError                              — Error subclass
 *   assertNoReentrantLiveRun(projectRoot, opts)     — throws or no-ops
 */

import fs from 'fs';
import path from 'path';
import { CC_ORCH_ACTIVE_RUN } from './run-marker.js';
import { resolveActiveHarnessDir } from './run-context.js';

export class ReentrantRunError extends Error {
  constructor(projectRoot) {
    super(
      `Refusing to run: this process was spawned from a LIVE cc-orch run ` +
      `(${CC_ORCH_ACTIVE_RUN} is set in the environment), and the target ` +
      `project root (${projectRoot}) has an ACTIVE harness run ` +
      `(.harness/state.json globalStatus === 'active'). ` +
      `Re-entering cc-orch against a live run's own project root can ` +
      `corrupt that run's state. ` +
      `If you are writing a test, do NOT point it at the live project ` +
      `root — create an isolated fixture root with fs.mkdtemp() instead.`
    );
    this.name = 'ReentrantRunError';
    this.projectRoot = projectRoot;
  }
}

/**
 * Throws ReentrantRunError when (and only when) all of the following hold:
 *   - env[CC_ORCH_ACTIVE_RUN] is set to a non-empty string (i.e. this
 *     process was itself spawned from a live cc-orch run), AND
 *   - resolveActiveHarnessDir(projectRoot) resolves the active-run pointer to
 *     a run harness directory (i.e. the pointer file exists and points at a
 *     run dir that has a state.json), AND
 *   - that run dir's state.json exists, parses as JSON, and has
 *     globalStatus === 'active'.
 *
 * In every other case this function is a silent no-op — including when
 * there is no active-run pointer at all, in which case a flat
 * .harness/state.json is never consulted. It never writes or mutates any
 * file — only a defensive read-and-parse of state.json.
 *
 * @param {string} projectRoot
 * @param {{ env?: object }} [options]
 */
export function assertNoReentrantLiveRun(projectRoot, { env = process.env } = {}) {
  const marker = env[CC_ORCH_ACTIVE_RUN];
  if (typeof marker !== 'string' || marker.length === 0) {
    return;
  }

  const resolvedDir = resolveActiveHarnessDir(projectRoot);
  if (resolvedDir === null) {
    return;
  }

  const stateFile = path.join(resolvedDir, 'state.json');
  let state;
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    state = JSON.parse(raw);
  } catch {
    return;
  }

  if (state && state.globalStatus === 'active') {
    throw new ReentrantRunError(projectRoot);
  }
}
