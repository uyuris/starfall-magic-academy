import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MILESTONE_TREASURE_BANDS,
  addEquipmentToBuffer,
  bandForMilestoneFloor,
  emptyEquipmentBuffer,
  equipmentBufferItems,
  readEquipmentBuffer,
  rollBossTreasureEquipment
} from '../src/dungeon/dungeonEquipmentDrops.mjs';
import { validateEquipmentInstance, WEAPON_TYPES } from '../src/equipment.mjs';
import { generateFloor, MILESTONE_FLOORS, itemKinds } from '../src/dungeon/dungeonGeneration.mjs';
import { magicParameterDefinitions } from '../src/parameters.mjs';

const MAGIC_KEYS = magicParameterDefinitions.map((definition) => definition.key);

test('a boss treasure roll is fully determined by (seed, floor) and is a valid equipment instance', () => {
  for (const floor of MILESTONE_FLOORS) {
    const a = rollBossTreasureEquipment({ seed: 4242, floor });
    const b = rollBossTreasureEquipment({ seed: 4242, floor });
    assert.deepEqual(a, b, `same (seed, floor=${floor}) reproduces the same instance`);
    // The returned instance is a valid C-08 equipment instance (validated inside the roll).
    assert.doesNotThrow(() => validateEquipmentInstance(a));
    assert.equal(a.instance_id, `dungeon_boss_equip_s4242_f${floor}`);
    assert.ok(MAGIC_KEYS.includes(a.element), 'element is one of the six magic elements');
    assert.equal(typeof a.name, 'string');
    assert.ok(a.name.length > 0 && a.flavor.length > 0, 'authored name/flavor are non-empty (no LLM)');
    if (a.kind === 'weapon') assert.ok(WEAPON_TYPES.includes(a.weapon_type));
  }
});

test('the two milestone floors map to distinct bands: 5F mid (T3/excellent), 10F high (T4/masterwork)', () => {
  assert.deepEqual(Object.keys(MILESTONE_TREASURE_BANDS).map(Number).sort((x, y) => x - y), MILESTONE_FLOORS);
  const five = rollBossTreasureEquipment({ seed: 99, floor: 5 });
  const ten = rollBossTreasureEquipment({ seed: 99, floor: 10 });
  assert.equal(five.tier, 3);
  assert.equal(five.quality, 'excellent');
  assert.equal(Object.keys(five.bonus_effects).length, 2, '5F rolls 2 bonus lines');
  assert.equal(ten.tier, 4);
  assert.equal(ten.quality, 'masterwork');
  assert.equal(Object.keys(ten.bonus_effects).length, 3, '10F rolls 3 bonus lines');
});

test('varying the seed varies the roll (not a constant), while the band stays fixed to the floor', () => {
  const rolls = [11, 22, 33, 44, 55].map((seed) => rollBossTreasureEquipment({ seed, floor: 10 }));
  for (const roll of rolls) {
    assert.equal(roll.tier, 4);
    assert.equal(roll.quality, 'masterwork');
  }
  const signatures = new Set(rolls.map((roll) => JSON.stringify(roll)));
  assert.ok(signatures.size > 1, 'different seeds do not all collapse to one instance');
});

test('a non-milestone floor has no boss treasure band and fails fast (milestone-only gate)', () => {
  for (const floor of [1, 4, 6, 7, 9]) {
    assert.throws(() => bandForMilestoneFloor(floor), /no boss treasure band/);
    assert.throws(() => rollBossTreasureEquipment({ seed: 1, floor }), /no boss treasure band/);
  }
});

test('the equipment buffer: empty→[], additive append with a one-of-a-kind guard, sorted display copies', () => {
  assert.deepEqual(emptyEquipmentBuffer(), []);
  // Absent buffer reads as empty; a present non-array is corrupt state and throws.
  assert.deepEqual(readEquipmentBuffer({}), []);
  assert.throws(() => readEquipmentBuffer({ equipment_buffer: 'nope' }), /must be an array/);

  const five = rollBossTreasureEquipment({ seed: 7, floor: 5 });
  const ten = rollBossTreasureEquipment({ seed: 7, floor: 10 });
  let buffer = addEquipmentToBuffer(emptyEquipmentBuffer(), ten);
  buffer = addEquipmentToBuffer(buffer, five);
  assert.equal(buffer.length, 2);
  // A duplicate instance_id is corrupt state and throws before any change.
  assert.throws(() => addEquipmentToBuffer(buffer, ten), /already holds instance_id/);
  // readEquipmentBuffer validates every held instance.
  assert.equal(readEquipmentBuffer({ equipment_buffer: buffer }).length, 2);
  // Display items are instance_id-sorted copies (f10 sorts before f5 lexically).
  const items = equipmentBufferItems(buffer);
  assert.deepEqual(items.map((i) => i.instance_id), [five.instance_id, ten.instance_id].sort((a, b) => a.localeCompare(b)));
  assert.notEqual(items[0], buffer.find((b) => b.instance_id === items[0].instance_id), 'items are copies, not the buffer entries');
});

test('the treasure chest is a boss reward, never scattered as floor loot by generation', () => {
  assert.ok(itemKinds.treasure_chest, 'treasure_chest is a known item kind (for name/glyph/effect resolution)');
  assert.equal(itemKinds.treasure_chest.effect, 'treasure');
  for (const floor of [1, 2, 3, 5, 10]) {
    for (const seed of [1, 4242, 90909]) {
      const generated = generateFloor({ seed, floor });
      assert.equal(
        generated.items.some((item) => item.kind === 'treasure_chest'),
        false,
        `floor ${floor} seed ${seed} scatters no treasure_chest`
      );
    }
  }
});
