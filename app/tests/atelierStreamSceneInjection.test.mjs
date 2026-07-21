// atelier-stream-scene-injection-fix: the stream endpoint's atelier scene injection, the injected-scene
// defensive invariant, and the corrupt-save repair script.
//
// The LLM-backed paths run with provider=mock (deterministic providers, no live LM), mirroring the errand /
// study-circle stream tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { fixtureRoot, isolatedPlayModeSettingsPath, readJson, writeJson } from './helpers.mjs';
import { projectRoot } from './testPaths.mjs';
import { createServer } from '../src/server.mjs';
import { initializeNewPlayArea, resolvePlayRoot } from '../src/playSession.mjs';
import {
  runConversationOpening,
  runConversationTurn as runConversationTurnCore,
  companionPostTurnStatePolicy
} from '../src/llm/conversationPipeline.mjs';
import {
  ATELIER_LOCATION_NAME,
  ATELIER_VISIBLE_SITUATION,
  atelierInjectedSceneContext
} from '../src/homunculusScene.mjs';
import {
  HOMUNCULUS_SOURCE_TYPE,
  ROUTING_HUB_SOURCE_TYPE,
  conversationFinalizationStageFields
} from '../src/routingMetaContext.mjs';
import { ROUTING_PERSONA_CHARACTER_ID } from '../src/routingPersona.mjs';
import {
  ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY,
  ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY
} from '../src/homunculusAtelierVisit.mjs';
import { repairAtelierConversationScene } from '../src/repairAtelierConversationScene.mjs';

const livePublicRoot = path.join(projectRoot, 'app/public');
const NOW = '2026-07-09T00:00:00.000Z';

