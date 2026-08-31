/**
 * thin-archive.js — 落袋: the thin loop's archive writer and its self-audit
 * (M1 blueprint v3 §范围-in item 4 + the gate table's 落袋自证 row).
 *
 * Every thin run — delivered OR parked — lands a sequenced directory under
 * `archives/<seq>-thin-<slug>/` holding:
 *
 *   - the spec pair and the acceptance file, snapshotted verbatim, with a
 *     sha256 MANIFEST (grading reproducibility);
 *   - record.json (schema `thin-v1`): baseSha, modelId, outcome/parkReason,
 *     the full red-loop transition trail, suspected acceptance defects,
 *     per-try {stats: cost/duration/turns, grade incl. PER-ASSERT
 *     acceptance lines — the v2 lesson: these must never be dropped},
 *     mechanical-step timings (acceptance / suite / orchestration, split
 *     out because the thin loop's overhead premium must be itemizable),
 *     and the final diff stat.
 *
 * No usage-ledger row is written: USAGE_LEDGER_OUTCOMES is a CLOSED set by
 * design and the ledger/archive are mutually exclusive views — a thin run
 * always archives, so the archive IS the record (double-count-free rule).
 *
 * rebuildGateNumbers() is the self-audit demanded by the gate: a pure
 * function that reconstructs the gate table's thin-loop column from the
 * archive alone, failing loudly when a required field is missing.
 *
 * The writer never throws (best-effort with an explicit error result).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function nextSeq(archivesDir) {
  let max = 0;
  for (const name of fs.readdirSync(archivesDir)) {
    const m = name.match(/^(\d{3})-/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

/**
 * Write the thin archive. Never throws.
 *
 * @param {object} p - { projectRoot, slug, specMdPath, specJsonPath,
 *   acceptPath, baseSha, modelId, loopOutcome (runRedLoop result),
 *   tryStats[] ({costUsd, durationMs, turns} per try, index-aligned),
 *   mechTimingsMs ({acceptance, suite, orchestration}), finalDiffStat }
 * @returns {{ok: boolean, archiveDir?: string, error?: string}}
 */
export function writeThinArchive(p) {
  let archiveDir;
  try {
    const archivesDir = path.join(p.projectRoot, 'archives');
    fs.mkdirSync(archivesDir, { recursive: true });
    // Non-recursive mkdir is the collision detector; on EEXIST (a
    // concurrent writer claimed the seq) advance and retry a few times
    // rather than silently losing this run's archive.
    let seqNum = parseInt(nextSeq(archivesDir), 10);
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(archivesDir, `${String(seqNum).padStart(3, '0')}-thin-${p.slug}`);
      try {
        fs.mkdirSync(candidate);
        archiveDir = candidate;
        break;
      } catch (err) {
        if (err.code === 'EEXIST') { seqNum += 1; continue; }
        throw err;
      }
    }
    if (!archiveDir) throw new Error('could not claim an archive sequence number after 5 attempts');

    const snapshots = [p.specMdPath, p.specJsonPath, p.acceptPath].filter(Boolean);
    const manifest = [];
    for (const src of snapshots) {
      const dest = path.join(archiveDir, path.basename(src));
      fs.copyFileSync(src, dest);
      manifest.push(`${sha256(dest)}  ${path.basename(src)}`);
    }
    fs.writeFileSync(path.join(archiveDir, 'MANIFEST.sha256'), manifest.join('\n') + '\n');

    const lo = p.loopOutcome ?? {};
    const tries = (lo.tries ?? []).map((t, i) => ({
      kind: t.kind,
      grade: t.grade ?? null,
      stats: (p.tryStats ?? [])[i] ?? null,
    }));

    const record = {
      schema: 'thin-v1',
      writtenAt: new Date().toISOString(),
      slug: p.slug,
      baseSha: p.baseSha,
      modelId: p.modelId,
      outcome: lo.outcome,
      parkReason: lo.parkReason,
      transitions: lo.transitions ?? [],
      suspectedAcceptanceDefects: lo.suspectedAcceptanceDefects ?? [],
      recordErrors: lo.recordErrors ?? [],
      tries,
      mechTimingsMs: p.mechTimingsMs ?? null,
      totalElapsedMs: typeof p.totalElapsedMs === 'number' ? p.totalElapsedMs : null,
      finalDiffStat: p.finalDiffStat ?? '',
    };
    fs.writeFileSync(path.join(archiveDir, 'record.json'), JSON.stringify(record, null, 2) + '\n');
    return { ok: true, archiveDir };
  } catch (err) {
    // Never leave a half-written archive behind: archives/ is committable
    // by design and a partial dir would get swept into a park commit.
    if (archiveDir) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return { ok: false, error: `thin archive write failed: ${err.message}` };
  }
}

