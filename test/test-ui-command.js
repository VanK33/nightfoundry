/**
 * test-ui-command.js — Unit tests for src/cli/commands/ui.js
 *
 * Uses http.createServer stubbing to avoid any real port binding.
 * Run: node test/test-ui-command.js
 */
import assert from 'assert';
import http from 'http';
import { EventEmitter } from 'events';
import { once } from 'events';
import { ui } from '../src/cli/commands/ui.js';

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
    failCount++;
  }
}

// ---------- Mock HTTP server (no real port binding) ----------

/**
 * Creates a fake http.Server (EventEmitter-based) that emits 'listening'
 * asynchronously and tracks whether close() was called.
 */
function createMockHttpServer() {
  const server = new EventEmitter();
  server.closeCalled = false;

  server.listen = function (..._args) {
    // Simulate async bind — emit 'listening' on next iteration
    setImmediate(() => this.emit('listening'));
    return this;
  };

  server.close = function (cb) {
    this.closeCalled = true;
    setImmediate(() => {
      this.emit('close');
      if (typeof cb === 'function') cb();
    });
  };

  server.address = () => ({ port: 0, family: 'IPv4', address: '127.0.0.1' });

  return server;
}

/**
 * Patches http.createServer to return a mock server for the duration of fn.
 * Passes a getter `getServer()` to fn so callers can retrieve the mock after
 * ui() has created it internally.
 */
async function withMockHttpServer(fn) {
  const origCreateServer = http.createServer;
  let mockServer;

  http.createServer = (..._args) => {
    mockServer = createMockHttpServer();
    return mockServer;
  };

  try {
    await fn(() => mockServer);
  } finally {
    http.createServer = origCreateServer;
  }
}

// ---------- stdout / console.log capture ----------

async function captureLog(fn) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...args) => chunks.push(args.join(' ') + '\n');
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return chunks.join('');
}

// ---------- Tests ----------

// TC1: flags.port takes precedence over process.env.PORT
await test('TC1: flags.port=5000 overrides env PORT=6000 — banner contains :5000', async () => {
  const savedPort = process.env.PORT;
  const savedExit = process.exit;
  process.env.PORT = '6000';
  process.exit = () => {};

  try {
    await withMockHttpServer(async (getServer) => {
      const output = await captureLog(async () => {
        await ui('/fake/root', { port: '5000' });
      });

      const mockServer = getServer();

      try {
        assert.ok(
          output.includes(':5000'),
          `Expected banner to contain ':5000', got: ${output.trim()}`
        );
      } finally {
        // Clean up the SIGINT handler and mock server
        const closePromise = once(mockServer, 'close');
        process.emit('SIGINT');
        await closePromise;
      }
    });
  } finally {
    process.exit = savedExit;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});

// TC2: process.env.PORT fallback when no flags.port
await test('TC2: no flags.port, env PORT=6000 — banner contains :6000', async () => {
  const savedPort = process.env.PORT;
  const savedExit = process.exit;
  process.env.PORT = '6000';
  process.exit = () => {};

  try {
    await withMockHttpServer(async (getServer) => {
      const output = await captureLog(async () => {
        await ui('/fake/root', {});
      });

      const mockServer = getServer();

      try {
        assert.ok(
          output.includes(':6000'),
          `Expected banner to contain ':6000', got: ${output.trim()}`
        );
      } finally {
        const closePromise = once(mockServer, 'close');
        process.emit('SIGINT');
        await closePromise;
      }
    });
  } finally {
    process.exit = savedExit;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});

// TC3: hardcoded default 3939 when neither flags.port nor env PORT is set
await test('TC3: no flags.port, no env PORT — banner contains :3939', async () => {
  const savedPort = process.env.PORT;
  const savedExit = process.exit;
  delete process.env.PORT;
  process.exit = () => {};

  try {
    await withMockHttpServer(async (getServer) => {
      const output = await captureLog(async () => {
        await ui('/fake/root', {});
      });

      const mockServer = getServer();

      try {
        assert.ok(
          output.includes(':3939'),
          `Expected banner to contain ':3939', got: ${output.trim()}`
        );
      } finally {
        const closePromise = once(mockServer, 'close');
        process.emit('SIGINT');
        await closePromise;
      }
    });
  } finally {
    process.exit = savedExit;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});

// TC4: SIGINT handler calls server.close() — verified via 'close' event, process.exit stubbed
await test('TC4: SIGINT triggers server.close() verified by close event (process.exit stubbed)', async () => {
  const savedPort = process.env.PORT;
  const savedExit = process.exit;
  delete process.env.PORT;

  try {
    await withMockHttpServer(async (getServer) => {
      // Suppress banner output
      const origLog = console.log;
      console.log = () => {};
      await ui('/fake/root', {});
      console.log = origLog;

      const mockServer = getServer();

      // Stub process.exit AFTER ui() resolves but BEFORE emitting SIGINT
      let exitCode = null;
      process.exit = (code) => {
        exitCode = code;
      };

      // Register 'close' listener BEFORE emitting SIGINT so we don't miss it
      const closePromise = once(mockServer, 'close');

      process.emit('SIGINT');

      // Wait for server to emit 'close' (fired by mock before process.exit callback)
      await closePromise;

      assert.ok(mockServer.closeCalled, 'Expected server.close() to have been called');
      assert.strictEqual(
        exitCode,
        0,
        `Expected process.exit(0) to be called, got process.exit(${exitCode})`
      );
    });
  } finally {
    process.exit = savedExit;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