// A routing play area with one active homunculus (錬成室のうちの子) seeded and ready to converse.
async function routingFixture(t, { elapsedWeeks = 5 } = {}) {
  const root = await fixtureRoot('magic-adv-atelier-stream-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const initialized = await initializeNewPlayArea({ root, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  const slotRoot = initialized.root;
  await seedActiveHomunculus(slotRoot);
  // The atelier destination unlocks at magic ≥ 80; seed unlocking parameters so /api/atelier/* is reachable.
  await writeJson(slotRoot, 'game_data/runtime/player_parameters.json', unlockedPlayerParameters());
  await patchRuntimeState(slotRoot, {
    current_screen: 'academy-atelier',
    current_interaction_character_id: null,
    pending_interaction_context: null,
    elapsed_weeks: elapsedWeeks
  });
  return { root, slotRoot, slotId: 'slot_001' };
}

function unlockedPlayerParameters() {
  const entry = (label, value) => ({ min: 0, max: 100, label, value });
  const magicKeys = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
  const abilityKeys = ['strength', 'agility', 'academics', 'magical_power', 'charisma'];
  return {
    magic: Object.fromEntries(magicKeys.map((key) => [key, entry(`${key}魔法習熟度`, 85)])),
    abilities: Object.fromEntries(abilityKeys.map((key) => [key, entry(key, 50)]))
  };
}

async function seedActiveHomunculus(slotRoot, { homunculusId = 'homunculus_001', displayName = 'ヴィオラ', faceId = 'hp_007' } = {}) {
  await writeJson(slotRoot, 'game_data/homunculi.json', {
    version: 1,
    active: [{ homunculus_id: homunculusId, display_name: displayName, face_id: faceId, created_week: 3 }],
    nameplates: []
  });
  await writeJson(slotRoot, `game_data/homunculi/${homunculusId}/profile.json`, {
    character_id: homunculusId,
    display_name: displayName,
    prompt_description: '臆病で甘えん坊、けれど時おり皮肉を差し込むホムンクルス。',
    speaking_basis: '一人称は「私」。控えめで小声、緊張すると言葉に詰まる。',
    parameters: { magic: {}, abilities: {} }
  });
  await writeJson(slotRoot, `game_data/homunculi/${homunculusId}/flags.json`, { character_id: homunculusId, flags: {} });
  await writeJson(slotRoot, `game_data/homunculi/${homunculusId}/skills.json`, { character_id: homunculusId, skills: [] });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${homunculusId}/memory`), { recursive: true });
  await fs.mkdir(path.join(slotRoot, `game_data/homunculi/${homunculusId}/work_records`), { recursive: true });
}

async function patchRuntimeState(slotRoot, patch) {
  const state = await readJson(slotRoot, 'game_data/runtime_state.json');
  await writeJson(slotRoot, 'game_data/runtime_state.json', { ...state, ...patch });
}

async function startServer(t, root) {
  const settingsPath = await isolatedPlayModeSettingsPath(t, 'magic-adv-atelier-stream-mode-');
  await fs.writeFile(settingsPath, `${JSON.stringify({ mode: 'routing', routing_persona_variant: 'fallen_star' }, null, 2)}\n`, 'utf8');
  const server = createServer({
    root,
    activeRoot: resolvePlayRoot(root),
    publicRoot: livePublicRoot,
    playModeSettingsPath: settingsPath,
    lmStudioConfigPath: path.join(root, 'missing-lmstudio.json')
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

function parseSseEvents(text) {
  return text.split('\n\n').filter((block) => block.trim()).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const dataText = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: dataText ? JSON.parse(dataText) : null };
  });
}

// Seeds an in-progress atelier conversation the way /api/atelier/conversation/start does — an opening record
// carrying the authored atelier scene plus the active-conversation marker — but directly, so the setup does not
// depend on an LM config (the atelier start endpoint eagerly resolves one). The stream turn under test still
// runs through the server.
async function seedAtelierConversation(slotRoot, { conversationId = 'conv_atelier_001', week = 5 } = {}) {
  await runConversationOpening({
    root: slotRoot,
    id: conversationId,
    characterId: 'homunculus_001',
    now: NOW,
    dungeonSceneContext: atelierInjectedSceneContext(),
    chatProvider: async () => '……おかえりなさい。あなたが、私を灯してくれたのですね。'
  });
  await patchRuntimeState(slotRoot, {
    current_screen: 'interaction',
    current_interaction_character_id: 'homunculus_001',
    last_conversation_id: conversationId,
    [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: {
      conversation_id: conversationId,
      homunculus_id: 'homunculus_001',
      display_name: 'ヴィオラ',
      face_id: 'hp_007',
      week
    }
  });
  return conversationId;
}

// A decided-'title' (区切りをつける) routing-hub conversation that is already work-recorded (discarded), so the
// wrap-up dispatch re-confirms its landing without enqueuing a new hub finalization — isolating the drain
// behavior under test. 'title' is the neutral non-progressing wrap-up exit.
function hubTitleDispatchConversation(id) {
  return {
    id,
    character_id: ROUTING_PERSONA_CHARACTER_ID,
    character_name: 'ルミ',
    created_at: NOW,
    updated_at: NOW,
    source_type: ROUTING_HUB_SOURCE_TYPE,
    routing_hub: { persona_variant: 'fallen_star' },
    routing_destination_judgment: { decided: true, destination_id: 'title', destination_label: '区切りをつける' },
    discarded_after_work_record_id: 'wr_hub_title_001',
    conversation_actor_context: null,
    prompt: 'hub prompt',
    messages: [
      { role: 'assistant', content: 'こんばんは。今週はどう過ごしますか？' },
      { role: 'user', content: '今日はここまでにする。' },
      { role: 'assistant', content: 'わかりました。今日はここで区切りをつけましょう。' }
    ]
  };
}

function failedHomunculusJob(conversationId) {
  return {
    conversation_id: conversationId,
    character_id: 'homunculus_001',
    enqueued_at: NOW,
    status: 'failed',
    attempts: 1,
    failed_at: NOW,
    error: { message: 'homunculus conversation record must carry a non-empty location_name for finalization' }
  };
}

// ----- Part 1: the stream atelier branch -----

test('a streamed homunculus atelier turn keeps the atelier scene on the record and finalization succeeds', async (t) => {
  const { root, slotRoot } = await routingFixture(t, { elapsedWeeks: 5 });
  const base = await startServer(t, root);
  const conversationId = await seedAtelierConversation(slotRoot, { week: 5 });

  // A daytime turn goes through the STREAM endpoint; before the fix it dropped the atelier 舞台.
  const streamed = await fetch(`${base}/api/conversation/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: conversationId, character_id: 'homunculus_001', player_input: '今日はどんな一日だった？', provider: 'mock' })
  });
  assert.equal(streamed.status, 200);
  const events = parseSseEvents(await streamed.text());
  assert.equal(events.some((e) => e.event === 'error'), false, 'the streamed atelier turn does not error');
  assert.ok(events.find((e) => e.event === 'result'), 'the stream emits a result event');

  // The persisted record keeps the homunculus source_type and the atelier 舞台, with no residual field location.
  const record = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
  assert.equal(record.source_type, HOMUNCULUS_SOURCE_TYPE);
  assert.equal(record.location_name, ATELIER_LOCATION_NAME);
  assert.equal(record.visible_situation, ATELIER_VISIBLE_SITUATION);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'location_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'time_slot'), false);
  // The finalization stage-descriptor guard (the one that fail-fasted before) now accepts the streamed record.
  assert.doesNotThrow(() => conversationFinalizationStageFields(record));

  // Ending the atelier conversation finalizes it (no location_name error) and completes the visit.
  const ended = await postJson(base, '/api/conversation/end', { conversation_id: conversationId, character_id: 'homunculus_001', provider: 'mock' });
  assert.equal(ended.status, 200, `atelier end failed: ${ended.text}`);
  assert.equal(ended.body.finalization_status, 'drained');
  const endedState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(Object.prototype.hasOwnProperty.call(endedState, ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY), false, 'the active atelier marker is cleared on a successful end');
  assert.equal(endedState[ROUTING_ATELIER_CONVERSATION_SPENT_WEEK_STATE_KEY], 5, 'the visit conversation is spent for this week');
});

