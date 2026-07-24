/**
 * HaltError — thrown by Pipeline gates and coverage checks when
 * autoFromHere=true and the gate cannot proceed without human input
 * (non-TTY environment, free-text required, etc.).
 *
 * exit-77 semantics: callers may inspect `.site` and `.reason` to
 * produce a human-friendly error message and route to a distinct
 * non-zero exit code.
 *
 * Lives in its own leaf module to avoid the pipeline.js → coverage.js
 * circular dependency that would otherwise occur if HaltError stayed
 * inside pipeline.js (pipeline.js already imports from coverage.js).
 */
export class HaltError extends Error {
  constructor(site, reason) {
    super(
      `Auto mode encountered halt site (${site}): ${reason}. ` +
      `Re-run interactively, or fix the underlying failure.`
    );
    this.name = 'HaltError';
    this.site = site;
    this.reason = reason;
  }
}

/**
 * UserInterruptError — thrown (as a promise rejection) by the interactive
 * prompt helpers in src/cli/prompt.js when the user presses Ctrl-C at a
 * readline prompt. Subclasses HaltError so existing generic HaltError
 * handling stays safe, but carries its own message: the parent's
 * "Auto mode encountered halt site…" text would be a lie for an
 * interactive Ctrl-C. Consumers (e.g. batchResume) match via
 * `err instanceof UserInterruptError` to abort without recording a failure.
 */
export class UserInterruptError extends HaltError {
  constructor() {
    super('user-interrupt', 'user pressed Ctrl-C at an interactive prompt');
    this.message = 'Interrupted by user (Ctrl-C) at interactive prompt.';
    this.name = 'UserInterruptError';
  }
}
