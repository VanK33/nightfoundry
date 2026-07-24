export class UncheckableSpecError extends Error {
  constructor(specPath, reason) {
    super(
      reason === 'legacy-dialect'
        ? `Uncheckable spec: the sibling spec.json of '${specPath}' has acceptance_criteria with no verification objects (legacy evidence-string dialect), so every spec-level deterministic gate would be silently disabled. Give each criterion a \`verification\` object (kind: command | file-check | manual — the brainstormer emits these) or pass --allow-incomplete-scope to override.`
        : `Uncheckable spec: '${specPath}' is a bare .md with no sibling spec.json; the planner cannot verify it. Write a spec.json (via the brainstormer) or pass --allow-incomplete-scope to override.`
    );
    this.name = 'UncheckableSpecError';
    this.specPath = specPath;
    this.reason = reason;
  }
}
