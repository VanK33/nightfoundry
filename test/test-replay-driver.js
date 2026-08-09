/**
 * test-replay-driver.js — Fixture-building unit tests for the (forthcoming)
 * replay driver.
 *
 * This file owns the standard PASS/FAIL test(name, fn) harness used across
 * the suite, plus a buildMiniArchive(rootDir) helper that assembles a
 * throwaway mini-archive under fs.mkdtempSync(rootDir) from trimmed-recording
 * constants declared in this file: a spec pair, one state/mission-*.json,
 * verification/ ground-truth files, and logs/*.jsonl session recordings for
 * an executor, a verifier, a reviewer, an analyzer and a remediation
 * planner. The recording/spec/state/verification constants below were
 * trimmed down from real archive 223 (223-planner-session-rotation-spec)
 * while this file was written, then embedded verbatim as constants here —
 * this file imports nothing from, and reads nothing under, the repo's
 * top-level archives directory.
 *
 * Run: node test/test-replay-driver.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { buildReplayDeps } from '../scripts/replay-archive.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';

// This file's own directory, resolved from import.meta.url so the driver
// script path below is correct regardless of the process's cwd.
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const REPLAY_ARCHIVE_SCRIPT = path.join(__dirname, '..', 'scripts', 'replay-archive.js');

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ---------- Trimmed-recording fixture constants (sourced from archive 223) ----------

const SPEC_MD = `# Spec: Planner session rotation — cap the reusable session's history via K-mission / token-tier rotation with a deterministic digest reseed

## Goal

The planner decomposes all missions in ONE reusable session, so turn k re-reads the full accumulated history — planner cost grows ~quadratically with mission count (measured twice: run 164 planner = 61% of $202; quant_bot 2026-08-06 planner = ~63% of $54.78, turn 5/6 at $5-7 each). This spec adds session ROTATION: at mission boundaries only, the planner retires the current reusable session and opens a fresh one when EITHER the session has planned K missions (default 3) OR the session's context size crosses a hard token threshold; the fresh session is reseeded with a compact, deterministically-built digest of all previously planned missions so cross-mission awareness (duplicate-deliverable and missing-dependency-edge prevention) survives the reset.

## Scope — in

1. **Config tiers** — update \`config.tokens\` (config.js:93-96) from the dead \`{warn: 150_000, forceNew: 180_000}\` (zero live callers, verified) to \`{warn: 80_000, forceNew: 100_000, alarm: 120_000, rotationMissionCount: 3}\`.
   - src/orchestrator/infra/config.js
`;

const SPEC_JSON = {
  goal: "Add planner session ROTATION to cap the reusable planner session's quadratic history cost (measured twice: run 164 planner = 61% of $202; quant_bot 2026-08-06 planner ~63% of $54.78): at MISSION BOUNDARIES ONLY (inside _planMissionReusable, before _ensureReusableSession), the planner retires the current reusable session and lazily reopens a fresh one when EITHER the session has planned config.tokens.rotationMissionCount missions (default 3) OR the session context size crosses the force threshold.",
  target_files: [
    'src/orchestrator/infra/config.js',
    'src/orchestrator/infra/token-tracker.js',
    'src/orchestrator/agents/planner.js',
  ],
  acceptance_criteria: [
    {
      description:
        "The rotation mission-count knob exists in config.tokens.",
      verification: {
        kind: 'command',
        command: 'test $(grep -c "rotationMissionCount" src/orchestrator/infra/config.js) -ge 1',
        targetFile: 'src/orchestrator/infra/config.js',
      },
    },
    {
      description: 'The alarm-tier threshold helper exists in the token tracker.',
      verification: {
        kind: 'command',
        command: 'grep -c "shouldAlarm" src/orchestrator/infra/token-tracker.js',
        targetFile: 'src/orchestrator/infra/token-tracker.js',
      },
    },
  ],
  constraints: [],
};

// Trimmed from archive 223 (223-planner-session-rotation-spec), state/mission-001-001.json
const MISSION_STATE = {
  id: '001-001',
  missionId: '001-001',
  description: 'Trimmed fixture mission for replay-driver tests',
  status: 'complete',
  subMissions: {
    '001-001-001': {
      id: '001-001-001',
      description: 'Trimmed fixture sub-mission with two complete tasks',
      status: 'complete',
      tasks: {
        '001-001-001-001': {
          id: '001-001-001-001',
          description:
            "In src/orchestrator/infra/config.js, replace the `tokens` object's contents (currently `warn: 150_000, forceNew: 180_000`) so that after the change `config.tokens.warn === 80000`, `config.tokens.forceNew === 100000`, `config.tokens.alarm === 120000`, and `config.tokens.rotationMissionCount === 3`.",
          status: 'complete',
          createdAt: '2026-08-06T20:51:09.217Z',
          startedAt: '2026-08-06T20:57:52.569Z',
          completedAt: '2026-08-06T20:59:49.342Z',
          targetFiles: ['src/orchestrator/infra/config.js'],
          dependencies: [],
          testCases: [
            'config.tokens.warn evaluates to 80000',
            'config.tokens.forceNew evaluates to 100000',
          ],
          tracesScenario: ['config.tokens.warn/forceNew value changes (150k/180k -> 80k/100k) are behavior-neutral until wired'],
          patternReferences: [],
          dataSchemas: [],
          verifyFile: 'verify/task-001-001-001-001.json',
          progressFile: 'progress/task-001-001-001-001.json',
          verificationFile: 'verification/task-001-001-001-001.json',
          retryCount: 0,
        },
        '001-001-001-002': {
          id: '001-001-001-002',
          description:
            "In src/orchestrator/infra/token-tracker.js, add a `shouldAlarm(inputTokens)` method to the TokenTracker class, placed among the existing `shouldWarn`/`shouldForceNewSession` threshold helpers.",
          status: 'complete',
          createdAt: '2026-08-06T20:51:09.217Z',
          startedAt: '2026-08-06T20:59:49.345Z',
          completedAt: '2026-08-06T21:01:35.256Z',
          targetFiles: ['src/orchestrator/infra/token-tracker.js'],
          dependencies: [{ taskId: '001-001-001-001', type: 'hard' }],
          testCases: [
            'new TokenTracker(dir).shouldAlarm(120000) returns true (boundary is inclusive)',
            'shouldAlarm(119999) returns false',
          ],
          tracesScenario: [],
          patternReferences: [],
          dataSchemas: [],
          verifyFile: 'verify/task-001-001-001-002.json',
          progressFile: 'progress/task-001-001-001-002.json',
          verificationFile: 'verification/task-001-001-001-002.json',
          retryCount: 0,
        },
      },
    },
  },
};

// Trimmed from archive 223 (223-planner-session-rotation-spec), verification/review-milestone-001.json
const REVIEW_MILESTONE_001 = {
  result: 'FAILED',
  findings: [
    {
      severity: 'warning',
      category: 'contract-mismatch',
      tier: 'composition',
      disposition: 'pending',
      file: 'src/orchestrator/core/pipeline.js',
      relatedFiles: ['src/orchestrator/agents/planner.js'],
      description:
        "Pipeline._buildPriorMissionDigest() returns a plain JS OBJECT (digest[missionId] = {targetFiles, tasks}) and passes it directly as context.priorMissionDigest to this.planner.planMission(...) (pipeline.js ~line 4616). But planner.js's _planMissionReusable only treats the digest as usable when `typeof priorMissionDigest === 'string' && priorMissionDigest.trim().length > 0` (planner.js ~line 868).",
      dispositionReason: '',
    },
  ],
  notes:
    "The milestone's individual tasks are each internally consistent with their own task text, and the config/token-tracker/planner-internal rotation machinery composes correctly end-to-end and matches all seven declared acceptance criteria.",
  scopeCompliance: {
    verdict: 'within_scope',
    evidence:
      'git diff/status shows exactly the seven declared targetFiles modified (config.js, token-tracker.js, planner.js, pipeline.js, gotchas.md, run-tests.js, plus new test/test-planner-rotation.js) with no untracked/unexpected files.',
    exceededFiles: [],
  },
  uncoveredCriteria: [],
};

// Trimmed from archive 223 (223-planner-session-rotation-spec), verification/task-regression-001-001.json
const TASK_REGRESSION_001_001 = {
  result: 'PASSED',
  hardChecks: [
    {
      name: 'Config.tokens updated to new values',
      status: 'PASS',
      evidence:
        "grep -A 4 'tokens:' src/orchestrator/infra/config.js shows warn: 80_000, forceNew: 100_000, alarm: 120_000, rotationMissionCount: 3",
    },
    {
      name: 'shouldAlarm method added to TokenTracker',
      status: 'PASS',
      evidence: 'Lines 168-170 in token-tracker.js define shouldAlarm(inputTokens) returning inputTokens >= config.tokens.alarm',
    },
  ],
};

// Milestone-level regression ground truth — the replayed run persists its
// own task-regression-milestone-001.json after the milestone regression
// gate passes; mirroring it here keeps the baseline comparison clean so a
// tamper is the ONLY source of divergence.
const TASK_REGRESSION_MILESTONE_001 = {
  result: 'PASSED',
  hardChecks: [],
};

// ---------- logs/*.jsonl session recordings ----------
// Each recording is trimmed to an init line, one tool-call message line, a
// result line and an exit line — the exit line's data.result.structured_output
// is the field replay tooling reads back as the recorded agent verdict.

const EXECUTOR_LOG_NAME = '2026-08-06T20-57-52-574Z-executor-001-001-001-001.jsonl';
const EXECUTOR_LOG_CONTENT =
  '{"ts":"2026-08-06T20:58:08.568Z","type":"init","role":"executor","taskId":"001-001-001-001","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"a05ae392-3112-457c-8090-143d64437db9","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T20:58:13.134Z","type":"message","role":"executor","taskId":"001-001-001-001","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01X56RiC2z2rWRV76WMwzgZw","name":"Read","input":{"file_path":"src/orchestrator/infra/config.js"}}]},"session_id":"a05ae392-3112-457c-8090-143d64437db9"}}\n' +
  '{"ts":"2026-08-06T20:58:29.509Z","type":"result","role":"executor","taskId":"001-001-001-001","data":{"type":"result","subtype":"success","is_error":false,"session_id":"a05ae392-3112-457c-8090-143d64437db9","total_cost_usd":0.16513524999999998,"structured_output":{"status":"COMPLETED","summary":"Updated config.tokens in src/orchestrator/infra/config.js: replaced warn/forceNew values and added new alarm and rotationMissionCount literal constants, leaving all other config keys untouched.","affectedFiles":[{"path":"src/orchestrator/infra/config.js","reason":"Replaced tokens object contents: warn: 80_000, forceNew: 100_000, added alarm: 120_000 and rotationMissionCount: 3 as literal constants."}],"testsSummary":"Verified via node script that config.tokens.warn===80000, config.tokens.forceNew===100000, config.tokens.alarm===120000, config.tokens.rotationMissionCount===3."}}}\n' +
  '{"ts":"2026-08-06T20:58:29.509Z","type":"exit","role":"executor","taskId":"001-001-001-001","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"a05ae392-3112-457c-8090-143d64437db9","total_cost_usd":0.16513524999999998,"structured_output":{"status":"COMPLETED","summary":"Updated config.tokens in src/orchestrator/infra/config.js: replaced warn/forceNew values and added new alarm and rotationMissionCount literal constants, leaving all other config keys untouched.","affectedFiles":[{"path":"src/orchestrator/infra/config.js","reason":"Replaced tokens object contents: warn: 80_000, forceNew: 100_000, added alarm: 120_000 and rotationMissionCount: 3 as literal constants."}],"testsSummary":"Verified via node script that config.tokens.warn===80000, config.tokens.forceNew===100000, config.tokens.alarm===120000, config.tokens.rotationMissionCount===3."}}}}\n';

const VERIFIER_LOG_NAME = '2026-08-06T20-58-29-516Z-verifier-001-001-001-001.jsonl';
const VERIFIER_LOG_CONTENT =
  '{"ts":"2026-08-06T20:58:30.100Z","type":"init","role":"verifier","taskId":"001-001-001-001","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"b1a2c3d4-1111-2222-3333-444455556666","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T20:58:35.200Z","type":"message","role":"verifier","taskId":"001-001-001-001","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_02Y67SjD3a3sXWV87XNxahAx","name":"Bash","input":{"command":"grep -c \\"rotationMissionCount\\" src/orchestrator/infra/config.js"}}]},"session_id":"b1a2c3d4-1111-2222-3333-444455556666"}}\n' +
  '{"ts":"2026-08-06T20:58:55.027Z","type":"result","role":"verifier","taskId":"001-001-001-001","data":{"type":"result","subtype":"success","is_error":false,"session_id":"b1a2c3d4-1111-2222-3333-444455556666","total_cost_usd":0.04123,"structured_output":{"result":"PASSED","hardChecks":[{"name":"The rotation mission-count knob exists in config.tokens.","status":"PASS","evidence":"grep -c \\"rotationMissionCount\\" src/orchestrator/infra/config.js returned 1"}],"taskScopeChecks":[{"description":"config.tokens.warn === 80000 (literal constant defined in config.tokens object)","status":"PASS","evidence":"Node.js execution confirmed: warn: 80000"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]}}}}\n' +
  '{"ts":"2026-08-06T20:58:55.027Z","type":"exit","role":"verifier","taskId":"001-001-001-001","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"b1a2c3d4-1111-2222-3333-444455556666","total_cost_usd":0.04123,"structured_output":{"result":"PASSED","hardChecks":[{"name":"The rotation mission-count knob exists in config.tokens.","status":"PASS","evidence":"grep -c \\"rotationMissionCount\\" src/orchestrator/infra/config.js returned 1"}],"taskScopeChecks":[{"description":"config.tokens.warn === 80000 (literal constant defined in config.tokens object)","status":"PASS","evidence":"Node.js execution confirmed: warn: 80000"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]}}}}}\n';

const REVIEWER_LOG_NAME = '2026-08-06T21-50-11-244Z-reviewer-001.jsonl';
const REVIEWER_LOG_CONTENT =
  '{"ts":"2026-08-06T21:50:12.000Z","type":"init","role":"reviewer","taskId":null,"data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"c2b3d4e5-2222-3333-4444-555566667777","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:50:20.400Z","type":"message","role":"reviewer","taskId":null,"data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_03Z78TkE4b4tYXW98YOybBy1","name":"Grep","input":{"pattern":"priorMissionDigest"}}]},"session_id":"c2b3d4e5-2222-3333-4444-555566667777"}}\n' +
  '{"ts":"2026-08-06T22:00:53.154Z","type":"result","role":"reviewer","taskId":null,"data":{"type":"result","subtype":"success","is_error":false,"session_id":"c2b3d4e5-2222-3333-4444-555566667777","total_cost_usd":0.5891,"structured_output":{"result":"FAILED","findings":[{"severity":"warning","category":"contract-mismatch","tier":"composition","disposition":"pending","file":"src/orchestrator/core/pipeline.js","relatedFiles":["src/orchestrator/agents/planner.js"],"description":"Pipeline._buildPriorMissionDigest() returns a plain JS OBJECT and passes it directly as context.priorMissionDigest to planMission, but planner.js only treats the digest as usable when typeof priorMissionDigest === \\"string\\".","dispositionReason":""}],"notes":"The milestone composes correctly end-to-end except for one critical cross-file contract mismatch.","scopeCompliance":{"verdict":"within_scope","evidence":"git diff/status shows exactly the declared targetFiles modified.","exceededFiles":[]},"uncoveredCriteria":[]}}}\n' +
  '{"ts":"2026-08-06T22:00:53.154Z","type":"exit","role":"reviewer","taskId":null,"data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"c2b3d4e5-2222-3333-4444-555566667777","total_cost_usd":0.5891,"structured_output":{"result":"FAILED","findings":[{"severity":"warning","category":"contract-mismatch","tier":"composition","disposition":"pending","file":"src/orchestrator/core/pipeline.js","relatedFiles":["src/orchestrator/agents/planner.js"],"description":"Pipeline._buildPriorMissionDigest() returns a plain JS OBJECT and passes it directly as context.priorMissionDigest to planMission, but planner.js only treats the digest as usable when typeof priorMissionDigest === \\"string\\".","dispositionReason":""}],"notes":"The milestone composes correctly end-to-end except for one critical cross-file contract mismatch.","scopeCompliance":{"verdict":"within_scope","evidence":"git diff/status shows exactly the declared targetFiles modified.","exceededFiles":[]},"uncoveredCriteria":[]}}}}\n';

const ANALYZER_LOG_NAME = '2026-08-06T21-53-04-894Z-analyzer-reviewer-001.jsonl';
const ANALYZER_LOG_CONTENT =
  '{"ts":"2026-08-06T21:53:05.000Z","type":"init","role":"analyzer","taskId":"reviewer-001","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"d3c4e5f6-3333-4444-5555-666677778888","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:53:10.000Z","type":"message","role":"analyzer","taskId":"reviewer-001","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_04A89UlF5c5uZYX09ZPzcCz2","name":"Read","input":{"file_path":"src/orchestrator/core/pipeline.js"}}]},"session_id":"d3c4e5f6-3333-4444-5555-666677778888"}}\n' +
  '{"ts":"2026-08-06T21:55:08.211Z","type":"result","role":"analyzer","taskId":"reviewer-001","data":{"type":"result","subtype":"success","is_error":false,"session_id":"d3c4e5f6-3333-4444-5555-666677778888","total_cost_usd":0.3011,"structured_output":{"recommendation":"re_plan","failureType":"review","rootCause":"Cross-task contract mismatch on the priorMissionDigest key: the producer emits a plain JS object while the consumer only accepts a string, so the digest-injection feature is dead code in the wired system.","evidence":"VERIFIED BY DIRECT SOURCE READ: pipeline.js returns an OBJECT in every path; planner.js gates activation on typeof === \\"string\\".","affectedTasks":[{"taskId":"001-003-001-001","reason":"Direct producer of the defect.","action":"needs_revalidation"},{"taskId":"001-002-001-005","reason":"Direct consumer of the defect.","action":"needs_revalidation"}],"notes":"This is a decomposition defect, not an implementation defect."}}}\n' +
  '{"ts":"2026-08-06T21:55:08.211Z","type":"exit","role":"analyzer","taskId":"reviewer-001","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"d3c4e5f6-3333-4444-5555-666677778888","total_cost_usd":0.3011,"structured_output":{"recommendation":"re_plan","failureType":"review","rootCause":"Cross-task contract mismatch on the priorMissionDigest key: the producer emits a plain JS object while the consumer only accepts a string, so the digest-injection feature is dead code in the wired system.","evidence":"VERIFIED BY DIRECT SOURCE READ: pipeline.js returns an OBJECT in every path; planner.js gates activation on typeof === \\"string\\".","affectedTasks":[{"taskId":"001-003-001-001","reason":"Direct producer of the defect.","action":"needs_revalidation"},{"taskId":"001-002-001-005","reason":"Direct consumer of the defect.","action":"needs_revalidation"}],"notes":"This is a decomposition defect, not an implementation defect."}}}}\n';

const REMEDIATION_PLANNER_LOG_NAME = '2026-08-06T21-55-08-211Z-planner-review-remediate-001.jsonl';
const REMEDIATION_PLANNER_LOG_CONTENT =
  '{"ts":"2026-08-06T21:55:09.000Z","type":"init","role":"planner","taskId":null,"data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"e4d5f6a7-4444-5555-6666-777788889999","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:55:15.000Z","type":"message","role":"planner","taskId":null,"data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_05B90VmG6d6vAZY10AQadDz3","name":"Read","input":{"file_path":"src/orchestrator/core/pipeline.js"}}]},"session_id":"e4d5f6a7-4444-5555-6666-777788889999"}}\n' +
  '{"ts":"2026-08-06T21:56:51.893Z","type":"result","role":"planner","taskId":null,"data":{"type":"result","subtype":"success","is_error":false,"session_id":"e4d5f6a7-4444-5555-6666-777788889999","total_cost_usd":0.2277,"structured_output":{"newTasks":[{"id":"001-001-001-003","subMissionId":"001-001-001","description":"Fix the broken priorMissionDigest contract between the pipeline producer and the planner consumer, which currently makes the cross-mission reseeding feature a silent no-op in production.","targetFiles":["src/orchestrator/agents/planner.js"]}]}}}\n' +
  '{"ts":"2026-08-06T21:56:51.893Z","type":"exit","role":"planner","taskId":null,"data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"e4d5f6a7-4444-5555-6666-777788889999","total_cost_usd":0.2277,"structured_output":{"newTasks":[{"id":"001-001-001-003","subMissionId":"001-001-001","description":"Fix the broken priorMissionDigest contract between the pipeline producer and the planner consumer, which currently makes the cross-mission reseeding feature a silent no-op in production.","targetFiles":["src/orchestrator/agents/planner.js"]}]}}}}\n';

// Recording pair for the mission's SECOND task (001-001-001-002) — without
// it a full-pipeline replay exhausts the executor cursor as soon as the
// scheduler dispatches the second task (MISSION_STATE declares two tasks).
const EXECUTOR2_LOG_NAME = '2026-08-06T20-59-49-345Z-executor-001-001-001-002.jsonl';
const EXECUTOR2_LOG_CONTENT =
  '{"ts":"2026-08-06T21:00:02.100Z","type":"init","role":"executor","taskId":"001-001-001-002","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"f5e6a7b8-5555-6666-7777-888899990000","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:00:09.410Z","type":"message","role":"executor","taskId":"001-001-001-002","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_06C01WnH7e7wBAZ21BRbeEA4","name":"Read","input":{"file_path":"src/orchestrator/infra/token-tracker.js"}}]},"session_id":"f5e6a7b8-5555-6666-7777-888899990000"}}\n' +
  '{"ts":"2026-08-06T21:01:12.930Z","type":"result","role":"executor","taskId":"001-001-001-002","data":{"type":"result","subtype":"success","is_error":false,"session_id":"f5e6a7b8-5555-6666-7777-888899990000","total_cost_usd":0.1420115,"structured_output":{"status":"COMPLETED","summary":"Added a shouldAlarm(inputTokens) method to the TokenTracker class in src/orchestrator/infra/token-tracker.js, placed among the existing shouldWarn/shouldForceNewSession threshold helpers.","affectedFiles":[{"path":"src/orchestrator/infra/token-tracker.js","reason":"Added shouldAlarm(inputTokens) returning inputTokens >= config.tokens.alarm, alongside the existing threshold helpers."}],"testsSummary":"Verified via node script that new TokenTracker(dir).shouldAlarm(120000) === true and shouldAlarm(119999) === false."}}}\n' +
  '{"ts":"2026-08-06T21:01:12.930Z","type":"exit","role":"executor","taskId":"001-001-001-002","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"f5e6a7b8-5555-6666-7777-888899990000","total_cost_usd":0.1420115,"structured_output":{"status":"COMPLETED","summary":"Added a shouldAlarm(inputTokens) method to the TokenTracker class in src/orchestrator/infra/token-tracker.js, placed among the existing shouldWarn/shouldForceNewSession threshold helpers.","affectedFiles":[{"path":"src/orchestrator/infra/token-tracker.js","reason":"Added shouldAlarm(inputTokens) returning inputTokens >= config.tokens.alarm, alongside the existing threshold helpers."}],"testsSummary":"Verified via node script that new TokenTracker(dir).shouldAlarm(120000) === true and shouldAlarm(119999) === false."}}}}\n';

const VERIFIER2_LOG_NAME = '2026-08-06T21-01-12-935Z-verifier-001-001-001-002.jsonl';
const VERIFIER2_LOG_CONTENT =
  '{"ts":"2026-08-06T21:01:13.400Z","type":"init","role":"verifier","taskId":"001-001-001-002","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"a6f7b8c9-6666-7777-8888-999900001111","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:01:20.700Z","type":"message","role":"verifier","taskId":"001-001-001-002","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_07D12XoI8f8xCBA32CScfFB5","name":"Bash","input":{"command":"grep -n \\"shouldAlarm\\" src/orchestrator/infra/token-tracker.js"}}]},"session_id":"a6f7b8c9-6666-7777-8888-999900001111"}}\n' +
  '{"ts":"2026-08-06T21:01:35.250Z","type":"result","role":"verifier","taskId":"001-001-001-002","data":{"type":"result","subtype":"success","is_error":false,"session_id":"a6f7b8c9-6666-7777-8888-999900001111","total_cost_usd":0.03877,"structured_output":{"result":"PASSED","hardChecks":[{"name":"The dormant force-rotate helper is wired into the planner.","status":"PASS","evidence":"grep -c \\"shouldForceNewSession\\" src/orchestrator/agents/planner.js returned 2"}],"taskScopeChecks":[{"description":"new TokenTracker(dir).shouldAlarm(120000) returns true (boundary is inclusive)","status":"PASS","evidence":"Node.js execution confirmed: shouldAlarm(120000) === true, shouldAlarm(119999) === false"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]}}}}\n' +
  '{"ts":"2026-08-06T21:01:35.250Z","type":"exit","role":"verifier","taskId":"001-001-001-002","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"a6f7b8c9-6666-7777-8888-999900001111","total_cost_usd":0.03877,"structured_output":{"result":"PASSED","hardChecks":[{"name":"The dormant force-rotate helper is wired into the planner.","status":"PASS","evidence":"grep -c \\"shouldForceNewSession\\" src/orchestrator/agents/planner.js returned 2"}],"taskScopeChecks":[{"description":"new TokenTracker(dir).shouldAlarm(120000) returns true (boundary is inclusive)","status":"PASS","evidence":"Node.js execution confirmed: shouldAlarm(120000) === true, shouldAlarm(119999) === false"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]}}}}}\n';

// Mission-regression verifier recording — the per-mission regression gate
// spawns its own verifier session (identity 'verifier:regression-001-001')
// after the mission's tasks complete; without a recording for that key a
// full-pipeline replay exhausts at the gate. Verdict mirrors
// TASK_REGRESSION_001_001 (the sidecar the real gate persisted).
const REGRESSION_VERIFIER_LOG_NAME = '2026-08-06T21-34-56-097Z-verifier-regression-001-001.jsonl';
const REGRESSION_VERIFIER_LOG_CONTENT =
  '{"ts":"2026-08-06T21:34:56.500Z","type":"init","role":"verifier","taskId":"regression-001-001","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"b7a8c9d0-7777-8888-9999-000011112222","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T21:35:04.900Z","type":"message","role":"verifier","taskId":"regression-001-001","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_08E23YpJ9g9yDCB43DTdgGC6","name":"Bash","input":{"command":"grep -A 4 \\"tokens:\\" src/orchestrator/infra/config.js"}}]},"session_id":"b7a8c9d0-7777-8888-9999-000011112222"}}\n' +
  '{"ts":"2026-08-06T21:36:41.200Z","type":"result","role":"verifier","taskId":"regression-001-001","data":{"type":"result","subtype":"success","is_error":false,"session_id":"b7a8c9d0-7777-8888-9999-000011112222","total_cost_usd":0.05233,"structured_output":{"result":"PASSED","hardChecks":[{"name":"Config.tokens updated to new values","status":"PASS","evidence":"grep -A 4 \'tokens:\' src/orchestrator/infra/config.js shows warn: 80_000, forceNew: 100_000, alarm: 120_000, rotationMissionCount: 3"},{"name":"shouldAlarm method added to TokenTracker","status":"PASS","evidence":"Lines 168-170 in token-tracker.js define shouldAlarm(inputTokens) returning inputTokens >= config.tokens.alarm"}],"taskScopeChecks":[],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]},"findings":[]}}}\n' +
  '{"ts":"2026-08-06T21:36:41.200Z","type":"exit","role":"verifier","taskId":"regression-001-001","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"b7a8c9d0-7777-8888-9999-000011112222","total_cost_usd":0.05233,"structured_output":{"result":"PASSED","hardChecks":[{"name":"Config.tokens updated to new values","status":"PASS","evidence":"grep -A 4 \'tokens:\' src/orchestrator/infra/config.js shows warn: 80_000, forceNew: 100_000, alarm: 120_000, rotationMissionCount: 3"},{"name":"shouldAlarm method added to TokenTracker","status":"PASS","evidence":"Lines 168-170 in token-tracker.js define shouldAlarm(inputTokens) returning inputTokens >= config.tokens.alarm"}],"taskScopeChecks":[],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]},"findings":[]}}}}\n';

// Milestone-level regression verifier recording — after the reviewer gate
// passes, the milestone regression gate spawns one more verifier session
// (identity 'verifier:regression-milestone-001').
const MILESTONE_REGRESSION_VERIFIER_LOG_NAME = '2026-08-06T22-03-15-867Z-verifier-regression-milestone-001.jsonl';
const MILESTONE_REGRESSION_VERIFIER_LOG_CONTENT =
  '{"ts":"2026-08-06T22:03:16.200Z","type":"init","role":"verifier","taskId":"regression-milestone-001","data":{"type":"system","subtype":"init","cwd":"/repo","session_id":"c8b9d0e1-8888-9999-0000-111122223333","model":"claude-sonnet-5[1m]"}}\n' +
  '{"ts":"2026-08-06T22:03:24.600Z","type":"message","role":"verifier","taskId":"regression-milestone-001","data":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_09F34ZqK0h0zEDC54EUehHD7","name":"Bash","input":{"command":"grep -c \\"shouldAlarm\\" src/orchestrator/infra/token-tracker.js"}}]},"session_id":"c8b9d0e1-8888-9999-0000-111122223333"}}\n' +
  '{"ts":"2026-08-06T22:05:03.800Z","type":"result","role":"verifier","taskId":"regression-milestone-001","data":{"type":"result","subtype":"success","is_error":false,"session_id":"c8b9d0e1-8888-9999-0000-111122223333","total_cost_usd":0.06111,"structured_output":{"result":"PASSED","hardChecks":[],"taskScopeChecks":[{"description":"Both fixture tasks\' deliverables survive milestone composition","status":"PASS","evidence":"config.tokens carries all four rotation keys and TokenTracker exposes shouldAlarm alongside shouldWarn/shouldForceNewSession"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]},"findings":[]}}}\n' +
  '{"ts":"2026-08-06T22:05:03.800Z","type":"exit","role":"verifier","taskId":"regression-milestone-001","data":{"result":{"type":"result","subtype":"success","is_error":false,"session_id":"c8b9d0e1-8888-9999-0000-111122223333","total_cost_usd":0.06111,"structured_output":{"result":"PASSED","hardChecks":[],"taskScopeChecks":[{"description":"Both fixture tasks\' deliverables survive milestone composition","status":"PASS","evidence":"config.tokens carries all four rotation keys and TokenTracker exposes shouldAlarm alongside shouldWarn/shouldForceNewSession"}],"standardsChecks":[],"back_reference_check":{"spec_consulted":true,"plan_consulted":true,"deviations":[]},"findings":[]}}}}\n';

const ALL_RECORDINGS = [
  { name: EXECUTOR_LOG_NAME, content: EXECUTOR_LOG_CONTENT },
  { name: VERIFIER_LOG_NAME, content: VERIFIER_LOG_CONTENT },
  { name: EXECUTOR2_LOG_NAME, content: EXECUTOR2_LOG_CONTENT },
  { name: VERIFIER2_LOG_NAME, content: VERIFIER2_LOG_CONTENT },
  { name: REGRESSION_VERIFIER_LOG_NAME, content: REGRESSION_VERIFIER_LOG_CONTENT },
  { name: MILESTONE_REGRESSION_VERIFIER_LOG_NAME, content: MILESTONE_REGRESSION_VERIFIER_LOG_CONTENT },
  { name: REVIEWER_LOG_NAME, content: REVIEWER_LOG_CONTENT },
  { name: ANALYZER_LOG_NAME, content: ANALYZER_LOG_CONTENT },
  { name: REMEDIATION_PLANNER_LOG_NAME, content: REMEDIATION_PLANNER_LOG_CONTENT },
];

// ---------- Top-level state.json + per-task verdict ground truth ----------
// A replayable archive needs a top-level state.json: the replay driver's
// reconstructGlobalPlanFromArchive() rebuilds the Phase 3a global plan from
// its `milestones` map (and carries projectMeta.scopeMapping through for the
// scope-coverage gate) — without it, planGlobal()'s session raises
// RecordingExhaustedError on its first turn and no replay can even start.
// The mission's targetFiles claim every SPEC_JSON.target_files entry so the
// plan-scope lint sees a fully-mapped spec.
const STATE_JSON = {
  projectMeta: {
    prdPath: 'spec.md',
    currentPhase: 'complete',
    scopeItems: [
      { id: 's1', label: 'Config tiers', source: 'numbered-bold-item' },
    ],
    scopeMapping: [
      { scopeItemId: 's1', missionIds: ['001-001'] },
    ],
  },
  milestones: {
    '001': {
      id: '001',
      description: 'Trimmed fixture milestone for replay-driver tests',
      status: 'complete',
      missions: {
        '001-001': {
          id: '001-001',
          description: 'Trimmed fixture mission for replay-driver tests',
          targetFiles: [
            'src/orchestrator/infra/config.js',
            'src/orchestrator/infra/token-tracker.js',
            'src/orchestrator/agents/planner.js',
          ],
        },
      },
    },
  },
};

// Per-task verdict sidecars mirrored into verification/ so a replayed run's
// own task-<id>.json writes compare clean against recorded ground truth
// (replay-lib's readRecordedOutcomes keys verdicts by these basenames).
const TASK_VERDICT_001 = {
  result: 'PASSED',
  hardChecks: [
    {
      name: 'The rotation mission-count knob exists in config.tokens.',
      status: 'PASS',
      evidence: 'grep -c "rotationMissionCount" src/orchestrator/infra/config.js returned 1',
    },
  ],
};
const TASK_VERDICT_002 = {
  result: 'PASSED',
  hardChecks: [
    {
      name: 'The alarm-tier threshold helper exists in the token tracker.',
      status: 'PASS',
      evidence: 'grep -c "shouldAlarm" src/orchestrator/infra/token-tracker.js returned 2',
    },
  ],
};

/**
 * Build a throwaway mini-archive under a fresh fs.mkdtempSync directory
 * (rooted at rootDir) from the trimmed-recording constants declared above.
 *
 * Writes: spec.md, spec.json, a top-level state.json,
 * state/mission-001-001.json, verification/ ground-truth sidecars, and
 * logs/*.jsonl for two executor/verifier pairs, the mission- and
 * milestone-level regression verifiers, a reviewer, an analyzer and a
 * remediation planner.
 *
 * `reviewResult` sets the recorded milestone-review verdict CONSISTENTLY in
 * both places it lives — the reviewer's logs/*.jsonl exit event and the
 * verification/review-milestone-001.json ground-truth sidecar — so an
 * untampered replay always agrees with its own ground truth. Two callers
 * need opposite values and cannot share one fixture:
 *   - 'PASSED' (default): the replay runs to completion, so the driver
 *     exits 0 with no divergence (the untampered TC4/TC5 cases).
 *   - 'FAILED': lets a divergence case tamper the recording in the only
 *     direction that still reaches compareReplay — FAILED -> PASSED, which
 *     keeps the replay on the completion path. Tampering the other way
 *     trips the reviewer circuit breaker before any divergence is computed.
 *
 * @param {string} [rootDir] - directory under which the mkdtemp archive dir is created; defaults to os.tmpdir()
 * @param {{reviewResult?: 'PASSED'|'FAILED'}} [options]
 * @returns {string} the created archive directory's path
 */