/**
 * 落袋自证: rebuild the gate table's thin-loop column from an archive dir
 * alone. Pure read; loud about anything missing.
 *
 * @param {string} archiveDir
 * @returns {{ok: boolean, missing?: string[], outcome?, parkReason?,
 *   finalAcceptancePass?, finalAcceptanceFail?, firstTryGreen?, tries?,
 *   totalCostUsd?, sessionWallMs?, totalWallMs?, mechTimingsMs?}}
 *   totalWallMs = session time + mechanical steps — THE number the gate's
 *   premium row must use (sessions alone would soften the losable line).
 */
export function rebuildGateNumbers(archiveDir) {
  const missing = [];
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(archiveDir, 'record.json'), 'utf8'));
  } catch {
    return { ok: false, missing: ['record.json unreadable'] };
  }

  const need = (cond, label) => {
    if (!cond) missing.push(label);
  };
  need(typeof rec.outcome === 'string', 'outcome');
  need(typeof rec.baseSha === 'string', 'baseSha');
  need(typeof rec.modelId === 'string', 'modelId');
  need(Array.isArray(rec.tries) && rec.tries.length > 0, 'tries');
  need(rec.mechTimingsMs && typeof rec.mechTimingsMs === 'object', 'mechTimingsMs');

  let totalCostUsd = 0;
  let sessionWallMs = 0;
  if (Array.isArray(rec.tries)) {
    rec.tries.forEach((t, i) => {
      need(
        t.grade && t.grade.acceptance &&
          typeof t.grade.acceptance.pass === 'number' &&
          typeof t.grade.acceptance.fail === 'number',
        `tries[${i}].grade.acceptance (with numeric pass/fail)`
      );
      need(t.stats && typeof t.stats.costUsd === 'number', `tries[${i}].stats`);
      if (t.stats) {
        totalCostUsd += t.stats.costUsd ?? 0;
        sessionWallMs += t.stats.durationMs ?? 0;
      }
    });
  }
  if (missing.length > 0) return { ok: false, missing };

  const last = rec.tries[rec.tries.length - 1];
  const first = rec.tries[0];
  return {
    ok: true,
    outcome: rec.outcome,
    parkReason: rec.parkReason,
    finalAcceptancePass: last.grade.acceptance.pass,
    finalAcceptanceFail: last.grade.acceptance.fail,
    firstTryGreen: first.grade.green === true,
    tries: rec.tries.length,
    totalCostUsd: Math.round(totalCostUsd * 100) / 100,
    sessionWallMs,
    // Prefer the MEASURED end-to-end elapsed time; the additive fallback
    // (sessions + mechanical buckets) exists only for records that predate
    // totalElapsedMs and undercounts orchestration overhead.
    totalWallMs:
      typeof rec.totalElapsedMs === 'number'
        ? rec.totalElapsedMs
        : sessionWallMs +
          Object.values(rec.mechTimingsMs).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0),
    mechTimingsMs: rec.mechTimingsMs,
  };
}
