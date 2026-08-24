import fs from 'fs';
import { displayName } from '../../orchestrator/infra/display-name.js';
import path from 'path';
import {
  readQueueEntry,
  updateQueueEntryStatus,
  readParkScene,
  writeParkScene,
  writeParkResumeMarker,
} from '../../orchestrator/core/state.js';
import {
  showParkSnapshot,
  reattachParkSnapshot,
  cleanupParkSnapshot,
} from '../../orchestrator/core/park-snapshot.js';
import {
  runHarnessDir,
  readActiveRunPointer,
  clearActiveRunPointer,
} from '../../orchestrator/core/run-context.js';

/** Resolve verbs and the queue statuses each one may act on. */
const RESOLVE_ACTIONS = ['requeue', 'waive', 'reject', 'approve'];
const RESOLVABLE_STATUSES = ['parked', 'halted-review', 'halted-analyzer', 'halted-scope'];

/** Matches "#{1,6} Heading text" markdown headings. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
/** Matches a heading whose text starts with "Scope" (e.g. "Scope", "Scope — in"). */
const SCOPE_HEADING_RE = /^scope\b/i;

/**
 * Approve-only scope-proposal writeback (see the --approve leg of
 * parkResolve below). Applies an approved scope proposal's `proposedFiles`
 * to a queue entry's spec pair:
 *
 *  - spec.json: every `proposedFiles[].path` not already present in
 *    `target_files` is appended to that array. Every other top-level
 *    key/value (goal, acceptance_criteria, constraints, plan_structure, …)
 *    is left exactly as read — this is a read → mutate target_files →
 *    re-serialize, never a rewrite of the object.
 *  - spec.md: one provenance-annotated bullet is appended per entry in
 *    `proposedFiles` (every proposed file, regardless of whether its path
 *    was already declared in target_files) to the relevant scope section —
 *    the first heading (any level 1-6) whose text starts with "Scope"
 *    (matches both a plain "## Scope" and "## Scope — in").
 *
 * Both files are read and validated FIRST — spec.json must parse to an
 * object, and spec.md must contain a locatable scope heading — before
 * either is written, so a thrown error here (missing/corrupt spec.json,
 * unreadable spec.md, no scope section) never leaves a half-written spec
 * pair. Callers are expected to treat a thrown error as fatal and abort
 * the resolve BEFORE mutating the scene/status (see the --approve call
 * site), so a failed writeback leaves the entry fully 'halted-scope'
 * rather than half-advanced.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {Array<{path: string}>} proposedFiles - the scene's proposed files
 * @param {string} resolvedAt - ISO timestamp used in the provenance annotation
 */
function applyScopeProposalWriteback(projectRoot, slug, proposedFiles, resolvedAt) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  const jsonPath = path.join(entryDir, 'spec.json');
  const mdPath = path.join(entryDir, 'spec.md');

  const files = (Array.isArray(proposedFiles) ? proposedFiles : []).filter(
    (f) => f && typeof f.path === 'string' && f.path.length > 0
  );

  let specJson;
  try {
    specJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read/parse queue/${slug}/spec.json (${err.message})`);
  }
  if (!specJson || typeof specJson !== 'object' || Array.isArray(specJson)) {
    throw new Error(`queue/${slug}/spec.json did not parse to an object`);
  }

  const targetFiles = Array.isArray(specJson.target_files) ? specJson.target_files : [];
  const seen = new Set(targetFiles);
  const newTargetFiles = [...targetFiles];
  for (const f of files) {
    if (!seen.has(f.path)) {
      newTargetFiles.push(f.path);
      seen.add(f.path);
    }
  }

  let mdContent;
  try {
    mdContent = fs.readFileSync(mdPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read queue/${slug}/spec.md (${err.message})`);
  }

  const lines = mdContent.split('\n');
  let headingIdx = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && SCOPE_HEADING_RE.test(m[2])) {
      headingIdx = i;
      headingLevel = m[1].length;
      break;
    }
  }
  if (headingIdx === -1) {
    throw new Error(
      `could not locate a scope section in queue/${slug}/spec.md ` +
      `(no heading matching '#{1,6} Scope ...' was found)`
    );
  }

  let sectionEndIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m && m[1].length <= headingLevel) {
      sectionEndIdx = i;
      break;
    }
  }

  // Insert right after the section's last non-blank line (skipping any
  // trailing blank lines that separate it from the next heading), so the
  // new bullets land inside the scope section rather than butting straight
  // up against whatever follows it.
  let insertIdx = sectionEndIdx;
  while (insertIdx > headingIdx + 1 && lines[insertIdx - 1].trim() === '') {
    insertIdx--;
  }

  const bulletLines = files.map(
    (f) => `- ${f.path} (approved via scope proposal, resolved ${resolvedAt})`
  );
  lines.splice(insertIdx, 0, ...bulletLines);
  const newMdContent = lines.join('\n');

  specJson.target_files = newTargetFiles;

  // Both writes happen only after every validation above has already
  // succeeded, so a thrown error above never leaves a half-written pair.
  fs.writeFileSync(jsonPath, JSON.stringify(specJson, null, 2));
  fs.writeFileSync(mdPath, newMdContent);
}

