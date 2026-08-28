/**
 * token-tracker.js — Aggregates token/cost usage across all sessions.
 *
 * Persists to .harness/logs/token-usage.json. Supports per-type and per-task queries.
 *
 * Public API:
 *   recordSession(name, type, resultEvent, meta?)   → Promise<void>
 *   flushInFlight(reason)                           → Promise<number>
 *   getTotalUsage() → { sessionCount, inputTokens, outputTokens, totalCostUsd, ... }
 *   getUsageByType(type) / getUsageByTask(taskId) / getUsageSince(sessionIndex)
 *   shouldWarn(tokens) / shouldForceNewSession(tokens) / shouldAlarm(tokens)
 *   summary() → full breakdown with byType
 *
 * Partial-record invariants (flushInFlight):
 *   (a) Every record flushed by `flushInFlight()` carries `partial: true`
 *       plus `flushReason`, and is persisted through the same atomic
 *       `save()` call under `_writeMutex` used by `recordSession` — there
 *       is no separate write path for partial records.
 *   (b) Only a partial record that THIS process instance itself wrote via
 *       `flushInFlight()` (tracked in `_flushedPartials`) may later be
 *       replaced in place by a same-name `recordSession()` finalize.
 *       Partial records restored from disk by `_load()` are never
 *       registered in `_flushedPartials`, so they are preserved rather
 *       than overwritten — they represent real billed spend from a prior
 *       (possibly different) process instance and must not be discarded.
 *
 * Concurrency (Phase I items 4+5): `recordSession` is now async and
 * acquires an instance-local mutex around the load-append-write
 * critical section. Before this, concurrent sessions finishing at
 * roughly the same time would race through the `_sessions.push()
 * → save()` sequence — classic load-modify-write on
 * `.harness/logs/token-usage.json` with no mtime guard and no atomic
 * rename. Writes were silently lost. The mutex plus the new
 * tmp-file-plus-rename inside `save()` closes both gaps.
 *
 * The mutex is instance-local because a single `TokenTracker` instance
 * is shared across all agents on a Pipeline. Concurrent trackers for
 * different projects (unusual) serialize independently.
 */
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { createMutex } from './mutex.js';
class TokenTracker {
  constructor(harnessDir) {
    this.harnessDir = harnessDir;
    this.usagePath = path.join(harnessDir, 'logs', 'token-usage.json');
    this._sessions = [];
    this._inFlight = new Map();
    this._writeMutex = createMutex();
    // Instance-local registry of session names whose partial records were
    // written by this process instance via flushInFlight().
    this._flushedPartials = new Set();
    this._load();
  }

  /**
   * recordIncrementalUsage — lightweight, sync, no-disk update for in-flight sessions.
   *
   * The SDK emits cumulative usage on every assistant frame, so each call
   * REPLACES the previous entry for `sessionName` (adding would double-count).
   * No mutex is acquired and save() is never called — this must be <1ms.
   *
   * @param {string} sessionName  - Unique session identifier (e.g. task ID or agent name).
   * @param {string} role         - Agent role: 'planner' | 'executor' | 'verifier' | …
   * @param {object} usage        - SDK usage object from the current message frame.
   */
  recordIncrementalUsage(sessionName, role, usage = {}) {
    const prev = this._inFlight.get(sessionName);
    const entry = {
      name: sessionName,
      type: role,
      timestamp: new Date().toISOString(),
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreation: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      totalCostUsd: usage.total_cost_usd != null
        ? usage.total_cost_usd
        : (prev ? prev.totalCostUsd : 0),
    };
    this._inFlight.set(sessionName, entry);
  }

