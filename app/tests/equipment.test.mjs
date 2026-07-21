import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  PLAYER_EQUIP_TARGET,
  validateEquipmentInstance,
  validateEquipmentSurface,
  loadEquipmentSurface,
  addEquipmentInstance,
  findEquipmentInstance,
  readEquipmentSlots,
  readAllEquipmentSlots,
  resolveEquippedInstances,
  aggregateEquipmentEffects,
  buildRunEquipment,
  resolveRunEquipment,
  applyEquipmentToCombatStats,
  equipItem,
  unequipItem
} from '../src/equipment.mjs';

function weapon(overrides = {}) {
  return {
    instance_id: 'wpn_1',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'fine',
    name: '紅蓮の剣',
    flavor: '柄に熾火の紋がめぐる。',
    base_effects: { attack: 5 },
    bonus_effects: { max_hp: 3 },
    ...overrides
  };
}

function amulet(overrides = {}) {
  return {
    instance_id: 'amu_1',
    kind: 'amulet',
    element: 'water',
    tier: 1,
    quality: 'common',
    name: '雫の護符',
    flavor: '触れると涼やかに湿る。',
    base_effects: { defense: 2 },
    bonus_effects: {},
    ...overrides
  };
}

async function storageRoot(state = { version: 1, characters: {} }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-equip-'));
  const statePath = path.join(root, 'data/mutable/game_data/runtime_state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return root;
}

async function readState(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'data/mutable/game_data/runtime_state.json'), 'utf8'));
}

test('validateEquipmentInstance accepts a valid weapon and amulet', () => {
  assert.doesNotThrow(() => validateEquipmentInstance(weapon()));
  assert.doesNotThrow(() => validateEquipmentInstance(amulet()));
  // Every closed-vocabulary effect on a weapon is accepted.
  assert.doesNotThrow(() => validateEquipmentInstance(weapon({
    base_effects: { attack: 1, defense: 1, max_hp: 1, max_mp: 1, spell_mp_discount: 1, self_heal_bonus: 1, element_spell_power: 1 },
    bonus_effects: {}
  })));
});

test('validateEquipmentInstance rejects malformed instances', () => {
  assert.throws(() => validateEquipmentInstance(null), /must be an object/);
  assert.throws(() => validateEquipmentInstance(weapon({ kind: 'ring' })), /kind must be one of/);
  assert.throws(() => validateEquipmentInstance(weapon({ element: 'plasma' })), /element must be a magic element/);
  assert.throws(() => validateEquipmentInstance(weapon({ weapon_type: 'axe' })), /weapon_type must be one of/);
  assert.throws(() => validateEquipmentInstance(weapon({ tier: 5 })), /tier must be an integer 1\.\.4/);
  assert.throws(() => validateEquipmentInstance(weapon({ quality: 'legendary' })), /quality must be one of/);
  assert.throws(() => validateEquipmentInstance(weapon({ name: '' })), /name must be a non-empty string/);
  assert.throws(() => validateEquipmentInstance(weapon({ flavor: '' })), /flavor must be a non-empty string/);
  // Exact keys: an amulet must not carry weapon_type, and no instance may carry extras.
  assert.throws(() => validateEquipmentInstance({ ...amulet(), weapon_type: 'sword' }), /keys must be exactly/);
  assert.throws(() => validateEquipmentInstance({ ...weapon(), extra: 1 }), /keys must be exactly/);
  const { flavor, ...missing } = weapon();
  assert.throws(() => validateEquipmentInstance(missing), /keys must be exactly/);
});

test('validateEquipmentInstance enforces the closed effect vocabulary and weapon-only rule', () => {
  assert.throws(() => validateEquipmentInstance(weapon({ base_effects: { crit: 3 } })), /unknown equipment effect: crit/);
  assert.throws(() => validateEquipmentInstance(weapon({ base_effects: { attack: 0 } })), /must be a positive integer/);
  assert.throws(() => validateEquipmentInstance(weapon({ base_effects: { attack: 1.5 } })), /must be a positive integer/);
  // element_spell_power is weapon-only.
  assert.throws(() => validateEquipmentInstance(amulet({ base_effects: { element_spell_power: 4 } })), /element_spell_power is weapon-only/);
  assert.throws(() => validateEquipmentInstance(amulet({ bonus_effects: { element_spell_power: 4 } })), /element_spell_power is weapon-only/);
});

