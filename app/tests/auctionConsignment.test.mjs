// 残す (a): 競売への出品が成立しなかったとき（装備中の品の払い出し・流札）に、差し出した品を所持から消す・所持金を動かす壊れ方から、プレイヤーの所持品を守る（操作の原子性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';
import { writeStarCradleCatalogDefinitionSplit } from './starCradleFixture.mjs';
import {
  ROUTING_AUCTION_STATE_KEY,
  loadAuctionCatalog,
  auctionCatalogItem,
  buildAuctionSlot,
  deriveAuctionEquipmentInstance,
  readConsignmentForWeek
} from '../src/routingAuction.mjs';
import { payoutConsignmentToPlayer } from '../src/auctionAward.mjs';
import {
  submitConsignment,
  resolveConsignmentLot
} from '../src/routingAuctionSession.mjs';
import { loadInventory } from '../src/economy.mjs';
import { loadEquipmentSurface } from '../src/equipment.mjs';

const RUNTIME_STATE_MUTABLE = 'data/mutable/game_data/runtime_state.json';
const EQUIPMENT_MUTABLE = 'data/mutable/game_data/player_equipment.json';
const WEEK = 4;
const BIDDERS = [
  { character_id: 'character_001', display_name: 'キャラ1' },
  { character_id: 'character_002', display_name: 'キャラ2' },
  { character_id: 'character_003', display_name: 'キャラ3' }
];
const BUDGETS = { character_001: 50000, character_002: 50000, character_003: 50000 };
const SELL_ITEM = 'material_light_t3'; // a known dungeon material, sell_price 120 (> 0)

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readState(root) {
  return JSON.parse(await fs.readFile(path.join(root, RUNTIME_STATE_MUTABLE), 'utf8'));
}

async function readMutableInventory(root) {
  for (const relativePath of ['data/mutable/game_data/player_inventory.json', 'data/seeds/game_data/player_inventory.json']) {
    try {
      return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('no player inventory found');
}

// A consignment-capable root: definitions the economy/equipment paths read + inventory + runtime_state. Optionally
// seeds an equipment instance and/or inventory items so the consignable-asset paths resolve.
async function consignmentRoot({ money = 60000, inventoryItems = [], equipmentInstances = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-auction-consign-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院', player_name: '主人公', world_description: '設定', world_condition_texts: []
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeStarCradleCatalogDefinitionSplit(root);
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', { money, items: inventoryItems });
  await writeJson(root, RUNTIME_STATE_MUTABLE, { version: 1, elapsed_weeks: WEEK, global_flags: {}, characters: {} });
  if (equipmentInstances.length > 0) await writeJson(root, EQUIPMENT_MUTABLE, { version: 1, instances: equipmentInstances });
  return root;
}

// Builds a 3-lot house slot so the consignment window (current_lot_index 0) is open with seated bidders.
async function seedSlot(root, itemIds = ['auction_item_05', 'auction_wa_02', 'auction_being_11']) {
  const catalog = await loadAuctionCatalog({ root });
  const lots = itemIds.map((itemId, index) => {
    const item = auctionCatalogItem(catalog, itemId);
    return { lot_index: index, item, band: item.band, initial_price: [6000, 9000, 8000][index], min_increment: 300, npc_budgets: { ...BUDGETS } };
  });
  const slot = buildAuctionSlot({ week: WEEK, bidders: BIDDERS, lots });
  const state = await readState(root);
  await writeJson(root, RUNTIME_STATE_MUTABLE, { ...state, [ROUTING_AUCTION_STATE_KEY]: slot });
  return slot;
}

async function mintEquipmentInstance(root) {
  const catalog = await loadAuctionCatalog({ root });
  const item = auctionCatalogItem(catalog, 'auction_wa_01'); // a B-band sword 骨子
  return deriveAuctionEquipmentInstance({ item, week: WEEK, name: '暁の一振り', flavor: '柄に星屑の名残が滲む一振り' });
}

// ----- payout writer: atomic asset removal + money credit -----

test('payoutConsignmentToPlayer (equipment) removes the instance and credits the winning bid; rejects an unknown or equipped instance before any write', async (t) => {
  const instance = await mintEquipmentInstance(await consignmentRoot());
  const root = await consignmentRoot({ money: 1000, equipmentInstances: [instance] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const payout = await payoutConsignmentToPlayer({ root, source: { kind: 'equipment', instance_id: instance.instance_id }, amount: 5000 });
  assert.equal(payout.amount, 5000);
  assert.equal((await readMutableInventory(root)).money, 6000);
  assert.equal((await loadEquipmentSurface({ root })).instances.length, 0);

  // unknown instance -> rejected, nothing written
  await assert.rejects(payoutConsignmentToPlayer({ root, source: { kind: 'equipment', instance_id: 'nope' }, amount: 5000 }), /unknown_equipment_instance/);

  // equipped instance -> rejected before any write
  const root2 = await consignmentRoot({ money: 1000, equipmentInstances: [instance] });
  t.after(() => fs.rm(root2, { recursive: true, force: true }));
  const state = await readState(root2);
  await writeJson(root2, RUNTIME_STATE_MUTABLE, { ...state, equipment_slots: { weapon: instance.instance_id } });
  await assert.rejects(payoutConsignmentToPlayer({ root: root2, source: { kind: 'equipment', instance_id: instance.instance_id }, amount: 5000 }), /equipment_instance_equipped/);
  assert.equal((await readMutableInventory(root2)).money, 1000); // untouched
  assert.equal((await loadEquipmentSurface({ root: root2 })).instances.length, 1); // untouched
});

// ----- session: resolve (settle / 流札) with the payout writer -----

test('resolveConsignmentLot 流札 (winner null) leaves the asset with the player and records passed_in', async (t) => {
  const root = await consignmentRoot({ money: 1000, inventoryItems: [{ item_id: SELL_ITEM, quantity: 1 }] });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await seedSlot(root);
  await submitConsignment({ root, authoringRoot: root, source: { kind: 'item', item_id: SELL_ITEM } });

  const result = await resolveConsignmentLot({ root, authoringRoot: root, winner: null, amount: null });
  assert.equal(result.resolution.outcome, 'passed_in');
  assert.equal(result.payout, null);
  assert.equal((await readMutableInventory(root)).money, 1000); // unchanged
  assert.equal((await loadInventory({ root })).items.find((entry) => entry.item_id === SELL_ITEM).quantity, 1); // asset stays
  assert.equal(readConsignmentForWeek(await readState(root), WEEK).status, 'resolved');
});
