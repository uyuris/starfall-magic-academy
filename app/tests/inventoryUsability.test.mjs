import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  isInventoryItemUsable,
  inventoryItemGiftCategory,
  annotateInventoryItemActions,
  loadInventoryItemActionSources
} from '../src/server/inventoryUsability.mjs';
import { loadInventory, useInventoryItem, grantInventoryRewards } from '../src/economy.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

// Authored auction treasure effect items (real catalog): a gift and a self_boost.
const AUCTION_GIFT = 'auction_item_01';
const AUCTION_SELF_BOOST = 'auction_item_04';

async function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), 'utf8');
}

// A representative item of every category the usability rule must classify. The alchemy ids are drawn from the
// canonical catalog (one per category); the shop id is a stat 霊薬; the material is a real dungeon material.
const SHOP_STAT_ITEM = 'light_mastery_elixir';
const ALCHEMY_SELF_BOOST = 'alchemy_light_secret_elixir';
const ALCHEMY_GIFT = 'alchemy_stardust_konpeito';
const ALCHEMY_ALLY_BOOST = 'alchemy_light_resonance_tonic';
const ALCHEMY_DUNGEON_CONSUMABLE = 'alchemy_light_throwing_bomb';
const ALCHEMY_PRODUCT = 'alchemy_stardust_trinket';
const DUNGEON_MATERIAL = 'material_light_t1';

async function usabilityRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-usability-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', {
    shop_name: '学院購買部',
    items: [
      {
        item_id: SHOP_STAT_ITEM,
        name: '光の霊薬',
        description: '使うと光魔法習熟度が1上がる。',
        buy_price: 10000,
        sell_price: 0,
        stat_effect: { group: 'magic', key: 'light', amount: 1 }
      }
    ]
  });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 12000,
    items: [
      { item_id: SHOP_STAT_ITEM, quantity: 1 },
      { item_id: ALCHEMY_SELF_BOOST, quantity: 1 },
      { item_id: ALCHEMY_GIFT, quantity: 1 },
      { item_id: ALCHEMY_ALLY_BOOST, quantity: 1 },
      { item_id: ALCHEMY_DUNGEON_CONSUMABLE, quantity: 1 },
      { item_id: ALCHEMY_PRODUCT, quantity: 1 },
      { item_id: DUNGEON_MATERIAL, quantity: 1 }
    ]
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: {
      light: { min: 0, max: 100, label: '光魔法習熟度', value: 7 }
    },
    abilities: {
      strength: { min: 0, max: 100, label: '筋力', value: 4 }
    }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', { version: 1, global_flags: {}, characters: {} });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  return root;
}

// The backend write path's verdict for an item id: usable iff POST /api/inventory/use would NOT reject it as a
// non-usable / unknown item. Another failure (insufficient / missing player parameter) still means the category
// itself is usable, so only item_is_not_usable / unknown_inventory_item count as "not usable".
async function usableByWritePath(root, itemId) {
  try {
    await useInventoryItem({ root, itemId, quantity: 1 });
    return true;
  } catch (error) {
    if (/item_is_not_usable|unknown_inventory_item/.test(error.message)) return false;
    return true;
  }
}

