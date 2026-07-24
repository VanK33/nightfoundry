/**
 * make-run.js — shared test helper.
 *
 * Mirrors the module-top marker-discipline guard used by
 * test/test-bootstrap-run-scoped.js: this helper is imported by tests that
 * spin up isolated fs.mkdtemp() fixture roots, not by a re-entrant cc-orch
 * invocation. But when the importing test file is launched from inside a
 * live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent process
 * environment and would trip assertNoReentrantLiveRun's guard on any fixture
 * root that carries an active state.json — a false positive on the
 * sanctioned mkdtemp pattern (see reentrancy-guard.js). Clear the marker
 * unconditionally here, before any process.env-sensitive imports, so this
 * module is re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import { generateRunId, claimActiveRun } from '../../src/orchestrator/core/run-context.js';
import { bootstrap } from '../../src/orchestrator/core/bootstrap.js';

/**
 * Creates a fully bootstrapped, run-scoped harness directory under the given
 * project root, optionally claiming the active-run pointer so that
 * resolveActiveHarnessDir(root)/activeHarnessDir(root) resolve to it.
 *
 * @param {string} root - absolute path to the project root (typically an
 *   isolated fs.mkdtemp() fixture directory).
 * @param {object} [opts]
 * @param {string} [opts.slug='test-run'] - slug fed to generateRunId; also
 *   recorded on the active-run pointer when claimed.
 * @param {string} [opts.kind='test'] - kind recorded on the active-run
 *   pointer when claimed.
 * @param {boolean} [opts.claim=true] - when true (the default), claims the
 *   active-run pointer for the generated runId. Pass false to bootstrap the
 *   run dir without writing the pointer.
 * @returns {{runId: string, harnessDir: string}}
 */
export function makeRun(root, { slug = 'test-run', kind = 'test', claim = true } = {}) {
  const runId = generateRunId(slug);
  const { harnessDir } = bootstrap(root, { runId });

  if (claim !== false) {
    claimActiveRun(root, { runId, slug, kind });
  }

  return { runId, harnessDir };
}
