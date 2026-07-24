import fs from 'fs';
import path from 'path';

const FINGERPRINT_FILENAME = 'dispersion-fingerprint.json';

/**
 * Read the dispersion-fingerprint.json for a specific archive.
 *
 * @param {string} projectRoot
 * @param {string} archiveId
 * @returns {{ ok: true, archiveId: string, fingerprint: object }
 *           |{ ok: false, reason: 'no_archive'|'no_fingerprint'|'malformed' }}
 */
export function readArchiveFingerprint(projectRoot, archiveId) {
  const archivesDir = path.join(projectRoot, 'archives');
  const archiveDir = path.join(archivesDir, archiveId);
  const fingerprintPath = path.join(archiveDir, FINGERPRINT_FILENAME);

  if (!fs.existsSync(archiveDir)) {
    return { ok: false, reason: 'no_archive' };
  }

  if (!fs.existsSync(fingerprintPath)) {
    return { ok: false, reason: 'no_fingerprint' };
  }

  let fingerprint;
  try {
    const raw = fs.readFileSync(fingerprintPath, 'utf8');
    fingerprint = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, archiveId, fingerprint };
}

/**
 * List all archives that have fingerprint files.
 *
 * @param {string} projectRoot
 * @returns {Array<{archiveId: string, fingerprint: object}>}
 */
export function listArchivesWithFingerprints(projectRoot) {
  const archivesDir = path.join(projectRoot, 'archives');

  if (!fs.existsSync(archivesDir)) {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(archivesDir);
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const entryPath = path.join(archivesDir, entry);
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const result = readArchiveFingerprint(projectRoot, entry);
    if (result.ok) {
      results.push({ archiveId: entry, fingerprint: result.fingerprint });
    }
  }

  return results;
}

/**
 * Produce a single-line summary for a fingerprint entry.
 *
 * @param {string} archiveId
 * @param {object} fingerprint
 * @returns {string}
 */
export function summarizeFingerprintLine(archiveId, fingerprint) {
  const plan = fingerprint.planStructure ?? {};
  const milestones = plan.milestoneCount ?? 0;
  const missions = plan.missionCount ?? 0;
  const tasks = plan.taskCount ?? 0;

  const verdicts = fingerprint.verifierVerdicts ?? [];
  const passed = verdicts.filter((v) => v.result === 'PASSED').length;
  const failed = verdicts.filter((v) => v.result === 'FAILED').length;
  const deviations = verdicts.reduce((sum, v) => sum + (v.backReferenceDeviationCount ?? 0), 0);

  const findings = fingerprint.reviewerFindings ?? [];
  const warnings = fingerprint.warnings ?? [];

  const runId = fingerprint.runId ?? archiveId;
  const slug = fingerprint.specSlug ? ` [${fingerprint.specSlug}]` : '';

  return (
    `${archiveId}${slug}  ` +
    `${milestones}ms/${missions}mi/${tasks}t  ` +
    `pass:${passed} fail:${failed} dev:${deviations}  ` +
    `findings:${findings.length} warn:${warnings.length}`
  );
}

/**
 * Produce a multi-line detailed report for a fingerprint.
 *
 * @param {string} archiveId
 * @param {object} fingerprint
 * @returns {string}
 */
