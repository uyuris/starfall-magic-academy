import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  loadShopCatalog,
  loadInventory,
  buyShopItem,
  useInventoryItem,
  loadGathering,
  collectGatheringPoint,
  sellShopItem,
  grantAllDungeonMaterials,
  DEBUG_DUNGEON_MATERIAL_GRANT_EACH
} from '../src/economy.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition, realDungeonMaterials } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function splitEconomyRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-economy-split-'));
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', {
    shop_name: '学院購買部',
    items: [
      {
        item_id: 'light_mastery_elixir',
        name: '光の霊薬',
        description: '使うと光魔法習熟度が1上がる。',
        buy_price: 10000,
        sell_price: 0,
        stat_effect: { group: 'magic', key: 'light', amount: 1 }
      }
    ]
  });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', {
    flags: [
      {
        id: 'stage.test.reward',
        label: '報酬テスト',
        location_id: 'front_gate_morning',
        condition: '報酬を受け取る。',
        question: '報酬を受け取ったか',
        reward_on_inventory_open: {
          item_id: 'ripple_clock_face',
          quantity: 1,
          name: '水面時計の銅針',
          description: 'テスト報酬。',
          sell_price: 3
        }
      }
    ]
  });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 12000,
    items: []
  });
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: {
      light: { min: 0, max: 100, label: '光魔法習熟度', value: 7 }
    },
    abilities: {
      strength: { min: 0, max: 100, label: '筋力', value: 4 }
    }
  });
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    global_flags: { 'stage.test.reward': true },
    characters: {}
  });
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  return root;
}

test('loadShopCatalog and loadInventory read split definitions/seeds without claiming stage rewards or mutating completion flags', async () => {
  const root = await splitEconomyRoot();

  const catalog = await loadShopCatalog({ root });
  const inventory = await loadInventory({ root });

  assert.equal(catalog.shop_name, '学院購買部');
  assert.equal(catalog.items[0].item_id, 'light_mastery_elixir');
  assert.equal(inventory.money, 12000);
  assert.equal(inventory.items.some((item) => item.item_id === 'ripple_clock_face'), false);

  const savedInventory = await readJson(root, 'data/seeds/game_data/player_inventory.json');
  const savedState = await readJson(root, 'data/mutable/game_data/runtime_state.json');
  assert.deepEqual(savedInventory.items, []);
  assert.equal(savedState.global_flags['stage.test.reward'], true);
});

