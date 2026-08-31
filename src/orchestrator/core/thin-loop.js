/**
 * thin-loop.js — The v0.3 thin loop's red-loop state machine
 * (M1 blueprint v3 §范围-in item 3, provisional sequence per design
 * decision 3):
 *
 *   try1 → (red) inplace-fix ×1 → (red) fresh-redo ×1 → (red) parked
 *
 * The git semantics of fresh-redo are the blueprint's hard rule and are
 * order-pinned by tests: ① capture the try's patch ② snapshot the working
 * tree into refs/thin/<slug>/<label> (and, when the executor moved HEAD,
 * snapshot HEAD into its own ref) ③ ONLY THEN reset to the recorded base
 * ④ start the fresh session. Rollback before snapshot must be impossible.
 *
 * Suspected-acceptance-defect channel (design decision 2/3): purely
 * mechanical — a FAIL label that appears in EVERY round's fail set is
 * marked as a suspected exam defect on the park record. Whether the
 * behavior "was actually implemented" is a semantic judgement that belongs
 * to the human at park time, never to this machine (the executor may not
 * grade itself).
 *
 * Everything is injected (executors, grader, git, recorder) so the state
 * machine is fully unit-testable without a model call or a real repo. The
 * loop never throws: executor exceptions park with an infra reason.
 */

/**
 * Pure helper: labels that failed in EVERY round (three or more rounds
 * required — fewer rounds can never trigger the channel).
 * @param {string[][]} failSets - per-round FAIL label arrays, in order.
 * @returns {string[]}
 */
export function suspectedAcceptanceDefects(failSets) {
  if (!Array.isArray(failSets) || failSets.length < 3) return [];
  let acc = new Set(failSets[0]);
  for (const round of failSets.slice(1)) {
    const cur = new Set(round);
    acc = new Set([...acc].filter((l) => cur.has(l)));
  }
  return [...acc].sort();
}

/**
 * Run the provisional red loop.
 *
 * @param {object} p
 * @param {string} p.baseSha           - preflight's recorded base.
 *   (Park persistence is the CLI assembly's job — T6 — wired from the
 *   returned outcome; this machine stays free of fs/park I/O.)
 * @param {Function} p.executeFresh    - async ({attempt}) => executor result; attempt 1 = try1, 2 = fresh-redo.
 * @param {Function} p.executeFollowup - async ({redList}) => executor result (same-session continue).
 * @param {Function} p.grade           - () => {green, redList, failLabels, ...} (thin-acceptance.runAll shape).
 * @param {object} p.git               - { headSha(), snapshotTry(label), snapshotHead(label), capturePatch(), resetToBase() }.
 * @param {Function} [p.record]        - (transition) => void; transition = {from, to, reason, residualReds, snapshotRef?}.
 * @returns {Promise<{outcome: 'delivered'|'parked', tries: Array, transitions: Array,
 *                    suspectedAcceptanceDefects: string[], parkReason?: string}>}
 */
export async function runRedLoop(p) {
  const record = p.record ?? (() => {});
  const tries = [];
  const transitions = [];
  const failSets = [];

  const recordErrors = [];
  const note = (from, to, reason, residualReds, extra = {}) => {
    const t = { from, to, reason, residualReds, ...extra };
    transitions.push(t);
    try {
      record(t);
    } catch (err) {
      // A failing persistence callback must never kill the loop; the
      // transition stays in memory and the failure is surfaced on the
      // outcome for the archiver to flag.
      recordErrors.push(`record failed at ${t.from}->${t.to}: ${err.message}`);
    }
  };

  const finish = (outcome, extra = {}) => ({
    outcome,
    tries,
    transitions,
    suspectedAcceptanceDefects: suspectedAcceptanceDefects(failSets),
    recordErrors,
    ...extra,
  });

  const attempt = async (kind, exec) => {
    let result;
    try {
      result = await exec();
    } catch (err) {
      return { infraError: `${kind} executor failed: ${err.message}` };
    }
    let grade;
    try {
      grade = p.grade();
    } catch (err) {
      return { infraError: `${kind} grading failed: ${err.message}` };
    }
    // Bulletproof the grader shape: a red grade without a redList must not
    // crash the loop.
    grade = { ...grade, redList: grade.redList ?? [], failLabels: grade.failLabels ?? [] };
    failSets.push(grade.failLabels);
    tries.push({ kind, result, grade });
    return { grade };
  };

  // ── try1 ────────────────────────────────────────────────────────────────
  const t1 = await attempt('fresh', () => p.executeFresh({ attempt: 1 }));
  if (t1.infraError) {
    note('try1', 'parked', t1.infraError, -1);
    return finish('parked', { parkReason: t1.infraError });
  }
  if (t1.grade.green) return finish('delivered');

  // ── in-place fix ────────────────────────────────────────────────────────
  note('try1', 'inplace-fix', 'red on try1 — red list handed back in-session', t1.grade.redList.length);
  const t2 = await attempt('inplace-fix', () => p.executeFollowup({ redList: t1.grade.redList }));
  if (t2.infraError) {
    note('inplace-fix', 'parked', t2.infraError, -1);
    return finish('parked', { parkReason: t2.infraError });
  }
  if (t2.grade.green) return finish('delivered');

  // ── fresh-redo: snapshot BEFORE rollback (hard order) ───────────────────
  // The reset is the LAST git step, so a failure anywhere in this block can
  // never leave the tree rolled back without a snapshot: either the reset
  // was not reached (tree keeps the try's work) or the snapshot already
  // exists (work recoverable from the ref). Failures park as infra.
  let snapshotRef;
  let headRef;
  let patch;
  try {
    patch = p.git.capturePatch();
    snapshotRef = p.git.snapshotTry('try1'); // blueprint-literal label; the tree holds try1's work plus its in-place fix
    if (p.git.headSha() !== p.baseSha) {
      // The executor made commits; preserve them in a ref before the reset.
      headRef = p.git.snapshotHead('try1');
    }
    p.git.resetToBase();
  } catch (err) {
    const where = snapshotRef ? 'after the snapshot (work preserved in the ref)' : 'before any rollback (work still in the tree)';
    const reason = `fresh-redo git surgery failed ${where}: ${err.message}`;
    note('inplace-fix', 'parked', reason, t2.grade.redList.length, { snapshotRef, headRef });
    return finish('parked', { parkReason: reason });
  }
  note('inplace-fix', 'fresh-redo', 'still red after the in-place fix — tree snapshotted and reset to base', t2.grade.redList.length, {
    snapshotRef,
    headRef,
    patchBytes: patch ? patch.length : 0,
  });

  const t3 = await attempt('fresh-redo', () => p.executeFresh({ attempt: 2 }));
  if (t3.infraError) {
    note('fresh-redo', 'parked', t3.infraError, -1);
    return finish('parked', { parkReason: t3.infraError });
  }
  if (t3.grade.green) return finish('delivered');

  // ── parked ──────────────────────────────────────────────────────────────
  const suspects = suspectedAcceptanceDefects(failSets);
  const reason =
    `still red after the full provisional sequence (in-place fix + fresh redo)` +
    (suspects.length ? `; suspected acceptance defects (same label red in all rounds): ${suspects.join(', ')}` : '');
  note('fresh-redo', 'parked', reason, t3.grade.redList.length);
  return finish('parked', { parkReason: reason });
}