/**
 * spec.md/spec.json divergence check: warns when spec.md was edited after
 * parking but spec.json was not (the two queue copies may have diverged).
 * Warning only — never blocks. Returns the warning string or null.
 */
function divergenceWarning(projectRoot, slug, parkedAt) {
  if (!parkedAt) return null;
  const parkedMs = new Date(parkedAt).getTime();
  if (!Number.isFinite(parkedMs)) return null;
  const entryDir = path.join(projectRoot, 'queue', slug);
  const mdPath = path.join(entryDir, 'spec.md');
  const jsonPath = path.join(entryDir, 'spec.json');
  if (!fs.existsSync(mdPath) || !fs.existsSync(jsonPath)) return null;
  if (fs.statSync(mdPath).mtimeMs > parkedMs && fs.statSync(jsonPath).mtimeMs <= parkedMs) {
    return (
      `Warning: queue/${slug}/spec.md was edited after parking but spec.json was not — ` +
      `the two copies may have diverged. Review spec.json before the entry runs again.`
    );
  }
  return null;
}

/**
 * Read one queue entry without letting a damaged directory throw.
 *
 * A gutted entry (e.g. queue spec files moved away by a pre-fix forensic
 * archive) makes readQueueEntry throw ENOENT. Returns
 * { entry, status, damage }: `entry` is null and `damage` carries the reason
 * when the entry files are missing/corrupt; `status` is recovered straight
 * from the status file when possible so damaged entries can still be
 * classified and listed.
 */
function readQueueEntryTolerant(projectRoot, slug) {
  let entry = null;
  let damage = null;
  try {
    entry = readQueueEntry(projectRoot, slug);
  } catch (err) {
    damage = err.message;
  }
  let status = entry?.status ?? null;
  if (status === null) {
    try {
      status = fs.readFileSync(path.join(projectRoot, 'queue', slug, 'status'), 'utf8').trim();
    } catch {
      status = null;
    }
  }
  return { entry, status, damage };
}

/**
 * Tolerant queue scan for the park views: like listQueue, but one damaged
 * entry must not kill the whole listing. Returns rows
 * { slug, status, entry, damage } sorted by validatedAt where readable
 * (damaged entries sort last).
 */
