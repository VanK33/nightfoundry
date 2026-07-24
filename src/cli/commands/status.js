/**
 * status.js — Display harness state tree (overview mode).
 *
 * Pure JS, no shell dispatch. Reads state.json and mission state files
 * directly and prints a compact summary.
 */
import fs from 'fs';
import path from 'path';
import { readState, resolveHarnessFileRef } from '../../orchestrator/core/state.js';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';
import { TokenTracker } from '../../orchestrator/infra/token-tracker.js';

/**
 * Truncate a string to maxLen chars, appending '...' if truncated.
 */
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return '...'.slice(0, maxLen);
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Count done vs total tasks across all sub-missions in a mission state file.
 */
function countTasks(missionState) {
  let done = 0;
  let total = 0;
  for (const smId of Object.keys(missionState.subMissions || {})) {
    const sm = missionState.subMissions[smId];
    for (const taskId of Object.keys(sm.tasks || {})) {
      total++;
      const s = sm.tasks[taskId].status;
      if (s === 'complete' || s === 'verified') done++;
    }
  }
  return { done, total };
}

/**
 * Format wall-clock duration between two ISO timestamps.
 * Returns a human-readable string like "2h 15m" or "45m 30s".
 */
function formatDuration(earliestIso, latestIso) {
  const ms = new Date(latestIso) - new Date(earliestIso);
  if (ms < 0) return '0s';
  const totalSecs = Math.floor(ms / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Determine if a nodeId looks like a mission ID (two numeric segments, e.g. '001-001').
 */
function isMissionId(nodeId) {
  return /^\d{3}-\d{3}$/.test(nodeId);
}

/**
 * Find a mission entry by missionId across all milestones.
 * Returns { ms, mi } or null if not found.
 */
function findMission(state, missionId) {
  for (const msId of Object.keys(state.milestones)) {
    const ms = state.milestones[msId];
    for (const miId of Object.keys(ms.missions || {})) {
      if (miId === missionId) {
        return { ms, msId, miId, mi: ms.missions[miId] };
      }
    }
  }
  return null;
}

/**
 * Drill-in mode: show task-level detail for a single mission.
 */
function statusDrillIn(harnessDir, state, missionId) {
  const found = findMission(state, missionId);
  if (!found) {
    console.error(`Unknown node: ${missionId}`);
    process.exit(1);
  }

  const { mi, miId } = found;
  const lines = [];

  // Mission header with full description
  lines.push(`Mission ${miId} [${mi.status}]: ${mi.description || ''}`);

  if (!mi.stateFile) {
    lines.push('  (not yet decomposed)');
    console.log(lines.join('\n'));
    return;
  }

  const missionFile = resolveHarnessFileRef(harnessDir, mi.stateFile);

  if (!fs.existsSync(missionFile)) {
    lines.push('  (not yet decomposed)');
    console.log(lines.join('\n'));
    return;
  }

  let missionState;
  try {
    missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
  } catch {
    lines.push('  (mission state file not readable)');
    console.log(lines.join('\n'));
    return;
  }

  const subMissions = missionState.subMissions || {};
  const smIds = Object.keys(subMissions).sort();

  if (smIds.length === 0) {
    lines.push('  (not yet decomposed)');
    console.log(lines.join('\n'));
    return;
  }

  for (const smId of smIds) {
    const sm = subMissions[smId];
    // Sub-mission header
    lines.push(`  Sub-mission ${smId} [${sm.status}]: ${sm.description || ''}`);

    const taskIds = Object.keys(sm.tasks || {}).sort();
    for (const taskId of taskIds) {
      const task = sm.tasks[taskId];
      const targetFilesCount = Array.isArray(task.targetFiles) ? task.targetFiles.length : 0;
      // One line per task: taskId, status, description, targetFiles count
      lines.push(`    ${taskId}  [${task.status}]  ${task.description || ''}  (${targetFilesCount} files)`);
    }
  }

  console.log(lines.join('\n'));
}

export function status(projectRoot, nodeId) {
  const harnessDir = activeHarnessDir(projectRoot);

  if (!fs.existsSync(path.join(harnessDir, 'state.json'))) {
    console.error('No .harness/state.json found.');
    process.exit(1);
  }

  const state = readState(harnessDir);

  // Drill-in mode: nodeId is a mission ID (e.g. '001-001')
  if (nodeId && isMissionId(nodeId)) {
    statusDrillIn(harnessDir, state, nodeId);
    return;
  }

  // If nodeId is provided but doesn't match any milestone, treat as unknown node
  if (nodeId) {
    const milestoneMatch = Object.keys(state.milestones).some(
      (msId) => msId.startsWith(nodeId) || nodeId.startsWith(msId)
    );
    if (!milestoneMatch) {
      console.error(`Unknown node: ${nodeId}`);
      process.exit(1);
    }
  }

  const lines = [];

  const milestoneIds = Object.keys(state.milestones).sort();
  if (milestoneIds.length === 0) {
    lines.push('No milestones yet.');
    console.log(lines.join('\n'));
    return;
  }

  for (const msId of milestoneIds) {
    if (nodeId && !msId.startsWith(nodeId) && !nodeId.startsWith(msId)) continue;
    const ms = state.milestones[msId];

    // Milestone header: MS 001 [done] Description
    lines.push(`MS ${msId} [${ms.status}] ${ms.description}`);

    const miIds = Object.keys(ms.missions || {}).sort();
    for (const miId of miIds) {
      if (nodeId && nodeId.length >= 3 && !miId.startsWith(nodeId) && !nodeId.startsWith(miId)) continue;
      const mi = ms.missions[miId];

      // Count tasks from mission state file
      let taskCounts = { done: 0, total: 0 };
      if (mi.stateFile) {
        const missionFile = resolveHarnessFileRef(harnessDir, mi.stateFile);
        if (fs.existsSync(missionFile)) {
          try {
            const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
            taskCounts = countTasks(missionState);
          } catch {
            // leave counts at 0/0
          }
        }
      }

      const desc = truncate(mi.description, 25);
      const taskStr = `${taskCounts.done}/${taskCounts.total} tasks`;
      // Mission line: id  desc≤25chars  M/N tasks  status
      lines.push(`  ${miId}  ${desc}  ${taskStr}  ${mi.status}`);
    }
  }

  // Summary line: read token-usage.json via TokenTracker
  const tracker = new TokenTracker(harnessDir);
  const usage = tracker.getTotalUsage();
  const sessions = tracker.getSessions();

  const sessionCount = usage.sessionCount;
  const cost = `$${usage.totalCostUsd.toFixed(2)}`;

  const timestamps = sessions.map((s) => s.timestamp).filter(Boolean).sort();
  let durationStr = 'n/a';
  if (timestamps.length >= 2) {
    durationStr = formatDuration(timestamps[0], timestamps[timestamps.length - 1]);
  } else if (timestamps.length === 1 || sessions.length === 1) {
    durationStr = '0s';
  }

  lines.push('');
  const sysPrompt = usage.systemPromptTokens || 0;
  const toolCalls = usage.toolCallCount || 0;
  lines.push(`Sessions: ${sessionCount}  Cost: ${cost}  Duration: ${durationStr}  sys_prompt≈: ${sysPrompt.toLocaleString()}  tool_calls: ${toolCalls}`);

  console.log(lines.join('\n'));
}