test('buyShopItem and useInventoryItem write split mutable inventory and player parameters without reviving legacy game_data writes', async () => {
  const root = await splitEconomyRoot();

  await loadInventory({ root });
  const bought = await buyShopItem({ root, itemId: 'light_mastery_elixir', quantity: 1 });
  assert.equal(bought.inventory.money, 2000);
  assert.equal(bought.inventory.items.some((item) => item.item_id === 'ripple_clock_face'), false);

  const used = await useInventoryItem({ root, itemId: 'light_mastery_elixir' });
  assert.equal(used.effect.key, 'light');
  assert.equal(used.effect.before, 7);
  assert.equal(used.effect.after, 8);
  assert.equal(used.inventory.items.some((item) => item.item_id === 'light_mastery_elixir'), false);

  const mutableInventory = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  const mutableParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(mutableInventory.money, 2000);
  assert.equal(mutableInventory.items.some((item) => item.item_id === 'light_mastery_elixir'), false);
  assert.equal(mutableParameters.magic.light.value, 8);
  assert.equal(await pathExists(path.join(root, 'app/config/world/settings.json')), false, 'item-use stat updates should not create a desktop world override file');

  await assert.rejects(fs.access(path.join(root, 'game_data/player_inventory.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'game_data/runtime/player_parameters.json')), { code: 'ENOENT' });
});

test('useInventoryItem spends the requested quantity at once (全部使う) applying the aggregated effect and one decrement', async () => {
  const root = await splitEconomyRoot();
  // Seed several elixirs so 全部使う has more than one unit to spend in a single use.
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 12000,
    items: [{ item_id: 'light_mastery_elixir', quantity: 5 }]
  });

  // 全部使う passes the owned count as quantity: amount(1) × 5 is added once and the stack is decremented to 0.
  const usedAll = await useInventoryItem({ root, itemId: 'light_mastery_elixir', quantity: 5 });
  assert.equal(usedAll.effect.used_quantity, 5);
  assert.equal(usedAll.effect.before, 7);
  assert.equal(usedAll.effect.after, 12);
  assert.equal(usedAll.effect.amount, 5);
  assert.equal(usedAll.inventory.items.some((item) => item.item_id === 'light_mastery_elixir'), false);

  const mutableInventory = await readJson(root, 'data/mutable/game_data/player_inventory.json');
  const mutableParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(mutableInventory.items.some((item) => item.item_id === 'light_mastery_elixir'), false);
  assert.equal(mutableParameters.magic.light.value, 12);
});

test('useInventoryItem clamps the aggregated 全部使う effect to 100 and fail-fasts on over-use and invalid quantity', async () => {
  const root = await splitEconomyRoot();
  // A near-max parameter so the aggregated 全部使う effect would overshoot 100 without the shared clamp.
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: { light: { min: 0, max: 100, label: '光魔法習熟度', value: 98 } },
    abilities: { strength: { min: 0, max: 100, label: '筋力', value: 4 } }
  });
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 12000,
    items: [{ item_id: 'light_mastery_elixir', quantity: 10 }]
  });

  const used = await useInventoryItem({ root, itemId: 'light_mastery_elixir', quantity: 10 });
  assert.equal(used.effect.before, 98);
  assert.equal(used.effect.after, 100);
  assert.equal(used.effect.used_quantity, 10);
  assert.equal(used.inventory.items.some((item) => item.item_id === 'light_mastery_elixir'), false);
  const clampedParameters = await readJson(root, 'data/mutable/game_data/runtime/player_parameters.json');
  assert.equal(clampedParameters.magic.light.value, 100);

  // Over-use beyond the owned count fail-fasts before any write (no partial consume).
  const shortRoot = await splitEconomyRoot();
  await writeJson(shortRoot, 'data/seeds/game_data/player_inventory.json', {
    money: 12000,
    items: [{ item_id: 'light_mastery_elixir', quantity: 2 }]
  });
  await assert.rejects(useInventoryItem({ root: shortRoot, itemId: 'light_mastery_elixir', quantity: 3 }), /insufficient_item_quantity/);
  // Invalid quantities fail-fast through the shared normalizeQuantity contract (no silent 1-unit fallback).
  await assert.rejects(useInventoryItem({ root: shortRoot, itemId: 'light_mastery_elixir', quantity: 0 }), /quantity_must_be_positive_integer/);
  await assert.rejects(useInventoryItem({ root: shortRoot, itemId: 'light_mastery_elixir', quantity: 1.5 }), /quantity_must_be_positive_integer/);
  // The stack is untouched after the rejected uses.
  const untouched = await loadInventory({ root: shortRoot });
  assert.equal(untouched.items.find((item) => item.item_id === 'light_mastery_elixir')?.quantity, 2);
});

