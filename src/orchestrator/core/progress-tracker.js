import fs from 'fs';
import path from 'path';

export class ProgressTracker {
  constructor(harnessDir, logger) {
    this.harnessDir = harnessDir;
    this.logger = logger;

    this._done = 0;
    this._total = 0;
    this._countedTaskIds = null;
    this._driftActive = false;
    this._totalCache = null;
    this._totalDirty = true;
  }

  get done() {
    return this._done;
  }

  get total() {
    return this._total;
  }

  get driftActive() {
    return this._driftActive;
  }

  markDone(taskId) {
    if (!this._countedTaskIds) this._countedTaskIds = new Set();
    if (this._countedTaskIds.has(taskId)) return;
    this._countedTaskIds.add(taskId);
    this._done++;
  }

  recomputeTotal(msId, msState) {
    const missionIds = Object.keys(msState.missions || {});
    const fileEntries = [];
    for (const miId of missionIds) {
      const filePath = path.join(this.harnessDir, 'state', `mission-${miId}.json`);
      if (fs.existsSync(filePath)) {
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
        fileEntries.push({ filePath, mtime });
      }
    }
    const cacheKey = fileEntries.map(e => `${e.filePath}:${e.mtime}`).join('|');
    if (
      this._totalCache &&
      this._totalCache.key === cacheKey &&
      !this._totalDirty
    ) {
      this._total = this._totalCache.total;
      return this._totalCache.total;
    }
    let total = 0;
    for (const { filePath } of fileEntries) {
      try {
        const msj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const sm of Object.values(msj.subMissions || {})) {
          total += Object.keys(sm.tasks || {}).length;
        }
      } catch { /* ignore corrupt state */ }
    }
    if (total === 0) total = missionIds.length;
    this._totalCache = { key: cacheKey, total };
    this._totalDirty = false;
    this._total = total;
    return total;
  }

  assertInvariant(taskId, currentMsId, currentMsState) {
    if (this._done > this._total && currentMsId && currentMsState) {
      this._total = this.recomputeTotal(currentMsId, currentMsState);
    }
    if (this._done > this._total) {
      if (!this._driftActive) {
        this._driftActive = true;
        this.logger?.warn?.(
          `Progress invariant drift: task ${taskId} pushed _progressDone (${this._done}) above _progressTotal (${this._total})`
        );
      }
    } else {
      this._driftActive = false;
    }
  }

  invalidateTotal() {
    this._totalCache = null;
    this._totalDirty = true;
  }

  resetForMilestone(msId, msState) {
    this._done = 0;
    this._countedTaskIds = new Set();
    this.invalidateTotal();
    this.recomputeTotal(msId, msState);
    this._driftActive = false;
  }
}
