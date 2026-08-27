/**
 * session-manager.js — Spawns short-lived Claude sessions via Agent SDK.
 *
 * Core of nightfoundry's interaction with Claude. All other modules
 * (planner, executor, verifier, analyzer) use SessionManager.spawn()
 * to dispatch work, then read results from the returned handle.
 *
 * Two spawn modes:
 *   spawn(options)          — single-prompt session. One query(), one result,
 *                             session ends when result arrives. Default pattern.
 *   spawnReusable(options)  — long-lived session that accepts multiple prompts
 *                             via sendPrompt(). Used by the reusable planner
 *                             session to keep cache warm across Phase 3b calls.
 *
 * Public API:
 *   spawn(options) → Promise<{handle, result}>  (options: prompt, name, tools, agent, jsonSchema, maxBudget, systemPrompt, cwd)
 *   spawnReusable(options) → ReusableSession
 *   kill(handle)   → void
 *   active()       → SessionHandle[]
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const RESULT_WATCHDOG_MS = 60000;
import {
  RateLimitError,
  APIConnectionError,
  AuthenticationError,
  InternalServerError,
  APIError,
} from '@anthropic-ai/sdk';
import config from './config.js';
import { bashCommandRunsWholeSuite } from '../core/whole-suite-bash.js';
import { withRunMarkerEnv } from '../core/run-marker.js';

/**
 * PromptStream — a pull-push async iterable of SDKUserMessage objects.
 *
 * The SDK's `query()` function accepts an `AsyncIterable<SDKUserMessage>`
 * as its prompt parameter. We build one of these, hand it to query(),
 * and then push messages into it from the outside via push(). The
 * consumer (SDK) pulls them via the async iterator protocol.
 *
 * This is the primitive that makes session reuse possible: one SDK
 * subprocess stays alive, waiting for the next message, while we feed
 * new prompts to it from our JS control flow.
 */
class PromptStream {
  constructor() {
    this._queue = [];          // pending messages waiting to be pulled
    this._resolvers = [];      // pending next() callers waiting for a message
    this._done = false;
  }

  /**
   * Push a new SDKUserMessage into the stream. If a consumer is waiting,
   * resolves it immediately. Otherwise queues for the next consumer pull.
   */
  push(msg) {
    if (this._done) {
      throw new Error('PromptStream: cannot push to closed stream');
    }
    const resolver = this._resolvers.shift();
    if (resolver) {
      resolver({ value: msg, done: false });
    } else {
      this._queue.push(msg);
    }
  }

  /**
   * Close the stream. All future pulls return {done: true}.
   */
  close() {
    this._done = true;
    // Resolve any pending consumers with done
    while (this._resolvers.length > 0) {
      this._resolvers.shift()({ value: undefined, done: true });
    }
  }