// ----- Part 2: the injected-scene defensive invariant -----

test('runConversationTurn fails fast before writing when an atelier conversation is continued without its injected scene', async (t) => {
  const { slotRoot } = await routingFixture(t, { elapsedWeeks: 5 });
  const conversationId = await seedAtelierConversation(slotRoot, { week: 5 });
  const before = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);

  // Continue the homunculus conversation WITHOUT re-supplying the atelier scene — the exact pre-fix stream bug.
  // The invariant must throw BEFORE any provider call or record write.
  await assert.rejects(
    runConversationTurnCore({
      root: slotRoot,
      id: conversationId,
      characterId: 'homunculus_001',
      playerInput: '少し話そう。',
      now: NOW,
      postTurnStatePolicy: companionPostTurnStatePolicy,
      emotionProvider: async () => { throw new Error('emotion provider must not run — the invariant must throw first'); },
      chatProvider: async () => { throw new Error('chat provider must not run — the invariant must throw first'); },
      conversationContinuationProvider: async () => 'true',
      workRecordRecallProvider: async () => ({ work_record_ids: [] })
    }),
    /homunculus conversation must be continued with its injected scene/
  );

  // The record was NOT overwritten: the invariant fires before the write, so the atelier scene survives intact.
  const after = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
  assert.deepEqual(after, before, 'the corrupting write is prevented; the record is byte-identical');
  assert.equal(after.location_name, ATELIER_LOCATION_NAME);
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'location_id'), false);

  // Positive control: the same turn WITH the atelier scene re-supplied succeeds and keeps the scene.
  await runConversationTurnCore({
    root: slotRoot,
    id: conversationId,
    characterId: 'homunculus_001',
    playerInput: '少し話そう。',
    now: '2026-07-09T00:01:00.000Z',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: atelierInjectedSceneContext(),
    emotionProvider: async () => ({ expression: 'neutral' }),
    chatProvider: async () => '……はい、少しだけ。',
    conversationContinuationProvider: async () => 'true',
    workRecordRecallProvider: async () => ({ work_record_ids: [] })
  });
  const healed = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
  assert.equal(healed.source_type, HOMUNCULUS_SOURCE_TYPE);
  assert.equal(healed.location_name, ATELIER_LOCATION_NAME);
  assert.equal(Object.prototype.hasOwnProperty.call(healed, 'location_id'), false);
});

// ----- Part 3: the corrupt-save repair, end-to-end through a routing dispatch -----

