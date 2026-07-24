/**
 * TaskIdCollisionError — thrown when a task ID is found in more than one
 * location during mission/sub-mission scanning.
 *
 * Stores the duplicate taskId and the location where it was first seen so
 * callers can surface a precise, actionable error message.
 *
 * Lives in its own leaf module following the same pattern as HaltError.
 */
export class TaskIdCollisionError extends Error {
  constructor(taskId, existingLocation) {
    super(
      `Task ID collision detected: '${taskId}' already exists at '${existingLocation}'. ` +
      `Each task ID must be unique across the entire mission tree.`
    );
    this.name = 'TaskIdCollisionError';
    this.taskId = taskId;
    this.existingLocation = existingLocation;
  }
}
