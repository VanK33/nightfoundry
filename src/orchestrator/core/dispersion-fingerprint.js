/**
 * dispersion-fingerprint.js — L2 measurement sidecar.
 *
 * Computes plan + verifier + reviewer statistics from a finished run's
 * harness state and writes `.harness/dispersion-fingerprint.json`. Pure
 * post-hoc: reads only from disk state files, runs no SDK sessions, and
 * never mutates pipeline behavior. Safe to fail — wrap callers in
 * try/catch and treat any throw as advisory.
 *
 * Drives later L3 (`cc-orch dispersion <spec-slug>`) cross-run comparison.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const FINGERPRINT_VERSION = 1;
const REVIEWER_DESCRIPTION_HASH_PREFIX_LEN = 200;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function normalizeDescription(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/\(lines?\s+\d+(?:[-–]\d+)?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeReadJson(filePath, warnings) {
  try {
    if (!fs.existsSync(filePath)) {
      warnings.push(`missing: ${filePath}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    warnings.push(`malformed: ${filePath} (${e.message})`);
    return null;
  }
}

function stdDev(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function classifyDecomposition(tasksByMission) {
  if (!tasksByMission.length) return 'flat';
  const allOne = tasksByMission.every((c) => c === 1);
  if (allOne) return 'flat';
  const allMulti = tasksByMission.every((c) => c >= 2);
  if (allMulti) return 'grouped';
  return 'mixed';
}

function computeTargetFilesOverlap(missions) {
  const missionFiles = missions.map((m) => new Set(m.targetFiles || []));
  let pairsWithShared = 0;
  for (let i = 0; i < missionFiles.length; i++) {
    for (let j = i + 1; j < missionFiles.length; j++) {
      const a = missionFiles[i];
      const b = missionFiles[j];
      for (const f of a) {
        if (b.has(f)) {
          pairsWithShared++;
          break;
        }
      }
    }
  }
  const union = new Set();
  let totalMentions = 0;
  for (const s of missionFiles) {
    for (const f of s) union.add(f);
    totalMentions += s.size;
  }
  return {
    missionsWithSharedTargets: pairsWithShared,
    uniqueFilesTouched: union.size,
    filesAcrossAllMissions: totalMentions,
  };
}

function collectMissionsFromStateFiles(harnessDir, warnings) {
  const stateDir = path.join(harnessDir, 'state');
  if (!fs.existsSync(stateDir)) {
    warnings.push(`missing dir: ${stateDir}`);
    return [];
  }
  const files = fs.readdirSync(stateDir).filter((f) => /^mission-.*\.json$/.test(f)).sort();
  const missions = [];
  for (const f of files) {
    const full = path.join(stateDir, f);
    const data = safeReadJson(full, warnings);
    if (!data) continue;
    const subMissions = data.subMissions || {};
    const tasks = [];
    const targetFiles = new Set();
    for (const sm of Object.values(subMissions)) {
      const smTasks = sm.tasks || {};
      for (const [tid, t] of Object.entries(smTasks)) {
        tasks.push({ id: tid, ...t });
        for (const tf of (t.targetFiles || [])) targetFiles.add(tf);
      }
    }
    missions.push({
      id: data.id || f.replace(/^mission-(.*)\.json$/, '$1'),
      description: data.description || '',
      tasks,
      targetFiles: [...targetFiles],
    });
  }
  return missions;
}

function collectVerifierVerdicts(harnessDir, warnings) {
  const verifyDir = path.join(harnessDir, 'verification');
  if (!fs.existsSync(verifyDir)) {
    warnings.push(`missing dir: ${verifyDir}`);
    return [];
  }
  const files = fs.readdirSync(verifyDir)
    .filter((f) => (
      /^task-.*\.json$/.test(f) && !/^task-regression-/.test(f)
    ))
    .sort();
  // Use a Map keyed by taskId for deduplication; later task- entries
  // overwrite earlier ones for the same taskId.
  const verdictsMap = new Map();
  for (const f of files) {
    const full = path.join(verifyDir, f);
    const data = safeReadJson(full, warnings);
    if (!data) continue;
    // task-{id}.json sidecar format
    const taskId = f.replace(/^task-(.*)\.json$/, '$1');
    const brc = data.back_reference_check;
    const devCount = brc && Array.isArray(brc.deviations) ? brc.deviations.length : 0;
    verdictsMap.set(taskId, {
      taskId,
      result: data.result || 'FAILED',
      backReferenceDeviationCount: devCount,
    });
  }
  return [...verdictsMap.values()];
}

function collectReviewerFindings(harnessDir, warnings) {
  const verifyDir = path.join(harnessDir, 'verification');
  if (!fs.existsSync(verifyDir)) return [];
  const files = fs.readdirSync(verifyDir)
    .filter((f) => /^review-milestone-.*\.json$/.test(f))
    .sort();
  if (!files.length) {
    warnings.push(`no reviewer milestone files in ${verifyDir}`);
    return [];
  }
  const findings = [];
  for (const f of files) {
    const data = safeReadJson(path.join(verifyDir, f), warnings);
    if (!data) continue;
    for (const finding of (data.findings || [])) {
      const descHash = sha256(
        String(finding.description || '').slice(0, REVIEWER_DESCRIPTION_HASH_PREFIX_LEN)
      );
      findings.push({
        severity: finding.severity,
        category: finding.category,
        file: finding.file,
        descriptionHash: descHash,
      });
    }
  }
  return findings;
}

export function computeFingerprint(harnessDir, opts = {}) {
  const warnings = [];
  const state = safeReadJson(path.join(harnessDir, 'state.json'), warnings) || {};
  const projectMeta = state.projectMeta || {};
  const prdPath = projectMeta.prdPath;
  let specHash = null;
  if (prdPath) {
    try {
      if (fs.existsSync(prdPath)) {
        specHash = sha256(fs.readFileSync(prdPath, 'utf8'));
      } else {
        warnings.push(`spec missing at projectMeta.prdPath: ${prdPath}`);
      }
    } catch (e) {
      warnings.push(`spec read failed: ${e.message}`);
    }
  } else {
    warnings.push('projectMeta.prdPath absent');
  }

  const specSlug = prdPath ? path.basename(prdPath, path.extname(prdPath)) : null;
  const runId = projectMeta.runId || projectMeta.createdAt || null;

  const milestonesMap = state.milestones || {};
  const milestoneIds = Object.keys(milestonesMap).sort();
  const milestoneCount = milestoneIds.length;
  const missionsByMilestone = milestoneIds.map((mid) => {
    const m = milestonesMap[mid] || {};
    return Object.keys(m.missions || {}).length;
  });

  const missions = collectMissionsFromStateFiles(harnessDir, warnings);
  const missionCount = missions.length;
  const tasksByMission = missions.map((m) => m.tasks.length);
  const taskCount = tasksByMission.reduce((a, b) => a + b, 0);

  const mean = tasksByMission.length
    ? tasksByMission.reduce((a, b) => a + b, 0) / tasksByMission.length
    : 0;
  const sd = stdDev(tasksByMission);
  const cv = mean > 0 ? sd / mean : 0;
  const decompositionStyle = {
    tasksPerMissionMin: tasksByMission.length ? Math.min(...tasksByMission) : 0,
    tasksPerMissionMax: tasksByMission.length ? Math.max(...tasksByMission) : 0,
    tasksPerMissionMean: Number(mean.toFixed(4)),
    tasksPerMissionCV: Number(cv.toFixed(4)),
    classification: classifyDecomposition(tasksByMission),
  };
  const targetFilesOverlap = computeTargetFilesOverlap(missions);

  const taskDescriptions = [];
  for (const m of missions) {
    for (const t of m.tasks) {
      const hcArr = Array.isArray(t.hardChecks) ? t.hardChecks
        : (Array.isArray(t.testCases) ? t.testCases : []);
      const hardCheckHashes = hcArr.map((hc) => {
        if (typeof hc === 'string') return sha256(hc);
        // Hash command identity, not the full object — renaming a check
        // without changing its command must NOT perturb the hash.
        if (hc && typeof hc === 'object' && typeof hc.command === 'string') {
          return sha256(hc.command);
        }
        return sha256(JSON.stringify(hc));
      });
      taskDescriptions.push({
        taskId: t.id,
        targetFiles: t.targetFiles || [],
        descriptionHash: sha256(normalizeDescription(t.description)),
        hardCheckCount: hcArr.length,
        hardCheckHashes,
      });
    }
  }

  const verifierVerdicts = collectVerifierVerdicts(harnessDir, warnings);
  const reviewerFindings = collectReviewerFindings(harnessDir, warnings);

  // Warnings embed disk paths under harnessDir; relativize so the fingerprint
  // is stable across runs in different (e.g. random tmp) working directories.
  const normalizedWarnings = warnings.map((w) => w.split(harnessDir).join('<harness>'));

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    runId,
    specSlug,
    specHash,
    planStructure: {
      milestoneCount,
      missionCount,
      taskCount,
      missionsByMilestone,
      tasksByMission,
      decompositionStyle,
      targetFilesOverlap,
    },
    taskDescriptions,
    verifierVerdicts,
    reviewerFindings,
    warnings: normalizedWarnings,
  };
}

export function writeFingerprint(harnessDir, opts = {}) {
  const fingerprint = computeFingerprint(harnessDir, opts);
  const outPath = path.join(harnessDir, 'dispersion-fingerprint.json');
  fs.writeFileSync(outPath, JSON.stringify(fingerprint, null, 2));
  return { path: outPath, fingerprint };
}
