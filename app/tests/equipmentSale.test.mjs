// 残す (a): 装備の売却が失敗したときに、差し出した装備が所持から消える・代金だけが入る壊れ方から、プレイヤーの装備と所持金を守る（操作の原子性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { sellEquipmentInstance } from '../src/equipmentSale.mjs';
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
