// homunculus-buddy-backend-b1: the domain-level contract for extending buddy / companion / equip-target
// vocabulary to "selectable roster ∪ active homunculus". Covers the companion-roster predicates, the buddy
// resolvers, the debug relationship setter's cross-roster exclusive switch, the equipment domain's homunculus
// companion keys, the dungeon companion descriptor face_url, and the routing hub buddy resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

import { fixtureRoot, baselineRuntimeState, writeJson, readJson } from './helpers.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { magicParameterDefinitions, abilityParameterDefinitions } from '../src/parameters.mjs';
import {
  isHomunculusIdFormat,
  isCompanionCharacterId,
  activeHomunculusIdSet,
  loadActiveHomunculusIdSet
} from '../src/companionRoster.mjs';
import { resolveActiveHomunculusActor, resolveCurrentBuddySummary } from '../src/buddyResolution.mjs';
import { setRelationshipDebugState } from '../src/relationshipState.mjs';
import {
  addEquipmentInstance,
  equipItem,
  readEquipmentSlots,
  readAllEquipmentSlots,
  resolveRunEquipment
} from '../src/equipment.mjs';
import { companionDescriptor } from '../src/dungeon/dungeonCompanion.mjs';
import { buildRoutingHubContextSnapshot } from '../src/routingHubContextSnapshot.mjs';

const MAGIC_KEYS = magicParameterDefinitions.map((definition) => definition.key);
const ABILITY_KEYS = abilityParameterDefinitions.map((definition) => definition.key);

function rawParams(magicValue = 50, abilityValue = 50) {
  return {
    magic: Object.fromEntries(MAGIC_KEYS.map((key) => [key, { value: magicValue }])),
    abilities: Object.fromEntries(ABILITY_KEYS.map((key) => [key, { value: abilityValue }]))
  };
}

