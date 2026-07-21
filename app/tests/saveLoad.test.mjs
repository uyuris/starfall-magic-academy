import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createStorageApi } from '../src/storage.mjs';
import { createSaveSlot as createSaveSlotCore, deleteSaveSlot, loadSaveSlot, listSaveSlots, updateActiveRoutingSlotPersonaVariant, updateSaveSlotNote } from '../src/saveLoad.mjs';
import { fixtureRoot, readJson } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { projectRoot } from './testPaths.mjs';

const execFileAsync = promisify(execFile);
const stampSlotPlayModeScript = path.join(projectRoot, 'scripts/stamp-slot-play-mode.mjs');

function createSaveSlot(options) {
  return createSaveSlotCore({ playMode: 'loop', ...options });
}

async function runStampSlotPlayMode(root, args) {
  return await execFileAsync(process.execPath, [stampSlotPlayModeScript, ...args], {
    cwd: root,
    // Pin the play-mode sidecar the script reads to this fixture root (mirroring the script's own
    // root-relative fallback), so an ambient MAGIC_ACADEMY_PLAY_MODE_SETTINGS — the developer machine's
    // real play settings, e.g. a routing sidecar with a pre-replacement variant — cannot leak into the gate.
    env: { ...process.env, FORCE_COLOR: '0', MAGIC_ACADEMY_PLAY_MODE_SETTINGS: path.join(root, 'app/config/play-mode.json') }
  });
}

async function writePlayModeSettings(root, settings) {
  await writeSplitJson(root, 'app/config/play-mode.json', settings);
}

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function splitSaveRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-save-split-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', [
    { id: 'herbology_garden', name: '薬草園', description: 'split save test location' }
  ]);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'split save fixture',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/seeds/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    global_flags: { 'story.archive_intro_done': false },
    characters: {}
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    global_flags: { 'story.archive_intro_done': false },
    characters: {}
  });
  await writeSplitJson(root, 'data/mutable/game_data/player_inventory.json', { money: 0, items: [] });
  await writeSplitJson(root, 'data/mutable/game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  await writeSplitJson(root, 'content/characters/character_007/profile.json', {
    character_id: 'character_007',
    display_name: 'split save char',
    identity: 'split save identity',
    visual_set_id: 'visual_set_007',
    prompt_description: 'split save prompt',
    speaking_basis: 'split save speaking',
    available_expressions: ['neutral'],
    parameters: { magic: {}, abilities: {} }
  });
  return root;
}

async function saveFixtureRoot() {
  const root = await fixtureRoot('magic-adv-save-');
  await fs.rm(path.join(root, 'game_data/save_slots'), { recursive: true, force: true });
  return root;
}

test('createSaveSlot snapshots runtime and character flags without embedding conversation logs, and loadSaveSlot restores them', async () => {
  const root = await saveFixtureRoot();
  await writeSplitJson(root, 'game_data/gathering_stock.json', {
    version: 1,
    stocks: {
      sanrin_trailhead_silverleaf_patch: 1,
      sanrin_conifer_forest_resin_cluster: 3,
      sanrin_stream_bank_mica_pebbles: 3,
      sanrin_mossy_shrine_blue_moss: 3
    }
  });
  await writeSplitJson(root, 'game_data/mp_reserve.json', { version: 1, reserves: { character_007: 45 } });
  const saved = await createSaveSlot({ root, slotId: 'slot_001', label: '薬草園の異常前', now: '2026-05-05T06:00:00.000+09:00' });
  assert.equal(saved.slot_id, 'slot_001');
  assert.equal(saved.label, '薬草園の異常前');
  assert.equal(saved.snapshot.runtime_state.current_location_id, 'herbology_garden');
  assert.equal(saved.snapshot.logs_embedded, false);

  const state = await readJson(root, 'game_data/runtime_state.json');
  state.current_location_id = 'old_corridor';
  state.global_flags['story.archive_intro_done'] = true;
  await fs.writeFile(path.join(root, 'game_data/runtime_state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await writeSplitJson(root, 'game_data/gathering_stock.json', {
    version: 1,
    stocks: {
      sanrin_trailhead_silverleaf_patch: 0,
      sanrin_conifer_forest_resin_cluster: 0,
      sanrin_stream_bank_mica_pebbles: 0,
      sanrin_mossy_shrine_blue_moss: 0
    }
  });

  const restored = await loadSaveSlot({ root, slotId: 'slot_001' });
  assert.equal(restored.runtime_state.current_location_id, 'herbology_garden');
  assert.equal(restored.runtime_state.global_flags['story.archive_intro_done'], false);
  const restoredGatheringStock = await readJson(root, 'game_data/play/slots/slot_001/game_data/gathering_stock.json');
  assert.equal(restoredGatheringStock.stocks.sanrin_trailhead_silverleaf_patch, 1);
  // The mp_reserve mutable player surface is carried into the slot by the canonical clone.
  const restoredMpReserve = await readJson(root, 'game_data/play/slots/slot_001/game_data/mp_reserve.json');
  assert.deepEqual(restoredMpReserve, { version: 1, reserves: { character_007: 45 } });

  const { slots } = await listSaveSlots({ root });
  assert.deepEqual(slots.map((slot) => slot.slot_id), ['slot_001']);
});