test('isInventoryItemUsable classifies each category (shop stat ∪ merged self_boost are usable, the rest are not)', () => {
  const sources = {
    shopCatalog: { items: [{ item_id: SHOP_STAT_ITEM, stat_effect: { group: 'magic', key: 'light', amount: 1 } }, { item_id: 'plain_shop_item', sell_price: 5 }] },
    selfBoostItemIds: new Set([ALCHEMY_SELF_BOOST, AUCTION_SELF_BOOST])
  };
  assert.equal(isInventoryItemUsable(SHOP_STAT_ITEM, sources), true, 'a 購買 stat 霊薬 is usable');
  assert.equal(isInventoryItemUsable(ALCHEMY_SELF_BOOST, sources), true, 'an alchemy self_boost is usable');
  assert.equal(isInventoryItemUsable(AUCTION_SELF_BOOST, sources), true, 'an auction self_boost is usable');
  assert.equal(isInventoryItemUsable(ALCHEMY_GIFT, sources), false, 'a gift is not usable (会話中の贈与のみ)');
  assert.equal(isInventoryItemUsable(ALCHEMY_ALLY_BOOST, sources), false, 'an ally_boost is not usable (贈与のみ)');
  assert.equal(isInventoryItemUsable(ALCHEMY_DUNGEON_CONSUMABLE, sources), false, 'a dungeon_consumable is not usable outside the dungeon');
  assert.equal(isInventoryItemUsable(ALCHEMY_PRODUCT, sources), false, 'a product is not usable');
  assert.equal(isInventoryItemUsable('plain_shop_item', sources), false, 'a shop item without a stat_effect is not usable');
  assert.equal(isInventoryItemUsable('totally_unknown_id', sources), false, 'an unknown id is not usable');
});

test('inventoryItemGiftCategory returns the deliverable category or null', () => {
  const sources = { giftCategoryById: new Map([[ALCHEMY_GIFT, 'gift'], [ALCHEMY_ALLY_BOOST, 'ally_boost'], [AUCTION_GIFT, 'gift']]) };
  assert.equal(inventoryItemGiftCategory(ALCHEMY_GIFT, sources), 'gift');
  assert.equal(inventoryItemGiftCategory(ALCHEMY_ALLY_BOOST, sources), 'ally_boost');
  assert.equal(inventoryItemGiftCategory(AUCTION_GIFT, sources), 'gift', 'an auction gift is deliverable');
  assert.equal(inventoryItemGiftCategory(ALCHEMY_SELF_BOOST, sources), null, 'a self_boost is not a deliverable gift');
  assert.equal(inventoryItemGiftCategory('totally_unknown_id', sources), null);
});

test('the action predicates fail fast on malformed sources (no silent false/null)', () => {
  assert.throws(() => isInventoryItemUsable('x', { shopCatalog: {}, selfBoostItemIds: new Set() }), /shopCatalog with an items array/);
  assert.throws(() => isInventoryItemUsable('x', { shopCatalog: { items: [] }, selfBoostItemIds: [] }), /selfBoostItemIds set/);
  assert.throws(() => inventoryItemGiftCategory('x', { giftCategoryById: {} }), /giftCategoryById map/);
});

test('annotateInventoryItemActions adds additive usable + gift_category to every item without touching other fields', () => {
  const sources = {
    shopCatalog: { items: [{ item_id: SHOP_STAT_ITEM, stat_effect: { group: 'magic', key: 'light', amount: 1 } }] },
    selfBoostItemIds: new Set([ALCHEMY_SELF_BOOST]),
    giftCategoryById: new Map([[ALCHEMY_GIFT, 'gift']])
  };
  const inventory = { money: 500, items: [
    { item_id: SHOP_STAT_ITEM, name: '光の霊薬', description: 'd', quantity: 2, sell_price: 0, stat_effect: { group: 'magic', key: 'light', amount: 1 } },
    { item_id: ALCHEMY_GIFT, name: '金平糖', description: 'g', quantity: 3, sell_price: 0 }
  ] };
  const annotated = annotateInventoryItemActions(inventory, sources);
  assert.equal(annotated.money, 500, 'money is preserved');
  assert.equal(annotated.items[0].usable, true);
  assert.equal(annotated.items[0].gift_category, null, 'a shop stat 霊薬 is not a gift');
  assert.equal(annotated.items[1].usable, false);
  assert.equal(annotated.items[1].gift_category, 'gift');
  // every original field survives untouched (additive)
  assert.equal(annotated.items[0].name, '光の霊薬');
  assert.deepEqual(annotated.items[0].stat_effect, { group: 'magic', key: 'light', amount: 1 });
  assert.equal(annotated.items[1].quantity, 3);
  assert.throws(() => annotateInventoryItemActions({ money: 0 }, sources), /items array/);
});

