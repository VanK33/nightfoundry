/**
 * dashboard.js — Minimal TTY-aware dashboard for parallel execution.
 *
 * Phase I items 4+5, decision D1 = B (per-session log files + status
 * dashboard) from docs/design/phase-1-parallel-execution.md §4.
 *
 * Behavior:
 *   - TTY mode: maintains a persistent single-line status at the
 *     bottom of the output showing running / queued / done / total
 *     counts, updated via \r + ANSI clear-line. Event lines
 *     (task-start / task-complete / task-fail) print above the
 *     status line and scroll normally.
 *   - Non-TTY mode (CI, piped stdout, log capture): the dashboard
 *     is a passthrough. Events and log lines print as plain
 *     newline-terminated lines. No ANSI escapes, no cursor control.
 *
 * The dashboard owns the `onLog` and `onProgress` sinks for any
 * component that wants dashboard-aware output. Callers wire:
 *
 *     const dashboard = new Dashboard({ sink: console.log });
 *     const scheduler = new Scheduler({
 *       onLog: (msg) => dashboard.log(msg),
 *       onProgress: (evt) => dashboard.onProgress(evt),
 *       ...
 *     });
 *
 * Non-goals for v1 (deferred to future):
 *   - Multi-line dashboard blocks with per-task rows
 *   - Color, unicode progress bars
 *   - Per-task ETA estimation
 *   - Persistent state across milestones
 *
 * Public API:
 *   class Dashboard {
 *     constructor({ output = process.stdout, sink = console.log, statusBar = null })
 *                                — pass a StatusBar instance to delegate TTY rendering to it
 *     log(message)               — dashboard-aware log sink
 *     onProgress(event)          — scheduler event consumer
 *     isActive()                 — true while a milestone is live
 *   }
 */

import { wrapLine, getTerminalWidth } from './wrap.js';

// ANSI control sequences. Used only when the output stream is a TTY.
const ANSI_CLEAR_LINE = '\r\x1b[K';

export class Dashboard {
  /**
   * @param {object} opts
   * @param {NodeJS.WriteStream} [opts.output]    Stream for ANSI rendering. Defaults to process.stdout.
   * @param {function}           [opts.sink]      Fallback sink used in non-TTY mode AND when the dashboard is inactive. Defaults to console.log.
   * @param {StatusBar|null}     [opts.statusBar] Optional StatusBar instance. When provided (non-null), TTY log
   *                                              lines and progress event lines are delegated to statusBar.onLog()
   *                                              and the built-in ANSI status line (_renderStatus) is suppressed.
   *                                              Pass null (default) for the original self-rendering behavior.
   */
  constructor({ output = process.stdout, sink = console.log, statusBar = null } = {}) {
    this.output = output;
    this.sink = sink;
    this.isTTY = Boolean(output && output.isTTY);
    this.statusBar = statusBar ?? null;
    this.statusBarActive = Boolean(statusBar);
    this._state = null;
    this._statusLinePrinted = false;
  }

  /**
   * True iff a milestone is currently being tracked.
   */
  isActive() {
    return this._state !== null;
  }

  /**
   * Dashboard-aware log sink. Callers route their onLog through this
   * so log lines print cleanly above the persistent status line.
   *
   * In non-TTY mode OR when the dashboard is inactive, this falls
   * through to the configured sink (typically console.log).
   */
  log(message) {
    const wrapped = wrapLine(String(message), { stream: this.output, fallbackWidth: 100, margin: 2 });
    if (this.isTTY && this.statusBar) {
      this.statusBar.onLog(wrapped);
      return;
    }
    if (!this._state || !this.isTTY) {
      this.sink(wrapped);
      return;
    }
    this._emitLine(wrapped);
    if (!this.statusBarActive) {
      this._renderStatus();
    }
  }

