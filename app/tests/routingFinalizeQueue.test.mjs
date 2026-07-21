import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { academyPostTurnStatePolicy, finalizeConversationAtomic as finalizeConversationAtomicCore, FINALIZATION_PROGRESS_PHASES, reportFinalizationProgress, runConversationTurn as runConversationTurnCore } from '../src/llm/conversationPipeline.mjs';
import { createServer } from '../src/server.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { deleteSaveSlot } from '../src/saveLoad.mjs';
import { initializeNewPlayArea as initializeNewPlayAreaCore, resolvePlayRoot } from '../src/playSession.mjs';
import {
  advancePromotionEpochForRoutingFinalize,
  enqueuePendingFinalization,
  getPromotionEpochForRoutingFinalize,
  listDrainablePendingFinalizations,
  resolveFinalizeStagingDir,
  resolveSlotFinalizeStagingRoot,
  runRoutingReadScope,
  runRoutingReadScopeRequired,
  preparePendingFinalizationRetryInState,
  selectNextPendingFinalizationForDrain
} from '../src/routingFinalizeQueue.mjs';
import { baselineRuntimeState, fixtureRoot, readJson } from './helpers.mjs';

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

// Build a routing-mode server whose active play slot root never resolves: no initializeNewPlayArea (so
// readValidActiveSlotId returns null) and no activeRoot option (so resolveValidActivePlayRoot resolves to
// null). This is the isomorphic condition behind the retry-idle flake — routing mode with context.activeRoot
// unresolved, where the pre-fix `context.activeRoot ?? context.root` fallback silently read the parent
// authoring root. `runtimeState` seeds the parent root that the buggy fallback would have read.
async function startRoutingServerWithoutActiveSlot(t, prefix, { runtimeState = baselineRuntimeState } = {}) {
  const root = await fixtureRoot(prefix, { runtimeState });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}settings-`));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });
  const server = createServer({ root, playModeSettingsPath: settingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { root, base: `http://127.0.0.1:${port}` };
}

async function seedQueuedConversation({ storage, conversationId, characterId, characterName = 'テスト生徒' }) {
  await storage.writeJson(`game_data/logs/conversations/${conversationId}.json`, {
    id: conversationId,
    character_id: characterId,
    character_name: characterName,
    created_at: '2026-05-05T06:00:00.000+09:00',
    updated_at: '2026-05-05T06:01:00.000+09:00',
    source_type: 'field',
    location_id: 'herbology_garden',
    time_slot: 'after_school',
    messages: [
      { role: 'assistant', content: '記録に残しましょう。' },
      { role: 'user', content: 'お願いします。' }
    ]
  });
}

async function ensureQueuedCharacterStorage(storage, characterId) {
  if (characterId === 'lina') return;
  await storage.writeJson(`game_data/characters/${characterId}/flags.json`, {
    character_id: characterId,
    flags: { [`knowledge.${characterId}.player_checked_garden_label`]: false }
  });
  await storage.writeJson(`game_data/characters/${characterId}/skills.json`, {
    character_id: characterId,
    skills: []
  });
}