  /**
   * recordSession — Finalize a session and persist its usage record atomically.
   *
   * Finalization clears the in-flight tally for `name`; subsequent
   * `getUsageByType` calls see only the finalized record.
   *
   * The in-flight entry deletion and the finalized-session push both occur
   * inside the same `_writeMutex` acquisition so no concurrent aggregation
   * call can observe a state where both the in-flight entry and the
   * finalized record exist simultaneously.
   *
   * @param {string} name         - Session identifier (matches the name used in recordIncrementalUsage).
   * @param {string} type         - Agent role: 'planner' | 'executor' | 'verifier' | …
   * @param {object} resultEvent  - SDK result event containing `usage` and `total_cost_usd`.
   * @param {object} [meta={}]    - Optional metadata fields merged into the persisted entry.
   * @returns {Promise<void>}
   */
  async recordSession(name, type, resultEvent, meta = {}) {
    const usage = resultEvent?.usage || {};
    const entry = {
      name,
      type,
      timestamp: new Date().toISOString(),
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreation: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      totalCostUsd: resultEvent?.total_cost_usd || 0,
      /**
       * Known metadata fields passed via `meta` by callers throughout the pipeline.
       * New callers should reuse these field names rather than inventing new ones.
       *
       * @property {string}  [phase]          - Planner phase identifier.
       *                                        Known values: '3a', '3b', '3a-verify', '3b-remediate'.
       * @property {string}  [missionId]      - Unique mission identifier for the current run.
       * @property {boolean} [reused]         - True when this entry represents a reusable-session turn
       *                                        (i.e. the underlying Claude session was kept alive across
       *                                        multiple tool calls rather than started fresh).
       * @property {number}  [turnIdx]        - 0-based index of this turn within a reusable session.
       * @property {string}  [taskId]         - Task ID assigned to the executor, verifier, or analyzer
       *                                        that produced this session record.
       * @property {string}  [status]         - Executor task status string (e.g. 'COMPLETED', 'BLOCKED').
       * @property {boolean} [verified]       - Verifier verdict: true = passed, false = failed.
       * @property {string}  [headline]       - One-line summary produced by the summarizer agent.
       * @property {string}  [eventId]        - Analyzer event identifier.
       * @property {string}  [recommendation] - Recommendation string produced by the analyzer.
       */
      ...meta,
    };

    const release = await this._writeMutex.acquire();
    try {
      // Clear in-flight entry first so finalized + in-flight remain disjoint by sessionName.
      this._inFlight.delete(name);

      // If this instance previously flushed a partial record for `name` via
      // flushInFlight(), finalizing now REPLACES that partial record in place
      // (rather than appending alongside it) so the ledger doesn't double-count
      // the same underlying session. A same-name partial record restored from
      // disk by _load() (i.e. not in this instance's registry) is left alone
      // and the finalized record is appended normally.
      if (this._flushedPartials.has(name)) {
        const idx = this._sessions.findIndex((s) => s.name === name && s.partial === true);
        if (idx !== -1) {
          this._sessions[idx] = entry;
        } else {
          this._sessions.push(entry);
        }
        this._flushedPartials.delete(name);
      } else {
        this._sessions.push(entry);
      }

      this.save();
    } finally {
      release();
    }
  }

  /**
   * flushInFlight — Convert every current in-flight usage estimate into a
   * finalized (but partial) session record and persist it atomically.
   *
   * Used when the process is aborting/shutting down and in-flight sessions
   * will never reach `recordSession`: without this, their streamed usage
   * would be lost entirely (not currently on disk, and about to vanish once
   * the process exits) rather than double-counted, but callers that want the
   * spend preserved need it written out. Each flushed record carries
   * `partial: true` and `flushReason: reason` so downstream consumers can
   * distinguish it from a normally-finalized session.
   *
   * Runs inside the same `_writeMutex` as `recordSession` so no concurrent
   * finalize/save can interleave with the flush.
   *
   * @param {string} reason - Why the flush is happening (e.g. 'abort').
   * @returns {Promise<number>} Number of records flushed.
   */
  async flushInFlight(reason) {
    const release = await this._writeMutex.acquire();
    try {
      if (this._inFlight.size === 0) {
        return 0;
      }
      const entries = [...this._inFlight.values()];
      for (const entry of entries) {
        const record = {
          ...entry,
          partial: true,
          flushReason: reason,
        };
        this._sessions.push(record);
        this._flushedPartials.add(entry.name);
      }
      this._inFlight.clear();
      this.save();
      return entries.length;
    } finally {
      release();
    }
  }

