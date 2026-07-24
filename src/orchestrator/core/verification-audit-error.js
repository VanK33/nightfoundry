export class VerificationAuditError extends Error {
  constructor(milestoneId, anomalies) {
    const detail = anomalies.map((a) => `${a.taskId}: ${a.issue}`).join('; ');
    super(
      `Milestone ${milestoneId} verification audit failed: ${anomalies.length} anomaly(ies): ${detail}`
    );
    this.name = 'VerificationAuditError';
    this.milestoneId = milestoneId;
    this.anomalies = anomalies;
  }
}