export function buildMiniArchive(rootDir = os.tmpdir(), options = {}) {
  const { reviewResult = 'PASSED' } = options;
  const archiveDir = fs.mkdtempSync(path.join(rootDir, 'replay-driver-'));

  fs.writeFileSync(path.join(archiveDir, 'spec.md'), SPEC_MD);
  fs.writeFileSync(path.join(archiveDir, 'spec.json'), JSON.stringify(SPEC_JSON, null, 2));
  fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify(STATE_JSON, null, 2));

  const stateDir = path.join(archiveDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'mission-001-001.json'), JSON.stringify(MISSION_STATE, null, 2));

  const verificationDir = path.join(archiveDir, 'verification');
  fs.mkdirSync(verificationDir, { recursive: true });
  fs.writeFileSync(
    path.join(verificationDir, 'review-milestone-001.json'),
    JSON.stringify({ ...REVIEW_MILESTONE_001, result: reviewResult }, null, 2)
  );
  fs.writeFileSync(
    path.join(verificationDir, 'task-regression-001-001.json'),
    JSON.stringify(TASK_REGRESSION_001_001, null, 2)
  );
  fs.writeFileSync(
    path.join(verificationDir, 'task-regression-milestone-001.json'),
    JSON.stringify(TASK_REGRESSION_MILESTONE_001, null, 2)
  );
  fs.writeFileSync(
    path.join(verificationDir, 'task-001-001-001-001.json'),
    JSON.stringify(TASK_VERDICT_001, null, 2)
  );
  fs.writeFileSync(
    path.join(verificationDir, 'task-001-001-001-002.json'),
    JSON.stringify(TASK_VERDICT_002, null, 2)
  );

  const logsDir = path.join(archiveDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  for (const { name, content } of ALL_RECORDINGS) {
    // The reviewer recording's verdict must match the ground-truth sidecar
    // written above, so an untampered replay never diverges from itself.
    const written = name === REVIEWER_LOG_NAME
      ? content.split('"result":"FAILED"').join(`"result":"${reviewResult}"`)
      : content;
    fs.writeFileSync(path.join(logsDir, name), written);
  }

  return archiveDir;
}