export function formatFingerprintDetail(archiveId, fingerprint) {
  const lines = [];

  lines.push(`Dispersion Fingerprint: ${archiveId}`);
  if (fingerprint.runId) lines.push(`Run ID:  ${fingerprint.runId}`);
  if (fingerprint.specSlug) lines.push(`Spec:    ${fingerprint.specSlug}`);
  if (fingerprint.specHash) lines.push(`SpecHash: ${fingerprint.specHash}`);
  lines.push(`Version: ${fingerprint.fingerprintVersion ?? '(unknown)'}`);

  // --- Plan Structure ---
  lines.push('');
  lines.push('Plan Structure:');
  const plan = fingerprint.planStructure ?? {};
  lines.push(`  Milestones: ${plan.milestoneCount ?? 0}`);
  lines.push(`  Missions:   ${plan.missionCount ?? 0}`);
  lines.push(`  Tasks:      ${plan.taskCount ?? 0}`);

  const ds = plan.decompositionStyle ?? {};
  if (ds.classification) {
    lines.push(`  Decomposition style: ${ds.classification}`);
    lines.push(
      `    tasks/mission — min:${ds.tasksPerMissionMin ?? '?'} max:${ds.tasksPerMissionMax ?? '?'} ` +
        `mean:${typeof ds.tasksPerMissionMean === 'number' ? ds.tasksPerMissionMean.toFixed(2) : '?'} ` +
        `CV:${typeof ds.tasksPerMissionCV === 'number' ? ds.tasksPerMissionCV.toFixed(2) : '?'}`
    );
  }

  const overlap = plan.targetFilesOverlap ?? {};
  if (overlap.uniqueFilesTouched !== undefined) {
    lines.push(`  Target files: ${overlap.uniqueFilesTouched} unique / ${overlap.filesAcrossAllMissions ?? '?'} total`);
    lines.push(`  Missions with shared targets: ${overlap.missionsWithSharedTargets ?? 0}`);
  }

  // --- Deviation Summary ---
  lines.push('');
  lines.push('Deviation Summary:');
  const verdicts = fingerprint.verifierVerdicts ?? [];
  if (verdicts.length === 0) {
    lines.push('  (no verifier verdicts)');
  } else {
    const passed = verdicts.filter((v) => v.result === 'PASSED').length;
    const failed = verdicts.filter((v) => v.result === 'FAILED').length;
    const totalDev = verdicts.reduce((sum, v) => sum + (v.backReferenceDeviationCount ?? 0), 0);
    lines.push(`  Tasks verified: ${verdicts.length}  pass: ${passed}  fail: ${failed}`);
    lines.push(`  Total back-reference deviations: ${totalDev}`);

    const withDev = verdicts.filter((v) => (v.backReferenceDeviationCount ?? 0) > 0);
    if (withDev.length > 0) {
      lines.push('  Tasks with deviations:');
      for (const v of withDev) {
        lines.push(`    ${v.taskId}  deviations:${v.backReferenceDeviationCount}  result:${v.result}`);
      }
    }
  }

  // --- Reviewer Finding Histogram ---
  lines.push('');
  lines.push('Reviewer Finding Histogram:');
  const findings = fingerprint.reviewerFindings ?? [];
  if (findings.length === 0) {
    lines.push('  (no reviewer findings)');
  } else {
    // Count by severity
    const bySeverity = {};
    for (const f of findings) {
      const sev = f.severity ?? 'unknown';
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }

    // Count by category
    const byCategory = {};
    for (const f of findings) {
      const cat = f.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }

    lines.push(`  Total findings: ${findings.length}`);
    lines.push('  By severity:');
    for (const [sev, count] of Object.entries(bySeverity).sort()) {
      lines.push(`    ${sev}: ${count}`);
    }
    lines.push('  By category:');
    for (const [cat, count] of Object.entries(byCategory).sort()) {
      lines.push(`    ${cat}: ${count}`);
    }
  }

  // --- Warnings ---
  lines.push('');
  lines.push('Warnings:');
  const warnings = fingerprint.warnings ?? [];
  if (warnings.length === 0) {
    lines.push('  (none)');
  } else {
    for (const w of warnings) {
      lines.push(`  ! ${w}`);
    }
  }

  return lines.join('\n');
}

/**
 * Compute derived statistics from a fingerprint.
 *
 * @param {object} fingerprint
 * @returns {object}
 */
function computeDerived(fingerprint) {
  const ps = fingerprint.planStructure || {};
  const verdicts = fingerprint.verifierVerdicts || [];
  const findings = fingerprint.reviewerFindings || [];

  let verifierPassRate = null;
  if (verdicts.length > 0) {
    const passed = verdicts.filter((v) => v.result === 'PASSED').length;
    verifierPassRate = Number((passed / verdicts.length).toFixed(4));
  }

  const findingsBySeverity = {};
  for (const f of findings) {
    const sev = f.severity ?? 'unknown';
    findingsBySeverity[sev] = (findingsBySeverity[sev] ?? 0) + 1;
  }

  return {
    taskCount: ps.taskCount ?? 0,
    missionCount: ps.missionCount ?? 0,
    milestoneCount: ps.milestoneCount ?? 0,
    verifierPassRate,
    reviewerFindingCount: findings.length,
    findingsBySeverity,
  };
}