test('gathering and inventory decorations expose gathering images and material icons', async () => {
  const root = await splitEconomyRoot();
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', {
    materials: [
      {
        item_id: 'moonfern_tip',
        name: '月羊歯の先端',
        description: '月明かりを受けた羊歯の若い先端。',
        buy_price: 0,
        sell_price: 14,
        icon: '/canonical/gathering/material-icons/moonfern_tip.png'
      }
    ],
    points: [
      {
        point_id: 'moonfern_patch',
        location_id: 'sanrin_trailhead',
        display_name: '月羊歯の茂み',
        description: '木陰に月羊歯がまとまっている。',
        image: '/canonical/gathering/points/moonfern_patch.png',
        stock_max: 2,
        material: {
          item_id: 'moonfern_tip',
          quantity: 1
        }
      }
    ]
  });

  const gathering = await loadGathering({ root });
  assert.equal(gathering.points[0].image, '/canonical/gathering/points/moonfern_patch.png');
  assert.equal(gathering.points[0].material.icon, '/canonical/gathering/material-icons/moonfern_tip.png');

  const collected = await collectGatheringPoint({ root, pointId: 'moonfern_patch' });
  assert.equal(collected.point.image, '/canonical/gathering/points/moonfern_patch.png');
  assert.equal(collected.point.material.icon, '/canonical/gathering/material-icons/moonfern_tip.png');
  assert.equal(collected.inventory.items[0].icon, '/canonical/gathering/material-icons/moonfern_tip.png');

  const inventory = await loadInventory({ root });
  assert.equal(inventory.items[0].icon, '/canonical/gathering/material-icons/moonfern_tip.png');

  const sold = await sellShopItem({ root, itemId: 'moonfern_tip', quantity: 1 });
  assert.equal(sold.item.icon, '/canonical/gathering/material-icons/moonfern_tip.png');
});

// Seeds a split-layout root that already owns one dungeon material, one gathering
// material, and one alchemy product, so buy/use response enrich can be compared
// against loadInventory's own decoration of the same items.
async function enrichEconomyRoot() {
  const root = await splitEconomyRoot();
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', {
    materials: [
      {
        item_id: 'moonfern_tip',
        name: '月羊歯の先端',
        description: '月夜に淡く光る羊歯の先端。',
        buy_price: 0,
        sell_price: 14,
        icon: '/canonical/gathering/material-icons/moonfern_tip.png'
      }
    ],
    points: []
  });
  // The canonical alchemy catalog (written by splitEconomyRoot) is a crafted-item catalog; a product
  // item (換金品) rides the same non-shop enrichment set as dungeon/gathering materials.
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 20000,
    items: [
      { item_id: 'material_dark_t1', quantity: 2 },
      { item_id: 'moonfern_tip', quantity: 3 },
      { item_id: 'alchemy_stardust_trinket', quantity: 1 }
    ]
  });
  return root;
}

test('buyShopItem response enriches dungeon/gathering/alchemy items identically to loadInventory (no raw id fallback)', async () => {
  const root = await enrichEconomyRoot();
  const canonical = await loadInventory({ root });
  const canonicalOf = (itemId) => canonical.items.find((item) => item.item_id === itemId);

  const bought = await buyShopItem({ root, itemId: 'light_mastery_elixir', quantity: 1 });
  const boughtOf = (itemId) => bought.inventory.items.find((item) => item.item_id === itemId);

  // Buying does not change the material quantities, so each non-shop item's decorated
  // entry must be byte-for-byte what loadInventory returns for it.
  for (const itemId of ['material_dark_t1', 'moonfern_tip', 'alchemy_stardust_trinket']) {
    assert.deepEqual(boughtOf(itemId), canonicalOf(itemId));
  }

  const dark = boughtOf('material_dark_t1');
  assert.equal(dark.name, '宵闇の煤');
  assert.notEqual(dark.name, 'material_dark_t1');
  assert.equal(dark.element, 'dark');
  assert.equal(dark.tier, 1);
  assert.equal(boughtOf('moonfern_tip').name, '月羊歯の先端');
  assert.equal(boughtOf('moonfern_tip').sell_price, 14);
  assert.equal(boughtOf('alchemy_stardust_trinket').name, '星屑の細工玉');
  assert.equal(boughtOf('alchemy_stardust_trinket').sell_price, 300);
});

