export class SpecCriterionError extends Error {
  constructor(failures) {
    super(
      `Spec criteria drain failed: ${failures.length} acceptance criterion(s) unmet: ${failures
        .map((f) => (f.targetFile != null
          ? `${f.name} (missing file: ${f.targetFile})`
          : `${f.name} (exit ${f.exitCode}: ${f.command})`))
        .join('; ')}`
    );
    this.name = 'SpecCriterionError';
    this.failures = failures;
  }
}
