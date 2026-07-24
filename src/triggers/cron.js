#!/usr/bin/env node

import cron from 'node-cron';
import { TokenTracker } from '../orchestrator/infra/token-tracker.js';
import { activeHarnessDir } from '../orchestrator/core/run-context.js';
import { loadProjectConfig } from '../orchestrator/infra/project-config.js';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

loadProjectConfig(PROJECT_ROOT);

console.log(`nightfoundry cron scheduler`);
console.log(`Project root: ${PROJECT_ROOT}`);

// Token usage snapshot — hourly
cron.schedule('0 * * * *', () => {
  const harnessDir = activeHarnessDir(PROJECT_ROOT);
  const tracker = new TokenTracker(harnessDir);
  const summary = tracker.summary();
  console.log(`[${new Date().toISOString()}] Token usage: ${summary.totalSessions} sessions, $${summary.totalCostUsd}`);
});

console.log('Cron jobs scheduled:');
console.log('  0 * * * * — token usage snapshot');
console.log('Press Ctrl+C to stop.');