test('loadSaveSlot preserves pending_finalizations field presence exactly while resolving the post-load screen', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_absent', label: 'queue absent', now: '2026-05-05T06:00:00.000+09:00' });

  const absentLoaded = await loadSaveSlot({ root, slotId: 'slot_absent', postLoadScreen: 'interaction' });
  assert.equal(absentLoaded.state.current_screen, 'interaction');
  assert.equal(Object.hasOwn(absentLoaded.state, 'pending_finalizations'), false, 'absent queue must stay absent after load');

  await createSaveSlot({ root, slotId: 'slot_present', label: 'queue present', now: '2026-05-05T06:10:00.000+09:00' });
  const slotPresentStatePath = path.join(root, 'game_data/play/slots/slot_present/game_data/runtime_state.json');
  const slotPresentState = JSON.parse(await fs.readFile(slotPresentStatePath, 'utf8'));
  const pendingFinalizations = [{
    conversation_id: 'conv_pending_001',
    character_id: 'lina',
    enqueued_at: '2026-05-05T06:11:00.000+09:00',
    status: 'pending',
    attempts: 0
  }];
  await fs.writeFile(slotPresentStatePath, `${JSON.stringify({
    ...slotPresentState,
    pending_finalizations: pendingFinalizations
  }, null, 2)}\n`, 'utf8');

  const presentLoaded = await loadSaveSlot({ root, slotId: 'slot_present', postLoadScreen: 'interaction' });
  assert.equal(presentLoaded.state.current_screen, 'interaction');
  assert.deepEqual(presentLoaded.state.pending_finalizations, pendingFinalizations, 'present queue must stay byte-shaped after load');
});

function phase2SlotRuntimeState({ characterId, screen, lastConversationId = null, endingCompleted = false }) {
  return {
    version: 1,
    current_location_id: 'front_gate_morning',
    current_screen: screen,
    current_interaction_character_id: endingCompleted ? null : characterId,
    last_conversation_id: lastConversationId,
    elapsed_weeks: 50,
    ending_started: true,
    ending_completed: endingCompleted,
    ending_character_id: characterId,
    global_flags: {
      'event.graduation_ending.ready': true,
      'event.graduation_ending.completed': endingCompleted
    },
    event_flag_sources: {
      'event.graduation_ending.ready': { character_id: characterId, source_type: 'graduation_ending', achieved_at: '2026-05-26T00:00:00.000Z' }
    },
    event_completion_sources: {},
    pending_interaction_context: endingCompleted ? null : {
      source_type: 'event',
      event_flag_id: 'event.graduation_ending.ready',
      event_label: '卒業',
      source_conversation_id: null,
      opening_context: '卒業の日。'
    }
  };
}

