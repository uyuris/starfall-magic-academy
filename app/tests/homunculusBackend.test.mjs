import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageApi } from '../src/storage.mjs';
import {
  resolveDialogueActor,
  isHomunculusDialogueActor
} from '../src/llm/dialogueActor.mjs';
import {
  HOMUNCULI_SURFACE_PATH,
  MAX_ACTIVE_HOMUNCULI,
  emptyHomunculiSurface,
  loadHomunculiSurface,
  appendActiveHomunculus,
  farewellActiveHomunculus,
  validateHomunculiSurface
} from '../src/homunculusSurface.mjs';
import {
  HOMUNCULUS_AFFINITY_INITIAL_VALUE,
  homunculusAffinityPath,
  defaultHomunculusAffinityFile,
  normalizeHomunculusAffinityFile,
  applyHomunculusAffinityDelta
} from '../src/homunculusAffinity.mjs';
import {
  ATELIER_LOCATION_NAME,
  ATELIER_VISIBLE_SITUATION,
  atelierInjectedSceneContext
} from '../src/homunculusScene.mjs';
import {
  HOMUNCULUS_SOURCE_TYPE,
  INJECTED_SCENE_SOURCE_TYPES
} from '../src/routingMetaContext.mjs';
import {
  runConversationOpening,
  runConversationTurn as runConversationTurnCore,
  companionPostTurnStatePolicy,
  finalizeConversation
} from '../src/llm/conversationPipeline.mjs';
import { initializeNewPlayArea } from '../src/playSession.mjs';
import { baselineRuntimeState } from './helpers.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

async function writeSplitJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function exists(root, relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function bareRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-homun-bare-'));
}

function activeEntry(overrides = {}) {
  return {
    homunculus_id: 'homunculus_001',
    display_name: 'ヴィオラ',
    face_id: 'hp_007',
    created_week: 3,
    ...overrides
  };
}

// A split-layout fixture with one seeded, minted homunculus actor + surface, mirroring the creature
// dialogue fixture. The homunculus actor directory is wholly per-slot mutable, so everything lives under
// data/mutable/game_data/homunculi/<id>/.
async function homunculusDialogueRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-homun-dialogue-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', [{ id: 'herbology_garden', name: '薬草園', description: 'homunculus fixture' }]);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: 'homunculus fixture',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_location_id: 'herbology_garden',
    current_screen: 'field',
    global_flags: {},
    event_flag_sources: {},
    event_completion_sources: {},
    disabled_stage_flag_judgment_flows: {},
    visited_locations: ['herbology_garden'],
    active_character_ids: ['lina'],
    last_conversation_id: null,
    characters: { lina: { flags: {} } },
    homunculi: {},
    pending_interaction_context: null,
    training_actions_used: 0,
    training_actions_limit: 6,
    elapsed_weeks: 2,
    ending_started: false,
    ending_completed: false,
    ending_character_id: null,
    current_buddy_character_id: null,
    current_enemy_character_ids: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/player_inventory.json', { money: 0, items: [] });
  await writeSplitJson(root, 'data/mutable/game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 25 } }
  });
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ',
    identity: '薬草園の生徒',
    visual_set_id: 'lina',
    prompt_description: '薬草の観察が得意。',
    speaking_basis: '丁寧に話す。',
    available_expressions: ['neutral', 'happy'],
    parameters: { magic: {}, abilities: {} }
  });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/flags.json', { character_id: 'lina', flags: {} });
  await writeSplitJson(root, 'data/mutable/game_data/characters/lina/skills.json', { character_id: 'lina', skills: [] });

  // The minted homunculus actor (per-slot mutable) and the surface.
  await writeSplitJson(root, 'data/mutable/game_data/homunculi/homunculus_001/profile.json', {
    character_id: 'homunculus_001',
    display_name: 'ヴィオラ',
    prompt_description: '臆病で甘えん坊、けれど時おり皮肉を差し込むホムンクルス。錬成室で灯された身を静かに受け止め、創り主のそばにいられることを何より大切に思っている。',
    speaking_basis: '一人称は「私」。控えめで小声、緊張すると言葉に詰まる。皮肉を言うときだけ少し早口で理屈っぽくなる。',
    parameters: { magic: {}, abilities: {} }
  });
  await writeSplitJson(root, 'data/mutable/game_data/homunculi/homunculus_001/flags.json', {
    character_id: 'homunculus_001',
    flags: {}
  });
  await writeSplitJson(root, 'data/mutable/game_data/homunculi/homunculus_001/skills.json', {
    character_id: 'homunculus_001',
    skills: []
  });
  await fs.mkdir(path.join(root, 'data/mutable/game_data/homunculi/homunculus_001/memory'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/mutable/game_data/homunculi/homunculus_001/work_records'), { recursive: true });
  await writeSplitJson(root, 'data/mutable/game_data/homunculi.json', {
    version: 1,
    active: [activeEntry()],
    nameplates: []
  });
  return root;
}

async function cleanup(t, root) {
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
}

// --- actor resolution ---

test('resolveDialogueActor resolves a homunculus id to the homunculus actor kind and mutable base path', () => {
  const actor = resolveDialogueActor('homunculus_012');
  assert.equal(actor.id, 'homunculus_012');
  assert.equal(actor.kind, 'homunculus');
  assert.equal(actor.stateCollection, 'homunculi');
  assert.equal(actor.basePath, 'game_data/homunculi/homunculus_012');
  assert.equal(isHomunculusDialogueActor('homunculus_012'), true);
  assert.equal(isHomunculusDialogueActor('character_012'), false);
});

test('resolveDialogueActor fails fast on a malformed homunculus id', () => {
  assert.throws(() => resolveDialogueActor('homunculus_12'), /unknown dialogue actor/);
  assert.throws(() => resolveDialogueActor('homunculus_1234'), /unknown dialogue actor/);
});

// --- surface ---

test('an absent homunculi surface reads as an empty surface', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  const surface = await loadHomunculiSurface({ root });
  assert.deepEqual(surface, emptyHomunculiSurface());
  assert.deepEqual(surface, { version: 1, active: [], nameplates: [] });
});

