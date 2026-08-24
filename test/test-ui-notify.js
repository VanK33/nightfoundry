/**
 * test-ui-notify.js — Contract tests for the side-rail notification watcher.
 *
 * Covers:
 *   - detectTransitions: pure edge-detection logic (baseline, three edges,
 *     dedup on sustained-true, no-fire on ordinary progress change, multiple
 *     simultaneous edges).
 *   - startNotifyWatcher: injected getSnapshot/postWebhook driving exactly
 *     the expected webhook posts across a snapshot sequence, fail-soft
 *     behavior when getSnapshot throws or postWebhook rejects, and stop()
 *     halting further polling.
 *   - server.js wiring: source-string inspection (mirroring
 *     test-config-contract.js) asserting startup is guarded on
 *     config.ui.notifyWebhookUrl and the poll interval is
 *     config.ui.siderailPollMs.
 *
 * Run: node test/test-ui-notify.js
 */
import assert from 'assert';
import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { detectTransitions, startNotifyWatcher } from '../src/ui/notify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverSrc = readFileSync(
  resolve(__dirname, '../src/ui/server.js'),
  'utf8'
);

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const baseline = {
  active: true,
  progress: 1,
  pendingDecision: false,
  error: false,
  current: { description: 'Task A' },
};

// ── TC1: detectTransitions ────────────────────────────────────────────────

test('TC1a: baseline (prev null) returns no transitions', () => {
  const transitions = detectTransitions(null, baseline);
  assert.deepStrictEqual(transitions, []);
});

test('TC1a2: baseline (prev undefined) returns no transitions', () => {
  const transitions = detectTransitions(undefined, baseline);
  assert.deepStrictEqual(transitions, []);
});

test('TC1b: pendingDecision edge (false -> true) fires once', () => {
  const curr = { ...baseline, pendingDecision: true };
  const transitions = detectTransitions(baseline, curr);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].type, 'pendingDecision');
  assert.ok(transitions[0].message.includes('Decision needed'));
  // Next-step hint: the phone message must be actionable, not just informational.
  assert.ok(/(cc-orch|nightfoundry) park list/.test(transitions[0].message),
    'pendingDecision message must carry the park-list next-step hint');
});

test('TC1c: error edge (false -> true) fires once', () => {
  const curr = { ...baseline, error: true };
  const transitions = detectTransitions(baseline, curr);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].type, 'error');
  assert.ok(transitions[0].message.includes('Run hit an error'));
  assert.ok(/(cc-orch|nightfoundry) status/.test(transitions[0].message),
    'error message must carry the status next-step hint');
});

test('TC1d: complete edge (active true -> false) fires once', () => {
  const curr = { ...baseline, active: false };
  const transitions = detectTransitions(baseline, curr);
  assert.strictEqual(transitions.length, 1);
  assert.strictEqual(transitions[0].type, 'complete');
  assert.ok(transitions[0].message.includes('Run complete'));
  assert.ok(/(cc-orch|nightfoundry) archive list/.test(transitions[0].message),
    'complete message must carry the archive-list next-step hint');
});

test('TC1e: dedup — pendingDecision already true stays silent on next tick', () => {
  const alreadyTrue = { ...baseline, pendingDecision: true };
  const stillTrue = { ...baseline, pendingDecision: true, progress: 2 };
  const transitions = detectTransitions(alreadyTrue, stillTrue);
  assert.deepStrictEqual(transitions, []);
});

test('TC1e2: dedup — error already true stays silent on next tick', () => {
  const alreadyTrue = { ...baseline, error: true };
  const stillTrue = { ...baseline, error: true, progress: 2 };
  const transitions = detectTransitions(alreadyTrue, stillTrue);
  assert.deepStrictEqual(transitions, []);
});

test('TC1e3: dedup — complete (active false) already settled stays silent', () => {
  const alreadyDone = { ...baseline, active: false };
  const stillDone = { ...baseline, active: false, progress: 2 };
  const transitions = detectTransitions(alreadyDone, stillDone);
  assert.deepStrictEqual(transitions, []);
});

