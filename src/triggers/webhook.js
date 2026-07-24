#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { Pipeline } from '../orchestrator/core/pipeline.js';
import { TokenTracker } from '../orchestrator/infra/token-tracker.js';
import { readState } from '../orchestrator/core/state.js';
import { loadProjectConfig } from '../orchestrator/infra/project-config.js';
import { runBaselineGate } from '../orchestrator/gates/baseline.js';
import {
  generateRunId,
  claimActiveRun,
  readActiveRunPointer,
  clearActiveRunPointer,
  resolveActiveHarnessDir,
  activeHarnessDir,
} from '../orchestrator/core/run-context.js';

const PORT = parseInt(process.env.PORT || '8743', 10);
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

function defaultCreatePipeline(root, opts) {
  const pipeline = new Pipeline(root, opts);
  pipeline.autoFromHere = true;
  return pipeline;
}

export function buildWebhookApp({ projectRoot, createPipeline = defaultCreatePipeline, baselineGate = runBaselineGate }) {
  loadProjectConfig(projectRoot);

  const app = express();
  app.use(express.json());

  const running = new Map();

  function summarizeState() {
    const harnessDir = activeHarnessDir(projectRoot);
    if (!fs.existsSync(path.join(harnessDir, 'state.json'))) {
      return { ok: false, error: 'No .harness/state.json found' };
    }
    try {
      const state = readState(harnessDir);
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  app.post('/run', async (req, res) => {
    const { goal, prdPath } = req.body;
    if (!goal && !prdPath) {
      return res.status(400).json({ error: 'Provide goal or prdPath' });
    }

    // Synchronous claim prefix: derive a slug (from prdPath's basename minus
    // extension, falling back to a goal-derived slug when there is no
    // prdPath), generate a runId, and atomically claim the active-run
    // pointer BEFORE any pipeline is constructed. This mirrors Pipeline#run's
    // own claim/refuse decision (see core/pipeline.js) but responds over HTTP
    // instead of throwing/logging.
    const slug = prdPath ? path.basename(prdPath).replace(/\.[^.]+$/, '') : goal;
    const runId = generateRunId(slug);
    const claimed = claimActiveRun(projectRoot, { runId, slug, kind: 'run' });

    if (!claimed) {
      const activeRun = readActiveRunPointer(projectRoot);
      return res.status(409).json({ error: 'Another run is already active', activeRun });
    }

    const logs = [];

    res.status(200).json({ runId, status: 'started' });

    running.set(runId, { status: 'running', logs, startedAt: new Date().toISOString() });

    const result = await baselineGate(projectRoot);

    if (!result.ok) {
      const entry = running.get(runId);
      if (entry) {
        entry.status = 'failed';
        entry.error = result.message;
      }
      // Claim hygiene: only clear the active-run pointer when the run dir
      // cannot be validated (resolveActiveHarnessDir returns null). When a
      // valid run dir resolves, leave the pointer intact.
      if (resolveActiveHarnessDir(projectRoot) === null) {
        clearActiveRunPointer(projectRoot);
      }
      return;
    }

    const pipeline = createPipeline(projectRoot, {
      onLog: (msg) => logs.push({ ts: new Date().toISOString(), msg }),
      onConfirm: async () => true,
    });

    pipeline.run(goal || `Implement spec at ${prdPath}`, { prdPath, preclaimedRun: { runId, slug, kind: 'run' } })
      .then(() => {
        const entry = running.get(runId);
        if (entry) entry.status = 'complete';
      })
      .catch((err) => {
        const entry = running.get(runId);
        if (entry) {
          entry.status = 'failed';
          entry.error = err.message;
        }
        // Claim hygiene: only clear the active-run pointer when the run dir
        // cannot be validated (resolveActiveHarnessDir returns null). When a
        // valid run dir resolves, leave the pointer intact.
        if (resolveActiveHarnessDir(projectRoot) === null) {
          clearActiveRunPointer(projectRoot);
        }
      });
  });

  app.post('/task', async (req, res) => {
    const { taskId, action } = req.body;
    if (!taskId || !action) {
      return res.status(400).json({ error: 'Provide taskId and action' });
    }

    switch (action) {
      case 'status': {
        const result = summarizeState();
        return res.json(result);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  });

  app.get('/status', (req, res) => {
    res.json(summarizeState());
  });

  app.get('/usage', (req, res) => {
    const harnessDir = activeHarnessDir(projectRoot);
    const tracker = new TokenTracker(harnessDir);
    res.json(tracker.summary());
  });

  app.get('/runs', (req, res) => {
    const runs = [];
    for (const [id, info] of running) {
      runs.push({ id, status: info.status, startedAt: info.startedAt, error: info.error });
    }
    res.json(runs);
  });

  app.get('/runs/:id/logs', (req, res) => {
    const entry = running.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Run not found' });
    res.json({ status: entry.status, logs: entry.logs, error: entry.error });
  });

  return app;
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('/webhook.js') ||
  process.argv[1].endsWith('\\webhook.js')
);

if (isMain) {
  const app = buildWebhookApp({ projectRoot: PROJECT_ROOT, createPipeline: defaultCreatePipeline });
  app.listen(PORT, () => {
    console.log(`nightfoundry webhook server listening on port ${PORT}`);
    console.log(`Project root: ${PROJECT_ROOT}`);
  });
}
