/**
 * thin.js — `nightfoundry run <spec.md>`: the v0.3 loop
 * (blueprint v3). One single-session executor over the whole spec, a
 * mechanical grading step, the provisional red loop, and 落袋 — nothing
 * else. Coexists with every v0.2 path untouched.
 *
 * Exit codes: 0 = delivered · 2 = parked · 3 = preflight refusal.
 *
 * Executor context (decided 2026-08-31, option (a)): `settingSources: []`
 * — full isolation like every v0.2 worker. Known asymmetry vs the bare
 * baseline (which read the project CLAUDE.md); the gate report must state
 * it. Option (b) (isolated config-dir loading ONLY the project CLAUDE.md)
 * stays available for rerunning disputed samples — a bare `['project']` is
 * ruled out because it also drags in the USER-level CLAUDE.md (probed
 * 2026-08-31).
 *
 * Park persistence (T4-review handover): a parked thin run lands a
 * tolerant queue entry — queue/<slug>/status = 'parked' plus a park.json
 * scene {kind: 'thin', ...} — so `park list` / `park show` surface it. The
 * scene points at the thin archive and the refs/thin/ snapshot; resolution
 * is manual by design in M1.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import config from '../../orchestrator/infra/config.js';
import { preflight } from '../../orchestrator/core/thin-preflight.js';
import {
  assembleGrade,
  runAcceptance,
  runSuite,
  scopeDiff,
} from '../../orchestrator/core/thin-acceptance.js';
import { runRedLoop } from '../../orchestrator/core/thin-loop.js';
import { writeThinArchive } from '../../orchestrator/core/thin-archive.js';
import { createParkSnapshot } from '../../orchestrator/core/park-snapshot.js';
import { writeParkScene } from '../../orchestrator/core/state.js';
import { SessionManager } from '../../orchestrator/infra/session-manager.js';

const EXECUTOR_INSTRUCTION =
  'Implement this spec and make the tests pass. Say DONE when finished.';

/** Slug from the spec filename: demo.spec.md -> demo. */
export function thinSlug(specPath) {
  return path
    .basename(specPath)
    .replace(/\.md$/, '')
    .replace(/\.spec$/, '');
}

/**
 * Persist a parked thin run as a tolerant queue entry so the existing
 * park surfaces (`park list` / `park show`) can see it.
 * Never throws; returns {ok, error?}.
 */
export function persistThinPark(projectRoot, slug, scene) {
  try {
    const entryDir = path.join(projectRoot, 'queue', slug);
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'status'), 'parked');
    writeParkScene(projectRoot, slug, scene);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `park persistence failed: ${err.message}` };
  }
}

