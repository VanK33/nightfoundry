import fs from 'fs';
import path from 'path';

/**
 * Creates an Express-style handler that lists all archives in archivesDir,
 * projecting manifest + state + token-usage into a summary object per archive.
 *
 * @param {{ archivesDir: string }} options
 * @returns {(req: object, res: object) => void}
 */
export function createArchivesListHandler({ archivesDir }) {
  return function archivesListHandler(_req, res) {
    // Read archivesDir — return [] on ENOENT or any other error (e.g. it's a file)
    let dirents;
    try {
      dirents = fs.readdirSync(archivesDir, { withFileTypes: true });
    } catch {
      return res.json({ archives: [] });
    }

    const archives = [];

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dirname = dirent.name;
      const archiveDir = path.join(archivesDir, dirname);

      // ── manifest.json ──────────────────────────────────────────────────────
      const manifestPath = path.join(archiveDir, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        archives.push({
          id: dirname,
          degraded: true,
          degradedReason: `malformed or missing manifest.json in ${dirname}: ${err.message}`,
        });
        continue;
      }
      if (!manifest || typeof manifest !== 'object') {
        archives.push({
          id: dirname,
          degraded: true,
          degradedReason: `manifest.json in ${dirname} is not an object`,
        });
        continue;
      }

      // ── root state.json ────────────────────────────────────────────────────
      const stateFilePath = path.join(archiveDir, 'state.json');
      let rootState = null;
      try {
        rootState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      } catch {
        rootState = null;
      }

      // ── logs/token-usage.json ──────────────────────────────────────────────
      const tokenUsagePath = path.join(archiveDir, 'logs', 'token-usage.json');
      let tokenUsage = null;
      try {
        tokenUsage = JSON.parse(fs.readFileSync(tokenUsagePath, 'utf8'));
      } catch {
        tokenUsage = null;
      }

      // ── totalTasks / verifiedTasks ─────────────────────────────────────────
      // Walk root state.milestones[].missions[] → mission-<id>.json → subMissions[].tasks[]
      let totalTasks = 0;
      let verifiedTasks = 0;

      if (rootState && typeof rootState === 'object') {
        const milestonesMap = rootState.milestones ?? {};
        for (const milestone of Object.values(milestonesMap)) {
          const missionsMap = milestone.missions ?? {};
          for (const mission of Object.values(missionsMap)) {
            const missionId = mission.id;
            const missionFilePath = path.join(
              archiveDir,
              'state',
              `mission-${missionId}.json`
            );
            let missionState = null;
            try {
              missionState = JSON.parse(fs.readFileSync(missionFilePath, 'utf8'));
            } catch {
              missionState = null;
            }

            if (missionState && typeof missionState === 'object') {
              const subMissionsMap = missionState.subMissions ?? {};
              for (const sm of Object.values(subMissionsMap)) {
                const tasksMap = sm.tasks ?? {};
                for (const task of Object.values(tasksMap)) {
                  // 'invalidated' tasks are replan husks — excluded from both counts
                  if (task.status === 'invalidated') continue;
                  totalTasks++;
                  // verifiedTasks counts the terminal status 'complete'; 'verified' is a
                  // transient in-flight state that persisted snapshots never show
                  if (task.status === 'complete') {
                    verifiedTasks++;
                  }
                }
              }
            }
          }
        }
      }

      // ── totalCostUsd ───────────────────────────────────────────────────────
      const totalCostUsd = tokenUsage?.totals?.totalCostUsd ?? manifest.totalCost ?? 0;

      // ── status aggregation from manifest.milestones[] ──────────────────────
      const manifestMilestones = Array.isArray(manifest.milestones)
        ? manifest.milestones
        : [];
      let status;
      if (manifestMilestones.length === 0) {
        status = 'pending';
      } else if (manifestMilestones.every((m) => m.status === 'complete')) {
        status = 'complete';
      } else if (manifestMilestones.some((m) => m.status === 'in_progress')) {
        status = 'in_progress';
      } else {
        status = 'pending';
      }

      archives.push({
        id: manifest.id,
        slug: manifest.name || manifest.seq || dirname,
        date: manifest.archivedAt || manifest.startedAt || null,
        totalCostUsd,
        totalTasks,
        verifiedTasks,
        status,
      });
    }

    // Sort by id (lexicographic — matches numeric prefix ordering e.g. 001 < 002)
    archives.sort((a, b) => String(a.id).localeCompare(String(b.id)));

    return res.json({ archives });
  };
}

/**
 * Creates an Express-style handler that returns full detail for a single archive.
 *
 * Matches by manifest.json id === req.params.id OR dirname === req.params.id.
 * All file reads use try/catch with null fallback — never throws.
 *
 * @param {{ archivesDir: string }} options
 * @returns {(req: object, res: object) => void}
 */
