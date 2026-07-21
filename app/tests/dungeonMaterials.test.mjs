import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATERIAL_ELEMENTS,
  MATERIAL_TIERS,
  materialItemId,
  normalizeDungeonMaterialCatalog
} from '../src/dungeonMaterialCatalog.mjs';
import {
  MATERIAL_BASE_DROP_RATE,
  addMaterialToBuffer,
  emptyMaterialBuffer,
  materialBufferEntries,
  readMaterialBuffer,
  rollEnemyMaterialDrop,
  tierForFloor
} from '../src/dungeon/dungeonMaterials.mjs';
import { generateFloor, MILESTONE_FLOORS } from '../src/dungeon/dungeonGeneration.mjs';
import { realDungeonMaterials } from './dungeonMaterialsFixture.mjs';

function fullCatalog() {
  const materials = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) {
      materials.push({
        item_id: `material_${element}_t${tier}`,
        name: `${element} t${tier}`,
        description: `${element} tier ${tier} material.`,
        sell_price: tier * 10,
        icon: `/canonical/dungeon/material-icons/material_${element}_t${tier}.png`
      });
    }
  }
  return { materials };
}

test('material elements are the six magic keys and tiers are 1-4', () => {
  assert.deepEqual([...MATERIAL_ELEMENTS], ['light', 'dark', 'fire', 'water', 'earth', 'wind']);
  assert.deepEqual([...MATERIAL_TIERS], [1, 2, 3, 4]);
});

test('materialItemId builds the id scheme and fails fast on bad element/tier', () => {
  assert.equal(materialItemId('fire', 2), 'material_fire_t2');
  assert.equal(materialItemId('wind', 4), 'material_wind_t4');
  assert.throws(() => materialItemId('luck', 1), /unknown dungeon material element/);
  assert.throws(() => materialItemId('fire', 5), /invalid dungeon material tier/);
  assert.throws(() => materialItemId('fire', 0), /invalid dungeon material tier/);
});

test('the authored dungeon material catalog loads as exactly 24 element×tier entries', async () => {
  const materials = normalizeDungeonMaterialCatalog(await realDungeonMaterials());
  assert.equal(materials.length, 24);
  const ids = new Set(materials.map((material) => material.item_id));
  assert.equal(ids.size, 24);
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) assert.equal(ids.has(`material_${element}_t${tier}`), true);
  }
  for (const material of materials) {
    assert.equal(typeof material.name, 'string');
    assert.equal(material.name.length > 0, true);
    assert.equal(typeof material.description, 'string');
    assert.equal(Number.isInteger(material.sell_price) && material.sell_price >= 0, true);
    assert.equal(material.icon.startsWith('/canonical/dungeon/material-icons/'), true);
    // element/tier meta is derived from the id scheme and matches the id.
    assert.equal(MATERIAL_ELEMENTS.includes(material.element), true);
    assert.equal(MATERIAL_TIERS.includes(material.tier), true);
    assert.equal(material.item_id, `material_${material.element}_t${material.tier}`);
  }
});

test('the strict catalog loader fails fast on wrong count, bad ids, duplicates, gaps, and bad fields', () => {
  assert.throws(() => normalizeDungeonMaterialCatalog({ materials: [] }), /exactly 24 entries/);

  const tooFew = fullCatalog();
  tooFew.materials.pop();
  assert.throws(() => normalizeDungeonMaterialCatalog(tooFew), /exactly 24 entries/);

  const badId = fullCatalog();
  badId.materials[0].item_id = 'material_light_t5';
  assert.throws(() => normalizeDungeonMaterialCatalog(badId), /must match material_<element>_t<1-4>/);

  const offScheme = fullCatalog();
  offScheme.materials[0].item_id = 'moonfern_tip';
  assert.throws(() => normalizeDungeonMaterialCatalog(offScheme), /must match material_<element>_t<1-4>/);

  const duplicate = fullCatalog();
  duplicate.materials[1].item_id = duplicate.materials[0].item_id;
  assert.throws(() => normalizeDungeonMaterialCatalog(duplicate), /duplicate dungeon material item_id|missing required entry/);

  const missingField = fullCatalog();
  delete missingField.materials[3].icon;
  assert.throws(() => normalizeDungeonMaterialCatalog(missingField), /\.icon is required/);

  const negativePrice = fullCatalog();
  negativePrice.materials[2].sell_price = -1;
  assert.throws(() => normalizeDungeonMaterialCatalog(negativePrice), /sell_price must be a non-negative integer/);
});

test('tierForFloor maps floor bands to tiers and rejects invalid floors', () => {
  assert.deepEqual([1, 2, 3].map(tierForFloor), [1, 1, 1]);
  assert.deepEqual([4, 5, 6].map(tierForFloor), [2, 2, 2]);
  assert.deepEqual([7, 8, 9].map(tierForFloor), [3, 3, 3]);
  assert.equal(tierForFloor(10), 4);
  assert.throws(() => tierForFloor(0), /invalid dungeon floor/);
});

test('a milestone boss always drops the element T4 material at 100%', () => {
  for (const element of MATERIAL_ELEMENTS) {
    for (const floor of [5, 10]) {
      const boss = { uid: 'boss1', element, boss: true };
      assert.equal(rollEnemyMaterialDrop({ seed: 42, floor, enemy: boss }), `material_${element}_t4`);
    }
  }
});