  /**
   * discardInFlight — drop a streamed in-flight usage estimate for a session that
   * will never be finalized by recordSession (e.g. a spawn that streamed some
   * usage then failed). Without this the estimate leaks permanently into the
   * getTotalUsage()/getUsageByType aggregation, over-counting the run's spend.
   */
  discardInFlight(name) {
    this._inFlight.delete(name);
  }

  getTotalUsage() {
    const inFlightEntries = [...this._inFlight.values()];
    return this._aggregate([...this._sessions, ...inFlightEntries]);
  }

  getUsageByType(type) {
    const inFlightMatching = [...this._inFlight.values()].filter((e) => e.type === type);
    return this._aggregate([...this._sessions.filter((s) => s.type === type), ...inFlightMatching]);
  }

  getUsageByTask(taskId) {
    // In-flight entries carry no taskId by default, so they are excluded unless
    // a caller explicitly sets entry.taskId via the meta spread path.
    const inFlightMatching = [...this._inFlight.values()].filter((e) => e.taskId === taskId);
    return this._aggregate([...this._sessions.filter((s) => s.taskId === taskId), ...inFlightMatching]);
  }

  getUsageSince(sessionIndex) {
    return this._aggregate(this._sessions.slice(sessionIndex));
  }

  shouldWarn(inputTokens) {
    return inputTokens >= config.tokens.warn;
  }

  shouldForceNewSession(inputTokens) {
    return inputTokens >= config.tokens.forceNew;
  }

  shouldAlarm(inputTokens) {
    return inputTokens >= config.tokens.alarm;
  }

  save() {
    // Atomic write via tmp + rename: if the process crashes mid-write,
    // the real file is either the previous version (rename hasn't
    // happened yet) or the new version (rename completed). It can
    // never be a truncated half-written file, which would break _load
    // on the next startup. Callers must hold `_writeMutex` — save() is
    // not safe to call concurrently with itself.
    const dir = path.dirname(this.usagePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.usagePath + '.tmp';
    // Use _aggregate directly on finalized sessions so in-flight values are
    // never persisted to disk — getTotalUsage() now includes _inFlight.
    fs.writeFileSync(tmpPath, JSON.stringify({
      sessions: this._sessions,
      totals: this._aggregate(this._sessions),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmpPath, this.usagePath);
  }

  getSessions() {
    return [...this._sessions];
  }

  summary() {
    // summary() reports only finalized sessions so that the on-disk JSON
    // (which calls summary() indirectly) never leaks in-flight values.
    const totals = this._aggregate(this._sessions);
    const byType = {};
    for (const type of ['planner', 'executor', 'verifier']) {
      byType[type] = this._aggregate(this._sessions.filter((s) => s.type === type));
    }

    return {
      totalSessions: this._sessions.length,
      ...totals,
      byType,
    };
  }

  /**
   * _load — Restore persisted sessions from disk on construction.
   *
   * Deliberately leaves `_flushedPartials` (the instance-local registry of
   * partial-record names written by THIS process via `flushInFlight()`)
   * empty: names of any partial records found in `data.sessions` are never
   * registered here. This guarantees that partial records restored from
   * disk — which represent real billed cross-process spend — are never
   * eligible to be replaced in place by a later same-name `recordSession()`
   * finalize; only partials this instance itself flushed can be replaced.
   */
  _load() {
    if (fs.existsSync(this.usagePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.usagePath, 'utf8'));
        this._sessions = data.sessions || [];
      } catch {
        this._sessions = [];
      }
    }
  }

  _aggregate(sessions) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let totalCostUsd = 0;
    let systemPromptTokens = 0;
    let toolCallCount = 0;

    for (const s of sessions) {
      inputTokens += s.inputTokens || 0;
      outputTokens += s.outputTokens || 0;
      cacheCreation += s.cacheCreation || 0;
      cacheRead += s.cacheRead || 0;
      totalCostUsd += s.totalCostUsd || 0;
      systemPromptTokens += s.systemPromptTokens || 0;
      toolCallCount += s.toolCallCount || 0;
    }

    return {
      sessionCount: sessions.length,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
      totalCostUsd: Math.round(totalCostUsd * 1000) / 1000,
      systemPromptTokens,
      toolCallCount,
    };
  }
}

export { TokenTracker };
