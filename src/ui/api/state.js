import fs from 'fs';
import path from 'path';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';

/**
 * Creates an Express-style handler that reads harnessDir/state.json
 * and projects it into the StateApiResponse shape.
 *
 * @param {{ projectRoot: string }} options
 * @returns {(req: object, res: object) => void}
 */
export function createStateHandler({ projectRoot }) {
  return function stateHandler(_req, res) {
    const harnessDir = activeHarnessDir(projectRoot);
    const stateFilePath = path.join(harnessDir, 'state.json');

    // (a) Missing state.json → return empty response
    if (!fs.existsSync(stateFilePath)) {
      return res.json({ active: false, milestones: [] });
    }

    // Parse state.json
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    } catch {
      return res.json({ active: false, milestones: [] });
    }

    const active = state.globalStatus === 'active';

    const projectMeta = {
      specPath: state.projectMeta?.prdPath ?? state.projectMeta?.specPath ?? null,
      currentPhase: state.projectMeta?.currentPhase ?? null,
      globalStatus: state.globalStatus ?? null,
    };

    // Build milestones array sorted by milestone id
    const milestonesMap = state.milestones ?? {};
    const milestones = Object.values(milestonesMap)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((milestone) => {
        const missionsMap = milestone.missions ?? {};
        const missions = Object.values(missionsMap)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((mission) => {
            const missionId = mission.id;
            const missionFilePath = path.join(
              harnessDir,
              'state',
              `mission-${missionId}.json`
            );

            let subMissions = [];

            if (fs.existsSync(missionFilePath)) {
              let missionState;
              try {
                missionState = JSON.parse(
                  fs.readFileSync(missionFilePath, 'utf8')
                );
              } catch {
                missionState = null;
              }

              if (missionState) {
                const subMissionsMap = missionState.subMissions ?? {};
                subMissions = Object.values(subMissionsMap)
                  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                  .map((sm) => {
                    const tasksMap = sm.tasks ?? {};
                    const tasks = Object.values(tasksMap)
                      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                      .map((task) => ({
                        id: task.id,
                        description: task.description,
                        status: task.status,
                        retryCount: task.retryCount ?? 0,
                        targetFiles: task.targetFiles ?? [],
                      }));
                    return {
                      id: sm.id,
                      description: sm.description,
                      tasks,
                    };
                  });
              }
            }

            return {
              id: mission.id,
              description: mission.description,
              status: mission.status,
              subMissions,
            };
          });

        return {
          id: milestone.id,
          description: milestone.description,
          status: milestone.status,
          missions,
        };
      });

    res.json({ active, projectMeta, milestones });
  };
}

export default createStateHandler;