async function seedSlotWithState(root, slotId, { playMode, routingPersonaVariant, state }) {
  await writeSplitJson(root, `game_data/play/slots/${slotId}/meta.json`, {
    slot_id: slotId, label: slotId, created_at: 't', updated_at: 't', player_note: '',
    current_location_id: state.current_location_id ?? null, current_screen: state.current_screen ?? null,
    graduation_completed: state.ending_completed === true,
    play_mode: playMode,
    ...(routingPersonaVariant ? { routing_persona_variant: routingPersonaVariant } : {})
  });
  await writeSplitJson(root, `game_data/play/slots/${slotId}/game_data/runtime_state.json`, state);
}

test('loadSaveSlot preserves the in-flight graduation phase 2 conversation entry state instead of wiping to the post-content landing', async () => {
  const root = await fixtureRoot('magic-adv-save-phase2-');

  // routing candidate, day preset (current_screen 'interaction').
  await seedSlotWithState(root, 'slot_cand_day', {
    playMode: 'routing', routingPersonaVariant: 'fallen_star',
    state: phase2SlotRuntimeState({ characterId: 'character_001', screen: 'interaction', lastConversationId: 'conv_p2_cand_001' })
  });
  const candDay = await loadSaveSlot({ root, slotId: 'slot_cand_day', postLoadScreen: 'interaction' });
  assert.equal(candDay.state.current_interaction_character_id, 'character_001');
  assert.equal(candDay.state.current_screen, 'interaction');
  assert.equal(candDay.state.last_conversation_id, 'conv_p2_cand_001');
  assert.equal(candDay.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');

  // routing guide persona (lina), legacy preset (current_screen 'academy-conversation-session').
  await seedSlotWithState(root, 'slot_lina_legacy', {
    playMode: 'routing', routingPersonaVariant: 'fallen_star',
    state: phase2SlotRuntimeState({ characterId: 'lina', screen: 'academy-conversation-session', lastConversationId: null })
  });
  const linaLegacy = await loadSaveSlot({ root, slotId: 'slot_lina_legacy', postLoadScreen: 'interaction' });
  assert.equal(linaLegacy.state.current_interaction_character_id, 'lina');
  assert.equal(linaLegacy.state.current_screen, 'academy-conversation-session');
  assert.equal(linaLegacy.state.last_conversation_id, null);
  assert.equal(linaLegacy.state.pending_interaction_context.event_flag_id, 'event.graduation_ending.ready');

  // loop candidate, day preset. The loop post-content landing (academy-room) is NOT applied while mid-phase-2.
  await seedSlotWithState(root, 'slot_loop_day', {
    playMode: 'loop',
    state: phase2SlotRuntimeState({ characterId: 'character_002', screen: 'interaction', lastConversationId: 'conv_p2_loop_001' })
  });
  const loopDay = await loadSaveSlot({ root, slotId: 'slot_loop_day', postLoadScreen: 'academy-room' });
  assert.equal(loopDay.state.current_interaction_character_id, 'character_002');
  assert.equal(loopDay.state.current_screen, 'interaction');
  assert.equal(loopDay.state.last_conversation_id, 'conv_p2_loop_001');

  await fs.rm(root, { recursive: true, force: true });
});

test('loadSaveSlot still wipes the interaction context to the post-content landing for a non-phase-2 pending interaction', async () => {
  const root = await fixtureRoot('magic-adv-save-nonphase2-');

  // ending not started: an ordinary pending interaction is wiped to the post-content landing (byte-equivalent
  // to the prior behavior), confirming the preservation gate is specific to in-flight graduation phase 2.
  await seedSlotWithState(root, 'slot_plain', {
    playMode: 'loop',
    state: {
      version: 1,
      current_location_id: 'front_gate_morning',
      current_screen: 'interaction',
      current_interaction_character_id: 'character_003',
      last_conversation_id: 'conv_plain_001',
      elapsed_weeks: 10,
      ending_started: false,
      ending_completed: false,
      ending_character_id: null,
      global_flags: {},
      pending_interaction_context: { source_type: 'field', event_flag_id: null }
    }
  });
  const loaded = await loadSaveSlot({ root, slotId: 'slot_plain', postLoadScreen: 'academy-room' });
  assert.equal(loaded.state.current_interaction_character_id, null);
  assert.equal(loaded.state.pending_interaction_context, null);
  assert.equal(loaded.state.current_screen, 'academy-room');

  await fs.rm(root, { recursive: true, force: true });
});

test('save slots persist explicit play_mode and expose it in slot summaries', async () => {
  const root = await saveFixtureRoot();

  const saved = await createSaveSlotCore({
    root,
    slotId: 'slot_routing',
    label: 'routing slot',
    playMode: 'routing',
    routingPersonaVariant: 'fallen_star',
    now: '2026-05-05T06:00:00.000+09:00'
  });

  assert.equal(saved.slot.play_mode, 'routing');
  assert.equal(saved.slot.routing_persona_variant, 'fallen_star');
  assert.equal((await readJson(root, 'game_data/play/slots/slot_routing/meta.json')).play_mode, 'routing');
  assert.equal((await readJson(root, 'game_data/play/slots/slot_routing/meta.json')).routing_persona_variant, 'fallen_star');
  assert.deepEqual(await listSaveSlots({ root }), {
    slots: [{
      slot_id: 'slot_routing',
      label: 'routing slot',
      created_at: '2026-05-05T06:00:00.000+09:00',
      updated_at: '2026-05-05T06:00:00.000+09:00',
      player_note: '',
      current_location_id: 'herbology_garden',
      current_screen: 'field',
      graduation_completed: false,
      play_mode: 'routing',
      routing_persona_variant: 'fallen_star'
    }],
    incompatible_slots: []
  });
  await assert.rejects(
    createSaveSlotCore({ root, slotId: 'slot_missing_mode', label: 'missing mode', now: '2026-05-05T06:05:00.000+09:00' }),
    /play_mode/
  );
  await assert.rejects(
    createSaveSlotCore({ root, slotId: 'slot_missing_variant', label: 'missing variant', playMode: 'routing', now: '2026-05-05T06:06:00.000+09:00' }),
    /routing_persona_variant/
  );
});

test('listSaveSlots degrades a closed-set-incompatible slot while load still fails fast', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_ok', label: 'ok slot', now: '2026-05-05T05:00:00.000+09:00' });
  await createSaveSlot({ root, slotId: 'slot_legacy', label: 'legacy slot', now: '2026-05-05T06:00:00.000+09:00' });
  const metaPath = path.join(root, 'game_data/play/slots/slot_legacy/meta.json');
  const legacyMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'));

  // 1) missing play_mode -> degraded (not a whole-list throw); a normal slot still lists.
  const missingMeta = { ...legacyMeta };
  delete missingMeta.play_mode;
  await fs.writeFile(metaPath, `${JSON.stringify(missingMeta, null, 2)}\n`, 'utf8');
  const missing = await listSaveSlots({ root });
  assert.deepEqual(missing.slots.map((slot) => slot.slot_id), ['slot_ok']);
  assert.equal(missing.incompatible_slots.length, 1);
  assert.deepEqual(missing.incompatible_slots[0], {
    slot_id: 'slot_legacy',
    compatibility: {
      error_code: 'slot_play_mode_missing',
      message: missing.incompatible_slots[0].compatibility.message
    },
    note: '',
    updated_at: legacyMeta.updated_at
  });
  assert.match(missing.incompatible_slots[0].compatibility.message, /node scripts\/stamp-slot-play-mode\.mjs/);
  // The degraded entry carries only display metadata; no play_mode-derived field.
  assert.equal('play_mode' in missing.incompatible_slots[0], false);
  assert.equal('loadable' in missing.incompatible_slots[0], false);
  assert.equal('deletable' in missing.incompatible_slots[0], false);
  await assert.rejects(loadSaveSlot({ root, slotId: 'slot_legacy' }), /node scripts\/stamp-slot-play-mode\.mjs/);

  // 2) invalid play_mode -> degraded with slot_play_mode_invalid.
  await fs.writeFile(metaPath, `${JSON.stringify({ ...missingMeta, play_mode: 'banana' }, null, 2)}\n`, 'utf8');
  const invalid = await listSaveSlots({ root });
  assert.deepEqual(invalid.slots.map((slot) => slot.slot_id), ['slot_ok']);
  assert.equal(invalid.incompatible_slots[0].compatibility.error_code, 'slot_play_mode_invalid');
  await assert.rejects(loadSaveSlot({ root, slotId: 'slot_legacy' }), /node scripts\/stamp-slot-play-mode\.mjs/);

  // 3) routing without variant -> degraded with slot_routing_persona_variant_missing.
  await fs.writeFile(metaPath, `${JSON.stringify({ ...missingMeta, play_mode: 'routing' }, null, 2)}\n`, 'utf8');
  const routingMissing = await listSaveSlots({ root });
  assert.deepEqual(routingMissing.slots.map((slot) => slot.slot_id), ['slot_ok']);
  assert.equal(routingMissing.incompatible_slots[0].compatibility.error_code, 'slot_routing_persona_variant_missing');
  await assert.rejects(loadSaveSlot({ root, slotId: 'slot_legacy' }), /node scripts\/stamp-slot-play-mode\.mjs/);
});

