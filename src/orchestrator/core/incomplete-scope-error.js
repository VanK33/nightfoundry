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