  /**
   * Consume a scheduler progress event. See scheduler.js for the
   * event shapes. The dashboard mutates its internal state and
   * re-renders the status line on every event.
   */
  onProgress(evt) {
    if (!evt || typeof evt !== 'object') return;

    switch (evt.type) {
      case 'milestone-start':
        this._state = {
          milestoneId: evt.milestoneId,
          total: evt.total || 0,
          complete: evt.preTerminal || 0,
          running: 0,
          errored: 0,
          runningTasks: new Map(),
        };
        if (this.isTTY) {
          if (!this.statusBar) {
            this._renderStatus();
          }
        } else {
          this.sink(`  [dashboard] milestone ${evt.milestoneId}: ${evt.total} total, ${evt.pending} pending, ${evt.preTerminal || 0} already done`);
        }
        break;

      case 'task-start':
        if (!this._state) break;
        this._state.runningTasks.set(evt.taskId, {
          startTime: Date.now(),
          description: evt.description || '',
          missionId: evt.missionId,
        });
        this._state.running = evt.running ?? this._state.running;
        if (this.isTTY) {
          if (this.statusBar) {
            this.statusBar.onLog(`  > ${evt.taskId}${evt.description ? ' — ' + evt.description : ''}`);
          } else {
            this._emitLine(`  > ${evt.taskId}${evt.description ? ' — ' + evt.description : ''}`);
            this._renderStatus();
          }
        }
        break;

      case 'task-complete': {
        if (!this._state) break;
        const entry = this._state.runningTasks.get(evt.taskId);
        const elapsed = entry ? Math.round((Date.now() - entry.startTime) / 1000) : 0;
        this._state.runningTasks.delete(evt.taskId);
        this._state.running = evt.running ?? this._state.running;
        this._state.complete++;
        if (this.isTTY) {
          if (this.statusBar) {
            this.statusBar.onLog(`  v ${evt.taskId} (${elapsed}s)`);
          } else {
            this._emitLine(`  v ${evt.taskId} (${elapsed}s)`);
            this._renderStatus();
          }
        }
        break;
      }

      case 'task-fail': {
        if (!this._state) break;
        this._state.runningTasks.delete(evt.taskId);
        this._state.errored++;
        if (this.isTTY) {
          if (this.statusBar) {
            this.statusBar.onLog(`  x ${evt.taskId} — ${evt.error || 'error'}`);
          } else {
            this._emitLine(`  x ${evt.taskId} — ${evt.error || 'error'}`);
            this._renderStatus();
          }
        } else {
          this.sink(`  [dashboard] task ${evt.taskId} failed: ${evt.error || 'error'}`);
        }
        break;
      }

      case 'milestone-complete':
        if (this.isTTY && this._statusLinePrinted && !this.statusBarActive) {
          // Release the status line so the next stdout write starts
          // on a fresh line instead of clobbering the status.
          this.output.write('\n');
          this._statusLinePrinted = false;
        } else if (!this.isTTY && this._state) {
          const s = this._state;
          this.sink(`  [dashboard] milestone ${s.milestoneId} complete: ${s.complete}/${s.total} done${s.errored ? ', ' + s.errored + ' errored' : ''}`);
        }
        this._state = null;
        break;

      default:
        // Unknown event type — ignore to stay forward-compatible.
        break;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Print a one-line event message, clearing the persistent status
   * line first (if present) so the event lands cleanly. Does NOT
   * re-render the status afterwards — callers should call
   * _renderStatus() themselves if they want the status to reappear.
   */
  _emitLine(text) {
    if (!this.isTTY) {
      this.sink(text);
      return;
    }
    if (!this.statusBarActive && this._statusLinePrinted) {
      this.output.write(ANSI_CLEAR_LINE);
      this._statusLinePrinted = false;
    }
    this.output.write(text + '\n');
  }

  /**
   * Write (or overwrite) the persistent status line at the current
   * cursor position. Uses \r + ANSI clear-line to replace whatever
   * was last drawn without leaving artifacts. No trailing newline —
   * the cursor stays on the same visual line so the next _emitLine
   * can replace it.
   */
  _renderStatus() {
    if (this.statusBarActive) return;
    if (!this.isTTY || !this._state) return;
    const s = this._state;
    const pending = Math.max(0, s.total - s.complete - s.running - s.errored);
    const parts = [
      `${s.running} running`,
      `${pending} queued`,
      `${s.complete} done`,
      `${s.total} total`,
    ];
    if (s.errored > 0) parts.push(`${s.errored} errored`);
    const line = `  [sched ${s.milestoneId}] ${parts.join(' / ')}`;
    this.output.write(ANSI_CLEAR_LINE + line);
    this._statusLinePrinted = true;
  }
}