  /**
   * AsyncIterator protocol. The SDK calls this repeatedly to pull
   * messages out of the stream.
   */
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        // If we have queued messages, return them immediately
        if (self._queue.length > 0) {
          return Promise.resolve({ value: self._queue.shift(), done: false });
        }
        // If closed and no more queued messages, we're done
        if (self._done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        // Otherwise, park until push() or close() is called
        return new Promise((resolve) => {
          self._resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * ReusableSession — a long-lived SDK session that accepts multiple prompts.
 *
 * Design rationale (from docs/audit/phase-1-overhead-audit.md):
 * every planner session in cc-orch re-creates its prompt cache from
 * scratch because each spawn() is a fresh SDK subprocess. Session
 * reuse keeps one subprocess alive, lets the SDK's ephemeral cache
 * warm up on the first prompt, and allows subsequent prompts to read
 * from that cache instead of re-writing it.
 *
 * Lifecycle:
 *   1. Construct via sessionManager.spawnReusable(options) — starts the
 *      underlying query() with a PromptStream as the prompt.
 *   2. Call sendPrompt(text) one or more times — each call pushes a
 *      user message into the stream and returns a promise that
 *      resolves with the SDK result event for that turn.
 *   3. Call close() when done — closes the stream, which signals the
 *      SDK to finish processing and exit the subprocess.
 *
 * Isolation guarantee: each ReusableSession owns its own subprocess.
 * Two ReusableSession instances never share state. This is critical
 * so that concurrent cc-orch invocations don't accidentally share
 * sessions.
 *
 * Error handling: if the background consumer encounters an error
 * (SDK crash, network failure, schema validation failure), all
 * pending sendPrompt() promises are rejected with that error. After
 * an error, no new prompts can be sent; the session is effectively
 * dead and should be closed.
 */
class ReusableSession {
  constructor(sessionManager, options) {
    this._sessionManager = sessionManager;
    this._options = options;
    this._stream = new PromptStream();
    this._pendingResults = [];   // FIFO queue of { resolve, reject } awaiting result events
    this._turnCount = 0;
    this._closed = false;
    this._error = null;
    this._signal = options.signal || sessionManager.signal || null;

    // Per-call wall-clock state (spec-percall-wallclock). The cap measures
    // each ACTIVE WINDOW (first outstanding prompt → pending queue empty),
    // never session lifetime: the timer is armed only while at least one
    // request is outstanding, so an idle session — even idle for hours
    // between calls — is never killed by the cap.
    this._activeWindowStart = null;  // Date.now() at empty→non-empty transition; null while idle
    this._terminate = null;          // set synchronously by _consumeEvents before any prompt can be sent

    // Shared SessionHandle for logger attachment + token tracking.
    // One handle covers the whole reusable session; each turn's events
    // route through it. Per-turn metadata (turn index) is attached via
    // the event dispatch path.
    this.handle = new SessionHandle(options.name || 'reusable');
    this.handle.agent = options.agent || null;
    sessionManager._active.set(this.handle.name, this.handle);

    // Build SDK options + start the underlying query. If ANY of this
    // throws synchronously (invalid options, SDK init failure,
    // subprocess spawn error), we must unwind cleanly: remove the
    // handle from _active, mark it finished, and re-throw so the
    // caller sees the failure. Without this, a failed constructor
    // would leak the handle in _active forever and the session
    // would look "stuck". (Bug caught in Copilot review, 2026-04-09.)
    try {
      const sdkOptions = sessionManager._buildSdkOptions(options, this.handle._readFiles);
      this.handle.systemPromptTokens = sdkOptions._approxSystemPromptTokens || 0;

      // Hermeticity chokepoint — same contract as spawn()'s guard (see there).
      // Sits inside the try so the constructor's clean-unwind path handles it.
      if (sessionManager._queryFn === query && process.env.CC_ORCH_TEST === '1' && process.env.CC_ORCH_REAL_SDK !== '1') {
        throw new Error(
          `Hermeticity guard: refusing to spawn a real reusable SDK session '${this.handle.name}' under CC_ORCH_TEST=1 — ` +
          `inject a fake via _queryFn, or set CC_ORCH_REAL_SDK=1 for the real-SDK lane`
        );
      }

      const q = sessionManager._queryFn({
        prompt: this._stream,
        options: sessionManager._toQueryOptions(sdkOptions),
      });
      this.handle._query = q;

      // Start the background consumer loop. It runs for the whole
      // lifetime of the session, routing result events to the oldest
      // pending sendPrompt() promise, and forwarding all events
      // through the SessionHandle so the logger sees them.
      this._consumerPromise = this._consumeEvents(q);
    } catch (err) {
      // Synchronous constructor failure. Clean up _active and handle
      // state so the failed session doesn't linger, then re-throw.
      //
      // Do NOT emit 'error' or 'exit' on the handle here: the caller
      // has not yet received the ReusableSession instance and
      // therefore hasn't attached any listeners (the logger is
      // normally attached in planner._ensureReusableSession AFTER
      // spawnReusable returns). A zero-listener 'error' emit would
      // throw synchronously and crash the process. The thrown error
      // IS the signal to the caller — no event needed.
      // (Bug caught in Copilot review, 2026-04-09.)
      sessionManager._active.delete(this.handle.name);
      this.handle.finished = true;
      this.handle.finishedAt = new Date().toISOString();
      this._error = err;
      this._closed = true;
      throw err;
    }
  }

  async _consumeEvents(q) {
    // Guard channel: the wall-clock timer and abort reject this directly,
    // so a hard-stalled SDK generator (blocked in an in-flight await that
    // closing the prompt stream cannot interrupt) no longer hangs the
    // consumer loop — and therefore no longer hangs close()/teardown that
    // awaits _consumerPromise. Mirrors the spawn() captured-reject fix.
    let rejectGuard;
    let settled = false;
    const guard = new Promise((_, reject) => { rejectGuard = reject; });

    const terminate = (err) => {
      if (settled) return;
      settled = true;
      this._error = err;                                 // set early so sendPrompt sees it
      try { this.handle._query?.return?.(); } catch {}   // tear down the SDK generator
      try { this._stream.close(); } catch {}             // close the prompt stream too
      rejectGuard(err);
    };

    // Per-call wall-clock (spec-percall-wallclock): the timer is no longer
    // armed here for the session's whole life. Instead, sendPrompt() arms it
    // via _armWallClock() when the pending queue transitions empty→non-empty,
    // and the result-event path below disarms it on non-empty→empty. Expose
    // terminate so the per-call timer routes through the SAME captured-reject
    // guard — the re-scope changes WHEN the timer runs, not HOW termination
    // works. This assignment is in the synchronous prefix of _consumeEvents
    // (invoked from the constructor), so it is always set before any
    // sendPrompt() can run.
    this._terminate = terminate;

    const onAbort = () => terminate(new DOMException('The operation was aborted', 'AbortError'));
    if (this._signal) {
      if (this._signal.aborted) {
        terminate(new DOMException('The operation was aborted', 'AbortError'));
      } else {
        this._signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Consume the SDK generator as its own promise so the wall-clock/abort
    // guard can win the race without waiting for a stalled iterator.
    const consume = (async () => {
      for await (const event of q) {
        this._sessionManager._dispatchEvent(this.handle, event);

        // A result event terminates the current turn — but only act when there
        // is a pending send it answers. Acting on a stray/duplicate result (none
        // pending) would wrongly wipe the NEXT turn's freshly-streamed in-flight
        // estimate below.
        if (event.type === 'result' && this._pendingResults.length > 0) {
          // The turn's live in-flight estimate is keyed by the handle name, but
          // the agent finalizes each turn via recordSession under a DIFFERENT,
          // turn-specific name. Once the turn's result lands that handle-name
          // estimate is stale — leaving it would make getTotalUsage double-count
          // this turn (finalized under the turn name AND still in-flight under
          // the handle name) until the next turn overwrites it or teardown
          // clears it. Discard it here at the turn boundary. (Trade-off: if the
          // agent's per-turn recordSession never runs — e.g. a post-result
          // planner validator throws — the turn is dropped from usage rather
          // than approximated by the stale estimate. Acceptable: that path is an
          // already-failing run, and the proper fix is the agent recording the
          // turn before it can throw, not a stale in-flight standing in for it.)
          this._sessionManager._tokenTracker?.discardInFlight?.(this.handle.name);

          // Resolve the oldest pending sendPrompt promise with this result,
          // unless it's a transport-level infrastructure failure — in that
          // case reject the pending turn promise with the InfrastructureError
          // instead (mirrors spawn()'s classifyResult handling).
          const { resolve, reject } = this._pendingResults.shift();
          const infra = classifyResult(event);
          if (infra !== null) {
            reject(infra);
          } else {
            resolve(event);
          }
          // Non-empty→empty transition: the active window closes and the
          // per-call wall-clock disarms. The session is now idle and MUST
          // NOT be killed by the cap, no matter how long it idles (the
          // planner session routinely idles >45min while missions execute).
          // If other prompts are still outstanding the shared window stays
          // armed until the queue fully drains (conservative, per spec).
          if (this._pendingResults.length === 0) {
            this._disarmWallClock();
          }
        }
      }
    })();
    consume.catch(() => {});
    guard.catch(() => {}); // parity with spawn(): swallow a late guard rejection if consume already won the race

    try {
      await Promise.race([consume, guard]);
      // consume won — the stream ended naturally. Backstop wall-clock check,
      // re-scoped to per-call semantics (spec-percall-wallclock): it measures
      // the CURRENT ACTIVE WINDOW (still-open _activeWindowStart), never
      // session birth. Kept rather than removed because it still closes a
      // real (if narrow) gap: setTimeout can lag under event-loop pressure,
      // so the stream can end with an outstanding call whose window already
      // crossed the cap before the timer callback ran — without this check
      // those pending sends would reject with the generic "session closed"
      // sentinel instead of WallClockExceededError. When the session is idle
      // at stream end (_activeWindowStart === null), there is no window and
      // no check — idle time can never trip it.
      if (!settled && this._activeWindowStart != null
          && Date.now() - this._activeWindowStart >= config.execution.maxSessionWallClockMs) {
        this._error = new WallClockExceededError(
          `ReusableSession '${this.handle.name}' exceeded per-call wall-clock limit of ${config.execution.maxSessionWallClockMs}ms`
        );
      }
    } catch (err) {
      // terminate() (wall-clock/abort) already set this._error and rejected
      // the guard — don't re-classify or emit. Otherwise the consumer itself
      // threw a real SDK error: classify, record, and emit to handle listeners.
      if (!settled) {
        const classified = classifyError(err);
        this._error = classified;
        this.handle.emit('error', classified);
      }
    } finally {
      // Disarm (idempotent): clears any live per-call timer and folds a
      // still-open active window into totalActiveMs so teardown accounting
      // is complete even when the session dies mid-call.
      this._disarmWallClock();
      if (this._signal) this._signal.removeEventListener('abort', onAbort);
      // Reject any sendPrompt promises that were waiting when the
      // consumer loop ended. This covers BOTH exit paths:
      //   - Error path: _error is set, reject with that error
      //   - Happy-path early exit: the SDK iterator completed cleanly
      //     but one or more sends never got a matching result (e.g.
      //     caller invoked close() before a result arrived, or the
      //     SDK hit its budget cap and ended gracefully). Reject with
      //     a sentinel error so the caller unblocks instead of hanging.
      //
      // Without this, a clean SDK exit with outstanding sends would
      // leave the send promises pending forever (caught by Copilot
      // review, 2026-04-09).
      const rejectionReason = this._error
        || new Error('ReusableSession: session closed before result arrived');
      while (this._pendingResults.length > 0) {
        this._pendingResults.shift().reject(rejectionReason);
      }

      this.handle.finished = true;
      this.handle.finishedAt = new Date().toISOString();
      this._sessionManager._active.delete(this.handle.name);
      // Backstop discard for the handle-name in-flight estimate. The common
      // case is cleared at each turn boundary (the result handler above), but a
      // session that closes mid-turn — abort/wall-clock, or close() before a
      // result arrives — never hits that boundary, so the last turn's estimate
      // would linger. Clear it here. Idempotent: a no-op when the turn boundary
      // already discarded it.
      this._sessionManager._tokenTracker?.discardInFlight?.(this.handle.name);
      // Observability rider (spec-percall-wallclock): one teardown line with
      // the cumulative active time and call count for this session.
      console.log(
        `[session-manager] ReusableSession '${this.handle.name}' teardown: ` +
        `callCount=${this.handle.callCount ?? 0} totalActiveMs=${this.handle.totalActiveMs ?? 0}`
      );
      // Deliberate asymmetry vs spawn(): ReusableSession's finally is the
      // single owner of the multi-turn handle lifecycle, so it ALWAYS emits
      // exactly one 'exit' here — including on the wall-clock/abort path,
      // where terminate() set _error and the catch's `!settled` guard
      // suppressed a duplicate 'error' emit. Do not "fix" this into a
      // conditional emit.
      this.handle.emit('exit', { result: this.handle._result });
    }
  }

  /**
   * Arm the per-call wall-clock timer (spec-percall-wallclock).
   *
   * Called by sendPrompt() on the empty→non-empty transition of
   * _pendingResults. No-op if a window is already armed (multiple
   * outstanding prompts share one window: first-out → queue-empty).
   * Each armed window gets a FRESH full budget — elapsed session
   * lifetime and previous calls' durations never count against it.
   *
   * Termination routes through _terminate (the captured-reject guard
   * set up in _consumeEvents), preserving the hard-stalled-generator
   * protection: the timer wins the race directly instead of waiting
   * for a stalled iterator to cooperate.
   */
  _armWallClock() {
    if (this.handle._wallClockTimer) return; // window already armed
    this._activeWindowStart = Date.now();
    this.handle._wallClockTimer = setTimeout(() => {
      this._terminate?.(new WallClockExceededError(
        `ReusableSession '${this.handle.name}' exceeded per-call wall-clock limit of ${config.execution.maxSessionWallClockMs}ms`
      ));
    }, config.execution.maxSessionWallClockMs);
    this.handle._wallClockTimer.unref();
  }

  /**
   * Disarm the per-call wall-clock timer and fold the just-closed active
   * window into handle.totalActiveMs. Called on the non-empty→empty
   * transition of _pendingResults, and (idempotently) at consumer
   * teardown to account for a window still open when the session dies.
   * While disarmed the session is idle and the cap cannot fire.
   */
  _disarmWallClock() {
    if (this.handle._wallClockTimer) {
      clearTimeout(this.handle._wallClockTimer);
      this.handle._wallClockTimer = null;
    }
    // `!= null` (not `!== null`): prototype-constructed sessions in tests
    // skip the constructor, leaving this undefined rather than null.
    if (this._activeWindowStart != null) {
      this.handle.totalActiveMs = (this.handle.totalActiveMs || 0) + (Date.now() - this._activeWindowStart);
      this._activeWindowStart = null;
    }
  }

  /**
   * Send a new prompt to the session and wait for its result.
   * Promise resolves with the SDK result event (has usage, total_cost_usd,
   * structured_output if jsonSchema was provided, etc).
   *
   * Can be called multiple times. Each call returns a distinct promise
   * that resolves when the NEXT result event arrives (FIFO ordering —
   * if you call sendPrompt twice in a row without awaiting, the first
   * promise resolves with the first result, the second with the second).
   */
  async sendPrompt(promptText) {
    if (this._signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    if (this._closed) {
      throw new Error('ReusableSession: cannot send to closed session');
    }
    if (this._error) {
      throw new Error(`ReusableSession: session errored — ${this._error.message}`);
    }

    this._sessionManager._assertUnderRunCeiling(this.handle.name);

    this._turnCount++;
    // `|| 0` base: tolerate test-fabricated handles that aren't real
    // SessionHandle instances and lack the rider fields.
    this.handle.callCount = (this.handle.callCount || 0) + 1;

    return new Promise((resolve, reject) => {
      this._pendingResults.push({ resolve, reject });
      // Empty→non-empty transition: arm the per-call wall-clock with a
      // fresh budget. If other prompts are already outstanding the
      // existing shared window keeps running (_armWallClock no-ops).
      if (this._pendingResults.length === 1) {
        this._armWallClock();
      }
      this._stream.push({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: promptText }],
        },
        parent_tool_use_id: null,
      });
    });
  }

  /**
   * Close the session. Stops accepting new prompts, flushes any
   * in-flight work, and waits for the background consumer to exit.
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._stream.close();
    // Wait for the consumer loop to finish its final iteration
    try {
      await this._consumerPromise;
    } catch {
      // Already emitted via error handler in _consumeEvents
    }
  }

  /** Number of turns (sendPrompt calls) this session has handled so far. */
  get turnCount() {
    return this._turnCount;
  }
}

/**
 * Handle for a running claude agent SDK session.
 * Emits: 'init', 'message', 'result', 'error', 'exit'
 *
 * Attaches a default no-op 'error' listener at construction time.
 * This is a defense against Node's EventEmitter invariant that
 * emitting 'error' on a zero-listener handle throws synchronously
 * and crashes the process. Our session lifecycle has a real window
 * where the SDK can fail BEFORE the caller has attached its own
 * listeners (the sync prefix of spawn()'s IIFE or
 * ReusableSession._consumeEvents can throw if query() or the
 * iterator is malformed). Without this default listener, an early
 * SDK failure would crash the whole orchestrator process.
 *
 * The no-op listener is purely defensive — it doesn't replace the
 * real logger listener that planner.js / executor.js / etc. attach
 * via logger.attachToSession(). Both listeners coexist, and real
 * error handling still happens through:
 *   (1) the caller's attached 'error' listener (for logging), and
 *   (2) the thrown/rejected promise from spawn() / sendPrompt()
 *       (for control flow).
 *
 * (Bug caught in Copilot review, 2026-04-09.)
 */
class SessionHandle extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.startedAt = new Date().toISOString();
    this.finished = false;
    this._result = null;
    this._query = null;  // SDK Query object
    this._toolCallCount = 0;
    this.systemPromptTokens = 0;
    this._readFiles = new Set(); // tracks files Read by the agent this session
    this._capturedStructuredOutput = null; // last StructuredOutput tool_use input seen
    this._resultReceived = false;
    this._watchdogTimer = null;
    this._wallClockTimer = null;
    // Observability rider (spec-percall-wallclock): cumulative active-window
    // time and sendPrompt call count, accumulated by ReusableSession and
    // logged once at its teardown. Initialized here (not in ReusableSession's
    // constructor) so every handle — including ones attached to
    // prototype-constructed sessions in tests — starts from clean zeros.
    this.totalActiveMs = 0;
    this.callCount = 0;

    // Default no-op 'error' listener — see class docstring.
    // Real listeners attached later via logger.attachToSession().
    this.on('error', () => {});
  }

  kill() {
    if (!this.finished && this._query) {
      this._query.close();
    }
  }

  get result() {
    return this._result;
  }
}

/**
 * InfrastructureError — wraps SDK/network errors with structured metadata.
 *
 * Fields:
 *   category   {string}  — one of 'rate_limit', 'network', 'auth', 'server', 'api', 'unknown'
 *   retryable  {boolean} — whether the caller should retry the operation
 *   statusCode {number|undefined} — HTTP status code from the SDK error (if available)
 *   cause      {Error}   — original error that triggered classification
 */
class InfrastructureError extends Error {
  constructor(message, { category, retryable, statusCode, cause }) {
    super(message);
    this.name = 'InfrastructureError';
    this.category = category;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

/**
 * WallClockExceededError — thrown when a session exceeds the configured wall-clock limit.
 *
 * Fields:
 *   name      {string}  — 'WallClockExceededError'
 *   retryable {boolean} — always false (wall-clock exhaustion is non-retryable)
 *   category  {string}  — 'wall-clock-exceeded'
 */
class WallClockExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WallClockExceededError';
    this.retryable = false;
    this.category = 'wall-clock-exceeded';
  }
}

/**
 * CostCeilingExceededError — thrown when a session exceeds the configured cost ceiling.
 *
 * Fields:
 *   name      {string}  — 'CostCeilingExceededError'
 *   retryable {boolean} — always false (cost ceiling exhaustion is non-retryable)
 *   category  {string}  — 'cost-ceiling'
 */
class CostCeilingExceededError extends InfrastructureError {
  constructor(message) {
    super(message, { category: 'cost-ceiling', retryable: false });
    this.name = 'CostCeilingExceededError';
  }
}

/**
 * classifyError — inspects an SDK or generic error and returns an InfrastructureError.
 *
 * Classification rules:
 *   RateLimitError        → category 'rate_limit', retryable true,  statusCode 429
 *   APIConnectionError    → category 'network',    retryable true,  statusCode undefined
 *   AuthenticationError   → category 'auth',       retryable false, statusCode 401
 *   InternalServerError   → category 'server',     retryable true,  statusCode 5xx
 *   APIError (other)      → category 'api',        retryable false, statusCode from .status
 *   unknown               → category 'unknown',    retryable false, statusCode undefined
 *
 * @param {Error} err — original error to classify
 * @returns {InfrastructureError}
 */
function classifyError(err) {
  // Order matters: RateLimitError and APIConnectionError are subclasses of APIError,
  // so they must be checked before the generic APIError branch.
  // AuthenticationError and InternalServerError are also subclasses of APIError.
  if (err instanceof RateLimitError) {
    return new InfrastructureError(err.message, {
      category: 'rate_limit',
      retryable: true,
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof APIConnectionError) {
    return new InfrastructureError(err.message, {
      category: 'network',
      retryable: true,
      statusCode: undefined,
      cause: err,
    });
  }
  if (err instanceof AuthenticationError) {
    return new InfrastructureError(err.message, {
      category: 'auth',
      retryable: false,
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof InternalServerError) {
    return new InfrastructureError(err.message, {
      category: 'server',
      retryable: true,
      statusCode: err.status,
      cause: err,
    });
  }
  if (err instanceof APIError) {
    return new InfrastructureError(err.message, {
      category: 'api',
      retryable: false,
      statusCode: err.status,
      cause: err,
    });
  }
  // Unknown / plain Error
  return new InfrastructureError(err.message, {
    category: 'unknown',
    retryable: false,
    statusCode: undefined,
    cause: err,
  });
}

function classifyResult(result) {
  if (result.is_error !== true) {
    return null;
  }
  const outputTokens = result.usage?.output_tokens ?? 0;
  const isTransportFailure =
    (result.duration_api_ms === 0 && outputTokens === 0) ||
    /timed out|timeout|ECONN|ETIMEDOUT|fetch failed|socket hang up|network|aborted/i.test(
      String(result.result || '')
    );
  if (isTransportFailure) {
    return new InfrastructureError(`SDK transport result error: ${result.result}`, {
      category: 'network',
      retryable: true,
      statusCode: undefined,
      cause: undefined,
    });
  }
  return null;
}

class SessionManager {
  constructor() {
    this._active = new Map(); // name -> SessionHandle
    // Default query function — can be overridden in tests to inject a mock.
    this._queryFn = query;
    this._tokenTracker = null;
  }

  /**
   * Wire a TokenTracker so _dispatchEvent can forward incremental usage
   * from each assistant frame. Called by pipeline.js immediately after
   * both SessionManager and TokenTracker are constructed.
   *
   * @param {TokenTracker} tt
   */
  setTokenTracker(tt) {
    this._tokenTracker = tt;
  }

  /**
   * Ceiling gate — refuses to dispatch a new session once cumulative run
   * spend has reached the configured ceiling.
   *
   * Reads config.budgets.runCeilingUsd and this._tokenTracker.getTotalUsage()
   * at call time (not cached) so a ceiling set/changed or spend accrued
   * between spawns is always seen fresh. Throws CostCeilingExceededError
   * ONLY when all of: the tracker is wired, the ceiling is a real number
   * (not null/undefined), AND cumulative totalCostUsd >= ceiling.
   *
   * Fails open in every other case — no tracker, no/null ceiling, or any
   * unexpected error while reading the tracker/config — so a gate
   * malfunction never blocks dispatch. The ceiling comparison itself is
   * the only path that ever throws.
   *
   * @param {string} sessionName - name of the session about to be spawned,
   *   included in the thrown error's message for diagnosis.
   */
  _assertUnderRunCeiling(sessionName) {
    let ceiling;
    let totalCostUsd;
    try {
      if (!this._tokenTracker) return;
      ceiling = config.budgets.runCeilingUsd;
      if (ceiling === null || ceiling === undefined) return;
      totalCostUsd = this._tokenTracker.getTotalUsage().totalCostUsd;
    } catch {
      // Fail open: an unexpected error reading tracker/config must never
      // block dispatch.
      return;
    }
    if (totalCostUsd >= ceiling) {
      throw new CostCeilingExceededError(
        `Run cost ceiling of $${ceiling} reached (cumulative spend $${totalCostUsd}) — refusing to spawn session '${sessionName}'`
      );
    }
  }

  /**
   * Spawn a new claude session via the Agent SDK.
   *
   * @param {Object} options
   * @param {string}   options.prompt       - The prompt to send
   * @param {string}   options.name         - Session name for logging
   * @param {string[]} [options.tools]      - Tool allowlist
   * @param {string}   [options.agent]      - Agent name (e.g. 'executor')
   * @param {object}   [options.jsonSchema] - JSON schema for structured output
   * @param {number}   [options.maxBudget]  - Max budget in USD
   * @param {string}   [options.systemPrompt] - System prompt override
   * @param {string}   [options.cwd]        - Working directory
   * @returns {Promise<{handle: SessionHandle, result: object}>}
   */
  spawn(options) {
    const signal = options.signal || this.signal || null;
    const handle = new SessionHandle(options.name || 'unnamed');
    handle.agent = options.agent || null;
    this._active.set(handle.name, handle);

    // Build SDK options synchronously. If this throws (invalid options,
    // config failure), unwind _active so the failed handle doesn't
    // linger as a ghost session. Mirrors the equivalent guard in
    // ReusableSession's constructor (line 163-194). Without this, a
    // synchronous failure in _buildSdkOptions would leak the handle
    // in _active forever with finished=false.
    let sdkOptions;
    try {
      sdkOptions = this._buildSdkOptions(options, handle._readFiles);
      handle.systemPromptTokens = sdkOptions._approxSystemPromptTokens || 0;
    } catch (err) {
      this._active.delete(handle.name);
      handle.finished = true;
      throw err;
    }

    // ── Wall-clock / abort guard ─────────────────────────────────────────
    // A session can hard-stall: the SDK generator blocked inside an in-flight
    // `await` never reaches a suspension point, so handle._query.return()
    // (cooperative cancellation) cannot interrupt it and the for-await loop
    // never ends. The wall-clock cap and abort therefore must reject the
    // spawn DIRECTLY rather than wait for the loop. `guard` is that channel;
    // `work` is the normal session lifecycle, raced against it.
    let rejectGuard;
    const guard = new Promise((_, reject) => { rejectGuard = reject; });

    const work = (async () => {
      // Declared at IIFE scope so terminate() and the catch block can both
      // see them.
      let onAbort;
      let settled = false;

      // Single teardown path for wall-clock-exceeded and abort. Tears down
      // the generator (best-effort — may be a no-op on a hard-stalled one,
      // which then leaks until the SDK subprocess exits), does the same
      // finished/_active bookkeeping the happy/catch paths do (so a stalled
      // session is NOT left as a ghost in _active), and rejects the guard so
      // spawn() returns immediately without awaiting the stalled generator.
      // Emits no event — matching the prior wall-clock path, which also did
      // not emit. The `settled` flag makes it idempotent and stops the work
      // body from running its success/error paths (and double-emitting) if
      // the generator happens to cooperate with return() afterwards.
      const terminate = (err) => {
        if (settled) return;
        settled = true;
        try { handle._query?.return?.(); } catch {}
        if (handle._watchdogTimer) { clearTimeout(handle._watchdogTimer); handle._watchdogTimer = null; }
        if (handle._wallClockTimer) { clearTimeout(handle._wallClockTimer); handle._wallClockTimer = null; }
        if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {} }
        handle.finished = true;
        handle.finishedAt = new Date().toISOString();
        this._active.delete(handle.name);
        rejectGuard(err);
      };

      try {
        this._assertUnderRunCeiling(handle.name);

        // Hermeticity chokepoint (archive-210 follow-through; the 4 live
        // leaks this closes were probe-verified 2026-08-20): under the test
        // runner (CC_ORCH_TEST=1) a session must never reach the real SDK
        // unless the real-SDK lane is explicitly opted into. Identity check
        // on _queryFn — injected fakes pass untouched.
        if (this._queryFn === query && process.env.CC_ORCH_TEST === '1' && process.env.CC_ORCH_REAL_SDK !== '1') {
          throw new Error(
            `Hermeticity guard: refusing to spawn a real SDK session '${handle.name}' under CC_ORCH_TEST=1 — ` +
            `inject a fake via _queryFn, or set CC_ORCH_REAL_SDK=1 for the real-SDK lane`
          );
        }

        const q = this._queryFn({
          prompt: options.prompt,
          options: this._toQueryOptions(sdkOptions),
        });
        handle._query = q;

        handle._wallClockTimer = setTimeout(() => {
          terminate(new WallClockExceededError(`Session '${handle.name}' exceeded wall-clock limit of ${config.execution.maxSessionWallClockMs}ms`));
        }, config.execution.maxSessionWallClockMs);
        handle._wallClockTimer.unref();

        // Abort signal: route through the same direct-terminate path —
        // return() alone cannot interrupt a hard-stalled generator (same
        // failure mode the wall-clock guard fixes). The abort check
        // immediately precedes addEventListener to close the race window.
        onAbort = () => terminate(new DOMException('The operation was aborted', 'AbortError'));
        if (signal) {
          if (signal.aborted) {
            if (handle._wallClockTimer) { clearTimeout(handle._wallClockTimer); handle._wallClockTimer = null; }
            this._active.delete(handle.name);
            handle.finished = true;
            throw new DOMException('The operation was aborted', 'AbortError');
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Consume the async generator. Spawn() is single-shot: first
        // result event is terminal. Set the first-wins flag and arm the
        // watchdog here — NOT in _dispatchEvent (which is shared with
        // ReusableSession and must keep firing result events per turn).
        for await (const event of q) {
          this._dispatchEvent(handle, event);
          if (event.type === 'result') {
            handle._resultReceived = true;
            handle._watchdogTimer = setTimeout(() => {
              try { handle._query?.return?.(); } catch {}
            }, RESULT_WATCHDOG_MS);
            handle._watchdogTimer.unref();
            break;
          }
        }

        // terminate() already fired (wall-clock/abort, and the generator
        // then cooperated with return()) — the guard already rejected; do
        // not run the success path or it would emit a second event.
        if (settled) return undefined;

        if (handle._watchdogTimer) { clearTimeout(handle._watchdogTimer); handle._watchdogTimer = null; }
        if (handle._wallClockTimer) { clearTimeout(handle._wallClockTimer); handle._wallClockTimer = null; }
        if (signal) signal.removeEventListener('abort', onAbort);

        const infra = classifyResult(handle._result);
        if (infra !== null) {
          handle.finished = true;
          handle.finishedAt = new Date().toISOString();
          this._active.delete(handle.name);
          handle.emit('error', infra);
          throw infra;
        }

        handle.finished = true;
        handle.finishedAt = new Date().toISOString();
        this._active.delete(handle.name);
        handle.emit('exit', { result: handle._result });

        return { handle, result: handle._result };
      } catch (err) {
        // terminate() already did teardown + guard rejection — let this
        // rejection be swallowed (work is the losing side of the race);
        // don't re-clean or re-emit.
        if (settled) throw err;
        if (handle._watchdogTimer) { clearTimeout(handle._watchdogTimer); handle._watchdogTimer = null; }
        if (handle._wallClockTimer) { clearTimeout(handle._wallClockTimer); handle._wallClockTimer = null; }
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err instanceof WallClockExceededError) {
          throw err;
        }
        if (signal?.aborted) {
          handle.finished = true;
          handle.finishedAt = new Date().toISOString();
          this._active.delete(handle.name);
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        if (err instanceof InfrastructureError) {
          // Already emitted at the classifyResult site (the only producer of a
          // thrown InfrastructureError on this path emits 'error' before
          // throwing). Re-emitting here would fire 'error' twice for one
          // transport-classified failure, tripping any error-counting consumer
          // at half threshold. Do the bookkeeping and re-throw WITHOUT a second
          // emit — exactly one 'error' per handle.
          handle.finished = true;
          this._active.delete(handle.name);
          throw err;
        }
        const classified = classifyError(err);
        handle.finished = true;
        this._active.delete(handle.name);
        handle.emit('error', classified);
        throw classified;
      }
    })();

    // Race the normal lifecycle against the guard. The guard rejects the
    // instant a timer/abort fires, so spawn() no longer depends on the
    // generator cooperating with return(). Attach no-op catches so the
    // losing side settling later cannot raise an unhandled rejection.
    const raced = Promise.race([work, guard]);
    work.catch(() => {});
    guard.catch(() => {});

    // Expose handle on the promise for early event attachment
    raced.handle = handle;

    // Reconcile the in-flight usage estimate when the session settles (success
    // OR failure). Every terminal path streams usage under handle.name into the
    // tracker's in-flight map; recordSession (the agent's finalize on success)
    // builds the authoritative entry from the result event, so discarding the
    // estimate here is safe and idempotent — and it cannot leak if the agent
    // throws before recordSession. This is the single owner of in-flight
    // cleanup for single-shot spawns, so agents no longer discard themselves.
    raced.finally(() => { this._tokenTracker?.discardInFlight?.(handle.name); }).catch(() => {});

    return raced;
  }

  /**
   * Build SDK options from our spawn options.
   *
   * @param {object} options   - Spawn options
   * @param {Set}    [readFiles] - Set that tracks files Read by the agent; shared
   *                               with the SessionHandle so it persists across turns.
   *                               Defaults to a fresh Set (used when called without a handle).
   * @param {boolean} [options.denyForeignPendingBash] - Opt-in flag: when true (together
   *                               with a non-empty options.foreignPendingFiles), deny any
   *                               Bash command whose command string contains one of those
   *                               paths (verbatim or './'-prefixed), steering the agent to
   *                               Read/Grep instead of shelling out to another mission's
   *                               in-flight files.
   * @param {string[]} [options.foreignPendingFiles] - Project-root-relative paths owned by
   *                               another in-flight mission; used only when
   *                               options.denyForeignPendingBash is truthy.
   */
  _buildSdkOptions(options, readFiles = new Set()) {
    const sdkOpts = {
      // Settings isolation: don't load user/project settings in worker sessions
      settingSources: [],
      // No session persistence for workers
      persistSession: false,
      // Stamp the run marker into the child environment so a spawned SDK
      // worker session's process.env carries CC_ORCH_ACTIVE_RUN, letting
      // downstream guards detect it belongs to an active orchestrator run.
      env: withRunMarkerEnv(),
    };

    // Working directory
    if (options.cwd) {
      sdkOpts.cwd = options.cwd;
    }

    // Output format: structured JSON or plain text
    if (options.jsonSchema) {
      sdkOpts.outputFormat = {
        type: 'json_schema',
        schema: options.jsonSchema,
      };
    }

    // Tools — use scoped Bash patterns instead of unrestricted Bash
    if (options.tools && options.tools.length > 0) {
      sdkOpts.tools = options.tools.map((tool) => {
        if (tool === 'Bash') {
          // Replace unrestricted Bash with scoped patterns
          return options.bashScope || 'Bash';
        }
        return tool;
      });
    }

    // Model — per-role model assignment
    if (options.model) {
      sdkOpts.model = options.model;
    }

    // Agent
    if (options.agent) {
      sdkOpts.agent = options.agent;
    }

    // Budget
    if (options.maxBudget) {
      sdkOpts.maxBudgetUsd = options.maxBudget;
    }

    // System prompt
    if (options.systemPrompt) {
      sdkOpts.systemPrompt = options.systemPrompt;
      sdkOpts._approxSystemPromptTokens = Math.ceil(options.systemPrompt.length / 4);
    }

    // Permission mode: bypass permissions for worker sessions
    if (config.sessionDefaults.dangerouslySkipPermissions) {
      sdkOpts.permissionMode = 'bypassPermissions';
    }

    // File-level guard: block Edit/Write outside targetFiles, and require prior Read
    // for existing files.  readFiles is the Set shared with the SessionHandle so
    // that file-tracking persists across the full session lifetime.
    const targetFiles = options.targetFiles;
    const sessionCwd = options.cwd || process.cwd();
    sdkOpts.canUseTool = (toolName, toolInput) => {
      // Normalize file_path to absolute — SDK tools should always provide
      // absolute paths, but defensive normalization prevents bypasses if
      // a relative path slips through.
      if (toolInput?.file_path && !path.isAbsolute(toolInput.file_path)) {
        toolInput.file_path = path.resolve(sessionCwd, toolInput.file_path);
      }
      // Track every Read call so _guardToolUse can verify prior-read for Edit/Write
      if (toolName === 'Read') {
        const fp = toolInput?.file_path;
        if (fp) readFiles.add(this._canonicalPath(fp));
      }
      // Opt-in whole-suite Bash deny (spawn-level flag; currently only the
      // reviewer passes it). The full suite is the final gate's job — a
      // review-time run against a not-yet-final tree produces false REDs.
      // This deny is the output-side guarantee behind the prompt rule.
      // Deliberately per-session: the milestone-regression verifier's
      // whole-suite run is sanctioned and must remain unaffected.
      if (options.denyWholeSuiteBash && toolName === 'Bash'
          && bashCommandRunsWholeSuite(toolInput?.command, config)) {
        return {
          behavior: 'deny',
          message: 'Whole-suite commands are reserved for the final integration gate — sibling work may not have run yet. Judge composition from the diff and targeted checks instead.',
        };
      }
      // Opt-in git-history/status read deny (spawn-level flag; the verifier
      // passes it). A verifier judging an in-flight run against git history
      // reads a tree that predates the work by design — the false-FAILED
      // misjudgment vector verified 2026-08-20. The deny message carries the
      // worktree contract so the model learns it at the moment of temptation.
      if (options.denyGitReadsBash && toolName === 'Bash'
          && /\bgit\s+(show|diff|log|status|ls-files|blame|reflog|cat-file|rev-parse|rev-list|describe|shortlog)\b/.test(toolInput?.command || '')) {
        return {
          behavior: 'deny',
          message: 'Deliverables live in the uncommitted working tree — verify content by reading files directly. Git history/status is not a baseline here: HEAD predates this work by design, so anything judged against it reads as missing.',
        };
      }
      // Opt-in file-removal deny (spawn-level flag; the read-only agents —
      // verifier, reviewer, analyzer — pass it). A judging role has no
      // legitimate reason to delete anything; a bare `rm <file>` slips the
      // global dangerous-pattern list (which covers only -r/-rf and globs)
      // and destroys uncommitted deliverables.
      if (options.denyFileRemovalBash && toolName === 'Bash'
          && SessionManager.FILE_REMOVAL_BASH_PATTERNS.some(
            (p) => p.test(toolInput?.command || ''),
          )) {
        return {
          behavior: 'deny',
          message: 'File removal is not available to read-only judging roles — inspect and report; never alter the tree.',
        };
      }
      // Opt-in foreign-pending-file Bash deny (spawn-level flag; passed
      // together with options.foreignPendingFiles — the project-root-relative
      // paths another in-flight mission currently owns). Deterministic string
      // containment only (verbatim path or its './'-prefixed form) — no
      // globbing, no regex path building, no basename matching — so a
      // sibling's untouched deliverable can't be shelled out to ahead of its
      // own review path.
      if (options.denyForeignPendingBash
          && Array.isArray(options.foreignPendingFiles) && options.foreignPendingFiles.length > 0
          && toolName === 'Bash') {
        const command = toolInput?.command || '';
        const hitsForeignPending = options.foreignPendingFiles.some(
          (f) => command.includes(f) || command.includes(`./${f}`),
        );
        if (hitsForeignPending) {
          return {
            behavior: 'deny',
            message: 'That path belongs to another in-flight mission — mission ownership means it is not yours to shell out to yet. Use Read or Grep to inspect it instead.',
          };
        }
      }
      // Thread the session cwd through to the guard so the project-root
      // boundary check (D1) can enforce that every Edit/Write resolves
      // inside the session root. Pass options.cwd directly (not the
      // process.cwd() fallback used for filePath normalization above) —
      // if a spawn path did not declare a cwd the guard must not invent
      // a default root.
      return this._guardToolUse(toolName, toolInput, targetFiles, readFiles, options.cwd);
    };

    // ENFORCEMENT PATH: under permissionMode 'bypassPermissions' the SDK
    // (agent-sdk >= 0.3) auto-approves every tool call BEFORE consulting
    // canUseTool — the callback is shadowed and the SDK emits a
    // CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning. The 0.2.x line still
    // consulted it (guard denials are on record in archive failed-202,
    // 2026-07-19), so the 0.3 upgrade silently disabled this guard. Hooks
    // run regardless of permission mode, so the SAME callback is wired as
    // a PreToolUse hook — the replacement the SDK's own warning names.
    // canUseTool stays on this object for the unit tests that drive the
    // guard directly and for any future non-bypass mode, but it is
    // stripped before the options reach query() (see _toQueryOptions), so
    // the SDK never sees a shadowed callback.
    const guard = sdkOpts.canUseTool;
    sdkOpts.hooks = {
      PreToolUse: [{
        hooks: [async (hookInput) => {
          const verdict = guard(hookInput.tool_name, hookInput.tool_input ?? {});
          if (verdict && verdict.behavior === 'deny') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: verdict.message,
              },
            };
          }
          // Allow: carry the guard's (possibly path-normalized) input
          // through, mirroring the updatedInput contract canUseTool had.
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              updatedInput: (verdict && verdict.updatedInput) || hookInput.tool_input || {},
            },
          };
        }],
      }],
    };

    return sdkOpts;
  }

  /**
   * Project a _buildSdkOptions() result onto what is actually handed to the
   * SDK's query(): identical except canUseTool is stripped. The guard's
   * enforcement path is the PreToolUse hook built alongside it (see
   * _buildSdkOptions); passing the callback too would only trigger the
   * SDK's CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning on every spawn under
   * bypassPermissions, enforcing nothing.
   *
   * @param {object} sdkOptions - a _buildSdkOptions() result
   * @returns {object} the same options minus canUseTool
   */
  _toQueryOptions(sdkOptions) {
    const { canUseTool: _stripped, ...forSdk } = sdkOptions;
    return forSdk;
  }

  /**
   * Dispatch SDK message event to the SessionHandle.
   *
   * SDK message types (from AsyncGenerator<SDKMessage>):
   *   - system: init, hook events
   *   - assistant: model responses with content blocks
   *   - result: final result with cost/usage
   */
  _dispatchEvent(handle, event) {
    const type = event.type;

    switch (type) {
      case 'system':
        handle.emit('init', event);
        break;

      case 'assistant': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              handle._toolCallCount++;
              if (block.name === 'StructuredOutput') {
                handle._capturedStructuredOutput = block.input;
              }
            }
          }
        }
        // Forward incremental usage to TokenTracker (if wired).
        // Wrapped in try/catch so a tracker error never breaks the SDK consumer loop.
        const usage = event.message?.usage;
        // !handle.finished: once the session has settled, its in-flight estimate
        // has been reconciled (discarded by the spawn/reusable teardown). A late
        // assistant frame draining out of a wall-clock/abort loser must NOT
        // re-create an _inFlight entry that no discard path will clean up again.
        if (usage && this._tokenTracker && handle.agent && !handle.finished) {
          try {
            this._tokenTracker.recordIncrementalUsage(handle.name, handle.agent, usage);
          } catch {
            // Swallow — incremental tally must never interrupt the event loop.
          }
        }
        handle.emit('message', event);
        break;
      }