// ---------- TC1: buildMiniArchive returns the expected directory shape ----------
await test('TC1 buildMiniArchive(tmp) returns a directory containing spec.md, spec.json, state/mission-*.json, verification/ and logs/*.jsonl', () => {
  const archiveDir = buildMiniArchive(os.tmpdir());
  try {
    assert.ok(fs.existsSync(path.join(archiveDir, 'spec.md')), 'Expected spec.md to exist');
    assert.ok(fs.existsSync(path.join(archiveDir, 'spec.json')), 'Expected spec.json to exist');

    const stateFiles = fs.readdirSync(path.join(archiveDir, 'state'));
    const missionFiles = stateFiles.filter((f) => /^mission-.*\.json$/.test(f));
    assert.ok(missionFiles.length >= 1, `Expected at least one state/mission-*.json, got: ${stateFiles.join(', ')}`);

    assert.ok(fs.existsSync(path.join(archiveDir, 'verification')), 'Expected verification/ to exist');
    assert.ok(fs.statSync(path.join(archiveDir, 'verification')).isDirectory(), 'Expected verification/ to be a directory');

    const logFiles = fs.readdirSync(path.join(archiveDir, 'logs'));
    const jsonlFiles = logFiles.filter((f) => f.endsWith('.jsonl'));
    assert.ok(jsonlFiles.length >= 1, `Expected at least one logs/*.jsonl file, got: ${logFiles.join(', ')}`);
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC2: every embedded recording constant carries an exit event with a structured_output ----------
await test('TC2 every embedded recording constant carries an exit event with a structured_output', () => {
  assert.strictEqual(ALL_RECORDINGS.length, 9, `Expected 9 embedded recordings (two executor/verifier pairs, mission and milestone regression verifiers, reviewer, analyzer, remediation planner), got ${ALL_RECORDINGS.length}`);

  for (const { name, content } of ALL_RECORDINGS) {
    const lines = content.trim().split('\n').map((line) => JSON.parse(line));
    const exitEvent = lines.find((line) => line.type === 'exit');
    assert.ok(exitEvent, `Expected an 'exit' event in recording ${name}`);
    assert.ok(
      exitEvent.data && exitEvent.data.result && exitEvent.data.result.structured_output,
      `Expected exit event in ${name} to carry data.result.structured_output, got: ${JSON.stringify(exitEvent)}`
    );
  }
});

// ---------- TC3: the module's source contains no path reference to the repo archives directory ----------
await test("TC3 the module's source contains no path reference to the repo archives directory", () => {
  const selfPath = new URL(import.meta.url).pathname;
  const source = fs.readFileSync(selfPath, 'utf8');
  // Built by concatenation so the forbidden token itself never appears as a
  // contiguous literal in this file's own source (which would trivially and
  // permanently fail this self-check).
  const forbiddenPathSegment = ['archives', '/'].join('');
  assert.ok(
    !source.includes(forbiddenPathSegment),
    'Expected the source to contain no repo-archives path reference'
  );
});

// ---------- TC2-divergence: tampered verdict → CLI exit 1 + divergence line ----------
await test('TC2-divergence tampered recorded verdict makes the driver exit 1 and report the diverging identity and field', async () => {
  // A FAILED-review fixture: the only tamper direction that still reaches
  // compareReplay is FAILED -> PASSED (see buildMiniArchive's docstring).
  const archiveDir = buildMiniArchive(os.tmpdir(), { reviewResult: 'FAILED' });
  try {
    // Tamper exactly one recorded agent verdict: the reviewer recording's
    // exit-event structured_output result, FAILED -> PASSED. Every other
    // fixture file stays byte-identical. This direction is deliberate: a
    // PASSED round-1 review keeps the replay on the plain completion path
    // (no remediation arc), so the run settles and compareReplay diffs the
    // replayed review conclusion against the archive's recorded FAILED —
    // whereas control-flow-altering tampers die in RecordingExhaustedError
    // before any divergence is computed.
    const logsDir = path.join(archiveDir, 'logs');
    const reviewerLog = fs.readdirSync(logsDir).find((f) => /-reviewer-001\.jsonl$/.test(f));
    assert.ok(reviewerLog, 'Expected a reviewer recording in the fixture');
    const reviewerLogPath = path.join(logsDir, reviewerLog);
    const lines = fs.readFileSync(reviewerLogPath, 'utf8').trim().split('\n');
    const tampered = lines.map((line) => {
      const event = JSON.parse(line);
      if (event.type !== 'exit') return line;
      assert.strictEqual(
        event.data.result.structured_output.result, 'FAILED',
        'Expected the recorded reviewer exit verdict to be FAILED before tampering'
      );
      event.data.result.structured_output.result = 'PASSED';
      return JSON.stringify(event);
    });
    fs.writeFileSync(reviewerLogPath, tampered.join('\n') + '\n');

    const child = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, archiveDir], { encoding: 'utf8' });

    assert.strictEqual(child.status, 1, `Expected exit status 1, got ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    const combined = `${child.stdout}\n${child.stderr}`;
    // The divergence line names the tampered recording's identity ('001',
    // the reviewer session's scope id as embedded in its recording
    // filename), the differing field, and the expected vs tampered values.
    assert.ok(
      combined.includes('001: result expected="FAILED" actual="PASSED"'),
      `Expected a divergence line naming identity 001 and field result, got:\n${combined}`
    );
    // The line must also name WHICH archive diverged — a report entry whose
    // archive resolves to null is unusable when probing a whole corpus.
    const divergenceLine = combined.split('\n').find((l) => l.includes('result expected='));
    assert.ok(
      divergenceLine && !divergenceLine.startsWith('[null]'),
      `Expected the divergence line to name its archive, got: ${divergenceLine}`
    );
    assert.ok(
      divergenceLine.startsWith(`[${path.basename(archiveDir)}]`),
      `Expected the divergence line to be prefixed with the archive id "${path.basename(archiveDir)}", got: ${divergenceLine}`
    );
  } finally {
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});

// ═══ Restored deliverables (2026-08-10) ═══
// The three blocks below were delivered by tasks 002-001-002-002 / -004 /
// -005 and then lost to successive whole-file rewrites of this shared
// file (each task's executor rewrote the file wholesale rather than
// appending). Recovered from harness snapshots and, for the probe cases,
// the -005 executor's recorded Edit payload.

// ---------- TC4: `node scripts/replay-archive.js <archiveDir>` over the untampered mini-archive exits 0 ----------
await test('TC4 replay-archive.js driver run over the untampered miniature archive exits 0', () => {
  const archiveDir = buildMiniArchive(os.tmpdir());
  try {
    const result = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, archiveDir], { encoding: 'utf8' });
    assert.strictEqual(
      result.status,
      0,
      `Expected the replay-archive.js driver to exit 0, got status ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`
    );
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC5: the driver's output reports no divergences over the untampered mini-archive ----------
await test("TC5 replay-archive.js driver's output over the untampered miniature archive contains no divergence line", () => {
  const archiveDir = buildMiniArchive(os.tmpdir());
  try {
    const result = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, archiveDir], { encoding: 'utf8' });
    const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`;
    const divergenceLine = combinedOutput.split('\n').find((line) => /divergence/i.test(line));
    assert.strictEqual(
      divergenceLine,
      undefined,
      `Expected no divergence line in the driver's output, found: ${JSON.stringify(divergenceLine)}`
    );
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC3: buildReplayDeps' dependency routing — predicate, snapshot and final-gate seams ----------
//
// Unlike TC1/TC2 above (which characterize the buildMiniArchive fixture
// itself), these three cases exercise scripts/replay-archive.js's
// buildReplayDeps() directly: (1) the shape of the deps object it returns,
// (2) that a real Pipeline actually calls whichever function occupies the
// predicate (assertChangesLanded) dependency slot — and that THAT
// function's own pass/fail return value, not any other signal, is what
// drives the task's downstream disposition, and (3) that the snapshot
// slots (snapshotFiles/restoreSnapshot) buildReplayDeps supplies are the
// ones actually invoked by the Pipeline, and that invoking them performs
// no on-disk snapshot work (no scripts/replay-archive.js code path shells
// out or reads/writes a real archive — see the module docstring).

/**
 * A bundle shape minimal enough for buildReplayDeps() to build every
 * dependency without throwing (createFakeSessionManager/
 * reconstructInitialPlansFromArchive only ever touch bundle.archiveDir at
 * spawn()-time, not at construction time — see replay-archive.js), while
 * never pointing at anything under the repo's real archives directory.
 *
 * @returns {{archiveDir:string, outcomes:{regression:Map}}}
 */
function buildMinimalDepsBundle() {
  return {
    archiveDir: path.join(os.tmpdir(), 'nonexistent-replay-driver-tc3-bundle'),
    outcomes: { regression: new Map() },
  };
}

/**
 * Builds a throwaway harness directory (state.json, one mission task,
 * verify.json sidecar, and the target file already present on disk) shaped
 * for driving Pipeline._executeAndVerifyTask directly — the same minimal
 * harness shape test-phantom-write-guard.js's createPipelineEnv uses.
 *
 * @param {string} [taskId]
 * @returns {{root:string, harnessDir:string, taskId:string, missionId:string, subMissionId:string, milestoneId:string}}
 */
function buildDependencyRoutingEnv(taskId = '001-001-001-001') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-driver-dep-routing-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }));

  const parts = taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const milestoneId = parts[0];

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'test milestone',
        status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'test mission',
            status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'test mission', {
    subMissions: [{
      id: subMissionId,
      description: 'test sm',
      tasks: [{
        id: taskId,
        description: 'test task for TC3 dependency-routing checks',
        targetFiles: ['src/foo.js'],
        dependencies: [],
        testCases: [],
      }],
    }],
  });

  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  // Pre-existing (in-before) target file, so a phantom-write probe-PASS
  // resolves to 'invalidated' (redundant) rather than 'failed'
  // (both-missing) — see pipeline.js's phantom-write probe branch.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/foo.js'), 'original content');

  return { root, harnessDir, taskId, missionId, subMissionId, milestoneId };
}