test('appendActiveHomunculus round-trips a minted child through the surface', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  await appendActiveHomunculus({ root, entry: activeEntry() });
  const surface = await loadHomunculiSurface({ root });
  assert.equal(surface.active.length, 1);
  assert.deepEqual(surface.active[0], activeEntry());
  assert.deepEqual(surface.nameplates, []);
});

test('appendActiveHomunculus fails fast when the active roster is already full', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_001', face_id: 'hp_001' }) });
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_002', face_id: 'hp_002' }) });
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_003', face_id: 'hp_003' }) });
  await assert.rejects(
    appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_004', face_id: 'hp_004' }) }),
    new RegExp(`active roster is full \\(${MAX_ACTIVE_HOMUNCULI}\\)`)
  );
  const surface = await loadHomunculiSurface({ root });
  assert.equal(surface.active.length, MAX_ACTIVE_HOMUNCULI);
});

test('appendActiveHomunculus rejects a duplicate id (across active and nameplates)', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_001', face_id: 'hp_001' }) });
  await assert.rejects(
    appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_001', face_id: 'hp_009' }) }),
    /homunculus_id already exists on the surface/
  );
});

test('farewellActiveHomunculus frees a slot, keeps a persistent nameplate, and never reuses the id', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_001', face_id: 'hp_001' }) });
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_002', face_id: 'hp_002' }) });
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_003', face_id: 'hp_003' }) });

  await farewellActiveHomunculus({ root, homunculusId: 'homunculus_002', epitaph: '静かな夜に灯り、静かに還った。', farewellWeek: 12 });
  const surface = await loadHomunculiSurface({ root });
  assert.deepEqual(surface.active.map((entry) => entry.homunculus_id), ['homunculus_001', 'homunculus_003']);
  assert.equal(surface.nameplates.length, 1);
  assert.deepEqual(surface.nameplates[0], {
    homunculus_id: 'homunculus_002',
    display_name: 'ヴィオラ',
    epitaph: '静かな夜に灯り、静かに還った。',
    face_id: 'hp_002',
    farewell_week: 12
  });

  // A slot is free again, but the farewelled id stays reserved forever — minting it again is rejected as a
  // duplicate even though the roster is not full.
  await assert.rejects(
    appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_002', face_id: 'hp_005' }) }),
    /homunculus_id already exists on the surface/
  );
  // The free slot can still take a genuinely new id.
  await appendActiveHomunculus({ root, entry: activeEntry({ homunculus_id: 'homunculus_004', face_id: 'hp_004' }) });
  const filled = await loadHomunculiSurface({ root });
  assert.deepEqual(filled.active.map((entry) => entry.homunculus_id), ['homunculus_001', 'homunculus_003', 'homunculus_004']);
});

test('validateHomunculiSurface throws on malformed surfaces (no compat read)', () => {
  assert.throws(() => validateHomunculiSurface({ version: 2, active: [], nameplates: [] }), /version must be 1/);
  assert.throws(() => validateHomunculiSurface({ version: 1, active: [], nameplates: [], extra: true }), /keys must be exactly/);
  assert.throws(() => validateHomunculiSurface({ version: 1, active: {}, nameplates: [] }), /active must be an array/);
  assert.throws(
    () => validateHomunculiSurface({ version: 1, active: [activeEntry(), activeEntry({ homunculus_id: 'homunculus_002', face_id: 'hp_002' }), activeEntry({ homunculus_id: 'homunculus_003', face_id: 'hp_003' }), activeEntry({ homunculus_id: 'homunculus_004', face_id: 'hp_004' })], nameplates: [] }),
    new RegExp(`active must hold at most ${MAX_ACTIVE_HOMUNCULI}`)
  );
  assert.throws(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ face_id: 'hp_051' })], nameplates: [] }), /face_id must be within hp_001/);
  assert.throws(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ face_id: 'hp_000' })], nameplates: [] }), /face_id must be within hp_001/);
  assert.throws(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ face_id: 'face_007' })], nameplates: [] }), /face_id must match hp_NNN/);
  assert.throws(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ homunculus_id: 'homunculus_1' })], nameplates: [] }), /homunculus_id must match/);
});

