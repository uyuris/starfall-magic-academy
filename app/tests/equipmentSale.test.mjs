import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { equipmentSellPrice, equippedInstanceIds, sellEquipmentInstance } from '../src/equipmentSale.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { createStorageApi } from '../src/storage.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

// consumeInventoryItems (reused for the atomic sale credit) resolves the full known-item
// universe, so those definitions must be seeded even though a sale charges no items.
async function seedEconomyDefinitions(root) {
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
}

function weapon(overrides = {}) {
  return {
    instance_id: 'equip_weapon_1',
    kind: 'weapon',
    weapon_type: 'sword',
    element: 'fire',
    tier: 2,
    quality: 'fine',
    name: '紅蓮の剣',
    flavor: '柄に熾火の紋がめぐる。',
    base_effects: { attack: 5, max_hp: 3 },
    bonus_effects: { attack: 2 },
    ...overrides
  };
}

function amulet(overrides = {}) {
  return {
    instance_id: 'equip_amulet_1',
    kind: 'amulet',
    element: 'water',
    tier: 1,
    quality: 'common',
    name: '雫の護符',
    flavor: '触れると涼やかに湿る。',
    base_effects: { defense: 4, max_hp: 2 },
    bonus_effects: { defense: 1 },
    ...overrides
  };
}

async function saleRoot({ money = 500, instances = [], state = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-sale-'));
  await seedEconomyDefinitions(root);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, characters: {}, ...state });
  await writeJson(root, 'data/mutable/game_data/player_inventory.json', { money, items: [] });
  await writeJson(root, 'data/mutable/game_data/player_equipment.json', { version: 1, instances });
  return root;
}

test('equipmentSellPrice is the exact deterministic (tier, quality) table', () => {
  const expected = {
    1: { common: 8, fine: 12, excellent: 18, masterwork: 28 },
    2: { common: 24, fine: 36, excellent: 54, masterwork: 84 },
    3: { common: 60, fine: 90, excellent: 135, masterwork: 210 },
    4: { common: 128, fine: 192, excellent: 288, masterwork: 448 }
  };
  for (const tier of [1, 2, 3, 4]) {
    for (const quality of ['common', 'fine', 'excellent', 'masterwork']) {
      assert.equal(equipmentSellPrice({ tier, quality }), expected[tier][quality], `tier ${tier} ${quality}`);
    }
  }
});

test('equipmentSellPrice fails fast on an unknown tier or quality (no fallback price)', () => {
  assert.throws(() => equipmentSellPrice({ tier: 5, quality: 'fine' }), /no sale price for equipment tier: 5/);
  assert.throws(() => equipmentSellPrice({ tier: 2, quality: 'legendary' }), /no sale price for equipment quality: legendary/);
});

test('equippedInstanceIds gathers every owner (hero + companions) and rejects a cross-owner share', () => {
  assert.deepEqual([...equippedInstanceIds({})], []);
  const state = {
    equipment_slots: { weapon: 'equip_weapon_1' },
    companion_equipment_slots: { character_003: { amulet: 'equip_amulet_1' } }
  };
  assert.deepEqual([...equippedInstanceIds(state)].sort(), ['equip_amulet_1', 'equip_weapon_1']);
  assert.throws(
    () => equippedInstanceIds({ equipment_slots: { weapon: 'x' }, companion_equipment_slots: { character_003: { weapon: 'x' } } }),
    /equipped by multiple owners/
  );
});

test('selling an unequipped instance removes it from the surface and credits the exact sell price', async () => {
  const root = await saleRoot({ money: 500, instances: [weapon(), amulet()] });
  const result = await sellEquipmentInstance({ root, instance_id: 'equip_weapon_1' });

  assert.equal(result.sell_price, 36, 'tier 2 fine sells for 36');
  assert.equal(result.sold_instance.instance_id, 'equip_weapon_1');
  assert.equal(result.sold_instance.name, '紅蓮の剣');
  assert.equal(result.inventory.money, 536, '500 + 36 credited');

  const surface = await loadEquipmentSurface({ root });
  assert.deepEqual(surface.instances.map((i) => i.instance_id), ['equip_amulet_1'], 'only the sold instance is removed');
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).money, 536, 'wallet persisted');
});

test('selling an unknown instance id fails fast before any write', async () => {
  const root = await saleRoot({ money: 500, instances: [amulet()] });
  await assert.rejects(sellEquipmentInstance({ root, instance_id: 'equip_missing' }), /unknown_equipment_instance/);

  assert.deepEqual((await loadEquipmentSurface({ root })).instances.map((i) => i.instance_id), ['equip_amulet_1']);
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).money, 500, 'wallet untouched');
});

test('selling an instance worn by the hero is rejected before any write', async () => {
  const root = await saleRoot({
    money: 500,
    instances: [weapon(), amulet()],
    state: { equipment_slots: { weapon: 'equip_weapon_1' } }
  });
  await assert.rejects(sellEquipmentInstance({ root, instance_id: 'equip_weapon_1' }), /equipment_instance_equipped/);

  assert.deepEqual((await loadEquipmentSurface({ root })).instances.map((i) => i.instance_id), ['equip_weapon_1', 'equip_amulet_1']);
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).money, 500, 'wallet untouched');
});

test('selling an instance worn by a companion is rejected before any write', async () => {
  const root = await saleRoot({
    money: 500,
    instances: [weapon(), amulet()],
    state: { companion_equipment_slots: { character_003: { amulet: 'equip_amulet_1' } } }
  });
  await assert.rejects(sellEquipmentInstance({ root, instance_id: 'equip_amulet_1' }), /equipment_instance_equipped/);

  assert.deepEqual((await loadEquipmentSurface({ root })).instances.map((i) => i.instance_id), ['equip_weapon_1', 'equip_amulet_1']);
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).money, 500, 'wallet untouched');
});

test('a sale is atomic: a failing surface write leaves neither the wallet credited nor the instance removed', async () => {
  const root = await saleRoot({ money: 500, instances: [weapon(), amulet()] });
  const realApi = createStorageApi({ root });
  // A storage whose surface write fails after the wallet delta is computed exercises the
  // transaction's no-partial-apply guarantee: the sale credit must not persist when the
  // paired surface removal cannot be written.
  const failingApi = {
    ...realApi,
    writeJson: async (relativePath, value) => {
      if (relativePath === 'game_data/player_equipment.json') throw new Error('injected surface write failure');
      return realApi.writeJson(relativePath, value);
    }
  };

  await assert.rejects(sellEquipmentInstance({ storage: failingApi, instance_id: 'equip_weapon_1' }), /injected surface write failure/);

  assert.deepEqual(
    (await loadEquipmentSurface({ root })).instances.map((i) => i.instance_id),
    ['equip_weapon_1', 'equip_amulet_1'],
    'no instance removed'
  );
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).money, 500, 'no money credited');
});