/**
 * Builds a real Pipeline against `root` using buildReplayDeps()'s own
 * dependency object as the constructor options — with ONLY the predicate
 * (assertChangesLanded) slot swapped for `assertChangesLandedSpy`, so the
 * snapshot (snapshotFiles/restoreSnapshot) and final-gate
 * (runFinalTestGate) slots stay exactly what buildReplayDeps supplied.
 * pipeline.executor/verifier/analyzer are replaced with scripted fakes
 * (same pattern as test-phantom-write-guard.js) purely so the run reaches
 * the predicate call deterministically, without spawning any session.
 *
 * @param {string} root
 * @param {{execResult:object, verifyResult:object, assertChangesLandedSpy:Function}} opts
 * @returns {{pipeline:Pipeline, deps:object}}
 */
function buildDependencyRoutingPipeline(root, { execResult, verifyResult, assertChangesLandedSpy }) {
  const deps = buildReplayDeps(buildMinimalDepsBundle());
  const pipeline = new Pipeline(root, {
    ...deps,
    assertChangesLanded: assertChangesLandedSpy,
    onLog: () => {},
    onConfirm: async () => true,
    statusBar: false,
  });
  pipeline.executor = {
    executeTask: async (task) => {
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: execResult.status, affectedFiles: execResult.affectedFiles || [] })
      );
      return execResult;
    },
  };
  pipeline.verifier = {
    verifyTask: async (task) => {
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, ...verifyResult })
      );
      return verifyResult;
    },
  };
  pipeline.analyzer = { analyzeFailure: async () => ({ eventId: 'fake-tc3', recommendation: 'human', affectedTasks: [] }) };
  return { pipeline, deps };
}