test('validateEquipmentSurface enforces version, array, uniqueness, and exact keys', () => {
  assert.doesNotThrow(() => validateEquipmentSurface({ version: 1, instances: [weapon(), amulet()] }));
  assert.throws(() => validateEquipmentSurface({ version: 2, instances: [] }), /version must be 1/);
  assert.throws(() => validateEquipmentSurface({ version: 1, instances: {} }), /instances must be an array/);
  assert.throws(() => validateEquipmentSurface({ version: 1, instances: [], extra: 1 }), /keys must be exactly/);
  assert.throws(
    () => validateEquipmentSurface({ version: 1, instances: [weapon({ instance_id: 'dup' }), amulet({ instance_id: 'dup' })] }),
    /duplicate equipment instance_id: dup/
  );
});

test('loadEquipmentSurface treats an absent surface as empty and validates a present one', async () => {
  const root = await storageRoot();
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] });
  await addEquipmentInstance({ root, instance: weapon() });
  const loaded = await loadEquipmentSurface({ root });
  assert.equal(loaded.instances.length, 1);
  assert.equal(findEquipmentInstance(loaded, 'wpn_1').name, '紅蓮の剣');
});

test('loadEquipmentSurface throws on a present-but-malformed surface', async () => {
  const root = await storageRoot();
  const surfacePath = path.join(root, 'data/mutable/game_data/player_equipment.json');
  await fs.writeFile(surfacePath, `${JSON.stringify({ version: 1, instances: [{ instance_id: 'x', kind: 'weapon' }] }, null, 2)}\n`, 'utf8');
  await assert.rejects(loadEquipmentSurface({ root }), /keys must be exactly/);
});

test('addEquipmentInstance appends and rejects a duplicate instance_id', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: weapon() });
  await addEquipmentInstance({ root, instance: amulet() });
  const surface = await loadEquipmentSurface({ root });
  assert.deepEqual(surface.instances.map((i) => i.instance_id), ['wpn_1', 'amu_1']);
  await assert.rejects(addEquipmentInstance({ root, instance: weapon() }), /instance_id already exists: wpn_1/);
});

test('readEquipmentSlots: absent is unequipped, present is strictly validated', () => {
  assert.deepEqual(readEquipmentSlots({}, PLAYER_EQUIP_TARGET), { weapon: null, amulet: null });
  assert.deepEqual(readEquipmentSlots({ equipment_slots: { weapon: 'w' } }, PLAYER_EQUIP_TARGET), { weapon: 'w', amulet: null });
  assert.throws(() => readEquipmentSlots({ equipment_slots: null }, PLAYER_EQUIP_TARGET), /must be an object/);
  assert.throws(() => readEquipmentSlots({ equipment_slots: [] }, PLAYER_EQUIP_TARGET), /must be an object/);
  assert.throws(() => readEquipmentSlots({ equipment_slots: { weapon: null } }, PLAYER_EQUIP_TARGET), /non-empty string/);
  assert.throws(() => readEquipmentSlots({ equipment_slots: { weapon: '' } }, PLAYER_EQUIP_TARGET), /non-empty string/);
  assert.throws(() => readEquipmentSlots({ equipment_slots: { trinket: 'x' } }, PLAYER_EQUIP_TARGET), /unknown equipment slot: trinket/);
});

test('readEquipmentSlots requires an explicit target with no player default', () => {
  assert.throws(() => readEquipmentSlots({}), /equip target must be 'player' or a selectable character id/);
  assert.throws(() => readEquipmentSlots({}, 'wizard'), /equip target must be 'player' or a selectable character id/);
  assert.throws(() => readEquipmentSlots({}, 'character_999'), /equip target must be 'player' or a selectable character id/);
});