export function createArchiveDetailHandler({ archivesDir }) {
  return function archiveDetailHandler(req, res) {
    const targetId = req.params.id;

    // ── Locate the matching archive directory ──────────────────────────────
    let dirents;
    try {
      dirents = fs.readdirSync(archivesDir, { withFileTypes: true });
    } catch {
      dirents = [];
    }

    let matchedArchiveDir = null;
    let matchedId = null;

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dirname = dirent.name;
      const archiveDir = path.join(archivesDir, dirname);

      // Match by dirname first (fast path)
      if (dirname === targetId) {
        matchedArchiveDir = archiveDir;
        matchedId = dirname;
        break;
      }

      // Match by manifest.json id
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
      } catch {
        manifest = null;
      }
      if (manifest && manifest.id === targetId) {
        matchedArchiveDir = archiveDir;
        matchedId = manifest.id;
        break;
      }
    }

    if (!matchedArchiveDir) {
      return res.status(404).json({ error: 'archive not found' });
    }

    // ── Re-read manifest to get the canonical id ───────────────────────────
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(matchedArchiveDir, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    const id = (manifest && manifest.id) ? manifest.id : matchedId;

    // ── state.json ─────────────────────────────────────────────────────────
    let rootState = null;
    try {
      rootState = JSON.parse(fs.readFileSync(path.join(matchedArchiveDir, 'state.json'), 'utf8'));
    } catch {
      rootState = null;
    }

    // ── state/mission-*.json — aggregate into state ────────────────────────
    // Project subMissions into each mission in the milestones tree
    let state = rootState ? JSON.parse(JSON.stringify(rootState)) : null;

    if (state && typeof state === 'object') {
      const milestonesMap = state.milestones ?? {};
      for (const milestone of Object.values(milestonesMap)) {
        const missionsMap = milestone.missions ?? {};
        for (const mission of Object.values(missionsMap)) {
          const missionId = mission.id;
          let missionState = null;
          try {
            missionState = JSON.parse(
              fs.readFileSync(
                path.join(matchedArchiveDir, 'state', `mission-${missionId}.json`),
                'utf8'
              )
            );
          } catch {
            missionState = null;
          }
          if (missionState && typeof missionState === 'object') {
            mission.subMissions = missionState.subMissions ?? {};
          }
        }
      }
    }

    // ── logs/token-usage.json (cost) ───────────────────────────────────────
    const COST_DEFAULTS = {
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      totalCostUsd: 0,
      byType: {},
    };

    let cost = COST_DEFAULTS;
    try {
      const tokenUsage = JSON.parse(
        fs.readFileSync(path.join(matchedArchiveDir, 'logs', 'token-usage.json'), 'utf8')
      );
      if (tokenUsage && typeof tokenUsage === 'object') {
        const totals = tokenUsage.totals;
        if (totals && typeof totals === 'object') {
          cost = {
            sessionCount: totals.sessionCount ?? 0,
            inputTokens: totals.inputTokens ?? 0,
            outputTokens: totals.outputTokens ?? 0,
            cacheCreation: totals.cacheCreation ?? 0,
            cacheRead: totals.cacheRead ?? 0,
            totalCostUsd: totals.totalCostUsd ?? 0,
            byType: COST_DEFAULTS.byType,
          };
        }
      }
    } catch {
      cost = COST_DEFAULTS;
    }

    // ── spec.md ────────────────────────────────────────────────────────────
    let specMd = null;
    try {
      specMd = fs.readFileSync(path.join(matchedArchiveDir, 'spec.md'), 'utf8');
    } catch {
      specMd = null;
    }

    // ── verification/review-milestone-*.json → reviewerFindings ───────────
    // Per spec contract: null when no review files exist OR read fails;
    // array (possibly empty) when at least one review file was successfully read.
    let reviewerFindings = null;
    try {
      const verificationDir = path.join(matchedArchiveDir, 'verification');
      let verificationDirents;
      try {
        verificationDirents = fs.readdirSync(verificationDir);
      } catch {
        verificationDirents = [];
      }

      const reviewFiles = verificationDirents
        .filter((name) => /^review-milestone-.*\.json$/.test(name))
        .sort();

      for (const reviewFile of reviewFiles) {
        let reviewData = null;
        try {
          reviewData = JSON.parse(
            fs.readFileSync(path.join(verificationDir, reviewFile), 'utf8')
          );
        } catch {
          reviewData = null;
        }
        if (reviewData && Array.isArray(reviewData.findings)) {
          if (reviewerFindings === null) reviewerFindings = [];
          reviewerFindings = reviewerFindings.concat(reviewData.findings);
        }
      }
    } catch {
      reviewerFindings = null;
    }

    // ── report.html existence check ────────────────────────────────────────
    let runReportRelPath = null;
    try {
      if (fs.existsSync(path.join(matchedArchiveDir, 'report.html'))) {
        runReportRelPath = 'report.html';
      }
    } catch {
      runReportRelPath = null;
    }

    return res.json({ id, state, cost, specMd, reviewerFindings, runReportRelPath });
  };
}

export default createArchivesListHandler;