async function buddyRoot(t, { runtimeState = {} } = {}) {
  const root = await fixtureRoot('magic-adv-hom-buddy-', {
    runtimeState: { ...baselineRuntimeState, elapsed_weeks: 3, ...runtimeState }
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Hand-seeds an active homunculus: the surface active entry plus its actor directory (profile / flags /
// affinity) — enough for the buddy/companion resolvers and consumption surfaces.
async function seedActiveHomunculus(root, {
  id = 'homunculus_001',
  displayName = 'ノクス',
  faceId = 'hp_007',
  createdWeek = 5,
  magic = 50,
  abilities = 60,
  affinity = 50
} = {}) {
  const surface = await readJson(root, 'game_data/homunculi.json').catch(() => ({ version: 1, active: [], nameplates: [] }));
  surface.active.push({ homunculus_id: id, display_name: displayName, face_id: faceId, created_week: createdWeek });
  await writeJson(root, 'game_data/homunculi.json', surface);
  await writeJson(root, `game_data/homunculi/${id}/profile.json`, {
    character_id: id,
    display_name: displayName,
    visual_set_id: faceId,
    prompt_description: 'x',
    speaking_basis: 'x',
    available_expressions: ['neutral'],
    parameters: rawParams(magic, abilities)
  });
  await writeJson(root, `game_data/homunculi/${id}/flags.json`, { character_id: id, flags: {} });
  await writeJson(root, `game_data/homunculi/${id}/affinity.json`, { homunculus_id: id, affinity, applied_affinity_conversation_ids: [] });
  return id;
}

test('companionRoster predicates: format, union, and active id set', async (t) => {
  assert.equal(isHomunculusIdFormat('homunculus_001'), true);
  assert.equal(isHomunculusIdFormat('homunculus_1'), false);
  assert.equal(isHomunculusIdFormat('character_001'), false);
  assert.equal(isHomunculusIdFormat('lina'), false);

  const active = new Set(['homunculus_003']);
  assert.equal(isCompanionCharacterId('character_005', active), true);
  assert.equal(isCompanionCharacterId('homunculus_003', active), true);
  assert.equal(isCompanionCharacterId('homunculus_009', active), false);
  assert.equal(isCompanionCharacterId('lina', active), false);
  assert.throws(() => isCompanionCharacterId('character_005', ['homunculus_003']), /activeHomunculusIds set is required/);

  const root = await buddyRoot(t);
  assert.deepEqual([...await loadActiveHomunculusIdSet({ root })], []);
  await seedActiveHomunculus(root, { id: 'homunculus_002' });
  assert.deepEqual([...await loadActiveHomunculusIdSet({ root })], ['homunculus_002']);
  assert.deepEqual([...activeHomunculusIdSet({ active: [{ homunculus_id: 'homunculus_002' }], nameplates: [] })], ['homunculus_002']);
});

test('resolveActiveHomunculusActor resolves an active homunculus summary and throws for a non-active id', async (t) => {
  const root = await buddyRoot(t);
  await seedActiveHomunculus(root, { id: 'homunculus_001', displayName: 'ノクス', faceId: 'hp_007', affinity: 72 });
  const actor = await resolveActiveHomunculusActor({ root, homunculusId: 'homunculus_001' });
  assert.equal(actor.homunculus_id, 'homunculus_001');
  assert.equal(actor.display_name, 'ノクス');
  assert.equal(actor.face_id, 'hp_007');
  assert.equal(actor.affinity, 72);
  assert.equal(actor.face_url, '/canonical/character_visual_sets/hp_007/face_emotions/neutral.jpg');
  assert.deepEqual(Object.keys(actor.parameters.magic).sort(), [...MAGIC_KEYS].sort());
  await assert.rejects(resolveActiveHomunculusActor({ root, homunculusId: 'homunculus_099' }), /is not active in the atelier/);
});

test('resolveCurrentBuddySummary returns the homunculus buddy display data, null with no buddy, throws on a dangling id', async (t) => {
  const noBuddyRoot = await buddyRoot(t);
  assert.equal(await resolveCurrentBuddySummary({ root: noBuddyRoot }), null);

  const root = await buddyRoot(t, { runtimeState: { current_buddy_character_id: 'homunculus_001' } });
  await seedActiveHomunculus(root, { id: 'homunculus_001', displayName: 'ヴィオラ', faceId: 'hp_012', affinity: 55 });
  assert.deepEqual(await resolveCurrentBuddySummary({ root }), {
    character_id: 'homunculus_001',
    kind: 'homunculus',
    display_name: 'ヴィオラ',
    face_url: '/canonical/character_visual_sets/hp_012/face_emotions/neutral.jpg',
    affinity: 55
  });

  const danglingRoot = await buddyRoot(t, { runtimeState: { current_buddy_character_id: 'homunculus_050' } });
  await assert.rejects(resolveCurrentBuddySummary({ root: danglingRoot }), /does not resolve to a selectable character or an active homunculus|is not active in the atelier/);
});

test('setRelationshipDebugState accepts an active homunculus buddy and writes its actor flag file', async (t) => {
  const root = await buddyRoot(t);
  await seedActiveHomunculus(root, { id: 'homunculus_001' });
  const result = await setRelationshipDebugState({ root, buddyCharacterId: 'homunculus_001', enemyCharacterIds: [] });
  assert.equal(result.relationship.current_buddy_character_id, 'homunculus_001');
  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_buddy_character_id, 'homunculus_001');
  assert.equal(state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);
  const flags = await readJson(root, 'game_data/homunculi/homunculus_001/flags.json');
  assert.equal(flags.flags['relationship.homunculus_001.buddy'], true);
});

test('setRelationshipDebugState rejects a non-active homunculus buddy with a 400 and writes no state', async (t) => {
  const root = await buddyRoot(t);
  await seedActiveHomunculus(root, { id: 'homunculus_001' });
  const before = await readJson(root, 'game_data/runtime_state.json');
  await assert.rejects(
    setRelationshipDebugState({ root, buddyCharacterId: 'homunculus_099', enemyCharacterIds: [] }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /buddy character is not a selectable roster character/);
      return true;
    }
  );
  assert.deepEqual(await readJson(root, 'game_data/runtime_state.json'), before);
});

test('setRelationshipDebugState switches buddy across rosters exclusively (homunculus <-> selectable)', async (t) => {
  const root = await buddyRoot(t);
  await seedActiveHomunculus(root, { id: 'homunculus_001' });

  // selectable buddy first
  await setRelationshipDebugState({ root, buddyCharacterId: 'character_004', enemyCharacterIds: [] });
  // switch to the homunculus: the selectable side's buddy flag is cleared
  await setRelationshipDebugState({ root, buddyCharacterId: 'homunculus_001', enemyCharacterIds: [] });
  let state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_buddy_character_id, 'homunculus_001');
  assert.equal(state.characters.character_004.flags['relationship.character_004.buddy'], false);
  assert.equal(state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], true);
  assert.equal((await readJson(root, 'game_data/characters/character_004/flags.json')).flags['relationship.character_004.buddy'], false);

  // switch back to a selectable: the homunculus side's buddy flag is cleared
  await setRelationshipDebugState({ root, buddyCharacterId: 'character_009', enemyCharacterIds: [] });
  state = await readJson(root, 'game_data/runtime_state.json');
  assert.equal(state.current_buddy_character_id, 'character_009');
  assert.equal(state.homunculi.homunculus_001.flags['relationship.homunculus_001.buddy'], false);
  assert.equal(state.characters.character_009.flags['relationship.character_009.buddy'], true);
  assert.equal((await readJson(root, 'game_data/homunculi/homunculus_001/flags.json')).flags['relationship.homunculus_001.buddy'], false);
});