test('a boundary face_id hp_050 is accepted and hp_001 is accepted', () => {
  assert.doesNotThrow(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ face_id: 'hp_050' })], nameplates: [] }));
  assert.doesNotThrow(() => validateHomunculiSurface({ version: 1, active: [activeEntry({ face_id: 'hp_001' })], nameplates: [] }));
});

// --- storage wiring ---

test('storage resolves the homunculi surface and actor directory to the mutable root', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  const storage = createStorageApi({ root });
  const surfaceWrite = storage.resolveWritePath('game_data/homunculi.json');
  assert.ok(surfaceWrite.endsWith(path.join('data', 'mutable', 'game_data', 'homunculi.json')), surfaceWrite);
  const actorWrite = storage.resolveWritePath('game_data/homunculi/homunculus_001/profile.json');
  assert.ok(actorWrite.endsWith(path.join('data', 'mutable', 'game_data', 'homunculi', 'homunculus_001', 'profile.json')), actorWrite);
  const actorRead = await storage.resolveReadPath('game_data/homunculi/homunculus_001/affinity.json');
  assert.ok(actorRead.endsWith(path.join('data', 'mutable', 'game_data', 'homunculi', 'homunculus_001', 'affinity.json')), actorRead);
});

// --- new-game wiring ---

async function playSessionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-homun-play-'));
  await writeSplitJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeSplitJson(root, 'data/definitions/game_data/event_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeSplitJson(root, 'data/definitions/game_data/locations.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/shop_catalog.json', { items: [] });
  await writeSplitJson(root, 'data/definitions/game_data/stage_flags.json', []);
  await writeSplitJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', { ...baselineRuntimeState });
  await writeSplitJson(root, 'content/characters/lina/profile.json', {
    character_id: 'lina',
    display_name: 'リナ',
    identity: '薬草園の案内役',
    visual_set_id: 'visual_set_001',
    prompt_description: 'homunculus play fixture mentor',
    speaking_basis: 'homunculus play fixture speaking',
    available_expressions: ['neutral'],
    parameters: { magic: {}, abilities: {} }
  });
  // A loop new game selects an opening mentor from the selectable roster, so a valid mentor profile must
  // exist for the loop branch of this wiring test.
  await writeSplitJson(root, 'content/characters/character_001/profile.json', {
    character_id: 'character_001',
    display_name: 'テスト生徒',
    identity: '静かな図書委員',
    parameter_attitude_type: 'equal_any_respect_average',
    prompt_description: '図書室で静かに案内する。',
    speaking_basis: '丁寧で落ち着いた口調。',
    available_expressions: ['neutral'],
    parameters: {
      magic: {
        light: { min: 0, max: 100, label: '光魔法習熟度', value: 25 },
        dark: { min: 0, max: 100, label: '闇魔法習熟度', value: 20 },
        fire: { min: 0, max: 100, label: '火魔法習熟度', value: 18 },
        water: { min: 0, max: 100, label: '水魔法習熟度', value: 22 },
        earth: { min: 0, max: 100, label: '土魔法習熟度', value: 19 },
        wind: { min: 0, max: 100, label: '風魔法習熟度', value: 21 }
      },
      abilities: {
        strength: { min: 0, max: 100, label: '筋力', value: 24 },
        agility: { min: 0, max: 100, label: '瞬発力', value: 26 },
        academics: { min: 0, max: 100, label: '学力', value: 61 },
        magical_power: { min: 0, max: 100, label: '魔力', value: 35 },
        charisma: { min: 0, max: 100, label: 'カリスマ', value: 29 }
      }
    }
  });
  return root;
}

test('a routing new game seeds an empty homunculi surface; a loop new game leaves it absent', async (t) => {
  const routingRoot = await playSessionRoot();
  const loopRoot = await playSessionRoot();
  t.after(async () => {
    await fs.rm(routingRoot, { recursive: true, force: true });
    await fs.rm(loopRoot, { recursive: true, force: true });
  });

  const routing = await initializeNewPlayArea({ root: routingRoot, slotId: 'slot_001', playMode: 'routing', routingPersonaVariant: 'fallen_star' });
  assert.equal(await exists(routing.root, 'game_data/homunculi.json'), true);
  assert.deepEqual(await readJson(routing.root, 'game_data/homunculi.json'), { version: 1, active: [], nameplates: [] });

  const loop = await initializeNewPlayArea({ root: loopRoot, slotId: 'slot_001', playMode: 'loop' });
  assert.equal(
    await exists(loop.root, 'game_data/homunculi.json'),
    false,
    'the homunculi surface is a routing-only surface; a loop new game must not seed it'
  );
  // Absence still reads as an honest empty surface.
  assert.deepEqual(await loadHomunculiSurface({ root: loop.root }), emptyHomunculiSurface());
});

