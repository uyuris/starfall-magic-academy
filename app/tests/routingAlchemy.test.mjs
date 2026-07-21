import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

import {
  buildAlchemyBookView,
  craftAlchemyRecipe,
  loadAlchemyDefinitions,
  validateAlchemyDefinitions
} from '../src/routingAlchemy.mjs';
import { loadInventory, sellShopItem } from '../src/economy.mjs';
import { minimalValidAlchemyDefinitions } from './alchemyFixtures.mjs';
import { writeDungeonMaterialsDefinition } from './dungeonMaterialsFixture.mjs';
import { writeAuctionCatalogDefinition } from './auctionCatalogFixture.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

async function writeJson(root, relativePath, value) {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(root, relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8'));
}

function baselineParameters() {
  const magic = ['light', 'dark', 'fire', 'water', 'earth', 'wind'];
  const abilities = ['strength', 'agility', 'academics', 'magical_power', 'charisma'];
  return {
    magic: Object.fromEntries(magic.map((key) => [key, { min: 0, max: 100, label: key, value: 10 }])),
    abilities: Object.fromEntries(abilities.map((key) => [key, { min: 0, max: 100, label: key, value: 10 }]))
  };
}

// A root carrying the canonical 56-entry alchemy catalog + the real 24-material dungeon catalog, so the
// loader, book view, and craft resolve real ids. `inventory` / `state` override the defaults.
async function alchemyRoot({ inventory = null, state = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magic-adv-alchemy-'));
  await writeJson(root, 'data/definitions/game_data/shop_catalog.json', { shop_name: '学院購買部', items: [] });
  await writeJson(root, 'data/definitions/game_data/gathering_points.json', { materials: [], points: [] });
  await writeJson(root, 'data/definitions/game_data/stage_flags.json', { flags: [] });
  await writeJson(root, 'data/definitions/game_data/world/settings.json', {
    academy_name: '星灯魔法学院',
    player_name: '主人公',
    world_description: '学院の基本設定。',
    world_condition_texts: []
  });
  await writeJson(root, 'data/definitions/game_data/alchemy_recipes.json', minimalValidAlchemyDefinitions());
  await writeDungeonMaterialsDefinition(root);
  await writeAuctionCatalogDefinition(root);
  await writeJson(root, 'data/seeds/game_data/runtime/player_parameters.json', baselineParameters());
  await writeJson(root, 'data/mutable/game_data/runtime_state.json', {
    version: 1,
    current_screen: 'academy-alchemy',
    elapsed_weeks: 3,
    global_flags: {},
    characters: {},
    ...state
  });
  await writeJson(root, 'data/mutable/game_data/player_inventory.json', inventory ?? {
    money: 20000,
    items: [
      { item_id: 'material_light_t1', quantity: 5 },
      { item_id: 'material_light_t2', quantity: 5 },
      { item_id: 'material_fire_t1', quantity: 5 },
      { item_id: 'material_earth_t2', quantity: 5 },
      { item_id: 'material_earth_t4', quantity: 3 }
    ]
  });
  return root;
}

test('authored alchemy definitions load as exactly the 56-entry standing recipe book', async () => {
  const definitions = await loadAlchemyDefinitions({ root: projectRoot });
  assert.equal(definitions.recipes.length, 56);
  assert.equal(definitions.items.length, 56);
  assert.equal(new Set(definitions.recipes.map((recipe) => recipe.recipe_id)).size, 56);
  assert.equal(new Set(definitions.items.map((item) => item.item_id)).size, 56);
  const categories = {};
  for (const item of definitions.items) categories[item.category] = (categories[item.category] ?? 0) + 1;
  assert.deepEqual(categories, { gift: 12, ally_boost: 11, self_boost: 12, dungeon_consumable: 17, product: 4 });
  // Every recipe produces a distinct catalog item (a bijection).
  const producedItems = new Set(definitions.recipes.map((recipe) => recipe.result_item));
  assert.equal(producedItems.size, 56);
  for (const item of definitions.items) assert.equal(producedItems.has(item.item_id), true);
});

test('alchemy definition validation fails fast on structural corruption', async () => {
  const root = await alchemyRoot();
  const base = minimalValidAlchemyDefinitions();

  const shortRecipes = structuredClone(base);
  shortRecipes.recipes = shortRecipes.recipes.slice(0, 55);
  await assert.rejects(() => validateAlchemyDefinitions(shortRecipes, { root }), /alchemy recipes must contain exactly 56 entries/);

  const shortItems = structuredClone(base);
  shortItems.items = shortItems.items.slice(0, 55);
  await assert.rejects(() => validateAlchemyDefinitions(shortItems, { root }), /alchemy items must contain exactly 56 entries/);

  const unknownMaterial = structuredClone(base);
  const fixedRecipe = unknownMaterial.recipes.find((recipe) => Array.isArray(recipe.material_costs));
  fixedRecipe.material_costs[0].item_id = 'material_bogus_t9';
  await assert.rejects(() => validateAlchemyDefinitions(unknownMaterial, { root }), /unknown alchemy material cost item_id: material_bogus_t9/);

  const badCategory = structuredClone(base);
  badCategory.items[0].category = 'trinket';
  await assert.rejects(() => validateAlchemyDefinitions(badCategory, { root }), /category must be one of/);

  const badChoiceTier = structuredClone(base);
  const choiceRecipe = badChoiceTier.recipes.find((recipe) => recipe.material_choice_cost);
  choiceRecipe.material_choice_cost.tier = 5;
  await assert.rejects(() => validateAlchemyDefinitions(badChoiceTier, { root }), /material_choice_cost\.tier must be one of/);

  const mixedCostModes = structuredClone(base);
  const fixed = mixedCostModes.recipes.find((recipe) => Array.isArray(recipe.material_costs));
  fixed.material_choice_cost = { tier: 1, quantity: 1 };
  await assert.rejects(() => validateAlchemyDefinitions(mixedCostModes, { root }), /must carry exactly one of material_costs or material_choice_cost/);

  const unresolvedResult = structuredClone(base);
  unresolvedResult.recipes[0].result_item = 'alchemy_does_not_exist';
  await assert.rejects(() => validateAlchemyDefinitions(unresolvedResult, { root }), /unknown alchemy result_item: alchemy_does_not_exist/);

  const badEffectMeta = structuredClone(base);
  const giftItem = badEffectMeta.items.find((item) => item.category === 'gift');
  delete giftItem.affinity_bonus;
  await assert.rejects(() => validateAlchemyDefinitions(badEffectMeta, { root }), /missing required key: affinity_bonus/);
});

test('economy inventory display fails fast when alchemy definitions are missing', async () => {
  const root = await alchemyRoot();
  await fs.rm(path.join(root, 'data/definitions/game_data/alchemy_recipes.json'));
  await assert.rejects(() => loadInventory({ root }), /alchemy definitions file is missing/);
});

test('buildAlchemyBookView returns the whole standing catalog priced against inventory', async () => {
  const root = await alchemyRoot();
  const book = await buildAlchemyBookView({ root });
  assert.equal(book.week, 3);
  assert.equal(book.recipes.length, 56);

  const gift = book.recipes.find((recipe) => recipe.recipe_id === 'alchemy_stardust_konpeito');
  assert.equal(gift.result.category, 'gift');
  assert.equal(gift.result.effect_summary, '好感度 +3');
  assert.deepEqual(gift.costs.items, [{ item_id: 'material_light_t1', display_name: '燐光の砂', required: 2, held: 5 }]);
  assert.equal(gift.costs.money.required, 0);
  assert.equal(gift.affordable, true);

  // The E-series choice cost exposes the six element materials at its tier as picker options.
  const product = book.recipes.find((recipe) => recipe.recipe_id === 'alchemy_stardust_trinket');
  assert.equal(product.result.category, 'product');
  assert.equal(product.costs.items, undefined);
  assert.equal(product.costs.choice.tier, 1);
  assert.equal(product.costs.choice.quantity, 4);
  assert.equal(product.costs.choice.options.length, 6);
  assert.equal(product.costs.choice.options.every((option) => /^material_[a-z]+_t1$/.test(option.item_id)), true);
  // fire_t1 held 5 >= 4 → affordable via a single element.
  assert.equal(product.affordable, true);

  const sage = book.recipes.find((recipe) => recipe.recipe_id === 'alchemy_sage_elixir');
  assert.equal(sage.costs.money.required, 10000);
});

test('craftAlchemyRecipe consumes a fixed cost, grants the item, and records the content result', async () => {
  const root = await alchemyRoot();
  const result = await craftAlchemyRecipe({
    root,
    recipe_id: 'alchemy_stardust_konpeito',
    now: '2026-07-09T00:00:00.000Z'
  });
  assert.equal(result.week, 3);
  assert.equal(result.crafted_item.item_id, 'alchemy_stardust_konpeito');
  assert.equal(result.crafted_item.quantity, 1);
  assert.deepEqual(result.consumed_costs.item_costs, [{ item_id: 'material_light_t1', quantity: 2 }]);
  assert.equal(result.content_result.kind, 'alchemy');
  assert.equal(result.content_result.detail.item_id, 'alchemy_stardust_konpeito');
  assert.equal(result.content_result.detail.category, 'gift');
  assert.equal(result.content_result.detail.quantity, 1);

  const inventory = await loadInventory({ root });
  assert.equal(inventory.items.find((item) => item.item_id === 'alchemy_stardust_konpeito')?.quantity, 1);
  assert.equal(inventory.items.find((item) => item.item_id === 'material_light_t1')?.quantity, 3);
});

test('craftAlchemyRecipe resolves an E-series single-element choice cost', async () => {
  const root = await alchemyRoot();
  const result = await craftAlchemyRecipe({
    root,
    recipe_id: 'alchemy_stardust_trinket',
    materials: [{ item_id: 'material_fire_t1', quantity: 4 }],
    now: '2026-07-09T00:00:00.000Z'
  });
  assert.deepEqual(result.consumed_costs.item_costs, [{ item_id: 'material_fire_t1', quantity: 4 }]);
  const inventory = await loadInventory({ root });
  assert.equal(inventory.items.find((item) => item.item_id === 'material_fire_t1')?.quantity, 1);
  assert.equal(inventory.items.find((item) => item.item_id === 'alchemy_stardust_trinket')?.quantity, 1);
});

test('craftAlchemyRecipe rejects malformed material choices before any consume', async () => {
  const root = await alchemyRoot();
  const before = await readJson(root, 'data/mutable/game_data/player_inventory.json');

  // Wrong tier for the choice.
  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_stardust_trinket', materials: [{ item_id: 'material_light_t2', quantity: 4 }], now: '2026-07-09T00:00:00.000Z' }),
    (error) => error.statusCode === 400 && error.errorCode === 'ALCHEMY_MATERIAL_CHOICE_INVALID'
  );
  // Two elements (not a single element) for the choice.
  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_stardust_trinket', materials: [{ item_id: 'material_light_t1', quantity: 2 }, { item_id: 'material_fire_t1', quantity: 2 }], now: '2026-07-09T00:00:00.000Z' }),
    /single element/
  );
  // Missing choice for a choice recipe.
  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_stardust_trinket', now: '2026-07-09T00:00:00.000Z' }),
    (error) => error.errorCode === 'ALCHEMY_MATERIAL_CHOICE_REQUIRED'
  );
  // A material choice supplied for a fixed recipe.
  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_stardust_konpeito', materials: [{ item_id: 'material_light_t1', quantity: 2 }], now: '2026-07-09T00:00:00.000Z' }),
    (error) => error.errorCode === 'ALCHEMY_MATERIAL_CHOICE_UNEXPECTED'
  );

  assert.deepEqual(await readJson(root, 'data/mutable/game_data/player_inventory.json'), before);
});