function scanQueueTolerant(projectRoot) {
  const queueDir = path.join(projectRoot, 'queue');
  let names = [];
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      if (!fs.statSync(path.join(queueDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    const { entry, status, damage } = readQueueEntryTolerant(projectRoot, name);
    if (entry === null && status === null) continue; // nothing classifiable at all
    rows.push({ slug: name, status, entry, damage });
  }
  rows.sort((a, b) => {
    const tA = new Date(a.entry?.validatedAt ?? NaN).getTime();
    const tB = new Date(b.entry?.validatedAt ?? NaN).getTime();
    return (Number.isFinite(tA) ? tA : Infinity) - (Number.isFinite(tB) ? tB : Infinity);
  });
  return rows;
}

/** One-line question summary for the list view. */
function questionSummary(scene) {
  if (!scene) return '(no park.json scene)';
  const questions = Array.isArray(scene.questions) ? scene.questions : [];
  if (questions.length === 0) return '(no questions recorded)';
  const first = String(questions[0]);
  const head = first.length > 60 ? `${first.slice(0, 57)}...` : first;
  return questions.length > 1 ? `${head} (+${questions.length - 1} more)` : head;
}

/**
 * List queue entries with status parked/halted-review/halted-analyzer: slug + site +
 * question summary. A scene-less entry (missing/corrupt park.json) is shown
 * with a placeholder, and a damaged entry (unreadable queue files) with a
 * warning placeholder — one bad entry never kills the list.
 *
 * @param {string} projectRoot
 * @param {{ json?: boolean }} options
 */
export function parkList(projectRoot, options = {}) {
  const { json = false } = options;

  const candidates = scanQueueTolerant(projectRoot).filter((r) =>
    RESOLVABLE_STATUSES.includes(r.status)
  );

  const rows = candidates.map((r) => {
    const scene = readParkScene(projectRoot, r.slug);
    return {
      slug: r.slug,
      status: r.status,
      site: scene?.site ?? '(no scene)',
      questions: r.damage ? `entry damaged: ${r.damage}` : questionSummary(scene),
      ...(r.damage ? { damage: r.damage } : {}),
    };
  });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No parked entries.');
    return;
  }

  const NAME_WIDTH = 30;
  const STATUS_WIDTH = 16;
  const SITE_WIDTH = 18;

  console.log(
    'Name'.padEnd(NAME_WIDTH) +
    'Status'.padEnd(STATUS_WIDTH) +
    'Site'.padEnd(SITE_WIDTH) +
    'Question'
  );
  console.log('-'.repeat(NAME_WIDTH + STATUS_WIDTH + SITE_WIDTH + 40));
  for (const row of rows) {
    console.log(
      row.slug.padEnd(NAME_WIDTH) +
      row.status.padEnd(STATUS_WIDTH) +
      row.site.padEnd(SITE_WIDTH) +
      row.questions
    );
  }
}

/**
 * Show the full park scene for one entry, plus both queue spec paths and a
 * spec.md/spec.json divergence warning when applicable. A damaged entry
 * (unreadable queue files) degrades to whatever is readable — status, paths,
 * scene — plus a clear damage warning instead of a raw ENOENT crash.
 *
 * @param {string} projectRoot
 * @param {string} slug
 */
export function parkShow(projectRoot, slug) {
  if (!slug) {
    console.error(`Usage: ${displayName()} park show <slug>`);
    process.exitCode = 1;
    return;
  }

  const entryDir = path.join(projectRoot, 'queue', slug);
  if (!fs.existsSync(entryDir)) {
    console.error(`Queue entry '${slug}' not found.`);
    process.exitCode = 1;
    return;
  }
  const { status, damage } = readQueueEntryTolerant(projectRoot, slug);

  const mdPath = path.join(entryDir, 'spec.md');
  const jsonPath = path.join(entryDir, 'spec.json');

  console.log(`Entry:    ${slug}`);
  console.log(`Status:   ${status ?? '(unreadable)'}`);
  console.log(`spec.md:  ${fs.existsSync(mdPath) ? mdPath : `${mdPath} (missing)`}`);
  console.log(`spec.json: ${fs.existsSync(jsonPath) ? jsonPath : `${jsonPath} (absent)`}`);
  if (damage) {
    console.log(`\nWarning: entry damaged — ${damage}`);
    console.log('Queue files are incomplete; showing what is readable. The spec may live in the failed archive for this run.');
  }

  const scene = readParkScene(projectRoot, slug);
  if (!scene) {
    console.log('\n(no readable park scene — park.json is missing or corrupt)');
    return;
  }

  if (scene.kind === 'scope-proposal') {
    console.log('\nScope proposal:');
    console.log(`Proposed by:        ${scene.proposedBy ?? '(unknown)'}`);
    console.log(`Mission:            ${scene.missionId ?? '(unknown)'}`);
    console.log(
      `Lint arms pending:  ${
        Array.isArray(scene.lintArmsPending) && scene.lintArmsPending.length > 0
          ? scene.lintArmsPending.join(', ')
          : '(none)'
      }`
    );
    const proposedFiles = Array.isArray(scene.proposedFiles) ? scene.proposedFiles : [];
    if (proposedFiles.length === 0) {
      console.log('Proposed files:     (none recorded)');
    } else {
      console.log('Proposed files:');
      for (const f of proposedFiles) {
        const taskIds = Array.isArray(f?.taskIds) ? f.taskIds.join(', ') : '(none)';
        console.log(`  - ${f?.path ?? '(unknown path)'}`);
        console.log(`      reason:   ${f?.reason ?? '(no reason recorded)'}`);
        console.log(`      taskIds:  ${taskIds}`);
      }
    }
  }

  console.log('\nPark scene:');
  console.log(JSON.stringify(scene, null, 2));

  // P2: when the scene carries a preserved work-in-progress snapshot, render
  // its diff on demand so a human can inspect the verified WIP before deciding
  // how to resolve. Fail-soft: a snapshot whose ref/object is gone (e.g. gc'd
  // after a prior cleanup) degrades to a note rather than crashing the view.
  if (scene.stashRef || scene.stashSha) {
    const ref = scene.stashRef || scene.stashSha;
    console.log('\nPreserved work-in-progress diff:');
    try {
      const diff = showParkSnapshot(ref, projectRoot).trim();
      console.log(diff || '(snapshot is empty)');
    } catch (err) {
      console.log(`(could not read preserved snapshot ${ref}: ${err.message})`);
    }
  }

  const warning = divergenceWarning(projectRoot, slug, scene.parkedAt);
  if (warning) console.log(`\n${warning}`);
}

/**
 * Resolve a parked/halted-review/halted-analyzer/halted-scope entry with
 * exactly one of --requeue|--waive|--reject|--approve (optional --note).
 *
 * Writes the resolution into the scene (never touches previousResolutions —
 * that field is pipeline-owned), then transitions status via the state.js
 * queue helpers: requeue/waive/approve → 'pending', reject → 'rejected'
 * (or 'failed-plan' for a halted-scope entry — see below).
 *
 * Legal targets: 'parked' accepts requeue/waive/reject; 'halted-review' and
 * 'halted-analyzer' accept --requeue (the WIP was preserved at the halt —
 * requeue RE-ATTACHES it onto the current tree) and --reject, but not --waive
 * (there is no assumption uncertainty to accept). 'halted-scope' is a scope
 * proposal awaiting a human decision — it is approve/reject only: --approve
 * marks the candidate plan for promotion (consumed by a later batchResume),
 * and --reject sends the entry to 'failed-plan' (the proposal is rejected,
 * not the entry itself — same terminal status a normal plan failure would
 * reach). --requeue and --waive are illegal for a scope-proposal scene.
 * --approve is illegal for any status other than 'halted-scope'. Any other
 * status is an illegal transition. A target without a readable scene is
 * refused rather than inventing one.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {{ requeue?: boolean, waive?: boolean, reject?: boolean, approve?: boolean, note?: string }} flags
 */
export function parkResolve(projectRoot, slug, flags = {}) {
  if (!slug) {
    console.error(`Usage: ${displayName()} park resolve <slug> --requeue|--waive|--reject|--approve [--note <text>]`);
    process.exitCode = 1;
    return;
  }

  const actions = RESOLVE_ACTIONS.filter((a) => flags[a]);
  if (actions.length !== 1) {
    console.error('park resolve requires exactly one of --requeue, --waive, --reject, --approve.');
    process.exitCode = 1;
    return;
  }
  const action = actions[0];

  const { entry, damage } = readQueueEntryTolerant(projectRoot, slug);
  if (!entry && !damage) {
    console.error(`Queue entry '${slug}' not found.`);
    process.exitCode = 1;
    return;
  }
  if (damage) {
    // Same refusal posture as a missing scene: resolving a gutted entry
    // would transition something the pipeline can no longer act on.
    console.error(
      `Refusing to resolve '${slug}': queue entry is damaged (${damage}). ` +
      `There is nothing left to re-validate or waive — inspect queue/${slug}/ and the ` +
      `failed archive for this run, or remove the entry with cc-orch queue remove ${slug}.`
    );
    process.exitCode = 1;
    return;
  }

  if (!RESOLVABLE_STATUSES.includes(entry.status)) {
    console.error(
      `Illegal transition: entry '${slug}' has status '${entry.status}' — ` +
      `only parked, halted-review, halted-analyzer, or halted-scope entries can be resolved.`
    );
    process.exitCode = 1;
    return;
  }
  if (action === 'approve' && entry.status !== 'halted-scope') {
    console.error(
      `--approve is not valid for entry '${slug}': it has status '${entry.status}', ` +
      `not 'halted-scope'. --approve only applies to a scope proposal awaiting review.`
    );
    process.exitCode = 1;
    return;
  }
  if (entry.status === 'halted-review' && action === 'waive') {
    console.error(
      `--waive is not valid for a halted-review entry: the reviewed work was already ` +
      `reverted, so there is no assumption uncertainty to accept. Use --requeue ` +
      `(full re-validation + re-execution) or --reject.`
    );
    process.exitCode = 1;
    return;
  }
  if (entry.status === 'halted-analyzer' && action === 'waive') {
    console.error(
      `--waive is not valid for a halted-analyzer entry: the analyzer escalated to a ` +
      `human after the failed work was already reverted, so there is no assumption ` +
      `uncertainty to accept. Use --requeue (full re-validation + re-execution) or --reject.`
    );
    process.exitCode = 1;
    return;
  }

  const scene = readParkScene(projectRoot, slug);
  if (!scene) {
    console.error(
      `Refusing to resolve '${slug}': no readable park scene (queue/${slug}/park.json ` +
      `is missing or corrupt). Inspect the entry directory manually, or remove it with ` +
      `cc-orch queue remove ${slug}.`
    );
    process.exitCode = 1;
    return;
  }
  if (scene.kind === 'scope-proposal' && (action === 'requeue' || action === 'waive')) {
    console.error(
      `--${action} is not valid for entry '${slug}': it is a scope proposal awaiting ` +
      `review, which is --approve or --reject only. Use --approve to promote the ` +
      `candidate plan, or --reject to send it to 'failed-plan'.`
    );
    process.exitCode = 1;
    return;
  }

  if (action === 'requeue') {
    const warning = divergenceWarning(projectRoot, slug, scene.parkedAt);
    if (warning) console.log(warning);
  }

  // P2 park diff preservation. Do the snapshot work BEFORE the scene/status
  // mutation below so that a failed reattach leaves the entry fully parked
  // (scene + status untouched) rather than half-advanced.
  const hasSnapshot = Boolean(scene.stashRef || scene.stashSha);
  if (hasSnapshot) {
    const ref = scene.stashRef || scene.stashSha;
    if (action === 'requeue') {
      // Re-attach the preserved WIP (3-way) to the current tree BEFORE the
      // entry re-runs. On conflict/failure: surface loudly and ABORT — the
      // entry stays parked, NOT advanced as if the work were restored, and the
      // anchoring ref is left in place so a human can recover it manually.
      try {
        reattachParkSnapshot(ref, projectRoot);
      } catch (err) {
        console.error(
          `Refusing to requeue '${slug}': re-attaching the preserved work-in-progress ` +
          `snapshot failed, so the entry stays parked (its preserved work is NOT lost — ` +
          `the ref ${ref} is left in place). Resolve the conflict, then retry.\n${err.message}`
        );
        process.exitCode = 1;
        return;
      }
      // Reattach succeeded — drop the anchoring ref (the WIP now lives in the
      // working tree) so no orphaned park ref accumulates.
      cleanupParkSnapshot(slug, projectRoot);

      // Persist the park-resume marker so a later re-validation can recognize
      // this entry was resumed from a park snapshot. Only meaningful when the
      // scene carried a durable stash COMMIT SHA — scene.stashRef (the
      // refs/park/<slug> ref name) must never reach the marker, because
      // cleanupParkSnapshot just deleted that ref on this same resolve, so a
      // marker holding it would be unreadable. Fail-soft: a marker-write
      // failure must not undo the reattach/cleanup already committed above —
      // warn and continue to the scene write + status flip below.
      if (scene.stashSha) {
        try {
          writeParkResumeMarker(projectRoot, slug, {
            stashSha: scene.stashSha,
            baseSha: scene.baseSha,
            resolvedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.warn(
            `Warning: could not write the park-resume marker for '${slug}' ` +
            `(${err.message}). The requeue itself succeeded.`
          );
        }
      }
    } else {
      // --reject / --waive: the preserved work is being discarded — drop the
      // anchoring ref (no reattach) so the stash object becomes gc-able.
      cleanupParkSnapshot(slug, projectRoot);
    }
  }

  const resolvedAt = new Date().toISOString();

  // Scope-proposal writeback: --approve promotes every scene.proposedFiles
  // path into the queue spec pair (spec.json's target_files array plus a
  // provenance-annotated bullet per file in spec.md's scope section). Done
  // BEFORE the scene write + status flip below — same ordering discipline as
  // the park-snapshot reattach above — so a failed writeback leaves the
  // entry fully 'halted-scope' (scene + status untouched) rather than
  // half-advanced. --reject and the other verbs never reach this branch, so
  // they perform no writeback.
  if (action === 'approve') {
    try {
      applyScopeProposalWriteback(projectRoot, slug, scene.proposedFiles, resolvedAt);
    } catch (err) {
      console.error(
        `Refusing to approve '${slug}': writing the approved scope proposal's files into ` +
        `queue/${slug}/spec.json and spec.md failed, so the entry stays 'halted-scope' ` +
        `(nothing was advanced).\n${err.message}`
      );
      process.exitCode = 1;
      return;
    }
  }

  // Scene first, then the status flip (the status is the commit point —
  // same ordering discipline as parking itself).
  scene.resolution = {
    action,
    at: resolvedAt,
    note: flags.note ?? null,
    consumedAt: null,
  };
  writeParkScene(projectRoot, slug, scene);

  // Status transition via the state.js helper only, and status-only by
  // design: rewriting the whole entry would stomp the spec.md/spec.json
  // mtimes (breaking the divergence warning for a later re-park) and
  // re-persist content this process holds in memory.
  // A rejected halted-scope entry (a rejected scope proposal) lands on
  // 'failed-plan' — the same terminal status a normal plan failure reaches —
  // rather than 'rejected', which is reserved for the parked/halted-review/
  // halted-analyzer reject path.
  let newStatus;
  if (action === 'reject') {
    newStatus = entry.status === 'halted-scope' ? 'failed-plan' : 'rejected';
  } else {
    newStatus = 'pending';
  }
  updateQueueEntryStatus(projectRoot, slug, newStatus);

  // Leftover harness dir cleanup for the parked run. Done AFTER the scene
  // write + status flip (same commit-point discipline as the telemetry
  // below) so an aborted resolve never removes anything. Keyed strictly on
  // the recorded runId — no slug-matching — and skipped entirely when the
  // runId is the active run's pointer target.
  // Every resolve verb (requeue/waive/reject/approve) settles this run, so the
  // active-run pointer must be cleared too — but strictly only when it still
  // names THIS run (never clobber a pointer some other run has since claimed).
  // ORDER MATTERS (W-361): the clear must happen BEFORE
  // removeParkedRunHarnessDir, whose own guard skips deletion while the
  // pointer still names scene.runId — the old order left every resolve
  // with an orphan run dir.
  // Fail-soft: an error reading/clearing the pointer must not undo the scene
  // write + status flip already committed above — warn and continue.
  try {
    const pointer = readActiveRunPointer(projectRoot);
    if (pointer?.runId === scene.runId) {
      clearActiveRunPointer(projectRoot);
    }
  } catch (err) {
    console.warn(
      `Warning: could not release the active-run pointer for run ` +
      `'${scene.runId}' (${err.message}). The resolve itself succeeded.`
    );
  }

  removeParkedRunHarnessDir(projectRoot, scene.runId);

  // Analyzer disposition telemetry. When the scene carries an analyzer signal
  // (recommendation or eventId — set by the halted-analyzer / halted-review park
  // legs), append ONE raw JSON line to a durable, mine-able log. This persists
  // in archives/ (which survives the per-run .harness/ wipe, like the analysis
  // corpus the future miner reads), so analyzer-human accuracy can be measured
  // later. Raw signals only — no false/true-human label is computed here; that
  // is mine-time classification. Done AFTER the scene write + status flip so an
  // aborted resolve (e.g. a requeue reattach conflict) never logs a disposition.
  if (scene.recommendation || scene.eventId) {
    recordAnalyzerDisposition(projectRoot, {
      slug,
      eventId: scene.eventId ?? null,
      recommendation: scene.recommendation ?? null,
      action,
      resolvedAt: scene.resolution.at,
      note: flags.note ?? null,
    });
  }

  console.log(`Entry '${slug}' resolved with --${action} → status '${newStatus}'.`);
}

/**
 * Remove the leftover .harness/<runId>/ dir for a just-resolved parked run,
 * keyed strictly on the RECORDED runId (no slug-matching). Preconditions,
 * all of which must hold or the removal is skipped:
 *  (a) runId is a non-empty string — an old park.json without a runId
 *      skips SILENTLY (no log, no error);
 *  (b) runHarnessDir(projectRoot, runId) exists on disk;
 *  (c) the active-run pointer does not name this runId (never remove the
 *      dir for the run currently in flight).
 * Fail-soft: a removal error logs at most a warning, mirroring
 * recordAnalyzerDisposition's posture — it never fails the resolve that
 * already committed its scene + status change.
 *
 * @param {string} projectRoot
 * @param {string|undefined|null} runId
 */
function removeParkedRunHarnessDir(projectRoot, runId) {
  if (typeof runId !== 'string' || runId.length === 0) return;

  const dir = runHarnessDir(projectRoot, runId);
  if (!fs.existsSync(dir)) return;

  const pointer = readActiveRunPointer(projectRoot);
  if (pointer?.runId === runId) return;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `Warning: could not remove leftover harness dir for run '${runId}' ` +
      `(${err.message}). The resolve itself succeeded.`
    );
  }
}

/**
 * Append one raw analyzer-disposition record to the durable, mine-able log at
 * <projectRoot>/archives/analyzer-dispositions.jsonl (one JSON object per line).
 * Best-effort/fail-soft: a non-writable archives/ logs a warning rather than
 * crashing the resolve that already committed its scene + status change.
 *
 * @param {string} projectRoot
 * @param {{ slug: string, eventId: string|null, recommendation: string|null,
 *   action: string, resolvedAt: string, note: string|null }} record
 */
function recordAnalyzerDisposition(projectRoot, record) {
  const logPath = path.join(projectRoot, 'archives', 'analyzer-dispositions.jsonl');
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.warn(
      `Warning: could not record analyzer disposition for '${record.slug}' ` +
      `(${err.message}). The resolve itself succeeded.`
    );
  }
}