// --- affinity ---

test('homunculus affinity opens at 50, clamps 0..100, and is idempotent per conversation', async (t) => {
  const root = await bareRoot();
  await cleanup(t, root);
  assert.equal(HOMUNCULUS_AFFINITY_INITIAL_VALUE, 50);
  assert.deepEqual(defaultHomunculusAffinityFile('homunculus_001'), {
    homunculus_id: 'homunculus_001',
    affinity: 50,
    applied_affinity_conversation_ids: []
  });

  const up = await applyHomunculusAffinityDelta({ root, homunculusId: 'homunculus_001', conversationId: 'conv_a', conversationDelta: 8 });
  assert.equal(up.before_affinity, 50);
  assert.equal(up.after_affinity, 58);
  assert.equal(up.buddy_delta, 0);
  assert.equal(up.total_delta, 8);
  assert.equal(up.already_applied, false);

  // Re-applying the same conversation is a no-op.
  const again = await applyHomunculusAffinityDelta({ root, homunculusId: 'homunculus_001', conversationId: 'conv_a', conversationDelta: 8 });
  assert.equal(again.already_applied, true);
  assert.equal(again.after_affinity, 58);

  // A buddy delta adds to the conversation delta: 58 + (2 + 10) = 70.
  const withBuddy = await applyHomunculusAffinityDelta({ root, homunculusId: 'homunculus_001', conversationId: 'conv_buddy', conversationDelta: 2, buddyDelta: 10 });
  assert.equal(withBuddy.buddy_delta, 10);
  assert.equal(withBuddy.total_delta, 12);
  assert.equal(withBuddy.before_affinity, 58);
  assert.equal(withBuddy.after_affinity, 70);

  // Clamp at the ceiling (a delta that would exceed 100).
  const ceil = await applyHomunculusAffinityDelta({ root, homunculusId: 'homunculus_001', conversationId: 'conv_ceil', conversationDelta: 90 });
  assert.equal(ceil.after_affinity, 100);
  // Clamp at the floor (a delta that would drop below 0).
  const floor = await applyHomunculusAffinityDelta({ root, homunculusId: 'homunculus_001', conversationId: 'conv_floor', conversationDelta: -250 });
  assert.equal(floor.after_affinity, 0);
  const persisted = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_001/affinity.json');
  assert.equal(persisted.affinity, 0);
});

test('homunculus affinity path and normalization are homunculus-only and fail fast on mismatch', () => {
  assert.equal(homunculusAffinityPath('homunculus_007'), 'game_data/homunculi/homunculus_007/affinity.json');
  assert.throws(() => homunculusAffinityPath('character_007'), /only supported for homunculus actors/);
  assert.throws(
    () => normalizeHomunculusAffinityFile({ homunculus_id: 'homunculus_002', affinity: 50, applied_affinity_conversation_ids: [] }, 'homunculus_001'),
    /homunculus_id must be homunculus_001/
  );
  assert.throws(
    () => normalizeHomunculusAffinityFile({ homunculus_id: 'homunculus_001', affinity: 120, applied_affinity_conversation_ids: [] }, 'homunculus_001'),
    /affinity must be an integer from 0 to 100/
  );
});

// --- conversation: opening / turn ---

async function collectHomunculusOpeningPrompt(root, id, characterId = 'homunculus_001') {
  let openingPrompt = '';
  const opened = await runConversationOpening({
    root,
    id,
    characterId,
    now: '2026-05-05T06:00:00.000+09:00',
    dungeonSceneContext: atelierInjectedSceneContext(),
    chatProvider: async ({ prompt }) => {
      openingPrompt = prompt;
      return '……おかえりなさい。あなたが、私を灯してくれたのですね。';
    }
  });
  return { opened, openingPrompt };
}