      case 'result':
        // _dispatchEvent is the shared dispatcher — called by spawn()'s
        // for-await AND ReusableSession._consumeEvents. Result-event
        // first-wins guard + watchdog arming live in spawn() (single-shot
        // semantics) so reusable sessions (multi-turn) keep firing
        // result events per turn uninterrupted.
        handle._result = event;
        if (handle._capturedStructuredOutput !== null && event.structured_output === undefined) {
          event._capturedStructuredOutput = handle._capturedStructuredOutput;
        }
        // Clear the captured slot after attachment so subsequent turns in
        // a reusable session don't cross-contaminate their result with
        // stale turn-1 StructuredOutput data.
        handle._capturedStructuredOutput = null;
        handle.emit('result', event);
        break;

      default:
        handle.emit('message', event);
        break;
    }
  }

  // --- Dangerous command patterns (shared with hook) ---
  static DANGEROUS_BASH_PATTERNS = [
    /\bgit\s+commit\b/,
    /\bgit\s+push\b/,
    /\bgit\s+reset\b/,
    /\bgit\s+rebase\b/,
    /\bgit\s+merge\b/,
    // Bare forms included: `git restore <path>` / `git checkout <path>` discard
    // uncommitted work just like the `--`-separated forms — a read-only agent
    // (verifier) used the bare form to destroy in-flight deliverables before
    // the pattern was widened (cross-session report, 2026-08-17).
    /\bgit\s+(checkout|restore)\b/,
    // Whole stash family: a bare `git stash` moves uncommitted deliverables
    // out of the working tree — as destructive to an in-flight run as any
    // revert (adversarial probe finding, 2026-08-20). Subsumes `stash drop`.
    /\bgit\s+stash\b/,
    /\bgit\s+branch\s+-[dD]\b/,
    /\bgit\s+tag\s+-d\b/,
    /\bgit\s+clean\b/,
    /\brm\s+-(r|rf|fr)\b/,
    /\brm\s.*\*/,
    /\bnpm\s+publish\b/,
    /\bnpm\s+unpublish\b/,
    /\b(kill|killall|pkill)\b/,
    /\b(DROP\s+TABLE|DELETE\s+FROM|TRUNCATE)\b/i,
    /^\s*sudo\b/,
  ];

  // --- File-removal Bash command patterns (CLOSED set, opt-in) ---
  //
  // Consulted only by the opt-in spawn-level removal deny (not wired into
  // any guard branch by this task — this constant is the declaration only).
  // Unlike DANGEROUS_BASH_PATTERNS (always-on for every sub-agent), this
  // list is CLOSED: it covers exactly the deletion primitives enumerated
  // below and MUST NOT be speculatively extended.
  //
  // Coverage (one primitive per bullet; node fs APIs combine the bare and
  // `fs.promises.`-qualified spellings via an optional group):
  //   - `rm`                                      — shell removal command
  //   - `fs.rm` / `fs.promises.rm`                 — recursive/force remover
  //   - `fs.rmSync` / `fs.promises.rmSync`         — recursive/force remover (sync)
  //   - `fs.rmdir` / `fs.promises.rmdir`           — directory remover
  //   - `fs.rmdirSync` / `fs.promises.rmdirSync`   — directory remover (sync)
  //   - `fs.unlink` / `fs.promises.unlink`         — file remover
  //   - `fs.unlinkSync` / `fs.promises.unlinkSync` — file remover (sync)
  //   - `rimraf`                                   — recursive-delete npm package (command word)
  //   - `shutil.rmtree`                            — Python recursive tree deleter
  //   - `os.remove`                                — Python os-module file deleter
  //   - `os.unlink`                                — Python os-module symlink deleter
  //   - `os.rmdir`                                 — Python os-module directory deleter
  //
  // Every entry is word-boundary disciplined so the two-letter shell stem
  // `rm` never matches inside a longer word or a path segment (e.g. the
  // word `confirm`, or a path like `src/form/x.js`).
  static FILE_REMOVAL_BASH_PATTERNS = [
    /\brm\b/,
    /\bfs\.(promises\.)?rm\b/,
    /\bfs\.(promises\.)?rmSync\b/,
    /\bfs\.(promises\.)?rmdir\b/,
    /\bfs\.(promises\.)?rmdirSync\b/,
    /\bfs\.(promises\.)?unlink\b/,
    /\bfs\.(promises\.)?unlinkSync\b/,
    /\brimraf\b/,
    /\bshutil\.rmtree\b/,
    /\bos\.remove\b/,
    /\bos\.unlink\b/,
    /\bos\.rmdir\b/,
  ];

  /**
   * Membership test for the read-tracking Set against a canonicalized
   * path. Fast path: entries added through the guard hook are already
   * canonical. Fallback: entries may be seeded as raw absolute paths
   * (the Set's original contract), so scan-and-canonicalize before
   * concluding a file was never Read.
   *
   * @param {Set<string>} readFiles
   * @param {string} canonicalAbs - output of _canonicalPath
   * @returns {boolean}
   */
  _readFilesHas(readFiles, canonicalAbs) {
    if (readFiles.has(canonicalAbs)) return true;
    for (const f of readFiles) {
      if (this._canonicalPath(f) === canonicalAbs) return true;
    }
    return false;
  }

  /**
   * Canonicalize an absolute path for guard comparisons: realpath-resolve
   * the longest EXISTING prefix and re-append the non-existent tail
   * verbatim — a Write may legitimately target a path that does not exist
   * yet. This closes the two-spellings hole a symlinked project root opens
   * (e.g. a `foo -> foo.nosync` alias makes .../foo/x.js and
   * .../foo.nosync/x.js the same file, which a plain path.resolve
   * prefix/equality test treats as different trees — archive 226's false
   * denials). Failure-soft: if no prefix of the path exists, the input is
   * returned unchanged.
   *
   * @param {string} p - an absolute path
   * @returns {string} the canonicalized path
   */
  _canonicalPath(p) {
    if (!p) return p;
    let head = p;
    let tail = '';
    for (;;) {
      try {
        const real = fs.realpathSync(head);
        return tail ? path.join(real, tail) : real;
      } catch {
        const parent = path.dirname(head);
        if (parent === head) return p;
        tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
        head = parent;
      }
    }
  }

  /**
   * Guard tool use for sub-agent sessions.
   * - Bash: block dangerous commands (git commit, rm -rf, etc.)
   * - Edit/Write: when sessionCwd is known, DENY writes whose resolved absolute
   *   path escapes the project root (D1). Write-time is the enforcement point:
   *   the write is the harm, regardless of whether any downstream verdict
   *   catches the mismatch afterwards.
   * - Edit/Write: when targetFiles is non-empty, require exact resolved-path
   *   equality with a declared target (D2). This closes the older loopholes
   *   where a substring/suffix match let out-of-tree paths through (e.g. a
   *   same-named directory in an unrelated project) and any path merely
   *   containing a target string was accepted.
   * - Edit/Write: if targetFiles specified and file exists on disk, require it
   *   to have been previously Read in this session (present in readFiles).
   *
   * Symlink handling (D3): path.resolve only — no fs.realpath. Adversarial
   * symlink escape is out of scope and tracked separately.
   *
   * When sessionCwd is not provided, the boundary check is skipped — no
   * default root is invented. targetFiles equality still applies with the
   * best-effort resolution described below.
   *
   * @param {string}  toolName    - SDK tool name
   * @param {object}  toolInput   - Tool input payload
   * @param {string[]} targetFiles - Allowed file paths (or undefined/null)
   * @param {Set}     readFiles   - Files already Read this session
   * @param {string=} sessionCwd  - Session cwd (absolute); enables D1 boundary
   * @returns {{ behavior: 'allow', updatedInput: object } | { behavior: 'deny', message: string }}
   */
  _guardToolUse(toolName, toolInput, targetFiles, readFiles = new Set(), sessionCwd = null) {
    // Guard Bash commands
    if (toolName === 'Bash') {
      const cmd = toolInput?.command || '';
      for (const pattern of SessionManager.DANGEROUS_BASH_PATTERNS) {
        if (pattern.test(cmd)) {
          return { behavior: 'deny', message: `Dangerous Bash command blocked: ${cmd}` };
        }
      }
    }

    // Guard Edit/Write
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = toolInput?.file_path || '';

      // Resolve the tool's file_path to an absolute path for boundary and
      // exact-match checks, then CANONICALIZE it (D3, revised 2026-08-12):
      // every comparison side below goes through _canonicalPath, which
      // realpath-resolves the longest existing prefix. A symlinked project
      // root (e.g. the `<name> -> <name>.nosync` iCloud-remediation alias)
      // gives the same file two absolute spellings; plain path.resolve
      // treats those as different trees, which made D1 false-deny in-root
      // writes on the guard's first live outing (archive 226).
      const abs = filePath
        ? this._canonicalPath(
            path.isAbsolute(filePath)
              ? path.resolve(filePath)
              : path.resolve(sessionCwd || process.cwd(), filePath)
          )
        : '';

      // D1: unconditional project-root boundary when sessionCwd is known.
      // Applies even with no targetFiles — an unscoped session may write
      // anywhere INSIDE the project, nowhere outside. The verification layer
      // catches the mismatch after the fact; this catches it before bytes
      // land on disk.
      if (sessionCwd && abs) {
        const root = this._canonicalPath(path.resolve(sessionCwd));
        const inRoot = abs === root || abs.startsWith(root + path.sep);
        if (!inRoot) {
          return {
            behavior: 'deny',
            message: `${toolName} blocked: ${abs} is outside the project root ${root} — all writes must stay within the project`,
          };
        }
      }

      // D2: declared-set membership by exact resolved-path equality. Legit
      // shapes (relative `auto/x.py`, `./auto/x.py`, absolute in-tree path)
      // still resolve-equal a declared targetFile. Kills both prior
      // loopholes: `endsWith` acceptance of out-of-tree suffix matches, and
      // `includes` acceptance of any path that merely contains the target
      // string. When sessionCwd is unknown we fall back to path.resolve(tf)
      // (absolute tf is unchanged; relative tf resolves against process.cwd()
      // — best-effort, since no root was declared).
      if (targetFiles && targetFiles.length > 0) {
        const rootForTf = sessionCwd ? path.resolve(sessionCwd) : null;
        const allowed = targetFiles.some((tf) => {
          if (typeof tf !== 'string') return false;
          const tfAbs = this._canonicalPath(rootForTf ? path.resolve(rootForTf, tf) : path.resolve(tf));
          return abs === tfAbs;
        });
        if (!allowed) {
          return {
            behavior: 'deny',
            message: `${toolName} blocked: ${filePath} is not in targetFiles`,
          };
        }
        // Require prior Read for existing files — prevents blind overwrites.
        // Compared on the CANONICAL path (see abs above): Read and Edit may
        // legitimately spell the same file through different root aliases.
        // Membership is checked canonical-vs-canonical, with a fallback scan
        // so entries seeded as raw absolute paths (the Set's original
        // contract, still pinned by test-session-manager-guard.js) keep
        // matching regardless of which spelling they used.
        if (fs.existsSync(abs) && !this._readFilesHas(readFiles, abs)) {
          return {
            behavior: 'deny',
            message: `${toolName} blocked: ${filePath} exists on disk but has not been Read in this session`,
          };
        }
      }
    }

    // SDK Zod schema requires updatedInput on allow branch (pass-through the
    // possibly-normalized input). Returning `{ behavior: 'allow' }` alone causes
    // ZodError: "expected record, received undefined" on every tool call.
    return { behavior: 'allow', updatedInput: toolInput };
  }

  /**
   * Spawn a new reusable (long-lived) session that can accept multiple
   * prompts. See ReusableSession for details. Used by the reusable
   * planner session.
   *
   * Options shape is identical to spawn(), EXCEPT prompt is omitted —
   * prompts are sent via the returned session's sendPrompt() method.
   *
   * @param {object} options - Session options (no `prompt` field)
   * @returns {ReusableSession}
   */
  spawnReusable(options) {
    return new ReusableSession(this, options);
  }

  /**
   * Kill a specific session.
   */
  kill(handle) {
    handle.kill();
  }

  /**
   * List active sessions.
   */
  active() {
    return Array.from(this._active.values());
  }
}

export { SessionManager, SessionHandle, ReusableSession, PromptStream, InfrastructureError, WallClockExceededError, CostCeilingExceededError, classifyError, classifyResult, RESULT_WATCHDOG_MS };
