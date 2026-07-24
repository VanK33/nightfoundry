import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { buildFileToMissionMap } from '../src/orchestrator/core/state.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      failCount++;
    }
  );
}

function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-file-to-mission-map-test-'));
  const harnessDir = path.join(root, '.harness');
  const stateDir = path.join(harnessDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectRoot: root, harnessDir, stateDir };
}

function createTestEnvNoState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-file-to-mission-map-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  // stateDir intentionally NOT created
  return { projectRoot: root, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeMissionState(stateDir, missionId, subMissions) {
  const filePath = path.join(stateDir, `mission-${missionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ subMissions }), 'utf8');
}

// TC1: single-mission happy path — files map to correct missionId
await test('TC1: single-mission: files in one mission targetFiles map to that missionId', () => {
  const { projectRoot, harnessDir, stateDir } = createTestEnv();
  try {
    writeMissionState(stateDir, '001-001', {
      sm1: {
        tasks: {
          task1: { targetFiles: ['src/foo.js', 'src/bar.js'] },
          task2: { targetFiles: ['src/baz.js'] },
        },
      },
    });

    const map = buildFileToMissionMap(harnessDir);

    assert.strictEqual(map.get('src/foo.js'), '001-001');
    assert.strictEqual(map.get('src/bar.js'), '001-001');
    assert.strictEqual(map.get('src/baz.js'), '001-001');
    assert.strictEqual(map.size, 3);
  } finally {
    cleanup(projectRoot);
  }
});

// TC2: ambiguous ownership — file in two missions picks sort()[0] + warns
await test('TC2: ambiguous ownership: file claimed by 001-001 and 001-002 maps to 001-001 (sort()[0]) and logs warning', () => {
  const { projectRoot, harnessDir, stateDir } = createTestEnv();
  try {
    writeMissionState(stateDir, '001-001', {
      sm1: {
        tasks: {
          task1: { targetFiles: ['src/shared.js', 'src/only-001-001.js'] },
        },
      },
    });
    writeMissionState(stateDir, '001-002', {
      sm1: {
        tasks: {
          task1: { targetFiles: ['src/shared.js', 'src/only-001-002.js'] },
        },
      },
    });

    const capturedWarnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => capturedWarnings.push(args.join(' '));
    let map;
    try {
      map = buildFileToMissionMap(harnessDir);
    } finally {
      console.warn = origWarn;
    }

    // Ambiguous file resolves to sort()[0] of ['001-001', '001-002'] = '001-001'
    assert.strictEqual(map.get('src/shared.js'), '001-001');
    // Non-ambiguous files resolve to their own missions
    assert.strictEqual(map.get('src/only-001-001.js'), '001-001');
    assert.strictEqual(map.get('src/only-001-002.js'), '001-002');
    // Warning was emitted for the ambiguous file
    assert.ok(
      capturedWarnings.some(w => w.includes('src/shared.js') && w.includes('multiple missions')),
      `expected a warning about src/shared.js but got: ${JSON.stringify(capturedWarnings)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC3: unowned changedFiles — falls back to sort()[0] of all missionIds + warns
await test('TC3: unowned file in changedFiles falls back to sort()[0] of all missionIds and logs warning', () => {
  const { projectRoot, harnessDir, stateDir } = createTestEnv();
  try {
    writeMissionState(stateDir, '001-002', {
      sm1: {
        tasks: {
          task1: { targetFiles: ['src/owned.js'] },
        },
      },
    });
    writeMissionState(stateDir, '001-001', {
      sm1: {
        tasks: {
          task1: { targetFiles: ['src/other.js'] },
        },
      },
    });

    const capturedWarnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => capturedWarnings.push(args.join(' '));
    let map;
    try {
      map = buildFileToMissionMap(harnessDir, ['src/unowned.js']);
    } finally {
      console.warn = origWarn;
    }

    // Fallback is sort()[0] of all missionIds: sort(['001-002', '001-001'])[0] = '001-001'
    assert.strictEqual(map.get('src/unowned.js'), '001-001');
    // Warning was emitted for the unowned file
    assert.ok(
      capturedWarnings.some(w => w.includes('src/unowned.js') && w.includes('not found in any mission')),
      `expected a warning about src/unowned.js but got: ${JSON.stringify(capturedWarnings)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC4: empty state dir (no mission files) → empty map
await test('TC4: empty state dir returns empty map', () => {
  const { projectRoot, harnessDir } = createTestEnvNoState();
  try {
    const map = buildFileToMissionMap(harnessDir);
    assert.strictEqual(map.size, 0);
    assert.ok(map instanceof Map);
  } finally {
    cleanup(projectRoot);
  }
});

// TC5: mission file with no tasks → no entries
await test('TC5: mission with no tasks contributes no entries to map', () => {
  const { projectRoot, harnessDir, stateDir } = createTestEnv();
  try {
    // Write a mission with a subMission that has no tasks
    writeMissionState(stateDir, '001-001', {
      sm1: {
        tasks: {},
      },
    });
    // Also write a mission with no subMissions at all
    writeMissionState(stateDir, '001-002', {});

    const map = buildFileToMissionMap(harnessDir);
    assert.strictEqual(map.size, 0);
  } finally {
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