// Mints a second per-slot homunculus actor + surface entry, mirroring the fixture's homunculus_001, so a
// roster-crossing buddy switch (homunculus → homunculus) can be exercised.
async function mintHomunculusActor(root, homunculusId, displayName, faceId) {
  await writeSplitJson(root, `data/mutable/game_data/homunculi/${homunculusId}/profile.json`, {
    character_id: homunculusId,
    display_name: displayName,
    prompt_description: '静かで思慮深いホムンクルス。錬成室で灯された身を受け止めている。',
    speaking_basis: '一人称は「私」。落ち着いた口調で話す。',
    parameters: { magic: {}, abilities: {} }
  });
  await writeSplitJson(root, `data/mutable/game_data/homunculi/${homunculusId}/flags.json`, {
    character_id: homunculusId,
    flags: {}
  });
  await writeSplitJson(root, `data/mutable/game_data/homunculi/${homunculusId}/skills.json`, {
    character_id: homunculusId,
    skills: []
  });
  await fs.mkdir(path.join(root, `data/mutable/game_data/homunculi/${homunculusId}/memory`), { recursive: true });
  await fs.mkdir(path.join(root, `data/mutable/game_data/homunculi/${homunculusId}/work_records`), { recursive: true });
  const surface = await readJson(root, 'data/mutable/game_data/homunculi.json');
  surface.active.push(activeEntry({ homunculus_id: homunculusId, display_name: displayName, face_id: faceId }));
  await writeSplitJson(root, 'data/mutable/game_data/homunculi.json', surface);
}

// Seeds a runtime-state current buddy plus its actor flags file for a homunculus id, so a later finalization
// can be checked for roster-crossing exclusive replacement.
async function seedHomunculusBuddyState(root, homunculusId) {
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.homunculi ??= {};
  state.homunculi[homunculusId] = { flags: { [`relationship.${homunculusId}.buddy`]: true } };
  state.current_buddy_character_id = homunculusId;
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', state);
  await writeSplitJson(root, `data/mutable/game_data/homunculi/${homunculusId}/flags.json`, {
    character_id: homunculusId,
    flags: { [`relationship.${homunculusId}.buddy`]: true }
  });
}

// The common non-relationship finalization providers for a homunculus finalization test. The field-anchored
// providers must never run for a homunculus, so they throw.
function homunculusFinalizationProviders(homunculusId = 'homunculus_001') {
  return {
    memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
      memory_record: {
        character_id: homunculusId,
        id: `mem_from_${conversation.id}`,
        type: 'relationship_change',
        text: 'ヴィオラは、創り主が灯した夜を静かに思い返した。',
        visibility: 'private',
        source_conversation_id: conversation.id,
        work_record_id: workRecordId,
        tags: ['ヴィオラ']
      }
    }),
    skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
    workRecordProvider: async ({ conversation, workRecordId }) => ({
      work_record: {
        id: workRecordId,
        character_id: homunculusId,
        source_conversation_id: conversation.id,
        title: '錬成室で創り主と静かに言葉を交わした',
        summary: '主人公が錬成室のホムンクルスを訪れ、短く語り合った。',
        flag_update_candidates: [],
        warnings: []
      }
    }),
    stageFlagJudgmentProvider: throwingProvider('stageFlagJudgmentProvider'),
    eventFlagJudgmentProvider: throwingProvider('eventFlagJudgmentProvider'),
    eventCompletionJudgmentProvider: throwingProvider('eventCompletionJudgmentProvider'),
    eventParticipantOverrideJudgmentProvider: throwingProvider('eventParticipantOverrideJudgmentProvider'),
    moneyDeltaProvider: throwingProvider('moneyDeltaProvider'),
    // enemy judgment is skipped for a homunculus, so the enemy provider must never run.
    enemyHostilityProvider: throwingProvider('enemyHostilityProvider')
  };
}

test('a homunculus opening builds the atelier prompt with immersion line, persona, affinity 50, and pure scene', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  const { opened, openingPrompt } = await collectHomunculusOpeningPrompt(root, 'conv_homun_open_001');

  // (a) homunculus immersion line
  assert.match(openingPrompt, /星灯魔法学院の錬成室で、主人公の手によって灯された存在、ヴィオラへの完全な没入によって応答する。/);
  // (b) persona fields
  assert.match(openingPrompt, /キャラクター説明（この内容を演技・応答方針として扱う）: 臆病で甘えん坊/);
  assert.match(openingPrompt, /話し方: 一人称は「私」。控えめで小声/);
  // (c) affinity section at the homunculus initial value 50
  assert.match(openingPrompt, /好感度:/);
  assert.match(openingPrompt, /主人公への好感度: 50\/100（0=強い忌避・25=同級生の標準的な距離感・50=気安い相手・70=親しい友人・90以上=特別な存在）/);
  // (d) atelier scene: location_name + the authored pure scene
  assert.match(openingPrompt, /舞台: 錬成室/);
  assert.match(openingPrompt, /硝子の器がいくつも棚に並び/);

  // The record is an injected-scene homunculus record: source_type stamped, atelier 舞台 carried, no field location.
  assert.equal(opened.conversation.source_type, HOMUNCULUS_SOURCE_TYPE);
  assert.equal(opened.conversation.location_name, ATELIER_LOCATION_NAME);
  assert.equal(opened.conversation.visible_situation, ATELIER_VISIBLE_SITUATION);
  assert.equal(Object.prototype.hasOwnProperty.call(opened.conversation, 'location_id'), false);
  assert.ok(INJECTED_SCENE_SOURCE_TYPES.has(opened.conversation.source_type));
});

