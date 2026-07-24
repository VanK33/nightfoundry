/**
 * status-bar.js — Multi-row TTY status bar with DECSTBM scroll-region isolation.
 *
 * Renders a live block at the bottom of the terminal showing per-agent
 * rows, overall progress, and milestone state. Uses ANSI DECSTBM (set
 * top and bottom margins) to carve out a reserved region at the bottom
 * so normal log output scrolls freely above without overwriting the bar.
 *
 * Behavior:
 *   - TTY mode (enabled=true): maintains a persistent multi-row status
 *     block updated via ANSI cursor-positioning and DECSTBM scroll regions.
 *   - Non-TTY mode (enabled=false): fully inert — all public methods are
 *     no-ops.  No ANSI escapes are ever written.
 *
 * DECSTBM strategy:
 *   _render() writes `\x1b[1;{rows-barHeight}r` to constrain the scroll
 *   region to the lines above the bar.  hide() resets to `\x1b[r` (full
 *   screen) and erases the bar area.  show() re-establishes the region.
 *
 * Fallback: when process.stdout.rows / columns are undefined the
 * implementation treats the terminal as 80×24.
 *
 * Public API:
 *   class StatusBar {
 *     constructor(options = {})
 *       opts.maxRows  {number}               Max agent rows to display. Default 8.
 *       opts.output   {NodeJS.WriteStream}    Output stream. Default process.stdout.
 *       opts.enabled  {boolean}              Defaults to output.isTTY.
 *     updateAgent(name, state)
 *       state: { role, taskId, description, status, elapsed, cost }
 *       Pass null/undefined to remove the agent row.
 *     updateProgress(done, total, totalCost, sessionCount)
 *     updateMilestone(msId, msTotal, elapsed)
 *     _render()            — immediate (re-)render, cancels pending debounce
 *     _scheduleRender()    — debounced _render(), coalesces calls within 100ms
 *     hide()               — erase bar + reset scroll region
 *     show()               — re-render bar + re-establish scroll region
 *     destroy()            — remove resize listener, hide bar, go inert
 *     promptWillStart()    — position cursor in scroll region before readline takes over
 *     promptDidEnd()       — re-render bar after readline closes
 *   }
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// ── Agent role icons ───────────────────────────────────────────────────────
const ROLE_ICONS = {
  planner: '🧠',
  executor: '⚡',
  verifier: '🔍',
  reviewer: '📋',
  analyzer: '🔧',
  summarizer: '📝',
};

// ── ANSI helpers (only emitted in TTY mode) ────────────────────────────────
const ANSI_SAVE_CURSOR    = '\x1b[s';
const ANSI_RESTORE_CURSOR = '\x1b[u';
const ANSI_CLEAR_TO_END   = '\x1b[J';
const ANSI_SHOW_CURSOR    = '\x1b[?25h';
const ANSI_RESET_SCROLL   = '\x1b[r';          // reset scroll region to full screen
const ANSI_SET_SCROLL     = (top, bot) => `\x1b[${top};${bot}r`;
const ANSI_MOVE_TO        = (row, col = 1) => `\x1b[${row};${col}H`;

// ── Version loading ────────────────────────────────────────────────────────
function _readVersion() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Elapsed time formatting ────────────────────────────────────────────────
function formatElapsed(seconds) {
  if (seconds == null) return '';
  const s = Math.floor(Number(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

// ── String truncation with '...' suffix ───────────────────────────────────
function truncate(str, maxLen) {
  if (!str) return '';
  if (maxLen <= 0) return '';
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return '...'.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}

// ── StatusBar ──────────────────────────────────────────────────────────────

export class StatusBar {
  /**
   * @param {object}             [opts]
   * @param {number}             [opts.maxRows=8]              Max agent rows.
   * @param {NodeJS.WriteStream} [opts.output=process.stdout]  Render target.
   * @param {boolean}            [opts.enabled]                Defaults to output.isTTY.
   */
  constructor({
    maxRows = 8,
    output = process.stdout,
    enabled = Boolean(output && output.isTTY),
  } = {}) {
    this.maxRows     = maxRows;
    this.output      = output;
    this.enabled     = enabled;

    // Read version from root package.json at construction time.
    this.version = _readVersion();

    // ── Agent state (one entry per active agent name) ──────────────
    // Each value: { role, taskId, description, status, elapsed, cost }
    this.agents = new Map();

    // ── Progress / milestone state ─────────────────────────────────
    this._progress = { done: 0, total: 0, totalCost: 0, sessionCount: 0, phase: null };
    this._milestone = { msId: null, msTotal: 0, elapsed: 0 };

    // ── Rendering bookkeeping ──────────────────────────────────────
    this._renderedLines      = 0;     // lines written in last _render()
    this._renderedRows       = 0;     // terminal rows at last _render() (for stale-position tracking)
    this._debounceTimer      = null;
    this._hidden             = false;
    this._scrollRegionActive = false; // true after first _render(); reset by hide()
    this._promptActive       = false; // true while readline prompt is active; blocks _scheduleRender()

    // ── Resize handler ─────────────────────────────────────────────
    this._onResize = () => {
      // Erase old bar area before re-rendering at the new position so stale
      // bar content does not remain visible in the old terminal rows.
      if (this._renderedLines > 0) {
        const oldBarStartRow = Math.max(1, this._renderedRows - this._renderedLines + 1);
        this.output.write(
          ANSI_SAVE_CURSOR +
          ANSI_MOVE_TO(oldBarStartRow, 1) +
          ANSI_CLEAR_TO_END +
          ANSI_RESTORE_CURSOR,
        );
      }
      this._scrollRegionActive = false;
      this._render();
    };
    if (this.enabled && this.output && typeof this.output.on === 'function') {
      this.output.on('resize', this._onResize);
    }
  }

  // ── Terminal dimensions ────────────────────────────────────────────────

  /** Returns terminal { rows, columns }, falling back to 80×24. */
  _getDimensions() {
    const rows    = (this.output && this.output.rows    != null) ? this.output.rows    : 24;
    const columns = (this.output && this.output.columns != null) ? this.output.columns : 80;
    return { rows: Math.max(4, rows), columns: Math.max(10, columns) };
  }

  // ── Public update methods ──────────────────────────────────────────────

  /**
   * Add, update, or remove an agent row.
   * Schedules a debounced render (100 ms). Call _render() directly for
   * immediate output (e.g. in tests).
   *
   * @param {string}      name   Unique agent name / identifier.
   * @param {object|null} state  Agent state, or null/undefined to remove.
   */
  updateAgent(name, state) {
    if (!this.enabled) return;
    if (state == null) {
      this.agents.delete(name);
    } else {
      this.agents.set(name, state);
    }
    this._scheduleRender();
  }

  /**
   * Update overall pipeline progress counters.
   * Schedules a debounced render (100 ms).
   *
   * @param {number} done
   * @param {number} total
   * @param {number} totalCost
   * @param {number} sessionCount
   * @param {string} [phase]  Optional phase name shown instead of bar when total===0.
   */
  updateProgress(done, total, totalCost, sessionCount, phase) {
    if (!this.enabled) return;
    this._progress = {
      done,
      total,
      totalCost,
      sessionCount,
      phase: phase != null ? phase : this._progress.phase,
    };
    this._scheduleRender();
  }

  /**
   * Set the current phase name, displayed instead of the progress bar
   * when total===0. Schedules a debounced render.
   *
   * @param {string|null} name  Phase label, e.g. 'planning mission 001'.
   */
  setPhase(name) {
    if (!this.enabled) return;
    this._progress = { ...this._progress, phase: name };
    this._scheduleRender();
  }

  /**
   * Update the current milestone state.
   * Schedules a debounced render (100 ms).
   *
   * @param {string|number} msId      Milestone identifier.
   * @param {number}        msTotal   Total tasks in this milestone.
   * @param {number}        elapsed   Elapsed seconds since milestone start.
   */
  updateMilestone(msId, msTotal, elapsed) {
    if (!this.enabled) return;
    this._milestone = { msId, msTotal, elapsed };
    this._scheduleRender();
  }

  // ── Log output ────────────────────────────────────────────────────────────

  /**
   * Write a log message into the DECSTBM scroll region so it appears above
   * the status bar without interleaving with bar rendering.
   *
   * Behaviour:
   *   - No-op when enabled=false (non-TTY / disabled).
   *   - When bar is hidden (_hidden=true): writes message + newline directly to
   *     the output stream (full-screen scroll region is already in effect).
   *   - When bar is visible: saves cursor, scrolls the DECSTBM region up by one
   *     line (\x1b[S), moves to column 1 of scrollBottom, writes the message,
   *     then restores the cursor.  Every call uses this single path — there is no
   *     fill-from-top phase.  Each call is a single atomic output.write() call,
   *     which prevents interleaving from parallel callers.
   *
   * @param {string} message  The log line to emit (coerced to string).
   */
  onLog(message) {
    if (!this.enabled) return;

    const text = String(message == null ? '' : message);

    if (this._hidden) {
      // Bar is hidden → scroll region is full screen; write directly.
      this.output.write(text + '\n');
      return;
    }

    // Defect #9: if bar has never been rendered, run _render() first to
    // establish the DECSTBM region. Without this, onLog with
    // _renderedLines===0 falls into the path where scrollBottom === rows
    // (the terminal's last physical row) and \x1b[S scrolls the entire
    // terminal — a working but implicit contract that caller order
    // matters. Auto-rendering makes the contract explicit: onLog is safe
    // at any point regardless of whether _render() has been called.
    //
    // Side effect: the first onLog now pays ~one render (~ms), and the
    // visual is "bar appears before first log" instead of "first log
    // appears at terminal bottom, then bar overlays it on next render."
    // The latter was observed in pre-fix dogfood runs as a startup flash.
    if (this._renderedLines === 0) {
      this._render();
    }

    // Bar is visible: use \x1b[S (SU) to scroll the active DECSTBM region up by
    // one line (row 1 scrolls off; scrollBottom becomes blank), then write the new
    // message at scrollBottom.  This avoids relying on '\n' at the scroll-region
    // bottom, which has unreliable behaviour in some xterm implementations.
    //
    // Defect #6 fix: split incoming text on embedded '\n' AND truncate each
    // segment to (cols - 1) to prevent two distinct overflow modes from
    // clobbering bar rows:
    //
    //   (a) Embedded '\n' inside `text` (e.g. multi-line banners produced by
    //       `_formatBanner(...).join('\n')` from pipeline.js) advances the
    //       cursor past the DECSTBM bottom margin without scrolling, since
    //       VT100 scrolls only when LF/index fires AT the bottom margin
    //       INSIDE the region. Each subsequent '\n' lands on a bar row.
    //   (b) Auto-wrap (DECAWM, default on) on a segment longer than terminal
    //       width pushes cursor to the next physical row — which, at the
    //       DECSTBM bottom margin, is a bar row.
    //
    // Both modes are confirmed by paired A+B agent xterm-headless repro
    // (2026-04-26 investigation). Splitting + truncating + per-segment
    // SAVE+SU+MOVE+text+RESTORE addresses both: each segment triggers its
    // own scroll-up and never wraps.
    const rows         = this._renderedRows  > 0 ? this._renderedRows  : this._getDimensions().rows;
    const cols         = (this.output && this.output.columns != null) ? this.output.columns : 80;
    const barHeight    = this._renderedLines > 0 ? this._renderedLines : 0;
    const scrollBottom = Math.max(1, rows - barHeight);  // 1-indexed ANSI row
    const maxSegLen    = Math.max(1, cols - 1);          // reserve 1 col so wrap is impossible

    const segments = text.split('\n');
    let out = '';
    for (const seg of segments) {
      const safe = seg.length > maxSegLen ? seg.slice(0, maxSegLen) : seg;
      out +=
        ANSI_SAVE_CURSOR +
        '\x1b[S' +
        ANSI_MOVE_TO(scrollBottom, 1) + safe +
        ANSI_RESTORE_CURSOR;
    }
    this.output.write(out);
  }

  // ── Debounced render scheduling ────────────────────────────────────────

  /**
   * Schedule a _render() call 100 ms from now, coalescing rapid updates.
   * Useful for batching many state mutations before rendering.
   * No-op while _promptActive is true (prompt has paused rendering).
   */
  _scheduleRender() {
    if (this._promptActive) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._render();
    }, 100);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /**
   * Compute the DECSTBM set-scroll-region escape for the current render cycle.
   *
   * Returns ANSI_SET_SCROLL(1, scrollBottom) the first time it is called after
   * a hide() reset (i.e. when _scrollRegionActive is false), then flips the
   * flag so subsequent calls within the same visible lifecycle return ''.
   *
   * @param {number} rows      Terminal row count (from _getDimensions()).
   * @param {number} barHeight Number of lines the bar occupies (from _buildLines()).
   * @returns {string}  The ANSI escape, or '' if the region is already active.
   */
  _setupScrollRegion(rows, barHeight) {
    if (this._scrollRegionActive) return '';
    const scrollBottom = Math.max(1, rows - barHeight);
    this._scrollRegionActive = true;
    // Sequence:
    //   1. ANSI_SET_SCROLL — establish DECSTBM; cursor homes to (1,1).
    //   2. \x1b[{n}S       — scroll the new region up by scrollBottom lines,
    //                         purging any stale content without a full \x1b[2J
    //                         that would wipe Dashboard output above the region.
    //   3. ANSI_MOVE_TO    — leave cursor at scrollBottom col 1 so the first
    //                         onLog write lands on the correct row.
    return (
      ANSI_SET_SCROLL(1, scrollBottom) +
      `\x1b[${scrollBottom}S` +
      ANSI_MOVE_TO(scrollBottom, 1)
    );
  }

  /**
   * Immediately (re-)render the status block.
   * Cancels any pending debounce timer before rendering.
   * No-op when enabled is false or the bar is hidden.
   */
  _render() {
    // Cancel pending debounce — we're rendering now.
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (!this.enabled || this._hidden) return;

    const { rows, columns } = this._getDimensions();
    const lines     = this._buildLines(columns);
    const barHeight = lines.length;  // derived directly from _buildLines(); no extra padding

    // Scroll region: rows 1..(rows - barHeight) for scrolling content.
    // Bar lives at rows (rows - barHeight + 1)..rows — no gap.
    const scrollBottom = Math.max(1, rows - barHeight);
    const barStartRow  = scrollBottom + 1;

    // ── barHeight change detection ─────────────────────────────────────────
    // When the bar grows or shrinks (agents added/removed), the old bar
    // footprint may extend beyond the new one (or vice versa).  Clear the
    // union of both footprints — from the topmost barStartRow of either the
    // old or new bar — so no stale rows are left on screen.  Then reset
    // _scrollRegionActive so _setupScrollRegion re-emits DECSTBM with the
    // updated scrollBottom in this render cycle.
    if (this._renderedLines > 0 && barHeight !== this._renderedLines) {
      const oldBarStartRow = Math.max(1, this._renderedRows - this._renderedLines + 1);
      const clearFromRow   = Math.min(oldBarStartRow, barStartRow);
      this.output.write(
        ANSI_SAVE_CURSOR +
        ANSI_MOVE_TO(clearFromRow, 1) +
        ANSI_CLEAR_TO_END +
        ANSI_RESTORE_CURSOR,
      );
      this._scrollRegionActive = false;
    }

    let out = '';

    // 1. Set DECSTBM scroll region so log output never overwrites the bar.
    //    Only emitted on the first render; the region persists until hide() resets it.
    //    Also re-emitted whenever _scrollRegionActive was reset above (barHeight change).
    out += this._setupScrollRegion(rows, barHeight);

    // 2. Save cursor position.
    out += ANSI_SAVE_CURSOR;

    // 3 & 4. Move to each bar line's row and write it.
    //
    // Using an explicit ANSI_MOVE_TO before every line rather than relying on
    // '\n' for positioning eliminates the auto-wrap problem: when a separator
    // line exactly fills the terminal width (e.g. '═'.repeat(80) in an 80-col
    // terminal), xterm sets a "pending wrap" flag but does NOT advance the
    // cursor until the next character is written.  A subsequent '\n' would
    // then fire the pending wrap AND the newline advance, creating a spurious
    // blank row.  With explicit MOVE_TO, every line is positioned correctly
    // regardless of auto-wrap state, keeping the bar area compact and clean.
    for (let i = 0; i < lines.length; i++) {
      out += ANSI_MOVE_TO(barStartRow + i, 1);
      out += lines[i];
    }

    // 5. Restore cursor to saved position.
    out += ANSI_RESTORE_CURSOR;

    this.output.write(out);
    this._renderedLines = barHeight;
    this._renderedRows  = rows;
  }

  // ── Line builders ──────────────────────────────────────────────────────

  /**
   * Build the full array of display lines for the current state.
   * @param {number} [width]  Terminal column count; defaults to _getDimensions().columns.
   * @returns {string[]}
   */
  _buildLines(width) {
    const { columns } = this._getDimensions();
    const w = (width != null && width > 0) ? width : columns;

    const sep1 = '═'.repeat(w);   // heavy border
    const sep2 = '─'.repeat(w);   // thin separator

    const lines = [];

    // ── Top border ──────────────────────────────────────────────────
    lines.push(sep1);

    // ── Milestone header ─────────────────────────────────────────────
    const { msId, elapsed } = this._milestone;
    const { done, total } = this._progress;

    const elapsedStr = (elapsed != null) ? formatElapsed(elapsed) : '';
    let headerContent;
    if (msId != null) {
      headerContent = ` cc-orch v${this.version} · milestone ${msId} (${done}/${total}) · ${elapsedStr}`;
    } else {
      headerContent = ` cc-orch v${this.version} · idle`;
    }
    lines.push(truncate(headerContent, w).padEnd(w));

    // ── Separator ────────────────────────────────────────────────────
    lines.push(sep2);

    // ── Agent rows (capped at maxRows) ───────────────────────────────
    const agentEntries = [...this.agents.entries()];
    const visible   = agentEntries.slice(0, this.maxRows);
    const hiddenCnt = agentEntries.length - visible.length;

    if (visible.length === 0) {
      lines.push(truncate(' (no active agents)', w).padEnd(w));
    } else {
      for (const [name, state] of visible) {
        lines.push(this._buildAgentRow(name, state, w).padEnd(w));
      }
    }

    if (hiddenCnt > 0) {
      lines.push(truncate(`  … +${hiddenCnt} more agents`, w).padEnd(w));
    }

    // ── Separator ────────────────────────────────────────────────────
    lines.push(sep2);

    // ── Progress bar ─────────────────────────────────────────────────
    lines.push(this._buildProgressLine(w).padEnd(w));

    // ── Bottom border ─────────────────────────────────────────────────
    lines.push(sep1);

    return lines;
  }

  /**
   * Build a single agent row.
   *
   * Layout:
   *   " {icon} {role:<10}  {middle}  {elapsed}  ${cost}"
   *
   * Middle section:
   *   - Shows "{taskId}  ▸ {description}" when taskId is present.
   *   - Shows empty string when no taskId is set.
   *
   * Note: all Map entries represent active agents — there is no 'idle' state
   * concept; agents are either present in the Map (active) or absent (deleted).
   *
   * @param {string} _name  Agent's unique name (Map key) — unused in display,
   *                        kept for signature consistency.
   * @param {object} state  Agent state { role, taskId, description, elapsed, cost }.
   * @param {number} width  Terminal column width.
   * @returns {string}
   */
  _buildAgentRow(_name, state, width) {
    const icon      = ROLE_ICONS[state.role] || '  ';
    const rawRole   = state.role || 'Unknown';
    const roleLabel = (rawRole[0].toUpperCase() + rawRole.slice(1)).padEnd(10);
    const elapsedS  = state.elapsed != null ? `${state.elapsed}s` : '';
    const costS     = state.cost    != null ? `$${Number(state.cost).toFixed(2)}` : '';

    // Right-aligned tail: "  {elapsed}  {cost}"
    const tail   = `  ${elapsedS.padStart(4)}  ${costS.padStart(6)}`;

    // Left prefix: " {icon} {role}  "
    const prefix = ` ${icon} ${roleLabel}  `;

    // Middle: active agents always show taskId + description
    const descPart  = state.description ? `  ▸ ${state.description}` : '';
    const middleRaw = state.taskId ? `${state.taskId}${descPart}` : '';

    const available = width - prefix.length - tail.length;
    const middle    = available > 0 ? truncate(middleRaw, available) : '';

    return (prefix + middle + tail).padEnd(width);
  }

  /**
   * Build the progress bar line.
   *
   * When total===0 and a phase name is set, shows the phase name instead
   * of a numeric bar.  Otherwise renders:
   *   " {████░░░░} {done}/{total} tasks · ${cost} · {sessions} sessions"
   *
   * Fill fraction is done/total (not inverted): more done → more fill.
   *
   * @param {number} width
   * @returns {string}
   */
  _buildProgressLine(width) {
    const { done, total, totalCost, sessionCount, phase } = this._progress;

    // ── Phase-name mode: total===0 and a phase label is available ──────────
    if (total === 0 && phase) {
      return truncate(` ${phase}`, width).padEnd(width);
    }

    const costS  = `$${Number(totalCost  || 0).toFixed(2)}`;
    const sessS  = `${sessionCount || 0} sessions`;
    const countS = `${done}/${total} tasks`;
    const suffix = ` ${countS} · ${costS} · ${sessS}`;

    // Reserve: 1 leading space + bar + suffix.
    // Fill fraction: done/total (more done → more filled blocks).
    const barWidth   = Math.max(4, width - suffix.length - 1);
    const fillCount  = total > 0 ? Math.round((done / total) * barWidth) : 0;
    const emptyCount = Math.max(0, barWidth - fillCount);

    const bar  = '█'.repeat(fillCount) + '░'.repeat(emptyCount);
    const line = ` ${bar}${suffix}`;

    return truncate(line, width).padEnd(width);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Erase the bar area and reset the DECSTBM scroll region to full screen.
   * After hide() the instance still holds state; call show() to restore.
   */
  hide() {
    if (!this.enabled) return;

    let out = '';

    // Reset scroll region to full terminal.
    out += ANSI_RESET_SCROLL;

    // Erase the bar area if anything was previously rendered.
    // Use _renderedRows (not the current rows) so that a terminal resize
    // between the last _render() and this hide() doesn't shift the erase
    // position and leave stale bar content on screen.
    if (this._renderedLines > 0) {
      const renderedRows = this._renderedRows || this._getDimensions().rows;
      const barStartRow = Math.max(1, renderedRows - this._renderedLines + 1);
      out += ANSI_SAVE_CURSOR;
      out += ANSI_MOVE_TO(barStartRow, 1);
      out += ANSI_CLEAR_TO_END;
      out += ANSI_RESTORE_CURSOR;
    }

    this.output.write(out);
    this._renderedLines      = 0;
    this._renderedRows       = 0;
    this._hidden             = true;
    this._scrollRegionActive = false;  // next show()/_render() re-establishes the scroll region
  }

  /**
   * Re-establish the DECSTBM scroll region and redraw the bar.
   * Reverses a previous hide() call.
   */
  show() {
    if (!this.enabled) return;
    this._hidden = false;
    this._render();
  }

  // ── Prompt lifecycle ──────────────────────────────────────────────────

  /**
   * Called immediately before readline takes over the terminal for a prompt.
   *
   * Positions the cursor at the bottom row of the DECSTBM scroll region
   * (the row just above the status bar) so that readline's question text
   * and user input are echoed there — not at row 1 col 1.
   *
   * The DECSTBM scroll region is intentionally left active: the bar stays
   * visible at the bottom while the user types, and input that overflows the
   * prompt line scrolls normally within the scroll region.
   *
   * No-op when enabled is false.
   */
  promptWillStart() {
    if (!this.enabled) return;

    // Cancel any pending debounce timer so a queued render doesn't fire
    // while readline has control of the terminal.
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Pause debounced rendering for the duration of the prompt.
    // _scheduleRender() becomes a no-op while _promptActive is true.
    this._promptActive = true;

    const { rows } = this._getDimensions();
    const barHeight   = this._renderedLines > 0 ? this._renderedLines : 0;
    const scrollBottom = Math.max(1, rows - barHeight);

    // Move cursor to column 1 of the last row inside the scroll region.
    // readline will start echoing from here, keeping input above the bar.
    this.output.write(ANSI_MOVE_TO(scrollBottom, 1));
  }

  /**
   * Called immediately after readline closes following a prompt.
   *
   * Clears the _promptActive flag (re-enabling debounced renders) and
   * re-renders the status bar so that any buffered state mutations from
   * updateAgent/updateProgress/updateMilestone/setPhase calls made during
   * the prompt are reflected in the bar.
   *
   * _render() ends with ANSI_RESTORE_CURSOR (\x1b[u), which is the
   * authoritative final cursor position.  No trailing ANSI_MOVE_TO is
   * emitted here — doing so would override the restore and re-introduce
   * the v3.1-style end-positioning that mission 001-002 removed.
   *
   * No-op when enabled is false.
   */
  promptDidEnd() {
    if (!this.enabled) return;

    // Re-enable debounced rendering now that readline has released the terminal.
    this._promptActive = false;

    // Re-render the bar so buffered state mutations during the prompt are reflected.
    // _render() issues ANSI_RESTORE_CURSOR (\x1b[u) as its final sequence, which
    // is the authoritative cursor position — no absolute MOVE_TO override follows.
    this._render();
  }

  /**
   * Permanently tear down the status bar.
   *
   * Emits a single atomic ANSI sequence that:
   *   1. Resets the scroll region to full screen (\x1b[r)
   *   2. Moves to the bar start row and erases to end of screen (\x1b[J)
   *   3. Shows the cursor (\x1b[?25h)
   *
   * Also removes the resize listener, cancels any pending debounce, and
   * marks the instance fully inert (enabled = false) so all subsequent
   * calls to any public method are no-ops.
   *
   * Idempotent: a second call is a no-op (enabled is already false).
   *
   * No-op in non-TTY mode (enabled is false from construction).
   */
  teardown() {
    if (!this.enabled) return;

    // Cancel any pending debounce.
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    // Remove the resize listener before going inert.
    if (this.output && typeof this.output.removeListener === 'function') {
      this.output.removeListener('resize', this._onResize);
    }

    // Compute bar start row using last render bookkeeping (matches hide() logic).
    const renderedRows = this._renderedRows > 0 ? this._renderedRows : this._getDimensions().rows;
    const barStartRow  = this._renderedLines > 0
      ? Math.max(1, renderedRows - this._renderedLines + 1)
      : renderedRows;

    // Single atomic write: reset scroll → erase bar area → show cursor.
    this.output.write(
      ANSI_RESET_SCROLL +
      ANSI_MOVE_TO(barStartRow, 1) +
      ANSI_CLEAR_TO_END +
      ANSI_SHOW_CURSOR
    );

    // Mark instance fully inert — all public methods check this.enabled first.
    this.enabled = false;
  }

  /**
   * Permanently tear down the status bar.
   * Delegates to teardown() to avoid duplication.
   */
  destroy() {
    this.teardown();
  }
}