test('listSaveSlots does not fold a malformed-meta slot (a different class) into incompatible_slots', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_ok', label: 'ok slot', now: '2026-05-05T05:00:00.000+09:00' });
  // A slot whose meta.json is malformed is not one of the 3 closed compatibility errors: isValidSlot
  // excludes it from listing entirely (it can neither be summarized nor surfaced as degraded). It must not
  // appear in slots or in incompatible_slots.
  const slotsRoot = path.join(root, 'game_data/play/slots');
  await fs.mkdir(path.join(slotsRoot, 'slot_broken/game_data'), { recursive: true });
  await fs.writeFile(path.join(slotsRoot, 'slot_broken/game_data/runtime_state.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(slotsRoot, 'slot_broken/meta.json'), '{broken-json\n', 'utf8');
  const listed = await listSaveSlots({ root });
  assert.deepEqual(listed.slots.map((slot) => slot.slot_id), ['slot_ok']);
  assert.deepEqual(listed.incompatible_slots, []);
});

test('stamp-slot-play-mode stamps one legacy slot and rejects unknown invalid or already-stamped input', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_legacy', label: 'legacy slot', now: '2026-05-05T06:00:00.000+09:00' });
  const metaPath = path.join(root, 'game_data/play/slots/slot_legacy/meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  delete meta.play_mode;
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await writePlayModeSettings(root, { mode: 'routing', routing_persona_variant: 'fallen_star' });

  const stamped = await runStampSlotPlayMode(root, ['slot_legacy', 'routing']);
  assert.match(stamped.stdout, /slot_legacy/);
  assert.equal((await readJson(root, 'game_data/play/slots/slot_legacy/meta.json')).play_mode, 'routing');
  assert.equal((await readJson(root, 'game_data/play/slots/slot_legacy/meta.json')).routing_persona_variant, 'fallen_star');

  await createSaveSlot({ root, slotId: 'slot_invalid_mode', label: 'invalid mode target', now: '2026-05-05T06:10:00.000+09:00' });
  const invalidModeMetaPath = path.join(root, 'game_data/play/slots/slot_invalid_mode/meta.json');
  const invalidModeMeta = JSON.parse(await fs.readFile(invalidModeMetaPath, 'utf8'));
  delete invalidModeMeta.play_mode;
  await fs.writeFile(invalidModeMetaPath, `${JSON.stringify(invalidModeMeta, null, 2)}\n`, 'utf8');

  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_missing', 'routing']),
    /unknown slot/
  );
  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_invalid_mode', 'banana']),
    /mode must be one of/
  );
  await assert.rejects(
    runStampSlotPlayMode(root, ['slot_legacy', 'loop']),
    /already has play_mode/
  );
});