test('readEquipmentSlots reads a companion entry: absent, present, and strict validation', () => {
  assert.deepEqual(readEquipmentSlots({}, 'character_003'), { weapon: null, amulet: null });
  const state = { companion_equipment_slots: { character_003: { weapon: 'w', amulet: 'a' }, character_007: { amulet: 'a2' } } };
  assert.deepEqual(readEquipmentSlots(state, 'character_003'), { weapon: 'w', amulet: 'a' });
  assert.deepEqual(readEquipmentSlots(state, 'character_007'), { weapon: null, amulet: 'a2' });
  // A companion with no entry reads as unequipped, not as a throw.
  assert.deepEqual(readEquipmentSlots(state, 'character_050'), { weapon: null, amulet: null });
  // The whole map is strictly validated: shape, character-id keys, and slot shape.
  assert.throws(() => readEquipmentSlots({ companion_equipment_slots: null }, 'character_003'), /companion_equipment_slots must be an object/);
  assert.throws(() => readEquipmentSlots({ companion_equipment_slots: [] }, 'character_003'), /companion_equipment_slots must be an object/);
  assert.throws(() => readEquipmentSlots({ companion_equipment_slots: { not_a_char: { weapon: 'w' } } }, 'character_003'), /unknown companion equipment character: not_a_char/);
  assert.throws(() => readEquipmentSlots({ companion_equipment_slots: { character_003: { weapon: null } } }, 'character_003'), /non-empty string/);
  assert.throws(() => readEquipmentSlots({ companion_equipment_slots: { character_003: { trinket: 'x' } } }, 'character_003'), /unknown equipment slot: trinket/);
});

test('readAllEquipmentSlots returns every owner and rejects a cross-owner shared instance', () => {
  assert.deepEqual(readAllEquipmentSlots({}), { player: { weapon: null, amulet: null }, companions: {} });
  const state = { equipment_slots: { weapon: 'wpn_1' }, companion_equipment_slots: { character_003: { amulet: 'amu_1' } } };
  assert.deepEqual(readAllEquipmentSlots(state), {
    player: { weapon: 'wpn_1', amulet: null },
    companions: { character_003: { weapon: null, amulet: 'amu_1' } }
  });
  // Same instance worn by the hero and a companion is corrupt persisted state.
  assert.throws(
    () => readAllEquipmentSlots({ equipment_slots: { weapon: 'x' }, companion_equipment_slots: { character_003: { weapon: 'x' } } }),
    /equipment instance x is equipped by multiple owners: player weapon and character_003 weapon/
  );
  // Same instance worn by two companions is equally corrupt.
  assert.throws(
    () => readAllEquipmentSlots({ companion_equipment_slots: { character_003: { amulet: 'y' }, character_007: { amulet: 'y' } } }),
    /equipment instance y is equipped by multiple owners/
  );
});

test('resolveEquippedInstances requires existence and a matching kind', () => {
  const surface = { version: 1, instances: [weapon(), amulet()] };
  const resolved = resolveEquippedInstances({ slots: { weapon: 'wpn_1', amulet: 'amu_1' }, surface });
  assert.equal(resolved.weapon.instance_id, 'wpn_1');
  assert.equal(resolved.amulet.instance_id, 'amu_1');
  assert.throws(() => resolveEquippedInstances({ slots: { weapon: 'ghost', amulet: null }, surface }), /unknown instance: ghost/);
  // Kind mismatch: an amulet id in the weapon slot.
  assert.throws(() => resolveEquippedInstances({ slots: { weapon: 'amu_1', amulet: null }, surface }), /requires a weapon, but amu_1 is a amulet/);
});

test('aggregateEquipmentEffects sums base+bonus and routes element_spell_power to the weapon element', () => {
  const resolved = resolveEquippedInstances({
    slots: { weapon: 'wpn_1', amulet: 'amu_1' },
    surface: {
      version: 1,
      instances: [
        weapon({ instance_id: 'wpn_1', element: 'fire', base_effects: { attack: 5, element_spell_power: 4 }, bonus_effects: { attack: 2, max_mp: 1 } }),
        amulet({ instance_id: 'amu_1', base_effects: { defense: 3 }, bonus_effects: { self_heal_bonus: 6 } })
      ]
    }
  });
  const effects = aggregateEquipmentEffects(resolved);
  assert.equal(effects.attack, 7);
  assert.equal(effects.max_mp, 1);
  assert.equal(effects.defense, 3);
  assert.equal(effects.self_heal_bonus, 6);
  assert.deepEqual(effects.element_spell_power, { fire: 4 });
});

