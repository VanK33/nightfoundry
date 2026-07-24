import fs from 'fs';
import path from 'path';
import { Pipeline } from '../../orchestrator/core/pipeline.js';
import { InfrastructureError } from '../../orchestrator/infra/session-manager.js';
import { usage as printUsage, renderRunCostSummary } from './usage.js';
import { askYesNo, askMenu } from '../prompt.js';
import { isUserSpecInvocation, prepareUserSpecInput, warnOnEngineSpecJson } from '../user-spec-input.js';
import { harnessRoot } from '../../orchestrator/core/run-context.js';
import { infraErrorHint } from '../infra-hint.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function run(projectRoot, specPath, flags) {
  const userSpecInvocation = isUserSpecInvocation(specPath, flags);
  if (userSpecInvocation) {
    specPath = await prepareUserSpecInput({
      projectRoot,
      specPath,
      flags,
      readStdin,
      log: console.log,
      warn: console.warn,
    });
  }

  const resolvedSpec = path.resolve(specPath);

  if (!fs.existsSync(resolvedSpec)) {
    console.error(`Spec file not found: ${resolvedSpec}`);
    process.exit(1);
  }

  if (!userSpecInvocation) {
    warnOnEngineSpecJson(resolvedSpec, projectRoot, { warn: console.warn });
  }

  // Check .harness/ — init if missing, with confirmation
  const autoMode = flags.auto || flags.a;
  // Runs live in .harness/run-{id}/ and no flat .harness/state.json is ever
  // written, so keying this first-run gate on state.json would re-prompt
  // "Initialize?" on every run. The shared .harness/ skeleton is the durable
  // "this root has been initialized" signal.
  const harnessExists = fs.existsSync(harnessRoot(projectRoot));
  if (!harnessExists) {
    if (autoMode) {
      console.log('No .harness/ found. Initializing...');
    } else {
      const confirm = await askYesNo(`No .harness/ found in ${projectRoot}. Initialize? (y/n) `);
      if (!confirm) {
        console.log('Aborted.');
        process.exit(0);
      }
    }
  }

  const pipeline = createPipeline(projectRoot, flags);

  try {
    const result = await pipeline.run(`Implement the spec at ${resolvedSpec}`, { prdPath: resolvedSpec, auto: autoMode });
    console.log('\n=== Pipeline Complete ===');
    if (result) {
      renderRunCostSummary(pipeline.tokenTracker, result.runStartSessionCount);
      printUsage(pipeline.projectRoot, { runStartSessionCount: result.runStartSessionCount });
    }
  } catch (err) {
    if (err instanceof InfrastructureError) {
      console.error(infraErrorHint({ batch: false, projectRoot }));
      process.exit(75);
    }
    console.error(`\nPipeline error: ${err.message}`);
    process.exit(1);
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
    statusBar: true,
  };

  if (allowIncompleteScope) {
    opts.allowIncompleteScope = true;
  }

  const pipeline = new Pipeline(projectRoot, opts);
  pipeline.autoFromHere = autoMode;
  return pipeline;
}
