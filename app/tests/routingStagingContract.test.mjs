import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageApi } from '../src/storage.mjs';
import { writeRuntimePathsManifest } from '../src/runtimeSlotBootstrap.mjs';
import {
  recoverPromotingFinalizations,
  resolveFinalizeStagingDir,
  runAtomicFinalizationWithStaging,
  runRoutingReadScopeWithRecoveryIfActive
} from '../src/routingFinalizeQueue.mjs';
import { readJson } from './helpers.mjs';

// Low-level contract tests for the finalize staging atomic mirror / promotion / recovery machinery.
// These exercise routingFinalizeQueue's staging public interface directly, so they build the smallest
// slot layout the machinery traverses (a single slot's game_data tree + the runtime-paths manifests
// that route storage's mutableRoot into it) instead of materializing the full 130+ roster via
// initializeNewPlayArea or copying a full game_data fixture. The end-to-end path (real server → turn →
// end → staging → promotion → drain) stays proven by the routing-mode server cases in
// routingFinalizeQueue.test.mjs; here the subject is only the file-mirroring/recovery semantics.

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// Build the minimal `<playRoot>/slots/slot_001/game_data` layout the staging functions resolve through
// createStorageApi (mutableRoot) + resolvePlayContext (active_slot.json). No roster, no definitions copy:
// the staging machinery only mirrors whatever files live under game_data. `seedFiles` seeds the tiny set
// of live mutable files a case needs. Fixture-build failure throws (no silent partial slot).
async function minimalRoutingSlotFixture(t, { runtimeState = {}, seedFiles = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-routing-staging-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const playRoot = path.join(root, 'play');
  const slotRoot = path.join(playRoot, 'slots', 'slot_001');
  const slotGameData = path.join(slotRoot, 'game_data');
  await fs.mkdir(slotGameData, { recursive: true });
  const baselineState = {
    version: 1,
    current_screen: 'academy-map',
    current_location_id: 'herbology_garden',
    ...runtimeState
  };
  await fs.writeFile(path.join(slotGameData, 'runtime_state.json'), `${JSON.stringify(baselineState, null, 2)}\n`, 'utf8');
  for (const [relativePath, value] of Object.entries(seedFiles)) {
    const fullPath = path.join(slotGameData, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  await writeRuntimePathsManifest({ root: slotRoot, sourceRoot: root, mutableRoot: slotGameData });
  await writeRuntimePathsManifest({ root: playRoot, sourceRoot: root, mutableRoot: slotGameData });
  await fs.writeFile(path.join(playRoot, 'active_slot.json'), `${JSON.stringify({ slot_id: 'slot_001' }, null, 2)}\n`, 'utf8');
  return { root, playRoot, slotRoot, slotGameData };
}

// Stage a promoting finalization ready for crash recovery: a promoting-sentinelled staging dir whose
// workspace/game_data is a snapshot of the live slot with `statePatch` applied. Mirrors the recovery
// precondition the server writes mid-promotion, but over the minimal fixture's tiny game_data.
async function stageRecoverablePromotion({ playRoot, slotGameData, conversationId, statePatch = {} }) {
  const stagingDir = resolveFinalizeStagingDir(playRoot, 'slot_001', conversationId);
  await fs.mkdir(path.join(stagingDir, 'workspace'), { recursive: true });
  await fs.cp(slotGameData, path.join(stagingDir, 'workspace/game_data'), { recursive: true });
  const stagedState = await readJson(path.join(stagingDir, 'workspace'), 'game_data/runtime_state.json');
  await fs.writeFile(path.join(stagingDir, 'workspace/game_data/runtime_state.json'), `${JSON.stringify({
    ...stagedState,
    ...statePatch
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(stagingDir, 'promoting'), '1', 'utf8');
  return stagingDir;
}

test('atomic promotion and recovery mirror staged file deletions', async (t) => {
  const { playRoot, slotGameData } = await minimalRoutingSlotFixture(t);
  const liveAtomicStale = path.join(slotGameData, 'characters/lina/memory/stale_atomic_delete.json');
  await fs.mkdir(path.dirname(liveAtomicStale), { recursive: true });
  await fs.writeFile(liveAtomicStale, `${JSON.stringify({ id: 'stale_atomic_delete' })}\n`, 'utf8');

  await runAtomicFinalizationWithStaging({
    root: playRoot,
    conversationId: 'conv_atomic_delete_001',
    finalizer: async ({ root: stagingRoot }) => {
      await fs.rm(path.join(stagingRoot, 'game_data/characters/lina/memory/stale_atomic_delete.json'), { force: true });
      return { state: await readJson(stagingRoot, 'game_data/runtime_state.json') };
    }
  });

  assert.equal(await exists(liveAtomicStale), false, 'promotion must delete live files absent from the staged workspace');

  const liveRecoveryStale = path.join(slotGameData, 'characters/lina/memory/stale_recovery_delete.json');
  await fs.mkdir(path.dirname(liveRecoveryStale), { recursive: true });
  await fs.writeFile(liveRecoveryStale, `${JSON.stringify({ id: 'stale_recovery_delete' })}\n`, 'utf8');
  const stagingDir = await stageRecoverablePromotion({
    playRoot,
    slotGameData,
    conversationId: 'conv_recovery_delete_001',
    statePatch: { current_location_id: 'delete_recovered_location' }
  });
  await fs.rm(path.join(stagingDir, 'workspace/game_data/characters/lina/memory/stale_recovery_delete.json'), { force: true });

  assert.deepEqual(await recoverPromotingFinalizations({ root: playRoot }), ['conv_recovery_delete_001']);

  assert.equal(await exists(liveRecoveryStale), false, 'recovery must delete live files absent from the staged workspace');
  const state = await createStorageApi({ root: playRoot }).readJson('game_data/runtime_state.json');
  assert.equal(state.current_location_id, 'delete_recovered_location');
});

test('explicit routing recovery entry recovers a staged promotion before serving scoped reads', async (t) => {
  const { playRoot, slotGameData } = await minimalRoutingSlotFixture(t);
  const stagingDir = await stageRecoverablePromotion({
    playRoot,
    slotGameData,
    conversationId: 'conv_recover_001',
    statePatch: { current_location_id: 'recovered_location' }
  });

  const storage = createStorageApi({ root: playRoot });
  await runRoutingReadScopeWithRecoveryIfActive({ root: playRoot }, async () => {
    const state = await storage.readJson('game_data/runtime_state.json');
    assert.equal(state.current_location_id, 'recovered_location');
  });

  assert.equal(await exists(stagingDir), false, 'recovered staging is removed after promotion');
});
