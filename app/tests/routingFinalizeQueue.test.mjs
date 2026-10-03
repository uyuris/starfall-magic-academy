// 残す (a): 会話後処理の失敗 job を捨てる壊れ方と、atomic promotion の途中で止まった slot を読込時の recovery が直し損ねる壊れ方から、slot の記録を守る。
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { academyPostTurnStatePolicy, finalizeConversationAtomic as finalizeConversationAtomicCore, runConversationTurn as runConversationTurnCore } from '../src/llm/conversationPipeline.mjs';
import { createServer } from '../src/server.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { initializeNewPlayArea as initializeNewPlayAreaCore, resolvePlayRoot } from '../src/playSession.mjs';
import {
  enqueuePendingFinalization,
  listDrainablePendingFinalizations,
  resolveFinalizeStagingDir,
  selectNextPendingFinalizationForDrain
} from '../src/routingFinalizeQueue.mjs';
import { fixtureRoot, readJson } from './helpers.mjs';

function runConversationTurn(args) {
  return runConversationTurnCore({ postTurnStatePolicy: academyPostTurnStatePolicy, ...args });
}

function finalizeConversationAtomic(args) {
  return finalizeConversationAtomicCore({ affinityDeltaProvider: async () => '0', ...args });
}

function initializeNewPlayArea(options) {
  return initializeNewPlayAreaCore({ playMode: 'routing', routingPersonaVariant: 'fallen_star', ...options });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    text
  };
}

async function playFixture(t, playModeOptions = {}) {
  const root = await fixtureRoot('magic-adv-routing-finalize-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', ...playModeOptions });
  return { root, playRoot: resolvePlayRoot(root), slotRoot: initialized.root };
}

async function writeRecoverableStaging({ root, slotRoot, conversationId, statePatch }) {
  const stagingDir = resolveFinalizeStagingDir(root, 'slot_001', conversationId);
  await fs.mkdir(path.join(stagingDir, 'workspace'), { recursive: true });
  await fs.cp(path.join(slotRoot, 'game_data'), path.join(stagingDir, 'workspace/game_data'), { recursive: true });
  const stagedState = await readJson(path.join(stagingDir, 'workspace'), 'game_data/runtime_state.json');
  await fs.writeFile(path.join(stagingDir, 'workspace/game_data/runtime_state.json'), `${JSON.stringify({
    ...stagedState,
    ...statePatch
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(stagingDir, 'promoting'), '1', 'utf8');
  return stagingDir;
}

async function startRoutingModeServer(t, root, prefix = 'magic-adv-routing-server-') {
  return await startPlayModeServer(t, root, { mode: 'routing', routing_persona_variant: 'fallen_star' }, prefix);
}

async function startPlayModeServer(t, root, settings, prefix) {
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  const lmStudioConfigPath = path.join(settingsRoot, 'lmstudio.json');
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  // The fixture is always initializeNewPlayArea'd (playFixture) before this helper runs, so the active
  // slot's play root is the authoritative slot-queue root for lifecycle endpoints. Pass it explicitly as
  // activeRoot so the endpoint reads the same storage root the test writes, instead of depending on the
  // async resolveValidActivePlayRoot restore completing first (the source of the retry-idle flake).
  const server = createServer({ root, activeRoot: resolvePlayRoot(root), playModeSettingsPath: settingsPath, lmStudioConfigPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, settingsPath, lmStudioConfigPath };
}

test('failed pending finalizations are retained and block only the same character subqueue', async (t) => {
  const { playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const state = await storage.readJson('game_data/runtime_state.json');
  const queuedState = {
    ...state,
    pending_finalizations: [
      {
        conversation_id: 'conv_failed_lina_001',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:00:00.000+09:00',
        status: 'failed',
        attempts: 1,
        error: { message: 'finalize failed' }
      },
      {
        conversation_id: 'conv_failed_yuki_001',
        character_id: 'character_002',
        enqueued_at: '2026-05-05T06:01:00.000+09:00',
        status: 'pending',
        attempts: 0
      },
      {
        conversation_id: 'conv_failed_lina_002',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:02:00.000+09:00',
        status: 'pending',
        attempts: 0
      }
    ]
  };

  await storage.writeJson('game_data/runtime_state.json', queuedState);
  const persisted = await storage.readJson('game_data/runtime_state.json');

  assert.deepEqual(
    listDrainablePendingFinalizations(persisted).map((job) => job.conversation_id),
    ['conv_failed_yuki_001'],
    'failed jobs must not stop unrelated characters, but same-character later jobs stay blocked'
  );
  assert.equal(selectNextPendingFinalizationForDrain(persisted).conversation_id, 'conv_failed_yuki_001');

  const afterEnqueue = await enqueuePendingFinalization({
    root: playRoot,
    job: {
      conversation_id: 'conv_failed_yuki_002',
      character_id: 'character_002',
      enqueued_at: '2026-05-05T06:03:00.000+09:00'
    }
  });
  assert.equal(afterEnqueue.pending_finalizations[0].status, 'failed', 'enqueue must retain failed jobs instead of dropping them');
  assert.deepEqual(
    listDrainablePendingFinalizations(afterEnqueue).map((job) => job.conversation_id),
    ['conv_failed_yuki_001', 'conv_failed_yuki_002']
  );
});

test('routing slot-load entry recovers staged promotion for the target slot', async (t) => {
  const { root, playRoot, slotRoot } = await playFixture(t);
  const stagingDir = await writeRecoverableStaging({
    root,
    slotRoot,
    conversationId: 'conv_load_recover_001',
    statePatch: { current_location_id: 'load_recovered_location' }
  });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-routing-load-recover-');

  const loaded = await postJson(base, '/api/slots/load', { slot_id: 'slot_001' });

  assert.equal(loaded.status, 200, loaded.text);
  assert.equal(loaded.body.state.current_location_id, 'load_recovered_location');
  assert.equal(loaded.body.runtime_state.current_location_id, 'load_recovered_location');
  assert.equal(await exists(stagingDir), false, 'load entry removes recovered staging');
  const state = await createStorageApi({ root: playRoot }).readJson('game_data/runtime_state.json');
  assert.equal(state.current_location_id, 'load_recovered_location');
});