test('TC1f: no-fire on ordinary progress-count change alone', () => {
  const curr = { ...baseline, progress: 2 };
  const transitions = detectTransitions(baseline, curr);
  assert.deepStrictEqual(transitions, []);
});

test('TC1g: multiple simultaneous edges fire together', () => {
  const curr = { ...baseline, pendingDecision: true, error: true, active: false };
  const transitions = detectTransitions(baseline, curr);
  assert.strictEqual(transitions.length, 3);
  const types = transitions.map((t) => t.type).sort();
  assert.deepStrictEqual(types, ['complete', 'error', 'pendingDecision']);
});

// ── Helpers for watcher tests ─────────────────────────────────────────────

/**
 * Builds a getSnapshot() that walks through `snapshots` in order, one new
 * snapshot per call, then clamps to the last entry for any further calls
 * (so extra ticks after the sequence is exhausted are diffed against
 * themselves and never produce spurious transitions).
 */
function makeSequenceGetSnapshot(snapshots) {
  let idx = 0;
  let callCount = 0;
  const getSnapshot = async () => {
    callCount++;
    const snap = snapshots[Math.min(idx, snapshots.length - 1)];
    if (idx < snapshots.length - 1) idx++;
    return snap;
  };
  return { getSnapshot, getCallCount: () => callCount };
}

/** Replays detectTransitions over a sequence to compute expected messages. */
function expectedMessages(snapshots) {
  let prev = null;
  const messages = [];
  for (const snap of snapshots) {
    const transitions = detectTransitions(prev, snap);
    for (const t of transitions) messages.push(t.message);
    prev = snap;
  }
  return messages;
}

// ── TC2: startNotifyWatcher drives exactly one postWebhook per transition ──

await asyncTest(
  'TC2: watcher posts exactly the expected webhook messages across a snapshot sequence',
  async () => {
    const snap1 = { ...baseline }; // baseline, no transition
    const snap2 = { ...baseline, progress: 2 }; // ordinary progress change, no transition
    const snap3 = { ...baseline, progress: 2, pendingDecision: true }; // pendingDecision edge
    const snap4 = { ...baseline, progress: 2, pendingDecision: true, error: true }; // error edge (pd dedup'd)
    const snap5 = { ...baseline, progress: 2, pendingDecision: true, error: true, active: false }; // complete edge

    const sequence = [snap1, snap2, snap3, snap4, snap5];
    const expected = expectedMessages(sequence);
    assert.strictEqual(expected.length, 3, 'fixture sanity: expected 3 transitions total');

    const { getSnapshot } = makeSequenceGetSnapshot(sequence);
    const posted = [];
    const postWebhook = async (webhookUrl, message) => {
      posted.push(message);
    };

    const watcher = startNotifyWatcher({
      getSnapshot,
      webhookUrl: 'http://example.test/webhook',
      intervalMs: 5,
      postWebhook,
      log: () => {},
    });

    // Enough real time for the 5-entry sequence (and a comfortable margin of
    // extra ticks, which must be inert since the sequence clamps at the end).
    await wait(150);
    watcher.stop();

    assert.deepStrictEqual(posted, expected);
  }
);

// ── TC3: throwing getSnapshot is fail-soft ──────────────────────────────────

await asyncTest(
  'TC3: getSnapshot throwing is fail-soft — warns, preserves prev, no crash',
  async () => {
    const snap1 = { ...baseline }; // establishes baseline
    const snap2 = { ...baseline, pendingDecision: true }; // edge vs snap1

    let calls = 0;
    const getSnapshot = async () => {
      calls++;
      if (calls === 1) return snap1;
      if (calls === 2) throw new Error('transient snapshot failure');
      return snap2;
    };

    const logs = [];
    const posted = [];
    const postWebhook = async (webhookUrl, message) => {
      posted.push(message);
    };

    const watcher = startNotifyWatcher({
      getSnapshot,
      webhookUrl: 'http://example.test/webhook',
      intervalMs: 5,
      postWebhook,
      log: (msg) => logs.push(msg),
    });

    await wait(150);
    watcher.stop();

    // Warned about the failed getSnapshot call.
    assert.ok(
      logs.some((m) => /getSnapshot failed/.test(m)),
      `expected a getSnapshot-failure log, got: ${JSON.stringify(logs)}`
    );

    // prev was preserved across the throwing tick: the pendingDecision edge
    // is still detected against snap1 (not lost / not diffed against
    // undefined), and fires exactly once (dedup on subsequent clamped ticks).
    assert.strictEqual(posted.length, 1);
    assert.ok(posted[0].includes('Decision needed'));
  }
);