test('useInventoryItem response enriches dungeon/gathering/alchemy items identically to loadInventory (no raw id fallback)', async () => {
  const root = await enrichEconomyRoot();
  const canonical = await loadInventory({ root });
  const canonicalOf = (itemId) => canonical.items.find((item) => item.item_id === itemId);

  // Acquire a usable elixir, then use it; the use response is the redrawn inventory.
  await buyShopItem({ root, itemId: 'light_mastery_elixir', quantity: 1 });
  const used = await useInventoryItem({ root, itemId: 'light_mastery_elixir', quantity: 1 });
  const usedOf = (itemId) => used.inventory.items.find((item) => item.item_id === itemId);

  for (const itemId of ['material_dark_t1', 'moonfern_tip', 'alchemy_stardust_trinket']) {
    assert.deepEqual(usedOf(itemId), canonicalOf(itemId));
  }

  const dark = usedOf('material_dark_t1');
  assert.equal(dark.name, '宵闇の煤');
  assert.notEqual(dark.name, 'material_dark_t1');
  assert.equal(dark.element, 'dark');
  assert.equal(dark.tier, 1);
  assert.equal(usedOf('moonfern_tip').name, '月羊歯の先端');
  assert.equal(usedOf('alchemy_stardust_trinket').name, '星屑の細工玉');
});

// A root with the canonical alchemy catalog, full hero parameters, and an inventory of one item per
// alchemy category, for exercising the inventory use path against alchemy items.
async function alchemyUseRoot() {
  const root = await splitEconomyRoot();
  const magic = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
  const abilities = ['strength', 'agility', 'academics', 'magical_power', 'charisma'];
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', {
    magic: Object.fromEntries(magic.map((key) => [key, { min: 0, max: 100, label: key, value: 20 }])),
    abilities: Object.fromEntries(abilities.map((key) => [key, { min: 0, max: 100, label: key, value: 20 }]))
  });
  await writeJson(root, 'data/seeds/game_data/player_inventory.json', {
    money: 0,
    items: [
      { item_id: 'alchemy_light_secret_elixir', quantity: 1 },
      { item_id: 'alchemy_sage_elixir', quantity: 1 },
      { item_id: 'alchemy_stardust_konpeito', quantity: 1 },
      { item_id: 'alchemy_light_throwing_bomb', quantity: 1 },
      { item_id: 'auction_item_04', quantity: 1 }, // 六色の秘薬・原典: auction self_boost, all 5 abilities +3
      { item_id: 'auction_item_01', quantity: 1 }  // 星降りの夜の蒸留酒: auction gift (not usable through use path)
    ]
  });
  return root;
}

test('useInventoryItem applies an alchemy self_boost item to the hero (single- and multi-target)', async () => {
  const root = await alchemyUseRoot();

  const single = await useInventoryItem({ root, itemId: 'alchemy_light_secret_elixir', quantity: 1 });
  assert.equal(single.item.item_id, 'alchemy_light_secret_elixir');
  assert.deepEqual(single.effects, [{ group: 'magic', key: 'light', label: '光魔法習熟度', amount: 4, before: 20, after: 24 }]);
  assert.equal(single.used_quantity, 1);
  assert.equal(single.world.player_parameters.magic.light.value, 24);
  assert.equal(single.inventory.items.some((item) => item.item_id === 'alchemy_light_secret_elixir'), false);

  // 賢者の霊薬 raises all five abilities in one use.
  const multi = await useInventoryItem({ root, itemId: 'alchemy_sage_elixir', quantity: 1 });
  assert.equal(multi.effects.length, 5);
  assert.equal(multi.effects.every((effect) => effect.group === 'abilities' && effect.amount === 2 && effect.after === 22), true);
  assert.equal(multi.world.player_parameters.abilities.charisma.value, 22);
});

test('useInventoryItem applies an auction self_boost item through the same merged path (catalog parameter_effects)', async () => {
  const root = await alchemyUseRoot();
  // 六色の秘薬・原典: catalog self_boost raising all five abilities by +3 (seed value 20 → 23).
  const used = await useInventoryItem({ root, itemId: 'auction_item_04', quantity: 1 });
  assert.equal(used.item.item_id, 'auction_item_04');
  assert.equal(used.effects.length, 5);
  assert.equal(used.effects.every((effect) => effect.group === 'abilities' && effect.amount === 3 && effect.before === 20 && effect.after === 23), true);
  assert.equal(used.world.player_parameters.abilities.strength.value, 23);
  assert.equal(used.inventory.items.some((item) => item.item_id === 'auction_item_04'), false, 'the one unit was consumed');
});

