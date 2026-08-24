/**
 * ui.js — Start the cc-orch web UI server.
 *
 * Port resolution precedence (first defined + finite value wins):
 *   1. flags.port  — CLI --port flag (highest priority)
 *   2. process.env.PORT — environment variable
 *   3. 3939        — hardcoded default (lowest priority)
 *
 * NaN values (e.g. unparseable strings) are treated as "not defined" and
 * the resolver falls through to the next candidate.
 *
 * The exported `ui` function returns a Promise that resolves once the HTTP
 * server emits 'listening'. It does NOT call process.exit on the success
 * path — callers (the CLI router) may await it freely.
 *
 * A one-shot SIGINT handler is installed after the server starts listening;
 * it calls server.close() then process.exit(0).
 */

import path from 'path';
import { displayName } from '../../orchestrator/infra/display-name.js';
import { once } from 'events';
import { createServer } from '../../ui/server.js';

/**
 * Resolve the listening port from flags, env, or the hardcoded default.
 *
 * @param {Record<string, unknown>} flags - CLI flags object (may have .port).
 * @returns {number} The resolved port number.
 */
function resolvePort(flags) {
  const candidates = [
    flags != null ? Number(flags.port) : NaN,
    Number(process.env.PORT),
    3939,
  ];

  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) {
      return candidate;
    }
  }

  // Fallback — should never reach here because 3939 is always finite.
  return 3939;
}

/**
 * Start the cc-orch web UI server.
 *
 * @param {string} projectRoot - Absolute path to the project root; the UI
 *   serves this root's .harness/ and archives/ (falls back to cwd).
 * @param {Record<string, unknown>} [flags={}] - CLI flags. Recognised keys:
 *   - port {string|number} — override the listening port.
 * @returns {Promise<void>} Resolves once the server is listening.
 */
export async function ui(projectRoot, flags = {}) {
  const port = resolvePort(flags);
  const root = projectRoot || process.cwd();

  const { listen } = createServer({
    projectRoot: root,
    archivesDir: path.join(root, 'archives'),
  });
  const server = listen(port);

  // Wait until the server is actually bound before printing the banner or
  // installing the SIGINT handler.
  await once(server, 'listening');

  console.log(`${displayName()} ui listening on http://localhost:${port}`);

  // One-shot SIGINT handler: close the server gracefully then exit.
  const onSigint = () => {
    process.removeListener('SIGINT', onSigint);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', onSigint);
}