test('buildRunEquipment returns null when unequipped and a slot+effect snapshot otherwise', () => {
  const surface = { version: 1, instances: [weapon(), amulet()] };
  assert.equal(buildRunEquipment({ slots: { weapon: null, amulet: null }, surface }), null);
  const snapshot = buildRunEquipment({ slots: { weapon: 'wpn_1', amulet: null }, surface });
  assert.equal(snapshot.slots.weapon.instance_id, 'wpn_1');
  assert.equal(snapshot.slots.weapon.weapon_type, 'sword');
  assert.equal(snapshot.slots.amulet, null);
  assert.equal(snapshot.effects.attack, 5);
});

test('applyEquipmentToCombatStats folds effects and leaves stats untouched when unequipped', () => {
  const stats = { max_hp: 40, max_mp: 12, melee_attack: 10, defense: 5, spell_power: { fire: 8, water: 6 } };
  assert.equal(applyEquipmentToCombatStats(stats, null), stats);
  const equipment = { slots: {}, effects: { attack: 3, defense: 2, max_hp: 10, max_mp: 4, spell_mp_discount: 0, self_heal_bonus: 0, element_spell_power: { fire: 5 } } };
  const applied = applyEquipmentToCombatStats(stats, equipment);
  assert.equal(applied.melee_attack, 13);
  assert.equal(applied.defense, 7);
  assert.equal(applied.max_hp, 50);
  assert.equal(applied.max_mp, 16);
  assert.deepEqual(applied.spell_power, { fire: 13, water: 6 });
  // The source stats object is not mutated.
  assert.equal(stats.melee_attack, 10);
  assert.deepEqual(stats.spell_power, { fire: 8, water: 6 });
});

test('resolveRunEquipment short-circuits to null when unequipped without reading the surface', async () => {
  // No surface file exists; an unequipped state must still resolve (to null), not throw.
  const root = await storageRoot({ version: 1 });
  assert.equal(await resolveRunEquipment({ root, state: {}, target: PLAYER_EQUIP_TARGET }), null);
  // A companion with no slots resolves the same way (per-owner read, no surface touch).
  assert.equal(await resolveRunEquipment({ root, state: {}, target: 'character_003' }), null);
  // The target is required — an omitted owner fails fast, never a silent player default.
  await assert.rejects(resolveRunEquipment({ root, state: {} }), /equip target must be 'player' or a selectable character id/);
});

test('equipItem and unequipItem persist runtime_state and keep the absent=unequipped invariant', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: weapon() });
  await addEquipmentInstance({ root, instance: amulet() });

  await equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: 'wpn_1' });
  await equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'amulet', instance_id: 'amu_1' });
  const equippedState = await readState(root);
  assert.deepEqual(equippedState.equipment_slots, { weapon: 'wpn_1', amulet: 'amu_1' });
  // A hero-only save never grows a companion field.
  assert.equal(Object.prototype.hasOwnProperty.call(equippedState, 'companion_equipment_slots'), false);

  // Unequipping one slot stores only the occupied slot (no explicit null).
  await unequipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon' });
  assert.deepEqual((await readState(root)).equipment_slots, { amulet: 'amu_1' });

  // Unequipping the last slot removes the field entirely (back to absent).
  await unequipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'amulet' });
  assert.equal(Object.prototype.hasOwnProperty.call(await readState(root), 'equipment_slots'), false);
});

test('equipItem fails fast on an unknown instance or a kind mismatch, before writing', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: amulet() });
  await assert.rejects(equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: 'ghost' }), /cannot equip unknown instance: ghost/);
  await assert.rejects(equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: 'amu_1' }), /requires a weapon, but amu_1 is a amulet/);
  await assert.rejects(equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'trinket', instance_id: 'amu_1' }), /unknown equipment slot: trinket/);
  // None of the failed attempts wrote a slot.
  assert.equal(Object.prototype.hasOwnProperty.call(await readState(root), 'equipment_slots'), false);
});