test('routing enqueue materializes pending_finalizations only on write and rejects corrupt queue state', async (t) => {
  const { playRoot, slotRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });

  const first = await enqueuePendingFinalization({
    root: playRoot,
    job: {
      conversation_id: 'conv_queue_001',
      character_id: 'lina',
      enqueued_at: '2026-05-05T06:00:00.000+09:00'
    }
  });

  assert.equal(first.current_screen, 'academy-map', 'enqueue must not own or rewrite current_screen');
  assert.equal(first.pending_finalizations.length, 1);
  assert.equal(first.pending_finalizations[0].status, 'pending');
  assert.equal(first.pending_finalizations[0].attempts, 0);
  assert.deepEqual((await storage.readJson('game_data/runtime_state.json')).pending_finalizations, first.pending_finalizations);

  await assert.rejects(
    () => enqueuePendingFinalization({
      root: playRoot,
      job: {
        conversation_id: 'conv_queue_bad_attempts_001',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:00:30.000+09:00',
        attempts: '0'
      }
    }),
    (error) => error?.errorCode === 'invalid_pending_finalizations' && /attempts/.test(error.message)
  );
  assert.equal((await storage.readJson('game_data/runtime_state.json')).pending_finalizations.length, 1, 'malformed enqueue input must not write');

  const corruptState = { ...first, pending_finalizations: { hidden: true } };
  await fs.writeFile(path.join(slotRoot, 'game_data/runtime_state.json'), `${JSON.stringify(corruptState, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => enqueuePendingFinalization({
      root: playRoot,
      job: {
        conversation_id: 'conv_queue_002',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:01:00.000+09:00'
      }
    }),
    /pending_finalizations must be an array/
  );
});

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

test('routing retry endpoint restores a failed pending finalization and drains it successfully', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-finalize-retry-success-');
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_retry_success_lina_001',
    characterId: 'lina',
    characterName: 'ルミ'
  });
  const state = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', {
    ...state,
    pending_finalizations: [
      {
        conversation_id: 'conv_retry_success_lina_001',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:00:00.000+09:00',
        status: 'failed',
        attempts: 1,
        failed_at: '2026-05-05T06:02:00.000+09:00',
        error: { message: 'previous finalization failed' }
      }
    ]
  });

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.character_id, 'lina');
  assert.equal(response.body.finalization_status, 'drained');
  assert.equal(response.body.retry_status, 'retried');
  assert.equal(response.body.retried.status, 'pending');
  assert.deepEqual(response.body.drained.map((entry) => entry.job.conversation_id), ['conv_retry_success_lina_001']);
  assert.deepEqual(response.body.state.pending_finalizations, []);
  const persisted = await storage.readJson('game_data/runtime_state.json');
  assert.deepEqual(persisted.pending_finalizations, []);
  const conversation = await storage.readJson('game_data/logs/conversations/conv_retry_success_lina_001.json');
  assert.equal(conversation.discarded_after_work_record_id, 'wr_conv_retry_success_lina_001');

  const repeated = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(repeated.status, 200, repeated.text);
  assert.equal(repeated.body.character_id, 'lina');
  assert.equal(repeated.body.finalization_status, 'idle');
  assert.equal(repeated.body.retry_status, 'idle');
  assert.equal(repeated.body.retried, null);
  assert.deepEqual(repeated.body.drained, []);
  const repeatedPersisted = await storage.readJson('game_data/runtime_state.json');
  assert.deepEqual(repeatedPersisted.pending_finalizations, []);
});

test('routing retry endpoint leaves a re-failed job visible with incremented attempts', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const { base, lmStudioConfigPath } = await startRoutingModeServer(t, root, 'magic-adv-finalize-retry-failure-');
  assert.equal(await exists(lmStudioConfigPath), false);
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_retry_failure_lina_001',
    characterId: 'lina',
    characterName: 'ルミ'
  });
  const state = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', {
    ...state,
    pending_finalizations: [
      {
        conversation_id: 'conv_retry_failure_lina_001',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:00:00.000+09:00',
        status: 'failed',
        attempts: 2,
        failed_at: '2026-05-05T06:02:00.000+09:00',
        error: { message: 'previous finalization failed' }
      }
    ]
  });

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina' });

  assert.equal(response.status, 503, response.text);
  const persisted = await storage.readJson('game_data/runtime_state.json');
  assert.equal(persisted.pending_finalizations.length, 1);
  assert.equal(persisted.pending_finalizations[0].conversation_id, 'conv_retry_failure_lina_001');
  assert.equal(persisted.pending_finalizations[0].status, 'failed');
  assert.equal(persisted.pending_finalizations[0].attempts, 3);
  assert.equal(persisted.pending_finalizations[0].error.error_code, 'LMSTUDIO_CONFIG_REQUIRED');
});

test('routing retry endpoint is idle when the character has no failed pending finalization', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-finalize-retry-idle-');
  const state = await storage.readJson('game_data/runtime_state.json');
  const expectedPending = [
    {
      conversation_id: 'conv_retry_idle_other_001',
      character_id: 'character_008',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'failed',
      attempts: 1,
      error: { message: 'other character failed' }
    }
  ];
  await storage.writeJson('game_data/runtime_state.json', {
    ...state,
    pending_finalizations: expectedPending
  });

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.finalization_status, 'idle');
  assert.equal(response.body.retry_status, 'idle');
  assert.deepEqual(response.body.drained, []);
  assert.deepEqual(response.body.state.pending_finalizations, expectedPending);
  const persisted = await storage.readJson('game_data/runtime_state.json');
  assert.deepEqual(persisted.pending_finalizations, expectedPending);
});

test('routing retry endpoint does not skip an earlier same-character pending job', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-finalize-retry-fifo-');
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_retry_fifo_pending_001',
    characterId: 'lina',
    characterName: 'ルミ'
  });
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_retry_fifo_failed_001',
    characterId: 'lina',
    characterName: 'ルミ'
  });
  const state = await storage.readJson('game_data/runtime_state.json');
  const expectedPending = [
    {
      conversation_id: 'conv_retry_fifo_pending_001',
      character_id: 'lina',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'pending',
      attempts: 0
    },
    {
      conversation_id: 'conv_retry_fifo_failed_001',
      character_id: 'lina',
      enqueued_at: '2026-05-05T06:01:00.000+09:00',
      status: 'failed',
      attempts: 1,
      failed_at: '2026-05-05T06:02:00.000+09:00',
      error: { message: 'later same-character job failed' }
    }
  ];
  await storage.writeJson('game_data/runtime_state.json', {
    ...state,
    pending_finalizations: expectedPending
  });

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.character_id, 'lina');
  assert.equal(response.body.finalization_status, 'idle');
  assert.equal(response.body.retry_status, 'idle');
  assert.equal(response.body.retried, null);
  assert.deepEqual(response.body.drained, []);
  assert.deepEqual(response.body.state.pending_finalizations, expectedPending);
  const persisted = await storage.readJson('game_data/runtime_state.json');
  assert.deepEqual(persisted.pending_finalizations, expectedPending);
  const laterConversation = await storage.readJson('game_data/logs/conversations/conv_retry_fifo_failed_001.json');
  assert.equal(Object.hasOwn(laterConversation, 'discarded_after_work_record_id'), false);
});

test('routing retry prepare leaves persisted state failed until finalize outcome', () => {
  const selectedJob = {
    conversation_id: 'conv_retry_prepare_001',
    character_id: 'lina',
    enqueued_at: '2026-05-05T06:00:00.000+09:00',
    status: 'failed',
    attempts: 2,
    failed_at: '2026-05-05T06:02:00.000+09:00',
    error: { message: 'previous failure' }
  };
  const state = { pending_finalizations: [selectedJob] };

  const prepared = preparePendingFinalizationRetryInState(state, selectedJob);

  assert.equal(prepared.job.status, 'pending');
  assert.equal(prepared.job.attempts, 2);
  assert.equal(Object.hasOwn(prepared.job, 'failed_at'), false);
  assert.equal(Object.hasOwn(prepared.job, 'error'), false);
  assert.equal(state.pending_finalizations[0].status, 'failed');
  assert.deepEqual(prepared.state, state);
});

test('routing retry prepare fails fast when the selected failed job is stale', () => {
  const selectedJob = {
    conversation_id: 'conv_retry_stale_001',
    character_id: 'lina',
    enqueued_at: '2026-05-05T06:00:00.000+09:00',
    status: 'failed',
    attempts: 2,
    failed_at: '2026-05-05T06:02:00.000+09:00',
    error: { message: 'previous failure' }
  };
  assert.throws(
    () => preparePendingFinalizationRetryInState({
      pending_finalizations: [
        {
          conversation_id: 'conv_retry_stale_001',
          character_id: 'lina',
          enqueued_at: '2026-05-05T06:00:00.000+09:00',
          status: 'pending',
          attempts: 2
        }
      ]
    }, selectedJob),
    (error) => error?.errorCode === 'invalid_pending_finalizations' &&
      /changed before retry prepare/.test(error.message)
  );
});

test('routing retry endpoint rejects loop mode', async (t) => {
  const { root } = await playFixture(t, { playMode: 'loop', routingPersonaVariant: undefined });
  const { base } = await startPlayModeServer(t, root, { mode: 'loop' }, 'magic-adv-finalize-retry-loop-');

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.error_code, 'ROUTING_MODE_REQUIRED');
});

test('routing retry endpoint fails fast when the active play slot root is unresolved (no parent-root false idle)', async (t) => {
  // Minimal isomorphic reproduction of the retry-idle flake: routing mode with no valid active slot, so
  // context.activeRoot never resolves and the pre-fix `context.activeRoot ?? context.root` fallback read
  // the parent authoring runtime_state instead of the slot queue. Retrying lina against that parent state
  // finds no lina job and answered the slot-queue request with a false 'idle' (200). The parent queue
  // carries only another character's failed job to mirror the investigation's idle case; a correct
  // slot-queue endpoint must never read or mutate it. Post-fix the endpoint fails fast before reading.
  const expectedParentPending = [
    {
      conversation_id: 'conv_retry_noactiveroot_other_001',
      character_id: 'character_008',
      enqueued_at: '2026-05-05T06:00:00.000+09:00',
      status: 'failed',
      attempts: 1,
      error: { message: 'other character failed' }
    }
  ];
  const { root, base } = await startRoutingServerWithoutActiveSlot(t, 'magic-adv-finalize-retry-noactiveroot-', {
    runtimeState: { ...baselineRuntimeState, pending_finalizations: expectedParentPending }
  });

  const response = await postJson(base, '/api/conversation/finalize/retry', { character_id: 'lina', provider: 'mock' });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.error_code, 'ROUTING_ACTIVE_ROOT_REQUIRED');
  const parentState = await readJson(root, 'game_data/runtime_state.json');
  assert.deepEqual(parentState.pending_finalizations, expectedParentPending, 'the parent-root queue must be left untouched');
});

test('routing opening endpoint fails fast when the active play slot root is unresolved', async (t) => {
  // The activeRoot fail-fast is a routing-mode invariant across the whole conversation-lifecycle handler,
  // not only the retry/drain queue routes. Pin the non-retry contract: the opening route also refuses to
  // silently operate on the parent authoring root when the active slot root is unresolved.
  const { base } = await startRoutingServerWithoutActiveSlot(t, 'magic-adv-opening-noactiveroot-');

  const response = await postJson(base, '/api/conversation/opening', {
    id: 'conv_opening_noactiveroot_001',
    character_id: 'lina',
    provider: 'mock'
  });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.error_code, 'ROUTING_ACTIVE_ROOT_REQUIRED');
});

test('routing conversation end endpoint fails fast when the active play slot root is unresolved', async (t) => {
  // Pin the drain-owning exit route under the same routing-mode invariant.
  const { base } = await startRoutingServerWithoutActiveSlot(t, 'magic-adv-end-noactiveroot-');

  const response = await postJson(base, '/api/conversation/end', { provider: 'mock' });

  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.error_code, 'ROUTING_ACTIVE_ROOT_REQUIRED');
});

test('routing interaction start opens the session without an entry pre-drain (drain-on-exit owns the queue)', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-interaction-no-predrain-');
  await ensureQueuedCharacterStorage(storage, 'character_008');
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_interaction_priority_other_001',
    characterId: 'character_008'
  });
  await seedQueuedConversation({
    storage,
    conversationId: 'conv_interaction_priority_lina_001',
    characterId: 'lina',
    characterName: 'ルミ'
  });
  const state = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', {
    ...state,
    pending_finalizations: [
      {
        conversation_id: 'conv_interaction_priority_other_001',
        character_id: 'character_008',
        enqueued_at: '2026-05-05T06:00:00.000+09:00',
        status: 'pending',
        attempts: 0
      },
      {
        conversation_id: 'conv_interaction_priority_lina_001',
        character_id: 'lina',
        enqueued_at: '2026-05-05T06:01:00.000+09:00',
        status: 'pending',
        attempts: 0
      }
    ]
  });

  const started = await postJson(base, '/api/interaction/start', { character_id: 'lina', provider: 'mock' });

  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.state.current_interaction_character_id, 'lina');
  // Drain-on-exit: interaction start runs NO entry pre-drain, so both pending finalizations remain in
  // FIFO order and neither seeded conversation is finalized at entry.
  const persisted = await storage.readJson('game_data/runtime_state.json');
  assert.deepEqual(
    persisted.pending_finalizations.map((job) => job.conversation_id),
    ['conv_interaction_priority_other_001', 'conv_interaction_priority_lina_001']
  );
  const linaConversation = await storage.readJson('game_data/logs/conversations/conv_interaction_priority_lina_001.json');
  assert.equal(Object.hasOwn(linaConversation, 'discarded_after_work_record_id'), false);
});

test('routing read scope blocks sentinel-protected mutable reads and post-fence discards stale bytes', async (t) => {
  const { root, playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  const stagingDir = resolveFinalizeStagingDir(root, 'slot_001', 'conv_guard_001');
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(path.join(stagingDir, 'promoting'), '1', 'utf8');

  await assert.rejects(
    () => runRoutingReadScope({ root: playRoot }, () => storage.readJson('game_data/runtime_state.json')),
    (error) => error?.code === 'ROUTING_READ_RACED_FINALIZE'
  );

  await assert.rejects(
    () => runRoutingReadScopeRequired(() => storage.readJson('game_data/runtime_state.json')),
    (error) => error?.code === 'ROUTING_READ_SCOPE_REQUIRED'
  );

  assert.equal((await storage.readJson('game_data/runtime_state.json')).current_screen, 'academy-map', 'loop/non-routing reads stay inert without an ALS scope');

  await fs.rm(path.join(stagingDir, 'promoting'), { force: true });
  const staleStorage = createStorageApi({
    root: playRoot,
    readOperationHooks: {
      afterReadFile: async ({ relativePath }) => {
        if (relativePath === 'game_data/runtime_state.json') advancePromotionEpochForRoutingFinalize();
      }
    }
  });
  await assert.rejects(
    () => runRoutingReadScope({ root: playRoot }, () => staleStorage.readJson('game_data/runtime_state.json')),
    (error) => error?.code === 'ROUTING_READ_RACED_FINALIZE'
  );
});

test('routing list reads fail fast when promotion completes between readdir and per-file reads', async (t) => {
  const { playRoot, slotRoot } = await playFixture(t);
  const memoryDir = path.join(slotRoot, 'game_data/characters/lina/memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'mem_list_001.json'), `${JSON.stringify({ id: 'mem_list_001', text: 'old one' })}\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'mem_list_002.json'), `${JSON.stringify({ id: 'mem_list_002', text: 'old two' })}\n`, 'utf8');

  const storage = createStorageApi({
    root: playRoot,
    readOperationHooks: {
      afterReaddir: async ({ relativePath }) => {
        if (relativePath !== 'game_data/characters/lina/memory') return;
        await fs.writeFile(path.join(memoryDir, 'mem_list_003.json'), `${JSON.stringify({ id: 'mem_list_003', text: 'new three' })}\n`, 'utf8');
        advancePromotionEpochForRoutingFinalize();
      }
    }
  });

  await assert.rejects(
    () => runRoutingReadScope({ root: playRoot }, () => storage.listJson('game_data/characters/lina/memory')),
    (error) => error?.code === 'ROUTING_READ_RACED_FINALIZE'
  );
});

