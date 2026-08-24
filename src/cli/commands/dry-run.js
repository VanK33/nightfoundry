import fs from 'fs';
import path from 'path';
import { Pipeline, copyBundleToQueueEntry } from '../../orchestrator/core/pipeline.js';
import { usage as printUsage } from './usage.js';
import { askYesNo, askMenu } from '../prompt.js';
import { isUserSpecInvocation, prepareUserSpecInput, warnOnEngineSpecJson } from '../user-spec-input.js';
import { emitCliFailureCandidate } from '../../orchestrator/core/candidates-ledger.js';

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

export async function dryRun(projectRoot, specPath, flags) {
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

  // w4-batch-failure-input-boundary Fix #3: reject non-.md spec inputs at the
  // dry-run boundary with an honest error naming the requirement. A non-.md
  // path makes deriveSpecJsonPath fall back to <projectRoot>/spec.json, so a
  // non-.md dry-run would COPY an unrelated project-root spec.json into the
  // queue entry AND UNLINK it from the root — an unrelated spec's json destroyed
  // at its canonical location. Rejecting here (output-side) kills the vector.
  if (!resolvedSpec.endsWith('.md')) {
    console.error(
      `Spec input must be a .md file: ${resolvedSpec}\n` +
      `cc-orch dry-run requires a Markdown spec (its sibling spec.json carries the ` +
      `verification criteria). A non-.md path would attach an unrelated project-root ` +
      `spec.json to the queue entry.`
    );
    process.exit(1);
  }

  if (!userSpecInvocation) {
    warnOnEngineSpecJson(resolvedSpec, projectRoot, { warn: console.warn });
  }

  const pipeline = createPipeline(projectRoot, flags);

  try {
    const result = await pipeline.dryRunValidate(`Implement the spec at ${resolvedSpec}`, { prdPath: resolvedSpec, auto: !!(flags.auto || flags.a) });
    if (result && result.queued === false) {
      console.error(`\nSpec validation failed: ${result.reason}`);
      process.exit(1);
    } else {
      console.log('\nSpec validated and queued. Run cc-orch resume --batch to execute.');
    }
  } catch (err) {
    try {
      emitCliFailureCandidate(projectRoot, { phase: 'dry-run', err, specPath: resolvedSpec });
    } catch (ledgerErr) {
      console.warn(`Failed to append candidate to candidates.jsonl: ${ledgerErr.message}`);
    }
    console.error(`\nPipeline error: ${err.message}`);
    process.exit(1);
  }
}

// Re-export for external importers/tests that reference copyBundleToQueueEntry
// from dry-run.js (the function lives in pipeline.js; this seam exposes the
// queue-finalize bundle-copy path dry-run invokes for direct testing).
export { copyBundleToQueueEntry };

function createPipeline(projectRoot, flags) {
  const autoMode = flags.auto || flags.a;
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