test('equipItem and unequipItem require an explicit target with no player default', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: weapon() });
  await assert.rejects(equipItem({ root, slot: 'weapon', instance_id: 'wpn_1' }), /equip target must be 'player' or a selectable character id/);
  await assert.rejects(equipItem({ root, target: 'character_999', slot: 'weapon', instance_id: 'wpn_1' }), /equip target must be 'player' or a selectable character id/);
  await assert.rejects(unequipItem({ root, slot: 'weapon' }), /equip target must be 'player' or a selectable character id/);
  assert.equal(Object.prototype.hasOwnProperty.call(await readState(root), 'equipment_slots'), false);
});

test('companion equip persists under companion_equipment_slots and drops emptied entries with no residue', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: weapon() });
  await addEquipmentInstance({ root, instance: amulet() });

  await equipItem({ root, target: 'character_003', slot: 'weapon', instance_id: 'wpn_1' });
  await equipItem({ root, target: 'character_003', slot: 'amulet', instance_id: 'amu_1' });
  const state = await readState(root);
  assert.deepEqual(state.companion_equipment_slots, { character_003: { weapon: 'wpn_1', amulet: 'amu_1' } });
  // The hero surface is untouched by a companion equip.
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'equipment_slots'), false);

  // Emptying one slot leaves only the occupied slot on that entry.
  await unequipItem({ root, target: 'character_003', slot: 'weapon' });
  assert.deepEqual((await readState(root)).companion_equipment_slots, { character_003: { amulet: 'amu_1' } });

  // Emptying the entry removes it, and an emptied map drops the whole field (no residue).
  await unequipItem({ root, target: 'character_003', slot: 'amulet' });
  assert.equal(Object.prototype.hasOwnProperty.call(await readState(root), 'companion_equipment_slots'), false);
});

test('one-of-a-kind exclusion: an instance cannot be equipped by two owners at once', async () => {
  const root = await storageRoot();
  await addEquipmentInstance({ root, instance: weapon() });
  await addEquipmentInstance({ root, instance: amulet() });

  // Hero equips the weapon; a companion may not take the same instance.
  await equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: 'wpn_1' });
  await assert.rejects(
    equipItem({ root, target: 'character_003', slot: 'weapon', instance_id: 'wpn_1' }),
    /cannot equip wpn_1: already equipped by player weapon/
  );
  // The rejected equip left no companion state.
  assert.equal(Object.prototype.hasOwnProperty.call(await readState(root), 'companion_equipment_slots'), false);

  // Companion equips the amulet; the hero may not take the same instance (reverse).
  await equipItem({ root, target: 'character_003', slot: 'amulet', instance_id: 'amu_1' });
  await assert.rejects(
    equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'amulet', instance_id: 'amu_1' }),
    /cannot equip amu_1: already equipped by character_003 amulet/
  );

  // Companion-to-companion collision is rejected the same way.
  await assert.rejects(
    equipItem({ root, target: 'character_007', slot: 'amulet', instance_id: 'amu_1' }),
    /cannot equip amu_1: already equipped by character_003 amulet/
  );

  // Re-equipping the same instance into the same target slot is a no-op, not a conflict.
  await assert.doesNotReject(equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'weapon', instance_id: 'wpn_1' }));
  assert.deepEqual((await readState(root)).equipment_slots, { weapon: 'wpn_1' });
});

test('equip fails fast when the persisted state already shares an instance across owners', async () => {
  const root = await storageRoot({
    version: 1,
    equipment_slots: { weapon: 'wpn_1' },
    companion_equipment_slots: { character_003: { weapon: 'wpn_1' } }
  });
  await addEquipmentInstance({ root, instance: weapon() });
  await addEquipmentInstance({ root, instance: amulet() });
  await assert.rejects(
    equipItem({ root, target: PLAYER_EQUIP_TARGET, slot: 'amulet', instance_id: 'amu_1' }),
    /equipment instance wpn_1 is equipped by multiple owners/
  );
});
