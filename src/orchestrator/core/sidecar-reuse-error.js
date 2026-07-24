export class SidecarReuseError extends Error {
  constructor(taskId, sidecarPath) {
    super(
      `Sidecar file already exists for task ${taskId}: ${sidecarPath}. ` +
      `Refusing to overwrite on first write — possible task-id reuse.`
    );
    this.name = 'SidecarReuseError';
    this.taskId = taskId;
    this.sidecarPath = sidecarPath;
  }
}