function readFinalTaskStatus(env) {
  const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
  return ms.subMissions[env.subMissionId].tasks[env.taskId].status;
}

await test('TC3 buildReplayDeps returns a deps object populating the predicate, snapshot and final-gate dependency slots', () => {
  const deps = buildReplayDeps(buildMinimalDepsBundle());
  assert.strictEqual(typeof deps.assertChangesLanded, 'function', 'Expected the predicate (assertChangesLanded) slot to be populated with a function');
  assert.strictEqual(typeof deps.snapshotFiles, 'function', 'Expected the snapshot-capture (snapshotFiles) slot to be populated with a function');
  assert.strictEqual(typeof deps.restoreSnapshot, 'function', 'Expected the snapshot-restore (restoreSnapshot) slot to be populated with a function');
  assert.strictEqual(typeof deps.runFinalTestGate, 'function', 'Expected the final-gate (runFinalTestGate) slot to be populated with a function');
});

await test('TC3 the pipeline calls the injected predicate and the disposition follows the verdict it returns', async () => {
  // Case A: predicate returns a PASS verdict (ok:true) — the disposition
  // this drives is the task ending 'complete'.
  const envPass = buildDependencyRoutingEnv();
  const passCalls = [];
  const predicatePass = (harnessDir, projectRoot, taskId, files) => {
    const verdict = { ok: true, unchanged: [], bothMissing: [] };
    passCalls.push({ args: [harnessDir, projectRoot, taskId, files], returned: verdict });
    return verdict;
  };
  try {
    const { pipeline } = buildDependencyRoutingPipeline(envPass.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
      assertChangesLandedSpy: predicatePass,
    });
    await pipeline._executeAndVerifyTask(envPass.missionId, envPass.subMissionId, {
      id: envPass.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    assert.ok(passCalls.length >= 1, 'Expected the pipeline to call the injected predicate at least once');
    assert.strictEqual(passCalls[0].returned.ok, true, 'Expected the injected predicate to have returned a pass verdict (ok:true)');
    assert.strictEqual(readFinalTaskStatus(envPass), 'complete', 'Expected a pass verdict from the injected predicate to drive the task to complete');
  } finally {
    fs.rmSync(envPass.root, { recursive: true, force: true });
  }

  // Case B: predicate returns a FAIL verdict (ok:false, nothing "unchanged"
  // both-missing since the declared file pre-exists on disk) — the
  // disposition this drives is the task ending 'invalidated' (redundant)
  // instead — a DIFFERENT downstream disposition from Case A, driven
  // purely by the predicate's own return value.
  const envFail = buildDependencyRoutingEnv();
  const failCalls = [];
  const predicateFail = (harnessDir, projectRoot, taskId, files) => {
    const verdict = { ok: false, unchanged: files, bothMissing: [] };
    failCalls.push({ args: [harnessDir, projectRoot, taskId, files], returned: verdict });
    return verdict;
  };
  try {
    const { pipeline } = buildDependencyRoutingPipeline(envFail.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
      assertChangesLandedSpy: predicateFail,
    });
    await pipeline._executeAndVerifyTask(envFail.missionId, envFail.subMissionId, {
      id: envFail.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    assert.ok(failCalls.length >= 1, 'Expected the pipeline to call the injected predicate at least once');
    assert.strictEqual(failCalls[0].returned.ok, false, 'Expected the injected predicate to have returned a fail verdict (ok:false)');
    assert.strictEqual(readFinalTaskStatus(envFail), 'invalidated', 'Expected a fail verdict from the injected predicate to drive a different disposition (invalidated) than Case A (complete)');
  } finally {
    fs.rmSync(envFail.root, { recursive: true, force: true });
  }
});

await test('TC3 the injected snapshot dependencies are the ones invoked, and they return without doing external work', async () => {
  const env = buildDependencyRoutingEnv();
  const snapshotFilesCalls = [];
  try {
    const deps = buildReplayDeps(buildMinimalDepsBundle());
    const wrappedSnapshotFiles = (...args) => {
      snapshotFilesCalls.push(args);
      return deps.snapshotFiles(...args);
    };
    const pipeline = new Pipeline(env.root, {
      ...deps,
      snapshotFiles: wrappedSnapshotFiles,
      onLog: () => {},
      onConfirm: async () => true,
      statusBar: false,
    });
    pipeline.executor = {
      executeTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, status: 'COMPLETED', affectedFiles: ['src/foo.js'] })
        );
        return { status: 'COMPLETED', affectedFiles: ['src/foo.js'] };
      },
    };
    pipeline.verifier = {
      verifyTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, report: 'ok' })
        );
        return { verified: true, report: 'ok' };
      },
    };
    // A pass verdict from the injected predicate (matching buildReplayDeps'
    // own always-pass assertChangesLanded) keeps the run OFF the
    // phantom-write probe route (see TC3 above), so it reaches the normal
    // completion path, which invokes the injected snapshotFiles (the
    // 'after' snapshot) — see pipeline.js's post-verification snapshot call.

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });

    assert.ok(snapshotFilesCalls.length >= 1, 'Expected the pipeline to invoke the injected snapshotFiles dependency');
    assert.ok(
      snapshotFilesCalls.some((args) => args[3] === 'after'),
      "Expected one of the invoked snapshotFiles calls to be the 'after' snapshot"
    );
    assert.strictEqual(
      fs.existsSync(path.join(pipeline.harnessDir, 'snapshots', env.taskId, 'after')),
      false,
      'Expected the injected snapshotFiles to return without doing external work (no snapshot directory written to disk)'
    );

    // restoreSnapshot: invoke the SAME routed seam the pipeline itself
    // calls elsewhere (e.g. on a BLOCKED/failed disposition) directly off
    // the constructed pipeline instance, confirming it is buildReplayDeps'
    // own no-op (returns 0, matching its documented contract) rather than
    // the real filesystem-backed restoreSnapshot.
    const restoreResult = pipeline._restoreSnapshot(pipeline.harnessDir, pipeline.projectRoot, env.taskId, 'before', {});
    assert.strictEqual(restoreResult, 0, "Expected the injected restoreSnapshot to return 0 (buildReplayDeps' documented no-op contract)");
    assert.strictEqual(
      fs.existsSync(path.join(pipeline.harnessDir, 'snapshots', env.taskId, 'before', 'restored.marker')),
      false,
      'Expected the injected restoreSnapshot to return without doing external work'
    );
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ---------- TC4: `node scripts/replay-archive.js --probe <corpusDir>` over a 1-of-2 corpus ----------
//
// Builds a throwaway corpus directory containing one COMPLETE miniature
// archive (via buildMiniArchive, rooted directly under the corpus dir so it
// lands as one of the corpus's immediate subdirectories) and one INCOMPLETE
// directory (empty — no logs/, no state/, no verification/, so probeCorpus
// classifies it as not-replayable), then spawns the real CLI script as a
// child process against that corpus dir and asserts on its exit code and
// stdout report.