test('updateSaveSlotNote stores one trimmed player note per slot without cross-slot leakage', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_001', label: 'slot one', now: '2026-05-05T06:00:00.000+09:00' });
  await createSaveSlot({ root, slotId: 'slot_002', label: 'slot two', now: '2026-05-05T06:30:00.000+09:00' });

  const longBody = 'あ'.repeat(2105);
  const updated = await updateSaveSlotNote({
    root,
    slotId: 'slot_001',
    playerNote: `  図書塔前 / リナ会話前\n${longBody}  `,
    now: '2026-05-05T07:00:00.000+09:00'
  });
  const expected = `図書塔前 / リナ会話前\n${longBody}`.slice(0, 2000);

  assert.equal(updated.slot_id, 'slot_001');
  assert.equal(updated.player_note, expected);
  assert.equal(updated.player_note.length, 2000);
  assert.equal(updated.updated_at, '2026-05-05T07:00:00.000+09:00');

  const slotOneMeta = await readJson(root, 'game_data/play/slots/slot_001/meta.json');
  const slotTwoMeta = await readJson(root, 'game_data/play/slots/slot_002/meta.json');
  assert.equal(slotOneMeta.player_note, expected);
  assert.equal(slotTwoMeta.player_note ?? '', '');

  const { slots } = await listSaveSlots({ root });
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.player_note, expected);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.player_note.length, 2000);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_002')?.player_note ?? '', '');
});

