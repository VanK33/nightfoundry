/**
 * logger.js — JSONL session logging and summary extraction.
 *
 * Each Claude session (planner, executor, verifier, analyzer) gets a
 * separate .jsonl log file under .harness/logs/. The logger attaches
 * to SessionHandle events and records everything.
 *
 * Public API:
 *   createSessionLog(name) → { logPath, write(event), close() }
 *   attachToSession(handle, log, meta?) — auto-log all handle events
 *   getSessionSummary(logPath) → { inputTokens, outputTokens, totalCost, ... }
 *   writeSessionSummary(name, summary, meta?) → Promise<void>
 *       (appends to session-summary.json under an instance-local mutex)
 *
 * Concurrency (Phase I items 4+5):
 *   - Per-session JSONL files (createSessionLog) are independent; each
 *     session writes to its own uniquely-timestamped file, so there is
 *     no contention across sessions.
 *   - `session-summary.json` is the shared file — a single JSON array
 *     that every session appends one entry to at session close. Under
 *     parallelism, multiple sessions finishing at once race through
 *     the load-append-write sequence and silently lose entries.
 *     `writeSessionSummary` is now async and serializes through an
 *     instance-local mutex, and writes via tmp + rename for atomicity.
 *     Matches the TokenTracker pattern from step 3.
 */
import fs from 'fs';
import path from 'path';
import { createMutex } from './mutex.js';
class Logger {
  constructor(harnessDir) {
    this.logsDir = path.join(harnessDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    this._summaryMutex = createMutex();
    this._onLog = null;
  }

  /**
   * Register a callback to receive warn() output (e.g. dashboard.log).
   * @param {function(string): void} fn
   */
  setOnLog(fn) {
    this._onLog = fn;
  }

  /**
   * Emit a warning message. Routes through this._onLog if set,
   * otherwise falls back to console.warn.
   * @param {string} msg
   */
  warn(msg) {
    if (this._onLog) {
      this._onLog(msg);
    } else {
      console.warn(msg);
    }
  }

  createSessionLog(name) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}-${name}.jsonl`;
    const logPath = path.join(this.logsDir, filename);
    fs.mkdirSync(this.logsDir, { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: 'a' });

    return {
      logPath,

      write(event) {
        const entry = {
          ts: new Date().toISOString(),
          ...event,
        };
        stream.write(JSON.stringify(entry) + '\n');
      },

      close() {
        stream.end();
      },
    };
  }

  attachToSession(handle, log, meta = {}) {
    const logEvent = (type, data) => {
      log.write({ type, ...meta, data });
    };

    handle.on('init', (data) => logEvent('init', data));
    handle.on('message', (data) => logEvent('message', data));
    handle.on('result', (data) => logEvent('result', data));
    handle.on('error', (err) => logEvent('error', { message: err.message, stack: err.stack }));
    handle.on('exit', (data) => logEvent('exit', data));
  }

  getSessionSummary(logPath) {
    if (!fs.existsSync(logPath)) return null;

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let totalCost = 0;
    let toolCalls = 0;
    let firstTs = null;
    let lastTs = null;

    for (const evt of events) {
      if (!firstTs) firstTs = evt.ts;
      lastTs = evt.ts;

      const data = evt.data || {};

      // Extract token usage from result events
      if (evt.type === 'result' && data.usage) {
        inputTokens += data.usage.input_tokens || 0;
        outputTokens += data.usage.output_tokens || 0;
        cacheCreation += data.usage.cache_creation_input_tokens || 0;
        cacheRead += data.usage.cache_read_input_tokens || 0;
      }

      if (data.total_cost_usd) {
        totalCost = data.total_cost_usd;
      }

      // Count tool use in assistant messages
      // SDK shape: data = { type: "assistant", message: { content: [...] } }
      if (evt.type === 'message' && data.message?.content) {
        const content = Array.isArray(data.message.content) ? data.message.content : [];
        toolCalls += content.filter((b) => b.type === 'tool_use').length;
      }
    }

    const durationMs = firstTs && lastTs
      ? new Date(lastTs) - new Date(firstTs)
      : 0;

    return {
      events: events.length,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
      totalCost,
      toolCalls,
      durationMs,
      startedAt: firstTs,
      finishedAt: lastTs,
    };
  }

  async writeSessionSummary(name, summary, meta = {}) {
    const summaryPath = path.join(this.logsDir, 'session-summary.json');

    const release = await this._summaryMutex.acquire();
    try {
      let summaries = [];
      if (fs.existsSync(summaryPath)) {
        try { summaries = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { summaries = []; }
      }
      summaries.push({ name, ...meta, ...summary, recordedAt: new Date().toISOString() });

      // Atomic write: tmp + rename. Survives crash mid-write — the
      // real file is either the previous version or the new version,
      // never a truncated half-write that would break _load on the
      // next session.
      const tmpPath = summaryPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(summaries, null, 2));
      fs.renameSync(tmpPath, summaryPath);
    } finally {
      release();
    }
  }
}

export { Logger };
