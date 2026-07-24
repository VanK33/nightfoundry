/**
 * test-mutex.js — Unit tests for src/orchestrator/infra/mutex.js.
 *
 * Covers the Phase I items 4+5 mutex primitive contract: FIFO ordering,
 * release-per-acquisition, idempotent release, stale-release isolation,
 * non-reentrant deadlock (documented behavior), contention stress, and
 * the mutex registry's per-key isolation. See docs/design/phase-1-
 * parallel-execution.md §3.2 for the design rationale.
 *
 * Run: node test/test-mutex.js
 */
import assert from 'assert';
import { createMutex, createMutexRegistry } from '../src/orchestrator/infra/mutex.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Helpers ──

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Race a promise against a timeout. Used to assert whether a promise
// resolves within a bounded window (ok: true) or is still pending
// after the window elapses (ok: false — used to detect "still blocked"
// without actually waiting forever).
function withTimeout(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ ok: true, value })),
    sleep(ms).then(() => ({ ok: false })),
  ]);
}

async function run() {
  // ── Basic acquire/release ──

  await test('acquire resolves to a release function', async () => {
    const lock = createMutex();
    const release = await lock.acquire();
    assert.strictEqual(typeof release, 'function', 'acquire should resolve to a release function');
    release();
  });

  await test('single acquire/release with no waiters, then re-acquire', async () => {
    const lock = createMutex();
    const release = await lock.acquire();
    release();
    // Second acquire must succeed immediately — no lingering locked state
    const release2 = await lock.acquire();
    release2();
  });

  // ── FIFO ordering ──

  await test('three waiters acquire in FIFO order after holder releases', async () => {
    const lock = createMutex();
    const order = [];

    const release0 = await lock.acquire();

    const p1 = (async () => {
      const r = await lock.acquire();
      order.push('A');
      r();
    })();
    const p2 = (async () => {
      const r = await lock.acquire();
      order.push('B');
      r();
    })();
    const p3 = (async () => {
      const r = await lock.acquire();
      order.push('C');
      r();
    })();

    // Let all three queue up before releasing
    await sleep(10);
    assert.deepStrictEqual(order, [], 'no waiter should have acquired while holder is active');

    release0();
    await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, ['A', 'B', 'C'], 'waiters should acquire in FIFO order');
  });

  // ── Release-on-throw via try/finally ──

  await test('try/finally release pattern handles thrown errors in critical section', async () => {
    const lock = createMutex();
    let caught = null;

    try {
      const release = await lock.acquire();
      try {
        throw new Error('boom');
      } finally {
        release();
      }
    } catch (err) {
      caught = err;
    }

    assert.strictEqual(caught?.message, 'boom', 'error should propagate out of the critical section');

    // Lock should be free — the next acquire must succeed immediately
    const timed = await withTimeout(lock.acquire(), 100);
    assert.strictEqual(timed.ok, true, 'lock should be free after throw + finally release');
    timed.value();
  });

  // ── Idempotent release ──

  await test('double release on the same acquisition is a safe no-op', async () => {
    const lock = createMutex();
    const release = await lock.acquire();
    release();
    release(); // must not throw or corrupt internal state

    // Lock must still be acquirable
    const release2 = await lock.acquire();
    release2();
  });

  await test('stale release from a prior holder does not unlock the current holder', async () => {
    // This is the test that justifies per-acquisition release functions:
    // a buggy caller that keeps a reference to an old release() and
    // calls it again must not interfere with whoever currently holds
    // the lock. Without release-per-acquisition, calling an old release
    // would unlock the active holder's critical section.
    const lock = createMutex();
    const release1 = await lock.acquire();
    release1();

    const release2 = await lock.acquire();
    // Fire the stale release. It should no-op because release1 already
    // marked its own 'released' flag on first call.
    release1();

    // A third acquirer must still be blocked by release2 — the stale
    // release1 call above must not have unlocked anything.
    const pending = lock.acquire();
    const stillBlocked = await withTimeout(pending, 50);
    assert.strictEqual(stillBlocked.ok, false, 'third acquirer should still be blocked by release2');

    release2();
    // Now the third acquirer proceeds
    const release3 = await pending;
    release3();
  });

  // ── Contention stress ──

  await test('10 concurrent acquirers all complete with FIFO ordering', async () => {
    const lock = createMutex();
    const order = [];
    const tasks = [];

    for (let i = 0; i < 10; i++) {
      tasks.push((async () => {
        const release = await lock.acquire();
        order.push(i);
        // Simulate a tiny amount of work inside the critical section
        await sleep(1);
        release();
      })());
    }

    await Promise.all(tasks);
    assert.strictEqual(order.length, 10, 'all 10 tasks should complete');
    assert.deepStrictEqual(
      order,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      'tasks should acquire in FIFO order under contention'
    );
  });

  await test('holder blocks new acquirers until released (no premature grant)', async () => {
    const lock = createMutex();
    const release = await lock.acquire();

    const pending = lock.acquire();
    const stillBlocked = await withTimeout(pending, 50);
    assert.strictEqual(stillBlocked.ok, false, 'second acquirer must block while first holds');

    release();
    const r2 = await pending;
    assert.strictEqual(typeof r2, 'function', 'pending acquirer should resolve after release');
    r2();
  });

  // ── Non-reentrant (documented behavior) ──

  await test('non-reentrant: acquiring while already holding deadlocks (documented)', async () => {
    const lock = createMutex();
    const release1 = await lock.acquire();

    // Attempting to acquire again from the same "owner" must not resolve
    // because release1 has not been called. This confirms the documented
    // non-reentrant behavior — callers are responsible for not double-
    // acquiring from the same critical section.
    const timed = await withTimeout(lock.acquire(), 50);
    assert.strictEqual(timed.ok, false, 'recursive acquire must deadlock (documented)');

    // Release the outer lock so the abandoned second acquire eventually
    // resolves and the test process can exit cleanly.
    release1();
  });

  // ── Mutex registry ──

  await test('registry returns the same mutex instance for the same key', async () => {
    const reg = createMutexRegistry();
    const lockA1 = reg.for('file-a');
    const lockA2 = reg.for('file-a');
    assert.strictEqual(lockA1, lockA2, 'registry should return the same mutex for the same key');
  });

  await test('registry returns different mutex instances for different keys', async () => {
    const reg = createMutexRegistry();
    const lockA = reg.for('file-a');
    const lockB = reg.for('file-b');
    assert.notStrictEqual(lockA, lockB, 'registry should return different mutexes for different keys');
  });

  await test('registry isolates contention per key', async () => {
    const reg = createMutexRegistry();
    const releaseA1 = await reg.for('file-a').acquire();

    // Same key should block
    const sameKeyBlocked = await withTimeout(reg.for('file-a').acquire(), 50);
    assert.strictEqual(sameKeyBlocked.ok, false, 'same-key acquire should block while file-a is held');

    // Different key must NOT block — this is the whole point of keyed mutexes
    const differentKeyFree = await withTimeout(reg.for('file-b').acquire(), 50);
    assert.strictEqual(differentKeyFree.ok, true, 'different-key acquire should succeed while file-a is held');
    differentKeyFree.value();

    releaseA1();
  });

  await test('registry mutexes remain independent under concurrent contention', async () => {
    const reg = createMutexRegistry();
    const orderA = [];
    const orderB = [];

    // 5 waiters on file-a, 5 on file-b, all running concurrently
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      tasks.push((async () => {
        const r = await reg.for('file-a').acquire();
        orderA.push(i);
        await sleep(1);
        r();
      })());
      tasks.push((async () => {
        const r = await reg.for('file-b').acquire();
        orderB.push(i);
        await sleep(1);
        r();
      })());
    }

    await Promise.all(tasks);
    assert.deepStrictEqual(orderA, [0, 1, 2, 3, 4], 'file-a waiters should be FIFO');
    assert.deepStrictEqual(orderB, [0, 1, 2, 3, 4], 'file-b waiters should be FIFO');
  });

  // ── Summary ──

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
