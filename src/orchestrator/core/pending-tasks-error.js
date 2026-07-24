export class PendingTasksAtMilestoneAdvance extends Error {
  constructor(msId, pendingTaskIds) {
    super(
      `Milestone ${msId} cannot advance: ${pendingTaskIds.length} task(s) still non-terminal: ${pendingTaskIds.join(', ')}`
    );
    this.name = 'PendingTasksAtMilestoneAdvance';
    this.milestoneId = msId;
    this.pendingTaskIds = pendingTaskIds;
  }
}
