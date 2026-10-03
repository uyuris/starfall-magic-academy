// 残す (a): 装備のクラフトが失敗したときに、差し出した素材を減らす壊れ方から、プレイヤーの所持品を守る（操作の原子性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  completeCraft
} from '../src/equipmentCraft.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';
import { MATERIAL_ELEMENTS, MATERIAL_TIERS } from '../src/dungeonMaterialCatalog.mjs';
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

function craftParams({ academics = 50, charisma = 50, magic = {} } = {}) {
  const magicGroup = {};
  for (const element of MATERIAL_ELEMENTS) magicGroup[element] = { value: magic[element] ?? 10 };
  return {
    magic: magicGroup,
    abilities: {
      strength: { value: 20 }, agility: { value: 20 }, academics: { value: academics },
      magical_power: { value: 20 }, charisma: { value: charisma }
    }
  };
}

function richInventory() {
  const items = [];
  for (const element of MATERIAL_ELEMENTS) {
    for (const tier of MATERIAL_TIERS) items.push({ item_id: `material_${element}_t${tier}`, quantity: 99 });
  }
  return { money: 100000, items };
}

// consumeInventoryItems resolves the full known-item universe (shop / stage / gathering
// / alchemy products / dungeon materials), so those definitions must be seeded even
// though craft only ever charges dungeon-material costs.
async function seedEconomyDefinitions(root) {
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
}

async function craftRoot({ parameters, inventory, elapsedWeeks = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-craft-'));
  await seedEconomyDefinitions(root);
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, elapsed_weeks: elapsedWeeks, characters: {} });
  if (parameters) await writeJson(root, 'data/mutable/game_data/runtime/player_parameters.json', parameters);
  if (inventory) await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory);
  return root;
}

test('completeCraft is atomic: an empty name or short materials leaves inventory and surface untouched', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2'; // tier 2 needs 4 material_fire_t2
  const root = await craftRoot({ parameters: craftParams({ academics: 50, magic: { fire: 50 } }), inventory: { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 4 }] }, elapsedWeeks: 1 });

  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '', flavor: 'x' }), /name must be a non-empty string/);
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] }, 'no instance added on a bad name');
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).items[0].quantity, 4, 'materials untouched on a bad name');

  await writeJson(root, 'data/mutable/game_data/player_inventory.json', { money: 100000, items: [{ item_id: 'material_fire_t2', quantity: 1 }] });
  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '刀', flavor: 'x' }), /insufficient_item_quantity/);
  assert.deepEqual(await loadEquipmentSurface({ root }), { version: 1, instances: [] }, 'no instance added on short materials');
  assert.equal((await readJson(root, 'data/mutable/game_data/player_inventory.json')).items[0].quantity, 1, 'materials untouched on short materials');
});

test('a successful craft consumes materials and adds the instance; a same-week recraft fails fast', async () => {
  const recipeId = 'craft_weapon_sword_fire_t2';
  const root = await craftRoot({ parameters: craftParams({ academics: 80, magic: { fire: 80 } }), inventory: richInventory(), elapsedWeeks: 4 });
  const ownedBefore = (await readJson(root, 'data/mutable/game_data/player_inventory.json')).items.find((item) => item.item_id === 'material_fire_t2').quantity;

  const done = await completeCraft({ root, recipe_id: recipeId, name: '紅蓮刀', flavor: '熾火の刃。' });
  const after = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  assert.equal(after.items.find((item) => item.item_id === 'material_fire_t2').quantity, ownedBefore - 4, 'materials consumed');
  const surface = await loadEquipmentSurface({ root });
  assert.equal(surface.instances.length, 1);
  assert.equal(surface.instances[0].instance_id, done.instance.instance_id);
  assert.equal(surface.instances[0].name, '紅蓮刀');

  // Same week + same recipe → duplicate instance_id → fail-fast, and nothing more is spent.
  await assert.rejects(completeCraft({ root, recipe_id: recipeId, name: '別の名', flavor: 'x' }), /instance_id already exists/);
  const afterDup = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  assert.equal(afterDup.items.find((item) => item.item_id === 'material_fire_t2').quantity, ownedBefore - 4, 'the failed recraft consumed nothing');
});