test('listSaveSlots exposes graduation_completed from slot runtime state without disturbing other slot metadata', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_001', label: 'graduated slot', now: '2026-05-05T06:00:00.000+09:00' });
  await createSaveSlot({ root, slotId: 'slot_002', label: 'active slot', now: '2026-05-05T06:30:00.000+09:00' });

  const slotOneState = await readJson(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json');
  slotOneState.ending_completed = true;
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json'), `${JSON.stringify(slotOneState, null, 2)}\n`);

  const { slots } = await listSaveSlots({ root });
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.graduation_completed, true);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_002')?.graduation_completed, false);
  assert.equal(slots.find((slot) => slot.slot_id === 'slot_001')?.player_note ?? '', '');
});

test('listSaveSlots ignores orphan slots that have meta.json but no runtime state', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_001', label: 'valid slot', now: '2026-05-05T06:00:00.000+09:00' });
  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_002'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_002/meta.json'), `${JSON.stringify({
    slot_id: 'slot_002',
    label: 'orphan slot',
    created_at: '2026-05-05T06:05:00.000+09:00',
    updated_at: '2026-05-05T06:05:00.000+09:00',
    player_note: '',
    current_location_id: 'herbology_garden',
    current_screen: 'field'
  }, null, 2)}\n`);

  const { slots } = await listSaveSlots({ root });
  assert.deepEqual(slots.map((slot) => slot.slot_id), ['slot_001']);
});