/** Real git seam for the red loop (deps-injectable in tests). */
export function makeThinGit(projectRoot, slug, baseSha) {
  // 64MB maxBuffer: a mega-tree diff overflows the Node default (1MB) and
  // kills capturePatch with ENOBUFS (observed on the gate's 11th sample).
  const sh = (cmd) =>
    String(execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
  return {
    headSha: () => sh('git rev-parse HEAD').trim(),
    capturePatch: () => sh(`git -c core.quotePath=false diff --no-renames ${baseSha}`),
    snapshotTry: (label) => {
      // The slug is namespaced with the label so the pinned stash ref lands
      // NESTED (refs/thin/<slug>/<label>-stash). A flat refs/thin/<slug>
      // would D/F-conflict with snapshotHead's refs/thin/<slug>/<label>-head
      // and make `git update-ref` throw on any dirty-tree + moved-HEAD park.
      const snap = createParkSnapshot(`${slug}/${label}-stash`, projectRoot, 'refs/thin/');
      // createParkSnapshot stashes tracked+untracked (resetting the tree)
      // and pins the stash to a ref; a clean tree yields null (nothing to
      // preserve, nothing to roll back) — report null honestly rather than
      // fabricating a ref name that was never created.
      return snap ? snap.stashRef : null;
    },
    snapshotHead: (label) => {
      const ref = `refs/thin/${slug}/${label}-head`;
      sh(`git update-ref ${ref} HEAD`);
      return ref;
    },
    resetToBase: () => {
      sh(`git reset --hard ${baseSha}`);
      sh('git clean -fd');
    },
  };
}

/** Real executor factory: one reusable SDK session per fresh attempt. */
export function makeThinExecutors({ projectRoot, specText, sessionManager, onStat }) {
  let session = null;
  const options = () => ({
    name: 'thin-executor',
    agent: 'executor',
    cwd: projectRoot,
    settingSourcesOverride: [], // decided option (a): v0.2-style full isolation
  });
  const collect = (result) => {
    onStat({
      costUsd: result?.total_cost_usd ?? result?.totalCostUsd ?? null,
      durationMs: result?.duration_ms ?? null,
      turns: result?.num_turns ?? null,
      model: result?.model ?? result?.modelUsage ?? null,
    });
    return result;
  };
  return {
    executeFresh: async () => {
      if (session) {
        try {
          await session.close();
        } catch {
          /* old session already dead is fine */
        }
      }
      session = sessionManager.spawnReusable(options());
      return collect(await session.sendPrompt(`${specText}\n\n${EXECUTOR_INSTRUCTION}`));
    },
    executeFollowup: async ({ redList }) => {
      if (!session) throw new Error('no live session for the in-place fix');
      return collect(
        await session.sendPrompt(
          `These acceptance checks fail:\n\n${redList.join('\n')}\n\nPlease fix them. Say DONE when finished.`
        )
      );
    },
    close: async () => {
      if (session) {
        try {
          await session.close();
        } catch {
          /* best effort */
        }
      }
    },
  };
}

/**
 * The thin command. All moving parts injectable via `deps` for tests; the
 * defaults wire the real engine.
 *
 * @returns {Promise<number>} exit code (0 delivered / 2 parked / 3 refused)
 */
export async function thinCommand(specPath, projectRoot, deps = {}) {
  const log = deps.log ?? console.log;
  const d = {
    preflight: deps.preflight ?? preflight,
    runRedLoop: deps.runRedLoop ?? runRedLoop,
    writeThinArchive: deps.writeThinArchive ?? writeThinArchive,
    persistThinPark: deps.persistThinPark ?? persistThinPark,
    makeGit: deps.makeGit ?? makeThinGit,
    makeExecutors: deps.makeExecutors,
    grader: deps.grader,
    now: deps.now ?? (() => Date.now()),
  };

  const pf = d.preflight(specPath, projectRoot);
  if (!pf.ok) {
    log('run: refusing to start:');
    for (const r of pf.refusals) log(`  - ${r}`);
    return 3;
  }
  for (const w of pf.warnings ?? []) log(`run: warning: ${w}`);

  const slug = thinSlug(specPath);
  const specText = fs.readFileSync(pf.inputs.specMd, 'utf8');
  const mech = { acceptance: 0, suite: 0, orchestration: 0 };
  const tryStats = [];

  const grader =
    d.grader ??
    (() => {
      const t0 = d.now();
      const acceptance = runAcceptance(pf.inputs.acceptPath, projectRoot);
      const t1 = d.now();
      // The engine config's testAllCommand is an npm default; a non-Node
      // TARGET project must pass its own via --suite (e.g. 'python -m
      // pytest -q'), else the suite would false-red every round.
      const suite = runSuite(projectRoot, deps.suiteCommand ?? config.execution.testAllCommand);
      const t2 = d.now();
      const scope = scopeDiff(projectRoot, pf.baseSha, pf.targetFiles);
      mech.acceptance += t1 - t0;
      mech.suite += t2 - t1;
      // orchestration is NOT accumulated here: it is derived at the end as
      // elapsed - sessions - acceptance - suite, so that snapshots, resets,
      // session spawning and scope diffing all land in the bucket instead
      // of being silently dropped (the gate's premium row runs on the sum).
      return assembleGrade({ acceptance, suite, scope });
    });

  let executors;
  let sessionManager = null;
  if (d.makeExecutors) {
    executors = d.makeExecutors({ projectRoot, specText, model: deps.modelId, onStat: (s) => tryStats.push(s) });
  } else {
    sessionManager = new SessionManager();
    executors = makeThinExecutors({
      projectRoot,
      specText,
      sessionManager,
      onStat: (s) => tryStats.push(s),
    });
  }

  const startedAt = d.now();
  let outcome;
  try {
    outcome = await d.runRedLoop({
      baseSha: pf.baseSha,
      executeFresh: executors.executeFresh,
      executeFollowup: executors.executeFollowup,
      grade: grader,
      git: d.makeGit(projectRoot, slug, pf.baseSha),
      record: (t) => log(`run: ${t.from} -> ${t.to}: ${t.reason}`),
    });
  } finally {
    if (executors.close) await executors.close();
  }

  const elapsedMs = d.now() - startedAt;
  {
    const sessionWallMs = tryStats.reduce((a, s) => a + (s.durationMs ?? 0), 0);
    mech.orchestration = Math.max(0, elapsedMs - sessionWallMs - mech.acceptance - mech.suite);
  }

  let finalDiffStat = '';
  try {
    finalDiffStat = String(
      execSync(`git -c core.quotePath=false diff --no-renames --stat ${pf.baseSha}`, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  } catch {
    /* diff stat is best-effort forensic garnish */
  }

  const archived = d.writeThinArchive({
    projectRoot,
    slug,
    specMdPath: pf.inputs.specMd,
    specJsonPath: pf.inputs.specJson,
    acceptPath: pf.inputs.acceptPath,
    baseSha: pf.baseSha,
    modelId: deps.modelId ?? tryStats.find((t) => typeof t.model === 'string')?.model ?? 'session-default',
    loopOutcome: outcome,
    tryStats,
    mechTimingsMs: mech,
    totalElapsedMs: elapsedMs,
    finalDiffStat,
  });
  if (!archived.ok) log(`run: WARNING — ${archived.error}`);
  else log(`run: archived ${archived.archiveDir} (${Math.round((d.now() - startedAt) / 1000)}s total)`);

  if (outcome.outcome === 'parked') {
    const stashRef = outcome.transitions.find((t) => t.snapshotRef)?.snapshotRef ?? null;
    let stashSha = null;
    if (stashRef) {
      try {
        stashSha = String(
          execSync(`git rev-parse --verify ${stashRef}`, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        ).trim();
      } catch {
        /* an injected/unresolvable ref stays sha-less; scene keeps the ref */
      }
    }
    const parked = d.persistThinPark(projectRoot, slug, {
      kind: 'thin',
      reason: outcome.parkReason,
      suspectedAcceptanceDefects: outcome.suspectedAcceptanceDefects,
      stashRef,
      stashSha,
      headRef: outcome.transitions.find((t) => t.headRef)?.headRef ?? null,
      archiveDir: archived.archiveDir,
      parkedAt: new Date(d.now()).toISOString(),
    });
    if (!parked.ok) log(`run: WARNING — ${parked.error}`);
    log(`run: PARKED — ${outcome.parkReason}`);
    return 2;
  }
  log('run: DELIVERED');
  return 0;
}