test('a naturally-spawned milestone boss carries boss===true and yields the guaranteed element T4 drop', () => {
  // Exercise the real spawn path: generateFloor is what fills run.enemies, and those
  // are the objects passed to defeatEnemy -> rollEnemyMaterialDrop. This ties the T4
  // guarantee to the production boss shape rather than a hand-built { boss: true }.
  for (const seed of [7, 42, 4242]) {
    for (const floor of MILESTONE_FLOORS) {
      const generated = generateFloor({ seed, floor });
      const bosses = generated.enemies.filter((enemy) => enemy.boss === true);
      assert.equal(bosses.length, 1, `milestone floor ${floor} (seed ${seed}) must spawn exactly one boss`);
      const boss = bosses[0];
      assert.equal(MATERIAL_ELEMENTS.includes(boss.element), true);
      assert.equal(rollEnemyMaterialDrop({ seed, floor, enemy: boss }), `material_${boss.element}_t4`);
    }
  }
  // And a naturally-spawned normal enemy is not treated as a boss (no boss field).
  const normalFloor = generateFloor({ seed: 4242, floor: 4 });
  const normals = normalFloor.enemies.filter((enemy) => enemy.boss === true);
  assert.equal(normals.length, 0, 'non-milestone floors spawn no boss');
});

test('enemy drops are deterministic in (seed, floor, uid) and never perturb across calls', () => {
  const enemy = { uid: 'e3', element: 'fire' };
  const first = rollEnemyMaterialDrop({ seed: 20260705, floor: 4, enemy });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(rollEnemyMaterialDrop({ seed: 20260705, floor: 4, enemy }), first);
  }
  // A different run seed can produce a different outcome, proving the roll is seed-driven.
  const seeds = Array.from({ length: 40 }, (_, i) => 1000 + i);
  const outcomes = new Set(seeds.map((seed) => rollEnemyMaterialDrop({ seed, floor: 4, enemy })));
  assert.equal(outcomes.size > 1, true);
});

test('a dropped normal-enemy material uses the floor tier band and the enemy element', () => {
  const floorTier = [[1, 1], [4, 2], [7, 3], [10, 4]];
  for (const [floor, tier] of floorTier) {
    // Scan uids until this floor produces a drop, then assert the tier/element mapping.
    let dropped = null;
    for (let i = 1; i <= 200 && !dropped; i += 1) {
      dropped = rollEnemyMaterialDrop({ seed: 7, floor, enemy: { uid: `e${i}`, element: 'water' } });
    }
    assert.equal(dropped, `material_water_t${tier}`);
  }
});

test('the base drop rate is honored across many independent enemies', () => {
  const trials = 3000;
  let drops = 0;
  for (let i = 0; i < trials; i += 1) {
    if (rollEnemyMaterialDrop({ seed: 555, floor: 2, enemy: { uid: `e${i}`, element: 'earth' } })) drops += 1;
  }
  const rate = drops / trials;
  assert.equal(Math.abs(rate - MATERIAL_BASE_DROP_RATE) < 0.05, true, `drop rate ${rate} should be near ${MATERIAL_BASE_DROP_RATE}`);
});

test('an enemy element outside the six material elements fails fast', () => {
  assert.throws(() => rollEnemyMaterialDrop({ seed: 1, floor: 1, enemy: { uid: 'e1', element: 'plasma' } }), /not a known material element/);
  assert.throws(() => rollEnemyMaterialDrop({ seed: 1, floor: 1, enemy: { uid: 'e1' } }), /not a known material element/);
  assert.throws(() => rollEnemyMaterialDrop({ seed: 1, floor: 1, enemy: { element: 'fire' } }), /enemy uid is required/);
});

test('the material buffer treats absence as empty and fails fast on corruption', () => {
  assert.deepEqual(emptyMaterialBuffer(), {});
  assert.deepEqual(readMaterialBuffer({}), {});
  assert.deepEqual(readMaterialBuffer({ material_buffer: undefined }), {});
  assert.deepEqual(readMaterialBuffer({ material_buffer: null }), {});
  assert.deepEqual(readMaterialBuffer({ material_buffer: { material_fire_t1: 2 } }), { material_fire_t1: 2 });

  assert.throws(() => readMaterialBuffer({ material_buffer: [] }), /must be an object/);
  assert.throws(() => readMaterialBuffer({ material_buffer: 'x' }), /must be an object/);
  assert.throws(() => readMaterialBuffer({ material_buffer: { material_fire_t1: 0 } }), /must be a positive integer/);
  assert.throws(() => readMaterialBuffer({ material_buffer: { material_fire_t1: 1.5 } }), /must be a positive integer/);
});

test('addMaterialToBuffer accrues counts and materialBufferEntries returns sorted pairs', () => {
  let buffer = emptyMaterialBuffer();
  buffer = addMaterialToBuffer(buffer, 'material_water_t2');
  buffer = addMaterialToBuffer(buffer, 'material_fire_t1', 2);
  buffer = addMaterialToBuffer(buffer, 'material_water_t2');
  assert.deepEqual(buffer, { material_water_t2: 2, material_fire_t1: 2 });
  assert.deepEqual(materialBufferEntries(buffer), [
    { item_id: 'material_fire_t1', quantity: 2 },
    { item_id: 'material_water_t2', quantity: 2 }
  ]);
  assert.throws(() => addMaterialToBuffer(buffer, 'material_fire_t1', 0), /positive integer/);
  assert.throws(() => addMaterialToBuffer([], 'material_fire_t1'), /must be an object/);
});