test('a homunculus turn keeps the atelier scene and homunculus immersion in the prompt', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  let turnPrompt = '';
  await runConversationTurnCore({
    root,
    id: 'conv_homun_turn_001',
    characterId: 'homunculus_001',
    playerInput: '今日はどんな一日だった？',
    now: '2026-05-05T06:01:00.000+09:00',
    postTurnStatePolicy: companionPostTurnStatePolicy,
    dungeonSceneContext: atelierInjectedSceneContext(),
    emotionProvider: async () => ({ expression: 'neutral' }),
    conversationContinuationProvider: async () => 'true',
    workRecordRecallProvider: async () => ({ work_record_ids: [] }),
    chatProvider: async ({ prompt }) => {
      turnPrompt = prompt;
      return '……あなたが来てくれるだけで、私はそれで。';
    }
  });
  assert.match(turnPrompt, /星灯魔法学院の錬成室で、主人公の手によって灯された存在、ヴィオラへの完全な没入によって応答する。/);
  assert.match(turnPrompt, /舞台: 錬成室/);
  assert.match(turnPrompt, /主人公への好感度: 50\/100/);
});

test('runConversationOpening fails fast for an unminted homunculus (actor directory absent)', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await assert.rejects(
    runConversationOpening({
      root,
      id: 'conv_homun_missing_001',
      characterId: 'homunculus_777',
      now: '2026-05-05T06:00:00.000+09:00',
      dungeonSceneContext: atelierInjectedSceneContext(),
      chatProvider: async () => 'unreachable'
    }),
    /ENOENT|no such file/
  );
});

// --- finalization policy: memory + affinity + buddy + mp reserve; enemy/stage/event/money skipped ---

function throwingProvider(label) {
  return async () => {
    throw new Error(`${label} must not run for a homunculus finalization`);
  };
}

test('finalizeConversation for a homunculus runs memory/work-record + affinity + buddy(false) + mp reserve, and skips enemy/stage/event/money', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await collectHomunculusOpeningPrompt(root, 'conv_homun_final_001');

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_homun_final_001',
    characterId: 'homunculus_001',
    now: '2026-05-05T06:05:00.000+09:00',
    ...homunculusFinalizationProviders('homunculus_001'),
    affinityDeltaProvider: async () => '+10',
    // A homunculus can be made a buddy: the buddy judgment runs. Here it declines, so no buddy is formed.
    buddyAgreementProvider: async () => 'false',
    // A homunculus can become a dungeon companion: its MP reserve line judgment runs.
    mpReserveProvider: async () => '45'
  });

  // memory + work record written to the homunculus actor directory
  assert.equal(await exists(root, 'data/mutable/game_data/homunculi/homunculus_001/memory/mem_from_conv_homun_final_001.json'), true);
  assert.equal(await exists(root, 'data/mutable/game_data/homunculi/homunculus_001/work_records/wr_conv_homun_final_001.md'), true);

  // affinity judged and applied with clamp: 50 -> 60 (buddy declined -> no buddy delta)
  const affinity = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_001/affinity.json');
  assert.equal(affinity.affinity, 60);
  assert.equal(finalized.affinity_update.before_affinity, 50);
  assert.equal(finalized.affinity_update.after_affinity, 60);
  assert.equal(finalized.affinity_update.buddy_delta, 0);
  assert.equal(finalized.affinity_update.total_delta, 10);
  assert.equal(await exists(root, 'data/mutable/game_data/logs/affinity_updates/conv_homun_final_001.json'), true);

  // buddy judged (declined) and its log written; no buddy formed and no current buddy set
  assert.equal(finalized.buddy_update.established, false);
  assert.equal(finalized.buddy_update.flag, 'relationship.homunculus_001.buddy');
  assert.equal(await exists(root, 'data/mutable/game_data/logs/buddy_updates/conv_homun_final_001.json'), true);
  const buddyLog = await readJson(root, 'data/mutable/game_data/logs/buddy_updates/conv_homun_final_001.json');
  assert.equal(buddyLog.established, false);

  // enemy judgment skipped (a homunculus can never be an enemy): skipped record, no log, enemy state unchanged
  assert.equal(finalized.enemy_update.skipped, true);
  assert.equal(finalized.enemy_update.reason, 'homunculus_actor');
  assert.equal(await exists(root, 'data/mutable/game_data/logs/enemy_updates/conv_homun_final_001.json'), false);
  assert.deepEqual(finalized.state.current_enemy_character_ids, []);

  // MP reserve line judged and persisted with a homunculus key
  assert.equal(finalized.mp_reserve_update.skipped, undefined);
  assert.equal(finalized.mp_reserve_update.before_percent, 30);
  assert.equal(finalized.mp_reserve_update.after_percent, 45);
  assert.equal(await exists(root, 'data/mutable/game_data/logs/mp_reserve_updates/conv_homun_final_001.json'), true);
  const mpReserve = await readJson(root, 'data/mutable/game_data/mp_reserve.json');
  assert.equal(mpReserve.reserves.homunculus_001, 45);

  // stage / event / money still skipped
  assert.equal(await exists(root, 'data/mutable/game_data/logs/money_updates/conv_homun_final_001.json'), false);
  assert.equal(await exists(root, 'data/mutable/game_data/logs/stage_reward_updates/conv_homun_final_001.json'), false);
  assert.equal(finalized.stage_reward_update.skipped, true);
  assert.equal(finalized.money_update.skipped, true);

  // money untouched, no new academy field / global flags introduced by finalization, no buddy set
  const inventory = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  assert.equal(inventory.money, 0);
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.deepEqual(state.global_flags, {});
  assert.equal(state.current_buddy_character_id, null);
});