// ── TC4: rejecting postWebhook is caught fail-soft ──────────────────────────

await asyncTest(
  'TC4: rejecting postWebhook is caught fail-soft and the loop continues',
  async () => {
    const snap1 = { ...baseline };
    const snap2 = { ...baseline, pendingDecision: true }; // transition 1 (pendingDecision)
    const snap3 = { ...baseline, pendingDecision: true, error: true }; // transition 2 (error)

    const { getSnapshot } = makeSequenceGetSnapshot([snap1, snap2, snap3]);

    const logs = [];
    const postCalls = [];
    let call = 0;
    const postWebhook = async (webhookUrl, message) => {
      call++;
      postCalls.push(message);
      if (call === 1) {
        throw new Error('webhook unreachable');
      }
      // second and further calls resolve fine
    };

    const watcher = startNotifyWatcher({
      getSnapshot,
      webhookUrl: 'http://example.test/webhook',
      intervalMs: 5,
      postWebhook,
      log: (msg) => logs.push(msg),
    });

    await wait(150);
    watcher.stop();

    // Both transitions were attempted despite the first postWebhook rejecting.
    assert.strictEqual(postCalls.length, 2);
    assert.ok(postCalls[0].includes('Decision needed'));
    assert.ok(postCalls[1].includes('Run hit an error'));

    // The rejection was caught and logged, not thrown (test reaching here
    // without an uncaught exception is itself part of the assertion).
    assert.ok(
      logs.some((m) => /postWebhook failed/.test(m)),
      `expected a postWebhook-failure log, got: ${JSON.stringify(logs)}`
    );
  }
);

// ── TC5: stop() halts further polling ───────────────────────────────────────

await asyncTest('TC5: stop() halts further polling', async () => {
  const { getSnapshot, getCallCount } = makeSequenceGetSnapshot([baseline]);

  const watcher = startNotifyWatcher({
    getSnapshot,
    webhookUrl: 'http://example.test/webhook',
    intervalMs: 5,
    postWebhook: async () => {},
    log: () => {},
  });

  await wait(60); // allow several ticks to occur
  const callsBeforeStop = getCallCount();
  assert.ok(callsBeforeStop > 0, 'expected at least one poll before stop()');

  watcher.stop();
  await wait(80); // would allow several more ticks if polling continued

  const callsAfterStop = getCallCount();
  assert.strictEqual(
    callsAfterStop,
    callsBeforeStop,
    'getSnapshot must not be called again after stop()'
  );
});

// ── TC6: server.js wiring guard (source-string inspection) ────────────────

test('TC6: server.js guards startup on config.ui.notifyWebhookUrl', () => {
  assert.ok(
    serverSrc.includes('config.ui?.notifyWebhookUrl') ||
      serverSrc.includes('config.ui.notifyWebhookUrl'),
    'server.js must guard the watcher startup on config.ui.notifyWebhookUrl'
  );
});

test('TC6: server.js passes config.ui.siderailPollMs as the poll interval', () => {
  assert.ok(
    serverSrc.includes('config.ui.siderailPollMs'),
    'server.js must reference config.ui.siderailPollMs for the poll interval'
  );
});

test('TC6: startNotifyWatcher is invoked inside the notifyWebhookUrl guard block', () => {
  const guardIdx = serverSrc.indexOf('notifyWebhookUrl');
  const watcherIdx = serverSrc.indexOf('startNotifyWatcher(', guardIdx);
  assert.ok(guardIdx !== -1, 'notifyWebhookUrl guard not found in server.js');
  assert.ok(
    watcherIdx !== -1 && watcherIdx > guardIdx,
    'startNotifyWatcher(...) call must appear after the notifyWebhookUrl guard check'
  );
});