/**
 * Builds a throwaway corpus directory (under os.tmpdir()) containing exactly
 * one replayable archive (a full buildMiniArchive fixture) and exactly one
 * non-replayable, incomplete directory (empty).
 *
 * @returns {string} the created corpus directory's path
 */
function buildOneOfTwoCorpus() {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-driver-corpus-'));
  // One complete miniature archive, created directly under corpusDir so it
  // is one of the corpus's immediate subdirectories.
  buildMiniArchive(corpusDir);
  // One incomplete directory: no logs/, state/ or verification/ at all.
  fs.mkdirSync(path.join(corpusDir, 'incomplete-archive'));
  return corpusDir;
}

await test('TC4 probe mode over a 1-of-2 corpus exits 0', () => {
  const corpusDir = buildOneOfTwoCorpus();
  try {
    const result = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, '--probe', corpusDir], {
      encoding: 'utf8',
    });
    assert.strictEqual(
      result.status,
      0,
      `Expected the child process to exit 0, got status=${result.status}, stderr=${result.stderr}`
    );
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});

await test('TC4 the report names the total scanned count and the replayable count', () => {
  const corpusDir = buildOneOfTwoCorpus();
  try {
    const result = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, '--probe', corpusDir], {
      encoding: 'utf8',
    });
    const stdout = result.stdout || '';
    assert.ok(
      /\b1\/2\b/.test(stdout),
      `Expected the report to name the replayable count over the total scanned count (1/2), got stdout: ${stdout}`
    );
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});

await test('TC4 the report includes the replayable-format rate', () => {
  const corpusDir = buildOneOfTwoCorpus();
  try {
    const result = spawnSync(process.execPath, [REPLAY_ARCHIVE_SCRIPT, '--probe', corpusDir], {
      encoding: 'utf8',
    });
    const stdout = result.stdout || '';
    assert.ok(
      /rate=50\.0%/.test(stdout),
      `Expected the report to include the replayable-format rate (rate=50.0%), got stdout: ${stdout}`
    );
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
