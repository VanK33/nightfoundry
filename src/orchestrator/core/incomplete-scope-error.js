export class IncompleteScopeError extends Error {
  constructor(uncoveredLabels) {
    super(
      `Scope coverage incomplete: ${uncoveredLabels.length} scope item(s) not matched by any mission: ${uncoveredLabels.join(', ')}` +
      // w4-state-resume-persistence Fix #2: name the escape hatch so the user
      // does not have to rediscover it after a hard fail.
      `. Pass --allow-incomplete-scope to proceed anyway (the disposition is persisted, so a later resume honors it).`
    );
    this.name = 'IncompleteScopeError';
    this.uncoveredLabels = uncoveredLabels;
  }
}

export class UnassignedSpecCheckError extends IncompleteScopeError {
  constructor(uncoveredLabels) {
    super(uncoveredLabels);
    this.message =
      `Spec hard-check coverage incomplete: ${uncoveredLabels.length} acceptance-check command(s) are not assigned to any task: ${uncoveredLabels.join(', ')}` +
      `. The file(s) referenced by ${uncoveredLabels.length === 1 ? 'this command' : 'these commands'} are claimed by no task's targetFiles` +
      // w4-state-resume-persistence Fix #2: name the escape hatch so the user
      // does not have to rediscover it after a hard fail.
      `. Pass --allow-incomplete-scope to proceed anyway (the disposition is persisted, so a later resume honors it).`;
    this.name = 'UnassignedSpecCheckError';
    this.uncoveredLabels = uncoveredLabels;
  }
}