test('TC6: startNotifyWatcher call wires intervalMs to config.ui.siderailPollMs', () => {
  const watcherIdx = serverSrc.indexOf('startNotifyWatcher(');
  assert.ok(watcherIdx !== -1, 'startNotifyWatcher(...) call not found in server.js');
  const closeIdx = serverSrc.indexOf('});', watcherIdx);
  const callBlock = serverSrc.slice(watcherIdx, closeIdx === -1 ? undefined : closeIdx);
  assert.ok(
    callBlock.includes('intervalMs: config.ui.siderailPollMs'),
    'startNotifyWatcher(...) call must set intervalMs: config.ui.siderailPollMs'
  );
});

// ── Real stubbed webhook receiver tests ────────────────────────────────────
//
// The tests above drive startNotifyWatcher with an injected postWebhook
// mock. The tests in this section stand up a real http.createServer (on an
// OS-assigned port, i.e. port 0) that records each POST it receives
// (method + parsed JSON body), and pass its URL as `webhookUrl` with NO
// `postWebhook` override — so the watcher's real `defaultPostWebhook` (which
// uses the global `fetch`) actually performs the HTTP POST against this
// receiver. This exercises the full request/response path end-to-end,
// including fail-soft behavior against an unreachable endpoint.

/**
 * Starts a stub HTTP receiver on an OS-assigned port that records every
 * POST it receives as `{ method, body }` (body JSON-parsed if possible).
 * @returns {Promise<{ server: http.Server, posts: Array, url: string }>}
 */
