/**
 * mutex.js — Minimal async mutex primitive for nightfoundry.
 *
 * Pure JS promise-based mutex. Serves as the serialization primitive
 * for Phase I items 4+5 (parallel task execution): the scheduler's
 * worker pool runs multiple agent sessions concurrently, but every
 * shared writer — state-machine transitions, TokenTracker.save,
 * Logger.writeSessionSummary, coverage.mergeRemediationTasks — must be
 * serialized through one of these mutexes to prevent the load-modify-
 * write races documented in docs/audit/phase-1-concurrency-writer-audit.md.
 *
 * Design properties:
 *   - FIFO: waiters acquire in the order they called acquire().
 *   - Release-per-acquisition: acquire() resolves to a release() function
 *     scoped to THAT acquisition, so a stale release from a prior holder
 *     is a no-op instead of corrupting whoever currently holds the lock.
 *   - Idempotent release: calling the same release() twice is a safe no-op.
 *   - Non-reentrant: calling acquire() while already holding the lock
 *     deadlocks. The caller must not do this. We do not build recursive
 *     locking because our use cases are narrow critical sections around
 *     filesystem writes; reentrancy would add complexity we do not need.
 *   - No cancellation: a waiter cannot abandon its place in the queue.
 *     If you await acquire() and then decide you don't want the lock,
 *     tough — you will still be granted it and must release it.
 *     Cancellation is a non-goal for the same reason as reentrancy.
 *
 * Usage:
 *   const lock = createMutex();
 *   const release = await lock.acquire();
 *   try {
 *     // ... critical section: load, mutate, atomic-write ...
 *   } finally {
 *     release();
 *   }
 *
 * Public API:
 *   createMutex() → { acquire(): Promise<() => void> }
 *   createMutexRegistry() → { for(key): Mutex }
 */

/**
 * Create a new async mutex.
 * @returns {{ acquire: () => Promise<() => void> }}
 */
export function createMutex() {
  let locked = false;
  /** @type {Array<() => void>} */
  const waiters = [];

  function acquire() {
    return new Promise((resolve) => {
      const grant = () => {
        locked = true;
        let released = false;
        const release = () => {
          // Double-release is a safe no-op. A well-behaved caller using
          // try/finally will only call release() once per acquisition;
          // this guard exists so a buggy caller that calls a stale
          // release() twice does not steal the lock from whoever
          // currently holds it.
          if (released) return;
          released = true;
          locked = false;
          const next = waiters.shift();
          if (next) next();
        };
        resolve(release);
      };

      if (!locked) {
        grant();
      } else {
        waiters.push(grant);
      }
    });
  }

  return { acquire };
}

/**
 * Create a registry of mutexes keyed by an arbitrary string key.
 * Lazily creates a new mutex on first access for each key. Intended
 * for per-file mutexes where the set of files is not known up front
 * (e.g., per-mission-state-file mutex keyed on the absolute file path).
 *
 * Registry lifetime matches whatever owns it (typically a Pipeline
 * instance or the state-machine module). Entries are never evicted —
 * the number of distinct mission files in a single run is bounded by
 * the plan size, so unbounded growth is not a concern in practice.
 *
 * @returns {{ for: (key: string) => { acquire: () => Promise<() => void> } }}
 */
export function createMutexRegistry() {
  const mutexes = new Map();
  return {
    for(key) {
      let mutex = mutexes.get(key);
      if (!mutex) {
        mutex = createMutex();
        mutexes.set(key, mutex);
      }
      return mutex;
    },
  };
}