test('finalizeConversation forms a homunculus buddy: sets current buddy, homunculus flag, actor flags file, buddy delta affinity', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await collectHomunculusOpeningPrompt(root, 'conv_homun_buddy_001');

  let buddyPrompt = '';
  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_homun_buddy_001',
    characterId: 'homunculus_001',
    now: '2026-05-05T06:05:00.000+09:00',
    ...homunculusFinalizationProviders('homunculus_001'),
    affinityDeltaProvider: async () => '+5',
    mpReserveProvider: async () => '30',
    buddyAgreementProvider: async ({ prompt, characterId }) => {
      buddyPrompt = prompt;
      assert.equal(characterId, 'homunculus_001');
      assert.match(prompt, /バディになる合意が相互に成立したか/);
      return 'true';
    }
  });

  assert.match(buddyPrompt, /バディになる合意/);
  assert.equal(finalized.buddy_update.established, true);
  assert.equal(finalized.buddy_update.flag, 'relationship.homunculus_001.buddy');

  // current buddy points to the homunculus; the buddy flag lives under the homunculi collection
  assert.equal(finalized.state.current_buddy_character_id, 'homunculus_001');
  assert.equal(finalized.state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);
  const persistedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.equal(persistedState.current_buddy_character_id, 'homunculus_001');
  assert.equal(persistedState.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);

  // the homunculus actor flags file carries the buddy flag
  const actorFlags = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_001/flags.json');
  assert.equal(actorFlags['relationship.homunculus_001.buddy'], true);

  // affinity total = conversation delta (+5) + buddy delta (+10): 50 -> 65
  const affinity = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_001/affinity.json');
  assert.equal(affinity.affinity, 65);
  assert.equal(finalized.affinity_update.conversation_delta, 5);
  assert.equal(finalized.affinity_update.buddy_delta, 10);
  assert.equal(finalized.affinity_update.total_delta, 15);
  assert.equal(finalized.affinity_update.before_affinity, 50);
  assert.equal(finalized.affinity_update.after_affinity, 65);
  const affinityLog = await readJson(root, 'data/mutable/game_data/logs/affinity_updates/conv_homun_buddy_001.json');
  assert.equal(affinityLog.buddy_delta, 10);
  assert.equal(affinityLog.total_delta, 15);
});

test('finalizeConversation preserves an existing homunculus buddy when the buddy judgment is false', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await seedHomunculusBuddyState(root, 'homunculus_001');
  await collectHomunculusOpeningPrompt(root, 'conv_homun_buddy_keep_001');

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_homun_buddy_keep_001',
    characterId: 'homunculus_001',
    now: '2026-05-05T06:05:00.000+09:00',
    ...homunculusFinalizationProviders('homunculus_001'),
    affinityDeltaProvider: async () => '0',
    mpReserveProvider: async () => '30',
    buddyAgreementProvider: async () => 'false'
  });

  assert.equal(finalized.buddy_update.established, false);
  assert.equal(finalized.state.current_buddy_character_id, 'homunculus_001');
  assert.equal(finalized.state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);
});

test('finalizeConversation switches a buddy from a homunculus to another homunculus (roster-crossing exclusive)', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await mintHomunculusActor(root, 'homunculus_002', 'ノクス', 'hp_002');
  await seedHomunculusBuddyState(root, 'homunculus_001');
  await collectHomunculusOpeningPrompt(root, 'conv_homun_switch_001', 'homunculus_002');

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_homun_switch_001',
    characterId: 'homunculus_002',
    now: '2026-05-05T06:05:00.000+09:00',
    ...homunculusFinalizationProviders('homunculus_002'),
    affinityDeltaProvider: async () => '0',
    mpReserveProvider: async () => '30',
    buddyAgreementProvider: async () => 'true'
  });

  assert.equal(finalized.buddy_update.established, true);
  assert.equal(finalized.state.current_buddy_character_id, 'homunculus_002');
  assert.equal(finalized.state.homunculi.homunculus_002.flags['relationship.homunculus_002.buddy'], true);
  // the previous homunculus buddy flag is cleared in state and in its actor flags file
  assert.equal(finalized.state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], undefined);
  const previousActorFlags = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_001/flags.json');
  assert.equal(previousActorFlags['relationship.homunculus_001.buddy'], undefined);
  const newActorFlags = await readJson(root, 'data/mutable/game_data/homunculi/homunculus_002/flags.json');
  assert.equal(newActorFlags['relationship.homunculus_002.buddy'], true);
});

