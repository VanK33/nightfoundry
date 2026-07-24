import fs from 'fs';
import path from 'path';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';

const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function createTaskVerifyHandler({ projectRoot }) {
  return function taskVerifyHandler(req, res) {
    const harnessDir = activeHarnessDir(projectRoot);
    const id = req.params.id;

    // (b) Validate id against regex
    if (!TASK_ID_REGEX.test(id)) {
      return res.status(400).json({ error: 'invalid task id' });
    }

    // (c) Compute sidecar path and assert no path traversal
    const verificationDir = path.join(harnessDir, 'verification');
    const sidecarPath = path.join(verificationDir, `task-${id}.json`);
    const resolvedSidecar = path.resolve(sidecarPath);
    const resolvedVerificationDir = path.resolve(verificationDir) + path.sep;

    if (!resolvedSidecar.startsWith(resolvedVerificationDir)) {
      return res.status(400).json({ error: 'invalid task id' });
    }

    // (d) If file missing or JSON.parse throws, respond 404
    if (!fs.existsSync(sidecarPath)) {
      return res.status(404).json({ error: 'not yet verified', taskId: id });
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    } catch {
      return res.status(404).json({ error: 'not yet verified', taskId: id });
    }

    // (e) Respond 200 with only hardChecks and taskScopeChecks
    return res.status(200).json({
      hardChecks: data.hardChecks ?? [],
      taskScopeChecks: data.taskScopeChecks ?? [],
    });
  };
}

export default createTaskVerifyHandler;