test('useInventoryItem rejects non-self_boost items (incl. an auction gift) and unknown items instead of a silent no-op', async () => {
  const root = await alchemyUseRoot();
  // A gift and a dungeon consumable are known items but not usable through the inventory use path.
  await assert.rejects(() => useInventoryItem({ root, itemId: 'alchemy_stardust_konpeito', quantity: 1 }), /item_is_not_usable/);
  await assert.rejects(() => useInventoryItem({ root, itemId: 'alchemy_light_throwing_bomb', quantity: 1 }), /item_is_not_usable/);
  // An auction gift is delivered in conversation, not used — not usable here.
  await assert.rejects(() => useInventoryItem({ root, itemId: 'auction_item_01', quantity: 1 }), /item_is_not_usable/);
  // A genuinely unknown id is distinguished from a known-but-not-usable one.
  await assert.rejects(() => useInventoryItem({ root, itemId: 'not_a_real_item', quantity: 1 }), /unknown_inventory_item/);
  // Nothing was consumed.
  const inventory = await loadInventory({ root });
  assert.equal(inventory.items.find((item) => item.item_id === 'alchemy_stardust_konpeito')?.quantity, 1);
  assert.equal(inventory.items.find((item) => item.item_id === 'alchemy_light_throwing_bomb')?.quantity, 1);
});

test('grantAllDungeonMaterials grants +10 of every catalog material and stacks additively on repeat', async () => {
  const root = await splitEconomyRoot();
  await loadInventory({ root });

  // A pre-existing non-material item is left untouched by the material grant.
  const bought = await buyShopItem({ root, itemId: 'light_mastery_elixir', quantity: 1 });
  const moneyAfterBuy = bought.inventory.money;

  const materialIds = (await realDungeonMaterials()).materials.map((material) => material.item_id);
  assert.equal(materialIds.length, 24);

  const first = await grantAllDungeonMaterials({ root });
  assert.equal(first.grant_each, DEBUG_DUNGEON_MATERIAL_GRANT_EACH);
  assert.equal(first.deposited_materials.length, 24);
  assert.equal(first.deposited_materials.every((grant) => grant.quantity === 10), true);
  for (const itemId of materialIds) {
    assert.equal(first.inventory.items.find((item) => item.item_id === itemId)?.quantity, 10);
  }
  // Money and the pre-existing elixir are not touched by a material grant.
  assert.equal(first.inventory.money, moneyAfterBuy);
  assert.equal(first.inventory.items.some((item) => item.item_id === 'light_mastery_elixir'), true);

  // A second grant is additive: owned materials are never reduced.
  const second = await grantAllDungeonMaterials({ root });
  for (const itemId of materialIds) {
    assert.equal(second.inventory.items.find((item) => item.item_id === itemId)?.quantity, 20);
  }

  const persisted = await loadInventory({ root });
  for (const itemId of materialIds) {
    assert.equal(persisted.items.find((item) => item.item_id === itemId)?.quantity, 20);
  }
});

test('grantAllDungeonMaterials fails fast when the material catalog is missing and leaves inventory unchanged', async () => {
  const root = await splitEconomyRoot();
  await loadInventory({ root });
  await fs.rm(path.join(root, 'data/definitions/game_data/dungeon_materials.json'));

  await assert.rejects(() => grantAllDungeonMaterials({ root }), /dungeon materials file is missing/);

  // Restore the catalog only to read inventory back: the failed grant must have written nothing.
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  const inventory = await loadInventory({ root });
  assert.equal(inventory.items.some((item) => item.item_id.startsWith('material_')), false);
});
