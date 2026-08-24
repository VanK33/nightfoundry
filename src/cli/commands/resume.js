import path from 'path';
import { displayName } from '../../orchestrator/infra/display-name.js';
import { Pipeline } from '../../orchestrator/core/pipeline.js';
import { InfrastructureError } from '../../orchestrator/infra/session-manager.js';
import { askYesNo, askMenu } from '../prompt.js';
import { readState, isUnresumableState } from '../../orchestrator/core/state.js';
import {
  activeHarnessDir,
  runHarnessDir,
  readActiveRunPointer,
  clearActiveRunPointer,
  activeRunPointerPath,
} from '../../orchestrator/core/run-context.js';
import { infraErrorHint } from '../infra-hint.js';

export async function resume(projectRoot, flags) {
  const autoMode = flags.auto || flags.a;

  const noReview = !!(flags['no-review']);
  if (noReview) {
    console.warn('--no-review is deprecated and now ignored; the review gate always runs (it auto-accepts on a clean PASS under --auto).');
  }

  const allowIncompleteScope = !!(flags['allow-incomplete-scope']);

  const pipelineOpts = {
    onLog: console.log,
    onConfirm: autoMode
      ? async () => true
      : async (question, askOpts) => askYesNo(`${question} (y/n) `, askOpts),
    onMenu: autoMode
      ? async (_question, options) => (options ? options[0].key : null)
      : async (question, options, askOpts) => askMenu(question, options, askOpts),
    statusBar: true,
  };

  if (allowIncompleteScope) {
    pipelineOpts.allowIncompleteScope = true;
  }

  if (!flags.batch) {
    try {
      const harnessDir = activeHarnessDir(projectRoot);
      const state = readState(harnessDir);
      if (isUnresumableState(state)) {
        // Best-effort pointer-scoped auto-clear: only remove the active-run
        // pointer when it is currently held AND it names this very run (the
        // one whose state was just read as unresumable). Never touch a
        // pointer that is absent, unparseable, or names a different run.
        const pointer = readActiveRunPointer(projectRoot);
        const heldRunId = (pointer && typeof pointer.runId === 'string' && pointer.runId.length > 0)
          ? pointer.runId
          : null;
        const pointerPath = activeRunPointerPath(projectRoot);
        let cleared = false;
        if (heldRunId && runHarnessDir(projectRoot, heldRunId) === harnessDir) {
          clearActiveRunPointer(projectRoot);
          cleared = true;
        }
        // cleared / heldRunId / pointerPath are captured here for the
        // resume-recovery message; the pointer clear itself is best-effort
        // and must never block falling through to the exit(76) below.
        const currentPhase = state && state.projectMeta && state.projectMeta.currentPhase;
        const milestoneCount = state && state.milestones ? Object.keys(state.milestones).length : 0;
        let message =
          `Cannot resume: state.projectMeta.currentPhase is "${currentPhase}" with ${milestoneCount} milestones recorded.\n`;
        if (cleared) {
          message +=
            `Stale active-run pointer at ${pointerPath} (runId: ${heldRunId}) was cleared.\n`;
        }
        message += `Recovery: run \`${displayName()} run <spec-path>\` to start a fresh run.
`;
        process.stderr.write(message);
        process.exit(76);
      }
    } catch (_err) {
      // state.json missing or unreadable — fall through to Pipeline (which handles it)
    }
  }

  const pipeline = new Pipeline(projectRoot, pipelineOpts);
  pipeline.autoFromHere = autoMode;

  try {
    const batchMode = !!(flags.batch);
    let result;
    if (batchMode) {
      result = await pipeline.batchResume();
      console.log('\n=== Batch Resume Complete ===');
      if (result && result.summary) {
        console.log(result.summary);
      }
    } else {
      result = await pipeline.resume();
      console.log('\n=== Resume Complete ===');
      // Note: "This Run" cost summary is emitted by Pipeline._emitRunCostSummary()
      // before archive teardown wipes .harness/logs/token-usage.json. Calling
      // printUsage here would read from a freshly-initialized empty token-usage
      // file post-archive and produce a negative session count.
    }
  } catch (err) {
    if (err instanceof InfrastructureError) {
      console.error(infraErrorHint({ batch: flags.batch, projectRoot }));
      process.exit(75);
    }
    console.error(`\nResume error: ${err.message}`);
    process.exit(1);
  }
}