/**
 * Compare two archive dispersion fingerprints and return a structured diff.
 *
 * @param {string} projectRoot
 * @param {string} archiveIdA
 * @param {string} archiveIdB
 * @param {object} [opts={}]
 * @param {boolean} [opts.json]
 * @returns {{ archiveA: string, archiveB: string, specHashMatch: boolean, diffs: object }}
 */
export function compareFingerprints(projectRoot, archiveIdA, archiveIdB, opts = {}) {
  const { json = false } = opts;

  const resultA = readArchiveFingerprint(projectRoot, archiveIdA);
  const resultB = readArchiveFingerprint(projectRoot, archiveIdB);

  if (!resultA.ok) {
    console.error(`Error reading fingerprint for archive ${archiveIdA}: ${resultA.reason}`);
    return null;
  }
  if (!resultB.ok) {
    console.error(`Error reading fingerprint for archive ${archiveIdB}: ${resultB.reason}`);
    return null;
  }

  const fpA = resultA.fingerprint;
  const fpB = resultB.fingerprint;

  const specHashMatch =
    fpA.specHash == null || fpB.specHash == null
      ? null
      : fpA.specHash === fpB.specHash;

  const planA = fpA.planStructure ?? {};
  const planB = fpB.planStructure ?? {};

  const verdictsA = fpA.verifierVerdicts ?? [];
  const verdictsB = fpB.verifierVerdicts ?? [];
  const passA = verdictsA.filter((v) => v.result === 'PASSED').length;
  const failA = verdictsA.filter((v) => v.result === 'FAILED').length;
  const passB = verdictsB.filter((v) => v.result === 'PASSED').length;
  const failB = verdictsB.filter((v) => v.result === 'FAILED').length;

  const findingsA = fpA.reviewerFindings ?? [];
  const findingsB = fpB.reviewerFindings ?? [];

  const diffs = {
    specHash: { a: fpA.specHash ?? null, b: fpB.specHash ?? null, match: specHashMatch },
    milestoneCount: { a: planA.milestoneCount ?? 0, b: planB.milestoneCount ?? 0, delta: (planB.milestoneCount ?? 0) - (planA.milestoneCount ?? 0) },
    missionCount: { a: planA.missionCount ?? 0, b: planB.missionCount ?? 0, delta: (planB.missionCount ?? 0) - (planA.missionCount ?? 0) },
    taskCount: { a: planA.taskCount ?? 0, b: planB.taskCount ?? 0, delta: (planB.taskCount ?? 0) - (planA.taskCount ?? 0) },
    verifierPass: { a: passA, b: passB, delta: passB - passA },
    verifierFail: { a: failA, b: failB, delta: failB - failA },
    reviewerFindingCount: { a: findingsA.length, b: findingsB.length, delta: findingsB.length - findingsA.length },
  };

  const result = { archiveA: archiveIdA, archiveB: archiveIdB, specHashMatch, diffs };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  // Text output: table similar to usage compare
  console.log(`\n--- Dispersion Compare ---`);
  console.log(`  A: ${archiveIdA}`);
  console.log(`  B: ${archiveIdB}`);
  console.log(`  Spec hash match: ${specHashMatch === null ? 'unknown (null specHash)' : specHashMatch}`);
  console.log('');

  const col0 = 24;
  const col1 = 12;
  const col2 = 12;
  const col3 = 12;

  const header =
    'Metric'.padEnd(col0) +
    'A'.padStart(col1) +
    'B'.padStart(col2) +
    'Delta'.padStart(col3);
  console.log(header);
  console.log('-'.repeat(col0 + col1 + col2 + col3));

  const row = (label, a, b, delta) => {
    const sign = typeof delta === 'number' ? (delta >= 0 ? '+' : '') : '';
    const deltaStr = typeof delta === 'number' ? `${sign}${delta}` : String(delta);
    return label.padEnd(col0) + String(a).padStart(col1) + String(b).padStart(col2) + deltaStr.padStart(col3);
  };

  console.log(row('Milestones', diffs.milestoneCount.a, diffs.milestoneCount.b, diffs.milestoneCount.delta));
  console.log(row('Missions', diffs.missionCount.a, diffs.missionCount.b, diffs.missionCount.delta));
  console.log(row('Tasks', diffs.taskCount.a, diffs.taskCount.b, diffs.taskCount.delta));
  console.log(row('Verifier pass', diffs.verifierPass.a, diffs.verifierPass.b, diffs.verifierPass.delta));
  console.log(row('Verifier fail', diffs.verifierFail.a, diffs.verifierFail.b, diffs.verifierFail.delta));
  console.log(row('Reviewer findings', diffs.reviewerFindingCount.a, diffs.reviewerFindingCount.b, diffs.reviewerFindingCount.delta));

  return result;
}