test('craftAlchemyRecipe fails fast on an unknown recipe and on insufficient costs, consuming nothing', async () => {
  const root = await alchemyRoot({ inventory: { money: 0, items: [] } });
  const before = await readJson(root, 'data/mutable/game_data/player_inventory.json');

  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_not_a_recipe', now: '2026-07-09T00:00:00.000Z' }),
    (error) => error.statusCode === 400 && error.errorCode === 'ALCHEMY_RECIPE_NOT_FOUND'
  );
  await assert.rejects(
    () => craftAlchemyRecipe({ root, recipe_id: 'alchemy_stardust_konpeito', now: '2026-07-09T00:00:00.000Z' }),
    /insufficient_/
  );

  assert.deepEqual(await readJson(root, 'data/mutable/game_data/player_inventory.json'), before);
});

test('craftAlchemyRecipe grants a product that inventory can display and shop selling can sell', async () => {
  const root = await alchemyRoot();
  const result = await craftAlchemyRecipe({
    root,
    recipe_id: 'alchemy_stardust_trinket',
    materials: [{ item_id: 'material_fire_t1', quantity: 4 }],
    now: '2026-07-09T00:00:00.000Z'
  });
  const inventory = await loadInventory({ root });
  const product = inventory.items.find((item) => item.item_id === 'alchemy_stardust_trinket');
  assert.equal(product.name, '星屑の細工玉');
  assert.equal(product.sell_price, 300);

  const sold = await sellShopItem({ root, itemId: 'alchemy_stardust_trinket', quantity: 1 });
  assert.equal(sold.inventory.money, result.inventory.money + 300);
  assert.equal(sold.inventory.items.some((item) => item.item_id === 'alchemy_stardust_trinket'), false);
});