test('routing markdown record lists fail fast when promotion completes during per-file reads', async (t) => {
  const { playRoot, slotRoot } = await playFixture(t);
  const recordsDir = path.join(slotRoot, 'game_data/characters/lina/work_records');
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.writeFile(path.join(recordsDir, 'record_list_001.md'), 'old record one', 'utf8');
  await fs.writeFile(path.join(recordsDir, 'record_list_002.md'), 'old record two', 'utf8');
  let advanced = false;

  const storage = createStorageApi({
    root: playRoot,
    readOperationHooks: {
      afterReadFile: async ({ relativePath }) => {
        if (advanced || !relativePath.startsWith('game_data/characters/lina/work_records/')) return;
        advanced = true;
        await fs.writeFile(path.join(recordsDir, 'record_list_002.md'), 'new record two', 'utf8');
        advancePromotionEpochForRoutingFinalize();
      }
    }
  });

  await assert.rejects(
    () => runRoutingReadScope({ root: playRoot }, () => storage.listMarkdownRecords('game_data/characters/lina/work_records')),
    (error) => error?.code === 'ROUTING_READ_RACED_FINALIZE'
  );
});

test('mode switch to loop is rejected while any routing promotion sentinel exists', async (t) => {
  const { root } = await playFixture(t);
  const settingsPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-routing-mode-')), 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing' }, null, 2)}\n`, 'utf8');
  const stagingDir = resolveFinalizeStagingDir(root, 'slot_001', 'conv_guard_002');
  await fs.mkdir(stagingDir, { recursive: true });
  await fs.writeFile(path.join(stagingDir, 'promoting'), '1', 'utf8');

  const server = createServer({ root, playModeSettingsPath: settingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const blocked = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'loop' })
  });
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /routing finalize/i);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { mode: 'routing' }, 'rejected PATCH must not overwrite the saved routing mode');

  await fs.rm(path.join(stagingDir, 'promoting'), { force: true });
  const allowed = await fetch(`${base}/api/settings/play-mode`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'loop' })
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { mode: 'loop' });
});

test('ordinary routing scoped reads do not perform crash recovery', async (t) => {
  const { root, slotRoot } = await playFixture(t);
  const stagingDir = await writeRecoverableStaging({
    root,
    slotRoot,
    conversationId: 'conv_no_recover_state_001',
    statePatch: { current_location_id: 'should_not_recover_on_state' }
  });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-routing-no-recover-');

  const response = await fetch(`${base}/api/state`);
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error_code, 'routing_read_raced_finalize');
  assert.equal(await exists(stagingDir), true, 'ordinary scoped reads must leave recovery to designated entry contexts');
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

test('routing hub entry recovers staged promotion before scoped reads', async (t) => {
  const { root, playRoot, slotRoot } = await playFixture(t);
  const stagingDir = await writeRecoverableStaging({
    root,
    slotRoot,
    conversationId: 'conv_hub_recover_001',
    statePatch: { current_location_id: 'hub_recovered_location' }
  });
  const { base } = await startRoutingModeServer(t, root, 'magic-adv-routing-hub-recover-');

  const started = await postJson(base, '/api/interaction/start', { character_id: 'lina' });

  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.state.current_location_id, 'hub_recovered_location');
  assert.equal(started.body.state.current_screen, 'interaction');
  assert.equal(await exists(stagingDir), false, 'hub entry removes recovered staging before scoped reads');
  const state = await createStorageApi({ root: playRoot }).readJson('game_data/runtime_state.json');
  assert.equal(state.current_location_id, 'hub_recovered_location');
});

test('deleteSaveSlot removes its finalize staging namespace', async (t) => {
  const { root } = await playFixture(t);
  const slotStagingRoot = resolveSlotFinalizeStagingRoot(root, 'slot_001');
  await fs.mkdir(resolveFinalizeStagingDir(root, 'slot_001', 'conv_delete_001'), { recursive: true });

  await deleteSaveSlot({ root, slotId: 'slot_001' });

  assert.equal(await exists(slotStagingRoot), false);
});

test('finalizeConversationAtomic stages live changes outside the slot and preserves screen ownership', async (t) => {
  const { root, playRoot, slotRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  await runConversationTurn({
    root: playRoot,
    id: 'conv_atomic_001',
    characterId: 'lina',
    playerInput: '今日は記録だけ残しておこう',
    now: '2026-05-05T06:10:00.000+09:00',
    chatProvider: async () => '……はい。記録に残すことを優先しましょう。'
  });
  const activeConversationState = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/runtime_state.json', {
    ...activeConversationState,
    current_screen: 'training',
    current_interaction_character_id: null,
    pending_interaction_context: null
  });

  const finalized = await finalizeConversationAtomic({
    root: playRoot,
    conversationId: 'conv_atomic_001',
    characterId: 'lina',
    now: '2026-05-05T06:11:00.000+09:00',
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' })
  });

  const state = await storage.readJson('game_data/runtime_state.json');
  const conversation = await storage.readJson('game_data/logs/conversations/conv_atomic_001.json');
  assert.equal(finalized.finalization_status, 'completed');
  assert.equal(state.current_screen, 'training', 'routing atomic finalize must not own current_screen');
  assert.equal(conversation.discarded_after_work_record_id, 'wr_conv_atomic_001');
  assert.equal(await exists(path.join(slotRoot, 'game_data/characters/lina/memory/mem_conv_atomic_001.json')), true);
  assert.equal(await exists(resolveFinalizeStagingDir(root, 'slot_001', 'conv_atomic_001')), false, 'staging dir is removed as the commit boundary');
  assert.equal(await exists(path.join(slotRoot, 'finalize_staging')), false, 'staging must stay outside the slot project root');
  assert.equal(await readJson(slotRoot, 'game_data/runtime_state.json').then((saved) => saved.current_screen), 'training');
});

test('finalizeConversationAtomic preserves routing prefix cluster order', async (t) => {
  const { playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  await runConversationTurn({
    root: playRoot,
    id: 'conv_atomic_order_001',
    characterId: 'lina',
    playerInput: 'この会話の後処理順を確認します。',
    now: '2026-05-05T06:20:00.000+09:00',
    chatProvider: async () => '……はい。順番を崩さず記録しましょう。'
  });
  const state = await storage.readJson('game_data/runtime_state.json');
  await storage.writeJson('game_data/stage_flags.json', {
    flags: [
      {
        id: 'stage.prefix_order_probe',
        label: 'prefix order probe',
        location_id: state.current_location_id,
        condition: '後処理順の確認が行われた。',
        question: '後処理順の確認が行われましたか？'
      }
    ]
  });

  const order = [];
  const waitOneTick = () => new Promise((resolve) => setImmediate(resolve));
  await finalizeConversationAtomic({
    root: playRoot,
    conversationId: 'conv_atomic_order_001',
    characterId: 'lina',
    now: '2026-05-05T06:21:00.000+09:00',
    memoryUpdateProvider: async ({ conversation, workRecordId }) => {
      order.push('memory:start');
      await waitOneTick();
      order.push('memory:done');
      return {
        memory_record: {
          id: 'mem_conv_atomic_order_001',
          character_id: conversation.character_id,
          type: 'relationship_change',
          text: '後処理順の確認をした。',
          source_conversation_id: conversation.id,
          work_record_id: workRecordId,
          visibility: 'character_known',
          tags: []
        }
      };
    },
    skillNecessityProvider: async () => {
      order.push(order.includes('memory:done') ? 'skill-necessity:start' : 'skill-necessity:before-memory-done');
      await waitOneTick();
      order.push('skill-necessity:done');
      return { necessary: true, raw_answer: 'true' };
    },
    workRecordProvider: async ({ conversation, workRecordId }) => {
      order.push(order.includes('skill-necessity:done') ? 'work-record:start' : 'work-record:before-skill-necessity-done');
      await waitOneTick();
      order.push('work-record:done');
      return {
        work_record: {
          id: workRecordId,
          character_id: conversation.character_id,
          source_conversation_id: conversation.id,
          title: '後処理順の確認',
          summary: '後処理の prefix cluster 順を確認した。',
          flag_update_candidates: [],
          warnings: []
        }
      };
    },
    skillUpdateProvider: async ({ conversation, workRecordId }) => {
      order.push(order.includes('work-record:done') ? 'skill-update' : 'skill-update:before-work-record-done');
      return {
        skill_record: {
          id: 'skill_conv_atomic_order_001',
          character_id: conversation.character_id,
          type: 'self_change',
          name: '後処理順の確認',
          description: '後処理順を確認した。',
          source_conversation_id: conversation.id,
          work_record_id: workRecordId,
          visibility: 'character_known',
          tags: []
        }
      };
    },
    stageFlagJudgmentProvider: async ({ candidateFlags }) => {
      order.push(order.includes('skill-update') ? 'stage' : 'stage:before-skill-update');
      return {
        flag_results: candidateFlags.map((flag) => ({
          flag_id: flag.id,
          achieved: false,
          reason: 'order probe only'
        }))
      };
    }
  });

  assert.deepEqual(order, [
    'memory:start',
    'memory:done',
    'skill-necessity:start',
    'skill-necessity:done',
    'work-record:start',
    'work-record:done',
    'skill-update',
    'stage'
  ]);
});

test('finalizeConversationAtomic reports the 5-phase finalization progress closed set in order, commit after promotion', async (t) => {
  const { playRoot } = await playFixture(t);
  const storage = createStorageApi({ root: playRoot });
  await runConversationTurn({
    root: playRoot,
    id: 'conv_atomic_progress_001',
    characterId: 'lina',
    playerInput: '後処理の進行通知を確認します。',
    now: '2026-05-05T06:20:00.000+09:00',
    chatProvider: async () => '……はい。区切りごとに知らせましょう。'
  });

  const progress = [];
  const beforeEpoch = getPromotionEpochForRoutingFinalize();
  let epochAtCommit = null;
  await finalizeConversationAtomic({
    root: playRoot,
    conversationId: 'conv_atomic_progress_001',
    characterId: 'lina',
    now: '2026-05-05T06:21:00.000+09:00',
    progressReporter: ({ phase, character_id }) => {
      if (phase === 'commit') epochAtCommit = getPromotionEpochForRoutingFinalize();
      progress.push({ phase, character_id });
    }
  });

  // The closed set is emitted exactly once, in order, each naming the drained conversation's actor.
  assert.deepEqual(
    progress.map((item) => item.phase),
    ['memory', 'skill', 'work_record', 'state_effects', 'commit']
  );
  for (const item of progress) assert.equal(item.character_id, 'lina');
  // commit fires only after the atomic promotion advanced the epoch (it is a live-committed boundary, not a
  // staging-write boundary).
  assert.equal(epochAtCommit, beforeEpoch + 1, 'commit is reported after the staging→live promotion completes');

  // The exported vocabulary is the exact ordered closed set; an out-of-set phase fail-fasts (no silent drop).
  assert.deepEqual(FINALIZATION_PROGRESS_PHASES, ['memory', 'skill', 'work_record', 'state_effects', 'commit']);
  assert.throws(
    () => reportFinalizationProgress(() => {}, 'not_a_phase', 'lina'),
    /unsupported finalization progress phase: not_a_phase/
  );
  // A phase outside the set throws even before an observer is checked, so a bad phase can never be silently
  // dropped when no reporter is attached either.
  assert.throws(() => reportFinalizationProgress(null, 'promotion', 'lina'), /unsupported finalization progress phase/);
  // A non-function reporter with a valid phase is a wiring bug, not a silent no-op.
  assert.throws(() => reportFinalizationProgress('nope', 'memory', 'lina'), /progressReporter must be a function/);
  // An absent reporter with a valid phase is the explicit no-observer case: no throw, nothing emitted.
  assert.doesNotThrow(() => reportFinalizationProgress(null, 'memory', 'lina'));
});

test('finalizeConversationAtomic attributes finalization progress (incl. commit) to the drained conversation actor, not a default', async (t) => {
  const { playRoot } = await playFixture(t);
  // A non-lina conversation: the commit phase must attribute to this actor read from the finalize result, so a
  // hard-coded 'lina' default or an outer-parameter fallback would be caught here.
  await runConversationTurn({
    root: playRoot,
    id: 'conv_atomic_progress_char_001',
    characterId: 'character_001',
    playerInput: '進行通知が正しいキャラに帰属するか確認します。',
    now: '2026-05-05T06:20:00.000+09:00',
    chatProvider: async () => '……ええ、区切りごとに知らせます。'
  });

  const progress = [];
  const mapCandidates = async ({ candidateFlags }) => ({
    flag_results: (candidateFlags ?? []).map((flag) => ({ flag_id: flag.id, achieved: false, reason: 'progress test' }))
  });
  const result = await finalizeConversationAtomic({
    root: playRoot,
    conversationId: 'conv_atomic_progress_char_001',
    characterId: 'character_001',
    now: '2026-05-05T06:21:00.000+09:00',
    progressReporter: ({ phase, character_id }) => progress.push({ phase, character_id }),
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
      memory_record: {
        id: 'mem_conv_atomic_progress_char_001',
        character_id: conversation.character_id,
        type: 'relationship_change',
        text: '進行通知の帰属を確認した。',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        visibility: 'character_known',
        tags: []
      }
    }),
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: conversation.character_id,
        source_conversation_id: conversation.id,
        title: '進行通知の帰属確認',
        summary: '後処理の進行通知が正しいキャラへ帰属するか確認した。',
        flag_update_candidates: [],
        warnings: []
      }
    }),
    stageFlagJudgmentProvider: mapCandidates,
    eventFlagJudgmentProvider: mapCandidates,
    eventParticipantOverrideJudgmentProvider: mapCandidates,
    eventCompletionJudgmentProvider: async () => ({ completions: [] }),
    moneyDeltaProvider: async () => '0',
    buddyAgreementProvider: async () => 'false',
    enemyHostilityProvider: async () => 'false',
    mpReserveProvider: async () => '30'
  });

  // The full closed set is emitted in order, and every phase — including commit, read from the finalize
  // result — names character_001, never the removed 'lina' default.
  assert.deepEqual(
    progress.map((item) => item.phase),
    ['memory', 'skill', 'work_record', 'state_effects', 'commit']
  );
  for (const item of progress) assert.equal(item.character_id, 'character_001');
  const commitEntry = progress.find((item) => item.phase === 'commit');
  assert.equal(commitEntry.character_id, result.conversation.character_id, 'commit is attributed to the finalize result conversation actor');
});

test('routing conversation end endpoint fully drains the finalization on exit (drain-on-exit)', async (t) => {
  const { root, playRoot, slotRoot } = await playFixture(t);
  const settingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-routing-endpoint-'));
  const settingsPath = path.join(settingsRoot, 'play-mode.json');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  t.after(async () => {
    await fs.rm(settingsRoot, { recursive: true, force: true });
  });

  const server = createServer({ root, activeRoot: resolvePlayRoot(root), playModeSettingsPath: settingsPath });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const turn = await postJson(base, '/api/conversation', {
    id: 'conv_endpoint_atomic_001',
    character_id: 'lina',
    provider: 'mock',
    player_input: '今日は記録を残して終わりにします。'
  });
  assert.equal(turn.status, 200, turn.text);
  assert.equal(turn.body.conversation.id, 'conv_endpoint_atomic_001');

  const beforeEpoch = getPromotionEpochForRoutingFinalize();
  const ending = await postJson(base, '/api/conversation/end', { provider: 'mock' });
  assert.equal(ending.status, 200, ending.text);
  // Drain-on-exit: the content-return end fully drains the pending-finalization queue before responding,
  // so the queue is empty at the transition and the response reports 'drained'.
  assert.equal(ending.body.finalization_status, 'drained');
  assert.equal(ending.body.state.current_screen, 'interaction');
  assert.equal(ending.body.transition.next_screen, 'interaction');
  assert.equal(ending.body.state.pending_finalizations.length, 0, 'the exit drain empties the queue');
  assert.ok(getPromotionEpochForRoutingFinalize() > beforeEpoch, 'the exit drain promotes the finalization (epoch advances)');

  const storage = createStorageApi({ root: playRoot });
  const conversation = await storage.readJson('game_data/logs/conversations/conv_endpoint_atomic_001.json');
  assert.equal(conversation.discarded_after_work_record_id, 'wr_conv_endpoint_atomic_001', 'the drained conversation is finalized');
  assert.equal(await exists(resolveFinalizeStagingDir(root, 'slot_001', 'conv_endpoint_atomic_001')), false, 'the staging dir is cleaned up after the promotion');
  assert.equal(await exists(path.join(slotRoot, 'finalize_staging')), false, 'endpoint staging must stay outside the slot project root');
});

test('post-visible prompt prewarm is spawned outside the foreground routing read scope', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'app/src/llm/conversationPipeline.mjs'), 'utf8');
  assert.match(
    source,
    /function startPostVisiblePromptPrewarm\(args\) \{[\s\S]*runOutsideRoutingReadScope\(\(\) => \{[\s\S]*void runPostVisiblePromptPrewarm\(args\)/,
    'detached prompt prewarm must not inherit the foreground routing read scope baseline'
  );
});
