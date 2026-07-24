import fs from 'fs';
import path from 'path';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';

const ZERO_TOTALS = {
  sessionCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreation: 0,
  cacheRead: 0,
  totalCostUsd: 0,
  byType: {},
};

export function createCostHandler({ projectRoot }) {
  return function costHandler(req, res) {
    const harnessDir = activeHarnessDir(projectRoot);
    const usagePath = path.join(harnessDir, 'logs', 'token-usage.json');

    if (!fs.existsSync(usagePath)) {
      return res.json({ ...ZERO_TOTALS, byType: {} });
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    } catch {
      return res.json({ ...ZERO_TOTALS, byType: {} });
    }

    const totals = data.totals ?? {};
    const sessionCount = totals.sessionCount ?? 0;
    const inputTokens = totals.inputTokens ?? 0;
    const outputTokens = totals.outputTokens ?? 0;
    const cacheCreation = totals.cacheCreation ?? 0;
    const cacheRead = totals.cacheRead ?? 0;
    const totalCostUsd = totals.totalCostUsd ?? 0;

    const sessions = data.sessions ?? [];
    const groups = {};
    for (const s of sessions) {
      if (!s.type) continue;
      if (!groups[s.type]) groups[s.type] = [];
      groups[s.type].push(s);
    }

    const byType = {};
    for (const [type, group] of Object.entries(groups)) {
      let gInput = 0;
      let gOutput = 0;
      let gCacheCreation = 0;
      let gCacheRead = 0;
      let gCost = 0;
      for (const s of group) {
        gInput += s.inputTokens ?? 0;
        gOutput += s.outputTokens ?? 0;
        gCacheCreation += s.cacheCreation ?? 0;
        gCacheRead += s.cacheRead ?? 0;
        gCost += s.totalCostUsd ?? 0;
      }
      byType[type] = {
        sessionCount: group.length,
        inputTokens: gInput,
        outputTokens: gOutput,
        cacheCreation: gCacheCreation,
        cacheRead: gCacheRead,
        totalCostUsd: gCost,
      };
    }

    return res.json({
      sessionCount,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
      totalCostUsd,
      byType,
    });
  };
}

export default createCostHandler;