test('listSaveSlots ignores malformed-meta and invalid-name slot directories instead of throwing', async () => {
  const root = await saveFixtureRoot();
  await createSaveSlot({ root, slotId: 'slot_001', label: 'valid slot', now: '2026-05-05T06:00:00.000+09:00' });
  await fs.mkdir(path.join(root, 'game_data/play/slots/not-a-slot/game_data'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/not-a-slot/meta.json'), '{broken-json\n', 'utf8');
  await fs.mkdir(path.join(root, 'game_data/play/slots/slot_002/game_data'), { recursive: true });
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_002/game_data/runtime_state.json'), `${JSON.stringify({ graduation_completed: false }, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'game_data/play/slots/slot_002/meta.json'), '{broken-json\n', 'utf8');

  const { slots } = await listSaveSlots({ root });
  assert.deepEqual(slots.map((slot) => slot.slot_id), ['slot_001']);
});

test('createSaveSlot snapshots split-root canonical surfaces into data/mutable play slots without creating legacy game_data/play', async (t) => {
  const root = await splitSaveRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const saved = await createSaveSlot({ root, slotId: 'slot_001', label: 'split canonical snapshot', now: '2026-05-05T06:00:00.000+09:00' });

  assert.equal(saved.slot_id, 'slot_001');
  assert.equal(saved.snapshot.runtime_state.current_location_id, 'herbology_garden');
  const slotState = await readJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/runtime_state.json');
  assert.equal(slotState.current_location_id, 'herbology_garden');
  const slotParameters = await readJson(root, 'data/mutable/game_data/play/slots/slot_001/game_data/runtime/player_parameters.json');
  assert.equal(slotParameters.magic.light.value, 25);
  const slotStorage = createStorageApi({ root: path.join(root, 'data/mutable/game_data/play/slots/slot_001') });
  const slotWorldSettings = await slotStorage.readJson('game_data/world/settings.json');
  assert.equal(slotWorldSettings.academy_name, '星灯魔法学院');

  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_001/game_data/runtime_state.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/active_slot.json')), { code: 'ENOENT' });
});

test('createSaveSlot succeeds without symlink privilege and still resolves canonical reads through storage', async (t) => {
  const root = await splitSaveRoot();
  const originalSymlink = fs.symlink;
  fs.symlink = async () => {
    const error = new Error('operation not permitted');
    error.code = 'EPERM';
    throw error;
  };
  t.after(async () => {
    fs.symlink = originalSymlink;
    await fs.rm(root, { recursive: true, force: true });
  });

  const saved = await createSaveSlot({ root, slotId: 'slot_001', label: 'non-privileged split slot', now: '2026-05-05T06:00:00.000+09:00' });
  const slotStorage = createStorageApi({ root: path.join(root, 'data/mutable/game_data/play/slots/slot_001') });

  assert.equal(saved.slot_id, 'slot_001');
  assert.equal(await slotStorage.resolveReadPath('game_data/world/settings.json'), path.join(root, 'data/definitions/game_data/world/settings.json'));
  assert.equal(await slotStorage.resolveReadPath('game_data/characters/character_007/profile.json'), path.join(root, 'content/characters/character_007/profile.json'));
  const runtimeState = await slotStorage.readJson('game_data/runtime_state.json');
  assert.equal(runtimeState.current_location_id, 'herbology_garden');
});

test('loadSaveSlot and split-root slot note updates stay under data/mutable play and do not recreate legacy game_data/play', async (t) => {
  const root = await splitSaveRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await createSaveSlot({ root, slotId: 'slot_001', label: 'split canonical snapshot', now: '2026-05-05T06:00:00.000+09:00' });
  await createSaveSlot({ root, slotId: 'slot_002', label: 'split second snapshot', now: '2026-05-05T06:10:00.000+09:00' });
  const updated = await updateSaveSlotNote({
    root,
    slotId: 'slot_001',
    playerNote: 'split root note',
    now: '2026-05-05T06:20:00.000+09:00'
  });
  assert.equal(updated.player_note, 'split root note');

  const slotTwoStorage = createStorageApi({ root: path.join(root, 'data/mutable/game_data/play/slots/slot_002') });
  assert.equal(
    await slotTwoStorage.resolveReadPath('game_data/runtime_state.json'),
    path.join(root, 'data/mutable/game_data/play/slots/slot_002/game_data/runtime_state.json')
  );

  const loaded = await loadSaveSlot({ root, slotId: 'slot_002' });
  assert.equal(loaded.slot.slot_id, 'slot_002');
  assert.equal(loaded.state.current_screen, 'academy-room');
  const activeSlot = await readJson(root, 'data/mutable/game_data/play/active_slot.json');
  assert.equal(activeSlot.slot_id, 'slot_002');

  const slotOneMeta = await readJson(root, 'data/mutable/game_data/play/slots/slot_001/meta.json');
  assert.equal(slotOneMeta.player_note, 'split root note');
  await assert.rejects(fs.access(path.join(root, 'game_data/play/active_slot.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_001/meta.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/play/slots/slot_002/game_data/runtime_state.json')), { code: 'ENOENT' });
});

test('deleteSaveSlot clears the active play-root manifest when deleting the active split-root slot', async (t) => {
  const root = await splitSaveRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await createSaveSlot({ root, slotId: 'slot_001', label: 'split canonical snapshot', now: '2026-05-05T06:00:00.000+09:00' });
  await loadSaveSlot({ root, slotId: 'slot_001' });

  const deleted = await deleteSaveSlot({ root, slotId: 'slot_001' });

  assert.equal(deleted.deleted_slot_id, 'slot_001');
  assert.equal(deleted.active_slot_id, null);
  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/play/.magic-academy-runtime-paths.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'data/mutable/game_data/play/active_slot.json')), { code: 'ENOENT' });
});

test('save slot operations reject slot ids that are not in the allowed slot_* format', async () => {
  const root = await saveFixtureRoot();

  await assert.rejects(
    createSaveSlot({ root, slotId: '../escape', label: 'bad slot', now: '2026-05-05T06:00:00.000+09:00' }),
    /slot/i
  );

  await createSaveSlot({ root, slotId: 'slot_001', label: 'good slot', now: '2026-05-05T06:01:00.000+09:00' });

  await assert.rejects(
    loadSaveSlot({ root, slotId: 'slot_001/../../runtime_state' }),
    /slot/i
  );
  await assert.rejects(
    updateSaveSlotNote({ root, slotId: 'slot_001/../../runtime_state', playerNote: 'bad', now: '2026-05-05T06:02:00.000+09:00' }),
    /slot/i
  );
  await assert.rejects(
    deleteSaveSlot({ root, slotId: 'slot_001/../../runtime_state' }),
    /slot/i
  );
});

test('updateActiveRoutingSlotPersonaVariant updates only an active routing slot, validates strictly, and errors explicitly on loop / no-active', async () => {
  const root = await fixtureRoot('magic-adv-slot-persona-');
  async function seedSlot(slotId, meta) {
    await writeSplitJson(root, `game_data/play/slots/${slotId}/meta.json`, meta);
    await writeSplitJson(root, `game_data/play/slots/${slotId}/game_data/runtime_state.json`, {
      version: 1, current_location_id: 'herbology_garden', current_screen: 'academy-map', ending_completed: false
    });
  }
  const routingMeta = {
    slot_id: 'slot_001', label: 'r', created_at: 't', updated_at: 't', player_note: '',
    current_location_id: 'herbology_garden', current_screen: 'academy-map', graduation_completed: false,
    play_mode: 'routing', routing_persona_variant: 'legacy_removed_variant'
  };
  const loopMeta = {
    slot_id: 'slot_002', label: 'l', created_at: 't', updated_at: 't', player_note: '',
    current_location_id: 'herbology_garden', current_screen: 'academy-room', graduation_completed: false,
    play_mode: 'loop'
  };
  await seedSlot('slot_001', routingMeta);
  await seedSlot('slot_002', loopMeta);

  // No active slot → explicit error (never a silent no-op).
  await assert.rejects(
    () => updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant: 'fallen_star' }),
    (error) => error?.statusCode === 409 && error?.errorCode === 'no_active_slot'
  );

  // Active routing slot with a stale (out-of-closed-set) variant → updated to the new closed-set variant.
  await writeSplitJson(root, 'game_data/play/active_slot.json', { slot_id: 'slot_001' });
  assert.deepEqual(await updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant: 'fallen_star' }), { slot_id: 'slot_001', routing_persona_variant: 'fallen_star' });
  assert.equal((await readJson(root, 'game_data/play/slots/slot_001/meta.json')).routing_persona_variant, 'fallen_star');

  // Idempotent: re-setting the already-set variant returns the same result without changing the variant.
  assert.deepEqual(await updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant: 'fallen_star' }), { slot_id: 'slot_001', routing_persona_variant: 'fallen_star' });
  assert.equal((await readJson(root, 'game_data/play/slots/slot_001/meta.json')).routing_persona_variant, 'fallen_star');

  // Active LOOP slot → explicit error (the global sidecar owns loop / the new-game default; not silently changed).
  await writeSplitJson(root, 'game_data/play/active_slot.json', { slot_id: 'slot_002' });
  await assert.rejects(
    () => updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant: 'fallen_star' }),
    (error) => error?.statusCode === 409 && error?.errorCode === 'active_slot_not_routing'
  );
  assert.deepEqual(await readJson(root, 'game_data/play/slots/slot_002/meta.json'), loopMeta, 'a loop slot meta is untouched');

  // Out-of-set variant fails fast on this write path (strict closed set — no alias / silent map).
  await writeSplitJson(root, 'game_data/play/active_slot.json', { slot_id: 'slot_001' });
  await assert.rejects(() => updateActiveRoutingSlotPersonaVariant({ root, routingPersonaVariant: 'legacy_removed_variant' }), /routing persona variant/);

  await fs.rm(root, { recursive: true, force: true });
});