async function corruptAtelierRecord(slotRoot, conversationId) {
  const record = await readJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`);
  const { location_name: _name, visible_situation: _situation, ...rest } = record;
  await writeJson(slotRoot, `game_data/logs/conversations/${conversationId}.json`, {
    ...rest,
    location_id: 'herbology_garden',
    time_slot: 'after_school'
  });
}

test('the repair script fixes a corrupt atelier record + failed job (dry-run first), unblocking a routing dispatch drain', async (t) => {
  const { root, slotRoot } = await routingFixture(t, { elapsedWeeks: 5 });
  const base = await startServer(t, root);

  // Reproduce the corrupt save: a real atelier opening record, then corrupt it exactly as the pre-fix stream
  // turn did (drop the scene, write a field descriptor), plus a failed finalization job blocking the queue.
  const atelierConversationId = await seedAtelierConversation(slotRoot, { conversationId: 'conv_atelier_broken_001', week: 5 });
  await corruptAtelierRecord(slotRoot, atelierConversationId);
  assert.throws(
    () => conversationFinalizationStageFields({ source_type: HOMUNCULUS_SOURCE_TYPE, location_id: 'herbology_garden', time_slot: 'after_school' }),
    /must carry a non-empty location_name/,
    'the corrupt record shape reproduces the finalization guard failure'
  );

  const hubConversationId = 'conv_hub_repair_001';
  await writeJson(slotRoot, `game_data/logs/conversations/${hubConversationId}.json`, hubTitleDispatchConversation(hubConversationId));
  await patchRuntimeState(slotRoot, {
    current_screen: 'routing-hub',
    current_interaction_character_id: ROUTING_PERSONA_CHARACTER_ID,
    last_conversation_id: hubConversationId,
    pending_interaction_context: null,
    pending_finalizations: [failedHomunculusJob(atelierConversationId)],
    [ROUTING_ATELIER_ACTIVE_CONVERSATION_STATE_KEY]: null
  });

  // Pre-repair: the routing hub dispatch is blocked by the failed homunculus job — the whole-queue drain
  // fails fast rather than completing the wrap-up.
  const blocked = await postJson(base, '/api/conversation/end', { conversation_id: hubConversationId, character_id: ROUTING_PERSONA_CHARACTER_ID, provider: 'mock' });
  assert.equal(blocked.status, 500, `blocked drain should fail: ${blocked.text}`);

  // Dry-run repair: the plan names the exact targets and writes NOTHING.
  const plan = await repairAtelierConversationScene({ root, slotId: 'slot_001', apply: false });
  assert.equal(plan.applied, false);
  assert.deepEqual(plan.conversation_repairs.map((r) => r.conversation_id), [atelierConversationId]);
  assert.deepEqual(plan.finalization_repairs, [{ conversation_id: atelierConversationId, character_id: 'homunculus_001', before_status: 'failed', after_status: 'pending' }]);
  const afterDryRun = await readJson(slotRoot, `game_data/logs/conversations/${atelierConversationId}.json`);
  assert.equal(Object.prototype.hasOwnProperty.call(afterDryRun, 'location_name'), false, 'dry-run must not touch the record');
  const stateAfterDryRun = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(stateAfterDryRun.pending_finalizations[0].status, 'failed', 'dry-run must not touch the queue');

  // Apply repair: the record regains the authored atelier scene (no field descriptor), and the failed job
  // becomes a clean retryable pending job.
  const applied = await repairAtelierConversationScene({ root, slotId: 'slot_001', apply: true });
  assert.equal(applied.applied, true);
  const repairedRecord = await readJson(slotRoot, `game_data/logs/conversations/${atelierConversationId}.json`);
  assert.equal(repairedRecord.location_name, ATELIER_LOCATION_NAME);
  assert.equal(repairedRecord.visible_situation, ATELIER_VISIBLE_SITUATION);
  assert.equal(Object.prototype.hasOwnProperty.call(repairedRecord, 'location_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(repairedRecord, 'time_slot'), false);
  assert.doesNotThrow(() => conversationFinalizationStageFields(repairedRecord), 'the repaired record passes the finalization guard');
  const repairedState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.deepEqual(repairedState.pending_finalizations[0], { conversation_id: atelierConversationId, character_id: 'homunculus_001', enqueued_at: NOW, status: 'pending', attempts: 0 });

  // Post-repair: the dispatch drains the now-retryable homunculus job (real finalization succeeds on the fixed
  // record) and lands the wrap-up exit (title). The routing drain is unblocked.
  const landed = await postJson(base, '/api/conversation/end', { conversation_id: hubConversationId, character_id: ROUTING_PERSONA_CHARACTER_ID, provider: 'mock' });
  assert.equal(landed.status, 200, `post-repair dispatch should succeed: ${landed.text}`);
  assert.equal(landed.body.finalization_status, 'drained');
  const landedState = await readJson(slotRoot, 'game_data/runtime_state.json');
  assert.equal(landedState.current_screen, 'title');
  assert.equal(landedState.pending_finalizations.length, 0, 'the repaired homunculus finalization drained clean');
});

test('the repair is a dry-run no-op on a clean save and fail-fasts on an unrepairable failed job', async (t) => {
  const { root, slotRoot } = await routingFixture(t, { elapsedWeeks: 5 });

  // Clean save: nothing to repair.
  const clean = await repairAtelierConversationScene({ root, slotId: 'slot_001', apply: false });
  assert.deepEqual(clean.conversation_repairs, []);
  assert.deepEqual(clean.finalization_repairs, []);

  // A failed homunculus job whose conversation record does not exist cannot be safely made retryable — fail-fast,
  // never silent-skip.
  await patchRuntimeState(slotRoot, {
    pending_finalizations: [failedHomunculusJob('conv_atelier_missing_999')]
  });
  await assert.rejects(
    repairAtelierConversationScene({ root, slotId: 'slot_001', apply: false }),
    /cannot make failed homunculus finalization retryable/
  );
});