test('the server usable flag matches the backend write path (POST /api/inventory/use) for every category — no drift', async () => {
  const root = await usabilityRoot();
  const sources = await loadInventoryItemActionSources({ root });
  for (const itemId of [SHOP_STAT_ITEM, ALCHEMY_SELF_BOOST, AUCTION_SELF_BOOST, AUCTION_GIFT, ALCHEMY_GIFT, ALCHEMY_ALLY_BOOST, ALCHEMY_DUNGEON_CONSUMABLE, ALCHEMY_PRODUCT, DUNGEON_MATERIAL, 'totally_unknown_id']) {
    // Fresh root per item so a successful use does not deplete the shared inventory before the next check. The
    // auction items are not in the seeded inventory, so grant one first (the write path checks the category, then
    // the quantity — an un-owned usable category would surface as insufficient, not as not-usable).
    const perItemRoot = await usabilityRoot();
    if (itemId === AUCTION_SELF_BOOST || itemId === AUCTION_GIFT) {
      await grantInventoryRewards({ root: perItemRoot, rewards: [{ item_id: itemId, quantity: 1 }] });
    }
    const byPredicate = isInventoryItemUsable(itemId, sources);
    const byWritePath = await usableByWritePath(perItemRoot, itemId);
    assert.equal(byPredicate, byWritePath, `usable flag must match the write path for ${itemId} (predicate=${byPredicate}, write-path=${byWritePath})`);
  }
  assert.equal(isInventoryItemUsable(SHOP_STAT_ITEM, sources), true);
  assert.equal(isInventoryItemUsable(ALCHEMY_SELF_BOOST, sources), true);
  assert.equal(isInventoryItemUsable(AUCTION_SELF_BOOST, sources), true);
  assert.equal(isInventoryItemUsable(AUCTION_GIFT, sources), false, 'an auction gift is delivered, not used');
  assert.equal(isInventoryItemUsable(DUNGEON_MATERIAL, sources), false);
});

test('annotateInventoryItemActions over the real loadInventory output marks self_boost usable, gift deliverable', async () => {
  const root = await usabilityRoot();
  // Grant one auction gift + one auction self_boost so the annotated inventory covers the auction rows too.
  await grantInventoryRewards({ root, rewards: [{ item_id: AUCTION_GIFT, quantity: 1 }, { item_id: AUCTION_SELF_BOOST, quantity: 1 }] });
  const [inventory, sources] = await Promise.all([loadInventory({ root }), loadInventoryItemActionSources({ root })]);
  const annotated = annotateInventoryItemActions(inventory, sources);
  for (const item of annotated.items) {
    assert.equal(typeof item.usable, 'boolean', `every item carries a boolean usable (${item.item_id})`);
    assert.ok(item.gift_category === null || item.gift_category === 'gift' || item.gift_category === 'ally_boost',
      `every item carries a gift_category of gift|ally_boost|null (${item.item_id})`);
  }
  const usableIds = annotated.items.filter((item) => item.usable).map((item) => item.item_id).sort();
  assert.deepEqual(usableIds, [ALCHEMY_SELF_BOOST, AUCTION_SELF_BOOST, SHOP_STAT_ITEM].sort(),
    'the shop stat 霊薬 and both self_boost items (alchemy + auction) are usable');
  const byId = new Map(annotated.items.map((item) => [item.item_id, item]));
  assert.equal(byId.get(ALCHEMY_GIFT).gift_category, 'gift');
  assert.equal(byId.get(ALCHEMY_ALLY_BOOST).gift_category, 'ally_boost');
  assert.equal(byId.get(AUCTION_GIFT).gift_category, 'gift', 'the auction gift is deliverable in the drawer');
  assert.equal(byId.get(AUCTION_SELF_BOOST).gift_category, null, 'an auction self_boost is not a deliverable gift');
});