function createReceiver() {
  return new Promise((resolvePromise) => {
    const posts = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        posts.push({ method: req.method, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        server,
        posts,
        url: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

// ── TC1(real): exactly one POST per qualifying transition, expected message ─

await asyncTest(
  'TC1(real): receiver records exactly one POST per qualifying transition with the expected message',
  async () => {
    const { server, posts, url } = await createReceiver();
    try {
      const snap1 = { ...baseline }; // baseline, no transition
      const snap2 = { ...baseline, progress: 2 }; // ordinary progress change, no transition
      const snap3 = { ...baseline, progress: 2, pendingDecision: true }; // pendingDecision edge
      const snap4 = { ...baseline, progress: 2, pendingDecision: true, error: true }; // error edge
      const snap5 = {
        ...baseline,
        progress: 2,
        pendingDecision: true,
        error: true,
        active: false,
      }; // complete edge

      const sequence = [snap1, snap2, snap3, snap4, snap5];
      const expected = expectedMessages(sequence);
      assert.strictEqual(expected.length, 3, 'fixture sanity: expected 3 transitions total');

      const { getSnapshot } = makeSequenceGetSnapshot(sequence);

      const watcher = startNotifyWatcher({
        getSnapshot,
        webhookUrl: url,
        // A comparatively large interval relative to a real (loopback) HTTP
        // round-trip ensures each tick's fetch() settles well before the
        // next tick fires, keeping `prev` update ordering deterministic.
        intervalMs: 100,
        log: () => {},
      });

      await wait(700);
      watcher.stop();

      assert.strictEqual(posts.length, 3, `expected exactly 3 POSTs, got ${posts.length}`);
      assert.deepStrictEqual(
        posts.map((p) => p.method),
        ['POST', 'POST', 'POST']
      );
      assert.deepStrictEqual(
        posts.map((p) => p.body && p.body.message),
        expected
      );
    } finally {
      server.close();
    }
  }
);

// ── TC2(real): no POST for ordinary progress-only change ───────────────────

await asyncTest(
  'TC2(real): no POST is sent to the receiver for ordinary progress-only changes',
  async () => {
    const { server, posts, url } = await createReceiver();
    try {
      const snap1 = { ...baseline };
      const snap2 = { ...baseline, progress: 2 };
      const snap3 = { ...baseline, progress: 3 };

      const { getSnapshot } = makeSequenceGetSnapshot([snap1, snap2, snap3]);

      const watcher = startNotifyWatcher({
        getSnapshot,
        webhookUrl: url,
        intervalMs: 100,
        log: () => {},
      });

      await wait(450);
      watcher.stop();

      assert.strictEqual(
        posts.length,
        0,
        `expected no POSTs for progress-only changes, got ${posts.length}`
      );
    } finally {
      server.close();
    }
  }
);

// ── TC3(real): dedup — no duplicate POST while a flag stays true ───────────

await asyncTest(
  'TC3(real): no duplicate POST is sent while a flag remains true across ticks',
  async () => {
    const { server, posts, url } = await createReceiver();
    try {
      const snap1 = { ...baseline };
      const snap2 = { ...baseline, pendingDecision: true }; // edge -> 1 POST
      const snap3 = { ...baseline, pendingDecision: true, progress: 5 }; // sustained true
      const snap4 = { ...baseline, pendingDecision: true, progress: 9 }; // sustained true

      const { getSnapshot } = makeSequenceGetSnapshot([snap1, snap2, snap3, snap4]);

      const watcher = startNotifyWatcher({
        getSnapshot,
        webhookUrl: url,
        intervalMs: 100,
        log: () => {},
      });

      await wait(550);
      watcher.stop();

      assert.strictEqual(
        posts.length,
        1,
        `expected exactly 1 POST (dedup on sustained-true), got ${posts.length}`
      );
      assert.ok(posts[0].body && posts[0].body.message.includes('Decision needed'));
    } finally {
      server.close();
    }
  }
);

// ── TC4(real): unreachable webhook is fail-soft ─────────────────────────────

await asyncTest(
  'TC4(real): unreachable webhook logs a warning, never throws/crashes, and polling continues',
  async () => {
    // Stand up a receiver, grab its (now-closed) URL, then close it so the
    // port is unreachable/refused for the duration of the test.
    const { server, url } = await createReceiver();
    await new Promise((resolvePromise) => server.close(resolvePromise));

    const snap1 = { ...baseline }; // baseline
    const snap2 = { ...baseline, pendingDecision: true }; // edge vs snap1 -> attempted POST

    let calls = 0;
    const getSnapshot = async () => {
      calls++;
      return calls === 1 ? snap1 : snap2;
    };

    const logs = [];
    const watcher = startNotifyWatcher({
      getSnapshot,
      webhookUrl: url, // unreachable: server closed
      intervalMs: 10,
      log: (msg) => logs.push(msg),
    });

    // Reaching past this await without an uncaught exception/rejection is
    // itself part of the "never throws/crashes" assertion.
    await wait(200);
    watcher.stop();

    assert.ok(
      calls >= 2,
      `expected polling to continue across multiple ticks despite the unreachable webhook, got ${calls} calls`
    );
    assert.ok(
      logs.some((m) => /notify: webhook POST to .* failed/.test(m)),
      `expected a webhook-failure warning to be logged, got: ${JSON.stringify(logs)}`
    );
  }
);

// ── TC5(real): stop() halts polling; receiver closed in cleanup ────────────

await asyncTest(
  'TC5(real): stop() halts polling against the real receiver, and the receiver is closed in cleanup',
  async () => {
    const { server, posts, url } = await createReceiver();
    try {
      const snap = { ...baseline, pendingDecision: true };
      let calls = 0;
      const getSnapshot = async () => {
        calls++;
        return snap;
      };

      const watcher = startNotifyWatcher({
        getSnapshot,
        webhookUrl: url,
        intervalMs: 10,
        log: () => {},
      });

      await wait(80); // allow several ticks to occur
      const callsBeforeStop = calls;
      assert.ok(callsBeforeStop > 0, 'expected at least one poll before stop()');

      watcher.stop();
      await wait(120); // would allow several more ticks if polling continued

      assert.strictEqual(
        calls,
        callsBeforeStop,
        'getSnapshot must not be called again after stop()'
      );
      // First tick establishes baseline (prev null -> no transition); no
      // further ticks change the snapshot, so no POST should ever fire.
      assert.strictEqual(posts.length, 0, 'expected no POSTs in this fixture');
    } finally {
      // Receiver closed in cleanup, per test contract.
      server.close();
    }
  }
);

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
