import fs from 'fs';
import path from 'path';
import { Pipeline } from '../../orchestrator/core/pipeline.js';
import { InfrastructureError } from '../../orchestrator/infra/session-manager.js';
import { usage as printUsage, renderSmallTaskCostSummary } from './usage.js';
import { askYesNo, askMenu } from '../prompt.js';
import { infraErrorHint } from '../infra-hint.js';
import { harnessRoot } from '../../orchestrator/core/run-context.js';

/**
 * task command — run a single ad-hoc task described as a plain string.
 *
 * Wraps the description in a minimal spec, writes it to a tmp file,
 * then invokes the pipeline in small-task mode. The tmp spec is always
 * removed in a finally block regardless of pipeline outcome.
 *
 */
export async function task(projectRoot, description, flags) {
  const harnessDir = harnessRoot(projectRoot);

  // Ensure .harness/ directory exists so we can write the tmp spec there
  if (!fs.existsSync(harnessDir)) {
    const autoMode = flags.auto || flags.a;
    if (autoMode) {
      console.log('No .harness/ found. Initializing...');
    } else {
      const confirm = await askYesNo(
        `No .harness/ found in ${projectRoot}. Initialize? (y/n) `
      );
      if (!confirm) {
        console.log('Aborted.');
        process.exit(0);
      }
    }
    fs.mkdirSync(harnessDir, { recursive: true });
  }

  // Write a synthetic minimal spec to a timestamped tmp file
  const timestamp = Date.now();
  const tmpSpecPath = path.join(harnessDir, `tmp-spec-${timestamp}.md`);
  const specContent = `# Task: ${description}

## Description

${description}

## Success Criteria

- [ ] ${description}
`;
  fs.writeFileSync(tmpSpecPath, specContent, 'utf8');

  const pipeline = createPipeline(projectRoot, flags);

  try {
    const result = await pipeline.run(
      `Implement the task described at ${tmpSpecPath}`,
      { prdPath: tmpSpecPath, mode: 'small-task' }
    );
    console.log('\n=== Task Complete ===');
    if (result) {
      renderSmallTaskCostSummary(pipeline.tokenTracker, result.runStartSessionCount);
      printUsage(pipeline.projectRoot, { runStartSessionCount: result.runStartSessionCount });
    }
  } catch (err) {
    if (err instanceof InfrastructureError) {
      console.error(`\nInfrastructure error: ${err.message}\n${infraErrorHint({ batch: false, projectRoot })}`);
      process.exit(75);
    }
    console.error(`\nPipeline error: ${err.message}`);
    process.exit(1);
  } finally {
    // Copy spec content into harness for archive auditability before deleting.
    // Update state.json prdPath to point to the archived copy so resume/archive
    // can find the spec after the tmp file is gone.
    try {
      const archiveSpecPath = path.join(pipeline.harnessDir, 'tmp-spec-archived.md');
      if (fs.existsSync(tmpSpecPath)) {
        fs.copyFileSync(tmpSpecPath, archiveSpecPath);
        // Update prdPath in state.json to the archived copy
        const stateJsonPath = path.join(pipeline.harnessDir, 'state.json');
        if (fs.existsSync(stateJsonPath)) {
          const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
          if (state.projectMeta) {
            state.projectMeta.prdPath = archiveSpecPath;
            fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2), 'utf8');
          }
        }
      }
    } catch {
      // Non-critical
    }
    // Always remove the tmp spec file
    if (fs.existsSync(tmpSpecPath)) {
      fs.unlinkSync(tmpSpecPath);
    }
  }
}

function createPipeline(projectRoot, flags) {
  const autoMode = flags.auto || flags.a;

  const noReview = !!(flags['no-review']);
  if (noReview) {
    console.warn('--no-review is deprecated and now ignored; the review gate always runs (it auto-accepts on a clean PASS under --auto).');
  }

  const allowIncompleteScope = !!(flags['allow-incomplete-scope']);

  const opts = {
    onLog: console.log,
    onConfirm: autoMode
      ? async () => true
      : async (question, askOpts) => askYesNo(`${question} (y/n) `, askOpts),
    onMenu: autoMode
      ? async (_question, options) => (options ? options[0].key : null)
      : async (question, options, askOpts) => askMenu(question, options, askOpts),
  };

  if (allowIncompleteScope) {
    opts.allowIncompleteScope = true;
  }

  const pipeline = new Pipeline(projectRoot, opts);
  pipeline.autoFromHere = autoMode;
  return pipeline;
}