/**
 * Main entry point for the dispersion command.
 *
 * In list mode (no archiveId option), lists all archives with dispersion fingerprints.
 * In show mode (archiveId option set), shows the fingerprint detail for that archive.
 *
 * Can also be called with the legacy positional-args form:
 *   dispersion(projectRoot, args, flags, opts)
 * or the preferred opts form:
 *   dispersion(projectRoot, opts)
 *
 * @param {string} projectRoot
 * @param {object|string[]} optsOrArgs  - options object OR legacy positional args array
 * @param {object}  [flags]             - legacy flags object; `json` and `j` properties are read from it
 * @param {object}  [legacyOpts]        - legacy opts object (merged when positional-args form used)
 */
export function dispersion(projectRoot, optsOrArgs = {}, flags = {}, legacyOpts = {}) {
  // Support both call forms:
  //   dispersion(root, { json, archiveId })         ← preferred
  //   dispersion(root, [archiveId], flags, { json })   ← legacy CLI router form
  let opts;
  if (Array.isArray(optsOrArgs)) {
    // Detect compare mode: first positional arg is 'compare'
    if (optsOrArgs[0] === 'compare') {
      const json = !!(flags.json || flags.j || legacyOpts.json);
      return compareFingerprints(projectRoot, optsOrArgs[1], optsOrArgs[2], { json });
    }
    opts = { ...legacyOpts, json: !!(flags.json || flags.j), archiveId: optsOrArgs[0] };
  } else {
    opts = optsOrArgs;
  }

  const { json = false, archiveId } = opts;

  // --- Show mode ---
  if (archiveId) {
    const archivesDir = path.join(projectRoot, 'archives');

    if (!fs.existsSync(archivesDir)) {
      console.error(`Archive not found: ${archiveId}`);
      console.error('No archives directory found.');
      return;
    }

    const archiveDir = path.join(archivesDir, archiveId);
    if (!fs.existsSync(archiveDir)) {
      console.error(`Archive not found: ${archiveId}`);
      let entries = [];
      try {
        entries = fs.readdirSync(archivesDir).filter((e) => {
          return fs.statSync(path.join(archivesDir, e)).isDirectory();
        });
      } catch {
        // ignore
      }
      if (entries.length > 0) {
        console.error('Available archives:');
        for (const entry of entries) {
          console.error(`  ${entry}`);
        }
      } else {
        console.error('No archives available.');
      }
      return;
    }

    const result = readArchiveFingerprint(projectRoot, archiveId);

    if (!result.ok) {
      console.error(`No fingerprint available for archive ${archiveId}: ${result.reason}`);
      return;
    }

    const derived = computeDerived(result.fingerprint);

    if (json) {
      console.log(JSON.stringify({ archiveId, fingerprint: result.fingerprint, derived }, null, 2));
      return;
    }

    console.log(formatFingerprintDetail(archiveId, result.fingerprint));
    return;
  }

  // --- List mode ---
  const archives = listArchivesWithFingerprints(projectRoot);

  if (json) {
    console.log(JSON.stringify({ archives }, null, 2));
    return;
  }

  if (archives.length === 0) {
    console.log('No fingerprints found.');
    return;
  }

  for (const { archiveId: id, fingerprint } of archives) {
    console.log(summarizeFingerprintLine(id, fingerprint));
  }
}