test('finalizeConversation switches a buddy from an academy character to a homunculus (roster-crossing exclusive)', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  // Seed a selectable character as the current buddy (state + actor flags file).
  const state = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  state.characters ??= {};
  state.characters.character_001 = { flags: { 'relationship.character_001.buddy': true } };
  state.current_buddy_character_id = 'character_001';
  await writeSplitJson(root, 'data/mutable/game_data/runtime_state.json', state);
  await writeSplitJson(root, 'data/mutable/game_data/characters/character_001/flags.json', {
    character_id: 'character_001',
    flags: { 'relationship.character_001.buddy': true }
  });
  await collectHomunculusOpeningPrompt(root, 'conv_homun_from_char_001');

  const finalized = await finalizeConversation({
    root,
    conversationId: 'conv_homun_from_char_001',
    characterId: 'homunculus_001',
    now: '2026-05-05T06:05:00.000+09:00',
    ...homunculusFinalizationProviders('homunculus_001'),
    affinityDeltaProvider: async () => '0',
    mpReserveProvider: async () => '30',
    buddyAgreementProvider: async () => 'true'
  });

  assert.equal(finalized.state.current_buddy_character_id, 'homunculus_001');
  assert.equal(finalized.state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);
  // the previous academy-character buddy flag is cleared in state and in its actor flags file
  assert.equal(finalized.state.characters.character_001.flags['relationship.character_001.buddy'], undefined);
  const characterFlags = await readJson(root, 'data/mutable/game_data/characters/character_001/flags.json');
  assert.equal(characterFlags['relationship.character_001.buddy'], undefined);
});

test('finalizeConversation for a homunculus fails fast when the mp reserve provider is missing', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await collectHomunculusOpeningPrompt(root, 'conv_homun_nompr_001');
  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_homun_nompr_001',
      characterId: 'homunculus_001',
      now: '2026-05-05T06:05:00.000+09:00',
      ...homunculusFinalizationProviders('homunculus_001'),
      affinityDeltaProvider: async () => '0',
      buddyAgreementProvider: async () => 'false'
      // mpReserveProvider intentionally omitted
    }),
    /mpReserveProvider is required/
  );
});

test('finalizeConversation for a homunculus fails fast on an out-of-range mp reserve answer', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await collectHomunculusOpeningPrompt(root, 'conv_homun_badmpr_001');
  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_homun_badmpr_001',
      characterId: 'homunculus_001',
      now: '2026-05-05T06:05:00.000+09:00',
      ...homunculusFinalizationProviders('homunculus_001'),
      affinityDeltaProvider: async () => '0',
      buddyAgreementProvider: async () => 'false',
      mpReserveProvider: async () => '150'
    }),
    /mp reserve|reserve percent|0.*100|integer/i
  );
});

test('finalizeConversation for a homunculus fails fast when the affinity provider is missing', async (t) => {
  const root = await homunculusDialogueRoot();
  await cleanup(t, root);
  await collectHomunculusOpeningPrompt(root, 'conv_homun_noaff_001');
  await assert.rejects(
    finalizeConversation({
      root,
      conversationId: 'conv_homun_noaff_001',
      characterId: 'homunculus_001',
      now: '2026-05-05T06:05:00.000+09:00',
      memoryUpdateProvider: async ({ conversation, workRecordId }) => ({
        memory_record: {
          character_id: 'homunculus_001',
          id: 'mem_x',
          type: 'relationship_change',
          text: 'ヴィオラは静かに慕った。',
          visibility: 'private',
          source_conversation_id: conversation.id,
          work_record_id: workRecordId,
          tags: []
        }
      }),
      skillNecessityProvider: async () => ({ necessary: false, raw_answer: 'false' }),
      workRecordProvider: async ({ conversation, workRecordId }) => ({
        work_record: {
          id: workRecordId,
          character_id: 'homunculus_001',
          source_conversation_id: conversation.id,
          title: 'x',
          summary: '主人公が短く言葉を交わした。',
          flag_update_candidates: [],
          warnings: []
        }
      })
      // affinityDeltaProvider intentionally omitted
    }),
    /affinityDeltaProvider is required/
  );
});