test('enemy vocabulary stays selectable-only: a homunculus id is never accepted as an enemy', async (t) => {
  const root = await buddyRoot(t);
  await seedActiveHomunculus(root, { id: 'homunculus_001' });
  await assert.rejects(
    setRelationshipDebugState({ root, buddyCharacterId: null, enemyCharacterIds: ['homunculus_001'] }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /enemy character is not a selectable roster character/);
      return true;
    }
  );
});

test('equipment domain: a homunculus is a valid companion equip owner and shares one-of-a-kind exclusivity', async (t) => {
  // Structural reads accept a homunculus companion key by format.
  assert.deepEqual(readEquipmentSlots({ companion_equipment_slots: { homunculus_001: { weapon: 'w' } } }, 'homunculus_001'), { weapon: 'w', amulet: null });
  const all = readAllEquipmentSlots({ equipment_slots: { weapon: 'w1' }, companion_equipment_slots: { homunculus_001: { amulet: 'a1' } } });
  assert.deepEqual(all.companions, { homunculus_001: { weapon: null, amulet: 'a1' } });
  // A shared instance across the hero and a homunculus companion is corrupt state and throws.
  assert.throws(
    () => readAllEquipmentSlots({ equipment_slots: { weapon: 'x' }, companion_equipment_slots: { homunculus_001: { weapon: 'x' } } }),
    /equipped by multiple owners/
  );

  const root = await buddyRoot(t);
  await addEquipmentInstance({ root, instance: weaponInstance('wpn_1') });
  await writeJson(root, 'game_data/runtime_state.json', { ...baselineRuntimeState });
  await equipItem({ root, target: 'homunculus_001', slot: 'weapon', instance_id: 'wpn_1' });
  const state = await readJson(root, 'game_data/runtime_state.json');
  assert.deepEqual(state.companion_equipment_slots, { homunculus_001: { weapon: 'wpn_1' } });
  const run = await resolveRunEquipment({ root, state, target: 'homunculus_001' });
  assert.equal(run.slots.weapon.instance_id, 'wpn_1');
});

test('companionDescriptor threads face_url only when supplied (selectable stays byte-identical)', () => {
  const selectable = { character_id: 'character_003', display_name: 'アリア', parameters: {} };
  assert.deepEqual(companionDescriptor(selectable, 'conv_x'), {
    character_id: 'character_003',
    name: 'アリア',
    parameters: {},
    conversation_id: 'conv_x'
  });
  const homunculus = { character_id: 'homunculus_001', display_name: 'ノクス', parameters: {} };
  assert.deepEqual(companionDescriptor(homunculus, 'conv_y', { faceUrl: '/canonical/x.jpg' }), {
    character_id: 'homunculus_001',
    name: 'ノクス',
    parameters: {},
    conversation_id: 'conv_y',
    face_url: '/canonical/x.jpg'
  });
});

test('buildRoutingHubContextSnapshot resolves a homunculus buddy display name and throws on a non-active buddy', async (t) => {
  const root = await buddyRoot(t, { runtimeState: { current_buddy_character_id: 'homunculus_001', current_enemy_character_ids: [] } });
  await seedActiveHomunculus(root, { id: 'homunculus_001', displayName: 'ヴィオラ' });
  const context = await buildRoutingHubContextSnapshot({ root, personaVariant: 'fallen_star', state: await readJson(root, 'game_data/runtime_state.json') });
  assert.deepEqual(context.relationship_context.buddy, { character_id: 'homunculus_001', display_name: 'ヴィオラ' });

  const danglingRoot = await buddyRoot(t, { runtimeState: { current_buddy_character_id: 'homunculus_042', current_enemy_character_ids: [] } });
  await assert.rejects(
    buildRoutingHubContextSnapshot({ root: danglingRoot, personaVariant: 'fallen_star', state: await readJson(danglingRoot, 'game_data/runtime_state.json') }),
    /is not active in the atelier/
  );
});

function weaponInstance(instanceId) {
  return {
    instance_id: instanceId,
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 1,
    quality: 'common',
    name: '鉄剣',
    flavor: 'x',
    base_effects: { attack: 3 },
    bonus_effects: {}
  };
}
