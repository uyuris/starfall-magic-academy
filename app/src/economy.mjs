import { createStorageApi } from './storage.mjs';
import { loadStageFlags } from './stageFlags.mjs';
import { abilityParameterDefinitions, magicParameterDefinitions } from './parameters.mjs';
import { loadWorldSettings, updatePlayerParameters } from './worldSettings.mjs';
import { loadAlchemyDefinitions } from './alchemyDefinitions.mjs';
import { loadDungeonMaterialDefinitions } from './dungeonMaterialCatalog.mjs';
import { loadAuctionInventoryItems } from './routingAuction.mjs';
import { loadSelfBoostDefinitions } from './auctionEffectItems.mjs';

const inventoryPath = 'game_data/player_inventory.json';
const catalogPath = 'game_data/shop_catalog.json';
const gatheringDefinitionsPath = 'game_data/gathering_points.json';
const gatheringStockPath = 'game_data/gathering_stock.json';

const statItemPrice = 10000;

const statItemDefinitions = [
  ...magicParameterDefinitions.map(({ key, label }) => ({
    item_id: `${key}_mastery_elixir`,
    name: `${label.replace('習熟度', '')}の霊薬`,
    description: `使うと${label}が1上がる。`,
    buy_price: statItemPrice,
    sell_price: 0,
    stat_effect: { group: 'magic', key, amount: 1 }
  })),
  ...abilityParameterDefinitions.map(({ key, label }) => ({
    item_id: `${key}_tonic`,
    name: `${label}の霊薬`,
    description: `使うと${label}が1上がる。`,
    buy_price: statItemPrice,
    sell_price: 0,
    stat_effect: { group: 'abilities', key, amount: 1 }
  }))
];

const fallbackCatalog = {
  shop_name: '学院購買部',
  items: statItemDefinitions
};

const fallbackInventory = {
  money: 150,
  items: [],
  applied_money_delta_conversation_ids: []
};

const specialRewardItems = [
  {
    item_id: 'fairy_doll',
    name: '妖精さんの人形',
    description: '禁書庫の静かなティータイムのあと、鞄に紛れていた小さな妖精の人形。淡い茶葉の香りがする。',
    buy_price: 0,
    sell_price: 0
  },
  {
    item_id: 'necromancy_book',
    name: '死霊術の本',
    description: '禁書庫で見つけた、死霊術について記された古い本。表紙は冷たく、開くと乾いた紙と封蝋の匂いがする。',
    buy_price: 0,
    sell_price: 0
  },
  {
    item_id: 'margin_starmap_bookmark',
    name: '余白星図の栞',
    description: '禁書庫の白紙本から抜け落ちた薄い栞。何も書かれていないはずの余白に、見るたび違う小さな星座が瞬いている。',
    buy_price: 0,
    sell_price: 0
  }
];

function storageApiFor(rootOrStorage) {
  if (rootOrStorage && typeof rootOrStorage.readJson === 'function' && typeof rootOrStorage.writeJson === 'function') {
    return rootOrStorage;
  }
  return createStorageApi({ root: rootOrStorage });
}

async function readJsonIfExists(rootOrStorage, relativePath, fallback) {
  const storage = storageApiFor(rootOrStorage);
  const value = await storage.readJsonIfExists(relativePath);
  return value == null ? structuredClone(fallback) : value;
}

async function readJson(rootOrStorage, relativePath) {
  const storage = storageApiFor(rootOrStorage);
  return await storage.readJson(relativePath);
}

async function writeJson(rootOrStorage, relativePath, value) {
  const storage = storageApiFor(rootOrStorage);
  await storage.writeJson(relativePath, value);
}

function normalizeQuantity(quantity) {
  const value = Number(quantity ?? 1);
  if (!Number.isInteger(value) || value <= 0) throw new Error('quantity_must_be_positive_integer');
  return value;
}

function normalizeInventory(inventory) {
  const appliedMoneyDeltaConversationIds = Array.isArray(inventory?.applied_money_delta_conversation_ids)
    ? [...new Set(inventory.applied_money_delta_conversation_ids
      .map((conversationId) => String(conversationId ?? '').trim())
      .filter(Boolean))].sort()
    : [];
  return {
    money: Math.max(0, Math.floor(Number(inventory?.money ?? 0))),
    items: (inventory?.items ?? [])
      .map((item) => ({ item_id: item.item_id, quantity: Math.max(0, Math.floor(Number(item.quantity ?? 0))) }))
      .filter((item) => item.item_id && item.quantity > 0),
    applied_money_delta_conversation_ids: appliedMoneyDeltaConversationIds
  };
}

function findCatalogItem(catalog, itemId) {
  const item = (catalog.items ?? []).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new Error('unknown_shop_item');
  return item;
}

function sellableItemDefinitions(catalog, stageRewardItems = []) {
  return [...(catalog.items ?? []), ...specialRewardItems, ...stageRewardItems];
}

function findSellableItem(catalog, stageRewardItems, itemId) {
  const item = sellableItemDefinitions(catalog, stageRewardItems).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new Error('unknown_inventory_item');
  return item;
}

function itemQuantity(inventory, itemId) {
  return inventory.items.find((item) => item.item_id === itemId)?.quantity ?? 0;
}

function setItemQuantity(inventory, itemId, quantity) {
  const nextItems = inventory.items.filter((item) => item.item_id !== itemId);
  if (quantity > 0) nextItems.push({ item_id: itemId, quantity });
  nextItems.sort((a, b) => a.item_id.localeCompare(b.item_id));
  return { ...inventory, items: nextItems };
}

function stageRewardCatalogItems(definitions) {
  return (definitions.flags ?? [])
    .map((flag) => flag.reward_on_inventory_open)
    .filter((reward) => reward?.item_id)
    .map((reward) => ({
      item_id: reward.item_id,
      name: reward.name ?? reward.item_id,
      description: reward.description ?? '',
      buy_price: 0,
      sell_price: Math.max(0, Math.floor(Number(reward.sell_price ?? 0)))
    }));
}

// Every crafted alchemy item participates in the economy's display/sell/known-item set. Only products
// carry a positive sell price; gifts, ally/self boosts, and dungeon consumables sell for 0 (they are
// functional items, not 換金品), matching the existing sell_price-0 reward-item pattern.
async function loadAlchemyItems({ root }) {
  const definitions = await loadAlchemyDefinitions({ root });
  return definitions.items.map((item) => ({
    item_id: item.item_id,
    name: item.name,
    description: item.description,
    buy_price: 0,
    sell_price: item.category === 'product' ? item.sell_price : 0
  }));
}

function requiredString(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${fieldName}_required`);
  return normalized;
}

function positiveInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error(`${fieldName}_must_be_positive_integer`);
  return normalized;
}

function nonNegativeInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) throw new Error(`${fieldName}_must_be_non_negative_integer`);
  return normalized;
}

function normalizeGatheringDefinitions(rawDefinitions) {
  const materials = (rawDefinitions.materials ?? []).map((material) => ({
    item_id: requiredString(material.item_id, 'material_item_id'),
    name: requiredString(material.name ?? material.item_id, 'material_name'),
    description: String(material.description ?? ''),
    buy_price: nonNegativeInteger(material.buy_price ?? 0, 'material_buy_price'),
    sell_price: nonNegativeInteger(material.sell_price ?? 0, 'material_sell_price'),
    icon: requiredString(material.icon, 'material_icon')
  }));
  const materialIds = new Set();
  for (const material of materials) {
    if (materialIds.has(material.item_id)) throw new Error(`duplicate_material_item_id: ${material.item_id}`);
    materialIds.add(material.item_id);
  }

  const points = (rawDefinitions.points ?? []).map((point) => {
    const material = point.material ?? {};
    const itemId = requiredString(material.item_id, 'gathering_material_item_id');
    if (!materialIds.has(itemId)) throw new Error(`unknown_gathering_material: ${itemId}`);
    return {
      point_id: requiredString(point.point_id, 'gathering_point_id'),
      location_id: requiredString(point.location_id, 'gathering_location_id'),
      display_name: requiredString(point.display_name ?? point.point_id, 'gathering_display_name'),
      description: String(point.description ?? ''),
      image: requiredString(point.image, 'gathering_image'),
      stock_max: positiveInteger(point.stock_max, 'gathering_stock_max'),
      material: {
        item_id: itemId,
        quantity: positiveInteger(material.quantity ?? 1, 'gathering_material_quantity')
      }
    };
  });
  const pointIds = new Set();
  for (const point of points) {
    if (pointIds.has(point.point_id)) throw new Error(`duplicate_gathering_point_id: ${point.point_id}`);
    pointIds.add(point.point_id);
  }
  return { materials, points };
}

function gatheringMaterialsById(definitions) {
  return new Map(definitions.materials.map((material) => [material.item_id, material]));
}

function fullGatheringStock(definitions) {
  return {
    version: 1,
    stocks: Object.fromEntries(definitions.points.map((point) => [point.point_id, point.stock_max]))
  };
}

function normalizeGatheringStock(rawStock, definitions) {
  if (rawStock == null) return fullGatheringStock(definitions);
  if (rawStock.version !== 1) throw new Error('invalid_gathering_stock_version');
  if (!rawStock.stocks || Array.isArray(rawStock.stocks) || typeof rawStock.stocks !== 'object') {
    throw new Error('invalid_gathering_stock_shape');
  }
  const expectedPointIds = new Set(definitions.points.map((point) => point.point_id));
  const stockPointIds = Object.keys(rawStock.stocks);
  const unknownPointId = stockPointIds.find((pointId) => !expectedPointIds.has(pointId));
  if (unknownPointId) throw new Error(`unknown_gathering_stock_point: ${unknownPointId}`);

  const stocks = {};
  for (const point of definitions.points) {
    if (!Object.prototype.hasOwnProperty.call(rawStock.stocks, point.point_id)) {
      throw new Error(`missing_gathering_stock_point: ${point.point_id}`);
    }
    const remaining = nonNegativeInteger(rawStock.stocks[point.point_id], 'gathering_stock_remaining');
    if (remaining > point.stock_max) throw new Error(`gathering_stock_exceeds_max: ${point.point_id}`);
    stocks[point.point_id] = remaining;
  }
  return { version: 1, stocks };
}

function decorateGatheringPoint(point, stock, materialById) {
  const material = materialById.get(point.material.item_id);
  if (!material) throw new Error(`unknown_gathering_material: ${point.material.item_id}`);
  return {
    point_id: point.point_id,
    location_id: point.location_id,
    display_name: point.display_name,
    description: point.description,
    image: point.image,
    material: {
      ...material,
      quantity: point.material.quantity
    },
    stock: {
      remaining: stock.stocks[point.point_id],
      max: point.stock_max
    }
  };
}

function decorateGathering(definitions, stock) {
  const materialById = gatheringMaterialsById(definitions);
  return {
    points: definitions.points.map((point) => decorateGatheringPoint(point, stock, materialById))
  };
}

function decorateInventory(inventory, catalog, stageRewardItems = []) {
  const itemDefinitions = sellableItemDefinitions(catalog, stageRewardItems);
  return {
    money: inventory.money,
    items: inventory.items.map((owned) => {
      const catalogItem = itemDefinitions.find((item) => item.item_id === owned.item_id);
      return {
        item_id: owned.item_id,
        name: catalogItem?.name ?? owned.item_id,
        description: catalogItem?.description ?? '',
        quantity: owned.quantity,
        sell_price: catalogItem?.sell_price ?? 0,
        ...(catalogItem?.icon ? { icon: catalogItem.icon } : {}),
        ...(catalogItem?.stat_effect ? { stat_effect: catalogItem.stat_effect } : {}),
        // element/tier are present only on dungeon material definitions; their absence
        // is the honest "this item is not a dungeon material", not a masked default.
        ...(catalogItem?.element ? { element: catalogItem.element } : {}),
        ...(Number.isInteger(catalogItem?.tier) ? { tier: catalogItem.tier } : {})
      };
    })
  };
}

function normalizeRewardGrant(reward) {
  if (!reward?.item_id) return null;
  return {
    item_id: reward.item_id,
    quantity: Math.max(1, Math.floor(Number(reward.quantity ?? 1)))
  };
}

function normalizeTransactionItems(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label}_must_be_array`);
  return items.map((item, index) => ({
    item_id: requiredString(item?.item_id, `${label}_${index}_item_id`),
    quantity: positiveInteger(item?.quantity, `${label}_${index}_quantity`)
  }));
}

function combineItemQuantities(items) {
  const byId = new Map();
  for (const item of items) byId.set(item.item_id, (byId.get(item.item_id) ?? 0) + item.quantity);
  return [...byId.entries()]
    .map(([item_id, quantity]) => ({ item_id, quantity }))
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}

function assertKnownInventoryItems(itemDefinitions, items) {
  const known = new Set(itemDefinitions.map((item) => item.item_id));
  for (const item of items) {
    if (!known.has(item.item_id)) throw new Error(`unknown_inventory_item: ${item.item_id}`);
  }
}

function applyRewardGrants(inventory, rewards) {
  let nextInventory = inventory;
  for (const reward of rewards) {
    nextInventory = setItemQuantity(nextInventory, reward.item_id, itemQuantity(nextInventory, reward.item_id) + reward.quantity);
  }
  return nextInventory;
}

export async function loadShopCatalog({ root }) {
  const catalog = await readJsonIfExists(root, catalogPath, fallbackCatalog);
  return {
    shop_name: catalog.shop_name ?? '学院購買部',
    items: (catalog.items ?? []).map((item) => ({
      item_id: item.item_id,
      name: item.name ?? item.item_id,
      description: item.description ?? '',
      buy_price: Math.max(0, Math.floor(Number(item.buy_price ?? 0))),
      sell_price: Math.max(0, Math.floor(Number(item.sell_price ?? 0))),
      ...(item.stat_effect ? {
        stat_effect: {
          group: item.stat_effect.group,
          key: item.stat_effect.key,
          amount: Math.max(1, Math.floor(Number(item.stat_effect.amount ?? 1)))
        }
      } : {})
    })).filter((item) => item.item_id)
  };
}

export async function loadGatheringDefinitions({ root }) {
  return normalizeGatheringDefinitions(await readJson(root, gatheringDefinitionsPath));
}

export async function loadGathering({ root }) {
  const definitions = await loadGatheringDefinitions({ root });
  const rawStock = await readJsonIfExists(root, gatheringStockPath, null);
  const stock = normalizeGatheringStock(rawStock, definitions);
  return decorateGathering(definitions, stock);
}

export async function resetGatheringStocks({ root }) {
  const definitions = await loadGatheringDefinitions({ root });
  const stock = fullGatheringStock(definitions);
  await writeJson(root, gatheringStockPath, stock);
  return decorateGathering(definitions, stock);
}

// The single source of the full non-shop item definition set (stage rewards + gathering
// materials + alchemy products + dungeon materials) used to enrich a decorated inventory.
// Every path that returns an inventory rendered directly by the client — loadInventory and
// the buy/use/sell/consume responses — decorates with this same set so item names,
// descriptions, sell prices, and dungeon element/tier survive without a GET refetch.
async function loadFullExtraItemDefinitions({ root }) {
  const [definitions, gatheringDefinitions, alchemyItems, dungeonMaterials, auctionItems] = await Promise.all([
    loadStageFlags({ root }),
    loadGatheringDefinitions({ root }),
    loadAlchemyItems({ root }),
    loadDungeonMaterialDefinitions({ root }),
    loadAuctionInventoryItems({ root })
  ]);
  // The star cradle seed/egg items are inventory-defined through the shop catalog (buyable) and the gathering
  // definitions (山林採集), both already merged above, so they enrich and are consumable without a separate
  // source here — no core inventory path takes a hard dependency on the star cradle catalog.
  return [
    ...stageRewardCatalogItems(definitions),
    ...gatheringDefinitions.materials,
    ...alchemyItems,
    ...dungeonMaterials,
    ...auctionItems
  ];
}

export async function loadInventory({ root }) {
  const [rawInventory, catalog, extraItems] = await Promise.all([
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadShopCatalog({ root }),
    loadFullExtraItemDefinitions({ root })
  ]);
  return decorateInventory(normalizeInventory(rawInventory), catalog, extraItems);
}

export async function grantInventoryRewards({ root, rewards = [] }) {
  const normalizedRewards = rewards
    .map((reward) => normalizeRewardGrant(reward))
    .filter(Boolean);
  const [rawInventory, catalog, definitions] = await Promise.all([
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadShopCatalog({ root }),
    loadStageFlags({ root })
  ]);
  const stageRewardItems = stageRewardCatalogItems(definitions);
  const inventory = normalizeInventory(rawInventory);
  const nextInventory = applyRewardGrants(inventory, normalizedRewards);
  const changed = JSON.stringify(nextInventory) !== JSON.stringify(inventory);
  if (changed) await writeJson(root, inventoryPath, nextInventory);
  return {
    granted_rewards: normalizedRewards,
    before_inventory: decorateInventory(inventory, catalog, stageRewardItems),
    inventory: decorateInventory(nextInventory, catalog, stageRewardItems)
  };
}

// Merges a dungeon run's material buffer ({ item_id: count }) into player_inventory
// on a kept run end (踏破/撤退). Only additive: owned items are never reduced. A
// buffer id outside the 24-material catalog fails fast rather than being accepted
// as an unknown item.
export async function depositDungeonMaterials({ root, materials }) {
  if (!root) throw new Error('root is required');
  if (!materials || typeof materials !== 'object' || Array.isArray(materials)) {
    throw new Error('materials must be an object of item_id -> count');
  }
  const grants = combineItemQuantities(Object.entries(materials).map(([itemId, quantity]) => ({
    item_id: requiredString(itemId, 'material_item_id'),
    quantity: positiveInteger(quantity, 'material_quantity')
  })));
  const [rawInventory, dungeonMaterials] = await Promise.all([
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadDungeonMaterialDefinitions({ root })
  ]);
  assertKnownInventoryItems(dungeonMaterials, grants);
  const inventory = normalizeInventory(rawInventory);
  const nextInventory = applyRewardGrants(inventory, grants);
  const changed = JSON.stringify(nextInventory) !== JSON.stringify(inventory);
  if (changed) await writeJson(root, inventoryPath, nextInventory);
  return {
    deposited_materials: grants,
    before_inventory: decorateInventory(inventory, { items: [] }, dungeonMaterials),
    inventory: decorateInventory(nextInventory, { items: [] }, dungeonMaterials)
  };
}

// Debug helper: grants a fixed quantity of every dungeon material catalog entry
// through the additive depositDungeonMaterials path. The material set and per-item
// amount are the single source of truth here — the catalog supplies the ids, so a
// catalog addition is granted automatically without re-listing item ids anywhere.
export const DEBUG_DUNGEON_MATERIAL_GRANT_EACH = 10;

export async function grantAllDungeonMaterials({ root }) {
  if (!root) throw new Error('root is required');
  const definitions = await loadDungeonMaterialDefinitions({ root });
  const materials = Object.fromEntries(
    definitions.map((entry) => [entry.item_id, DEBUG_DUNGEON_MATERIAL_GRANT_EACH])
  );
  const result = await depositDungeonMaterials({ root, materials });
  return { grant_each: DEBUG_DUNGEON_MATERIAL_GRANT_EACH, ...result };
}

export async function buyShopItem({ root, itemId, quantity }) {
  const amount = normalizeQuantity(quantity);
  const [catalog, rawInventory, extraItems] = await Promise.all([
    loadShopCatalog({ root }),
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadFullExtraItemDefinitions({ root })
  ]);
  const inventory = normalizeInventory(rawInventory);
  const item = findCatalogItem(catalog, itemId);
  const total = item.buy_price * amount;
  if (inventory.money < total) throw new Error('insufficient_money');
  const next = setItemQuantity({ ...inventory, money: inventory.money - total }, itemId, itemQuantity(inventory, itemId) + amount);
  await writeJson(root, inventoryPath, next);
  return { item, quantity: amount, inventory: decorateInventory(next, catalog, extraItems) };
}

export async function sellShopItem({ root, itemId, quantity }) {
  const amount = normalizeQuantity(quantity);
  const [catalog, rawInventory, sellableExtraItems] = await Promise.all([
    loadShopCatalog({ root }),
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadFullExtraItemDefinitions({ root })
  ]);
  const inventory = normalizeInventory(rawInventory);
  const item = findSellableItem(catalog, sellableExtraItems, itemId);
  const owned = itemQuantity(inventory, itemId);
  if (owned < amount) throw new Error('insufficient_item_quantity');
  const next = setItemQuantity({ ...inventory, money: inventory.money + (item.sell_price * amount) }, itemId, owned - amount);
  await writeJson(root, inventoryPath, next);
  return { item, quantity: amount, inventory: decorateInventory(next, catalog, sellableExtraItems) };
}

// Applies one inventory transaction — item costs, a money debit (moneyCost), item
// rewards, and an optional money credit (moneyReward) — with an atomic side-write hook.
// beforeWrite runs after the next inventory is computed but before it is persisted, and
// its side write is rolled back through rollbackBeforeWrite if the inventory write then
// fails, so the inventory write and the side write are never partially applied. Equipment
// craft uses this to bundle material spend + surface append; equipment sale uses moneyReward
// to bundle the sale credit + surface removal. moneyReward defaults to 0, so a pure consume
// caller is unaffected.
export async function consumeInventoryItems({ root, itemCosts, moneyCost, moneyReward = 0, rewards, beforeWrite = null, rollbackBeforeWrite = null }) {
  if (!root) throw new Error('root is required');
  if (beforeWrite !== null && typeof beforeWrite !== 'function') throw new Error('beforeWrite must be a function');
  if (rollbackBeforeWrite !== null && typeof rollbackBeforeWrite !== 'function') throw new Error('rollbackBeforeWrite must be a function');
  const costs = combineItemQuantities(normalizeTransactionItems(itemCosts, 'item_costs'));
  const grants = combineItemQuantities(normalizeTransactionItems(rewards, 'rewards'));
  const money = nonNegativeInteger(moneyCost, 'money_cost');
  const reward = nonNegativeInteger(moneyReward, 'money_reward');
  const [catalog, rawInventory, extraItems] = await Promise.all([
    loadShopCatalog({ root }),
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadFullExtraItemDefinitions({ root })
  ]);
  const itemDefinitions = sellableItemDefinitions(catalog, extraItems);
  assertKnownInventoryItems(itemDefinitions, [...costs, ...grants]);

  const inventory = normalizeInventory(rawInventory);
  if (inventory.money < money) throw new Error('insufficient_money');
  for (const cost of costs) {
    if (itemQuantity(inventory, cost.item_id) < cost.quantity) throw new Error('insufficient_item_quantity');
  }

  let nextInventory = { ...inventory, money: inventory.money - money + reward };
  for (const cost of costs) {
    nextInventory = setItemQuantity(nextInventory, cost.item_id, itemQuantity(nextInventory, cost.item_id) - cost.quantity);
  }
  for (const grant of grants) {
    nextInventory = setItemQuantity(nextInventory, grant.item_id, itemQuantity(nextInventory, grant.item_id) + grant.quantity);
  }
  const changed = JSON.stringify(nextInventory) !== JSON.stringify(inventory);
  let beforeWriteResult = null;
  if (beforeWrite) {
    beforeWriteResult = await beforeWrite({
      before_inventory: decorateInventory(inventory, catalog, extraItems),
      inventory: decorateInventory(nextInventory, catalog, extraItems),
      before_inventory_state: structuredClone(inventory),
      inventory_state: structuredClone(nextInventory)
    });
  }
  try {
    if (changed) await writeJson(root, inventoryPath, nextInventory);
  } catch (error) {
    if (rollbackBeforeWrite) {
      try {
        await rollbackBeforeWrite({ error, beforeWriteResult });
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
  return {
    item_costs: costs,
    money_cost: money,
    granted_rewards: grants,
    before_inventory: decorateInventory(inventory, catalog, extraItems),
    inventory: decorateInventory(nextInventory, catalog, extraItems),
    beforeWriteResult
  };
}

export async function collectGatheringPoint({ root, pointId }) {
  const normalizedPointId = requiredString(pointId, 'gathering_point_id');
  const definitions = await loadGatheringDefinitions({ root });
  const point = definitions.points.find((candidate) => candidate.point_id === normalizedPointId);
  if (!point) throw new Error('unknown_gathering_point');

  const [rawStock, rawInventory, catalog, stageFlagDefinitions] = await Promise.all([
    readJsonIfExists(root, gatheringStockPath, null),
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadShopCatalog({ root }),
    loadStageFlags({ root })
  ]);
  const stock = normalizeGatheringStock(rawStock, definitions);
  const remaining = stock.stocks[point.point_id];
  if (remaining <= 0) throw new Error('gathering_stock_empty');

  const inventory = normalizeInventory(rawInventory);
  const nextStock = {
    version: 1,
    stocks: {
      ...stock.stocks,
      [point.point_id]: remaining - 1
    }
  };
  const nextInventory = setItemQuantity(
    inventory,
    point.material.item_id,
    itemQuantity(inventory, point.material.item_id) + point.material.quantity
  );
  const extraItems = [
    ...stageRewardCatalogItems(stageFlagDefinitions),
    ...definitions.materials
  ];

  await writeJson(root, gatheringStockPath, nextStock);
  await writeJson(root, inventoryPath, nextInventory);
  return {
    point: decorateGatheringPoint(point, nextStock, gatheringMaterialsById(definitions)),
    gathered_item: structuredClone(point.material),
    gathering: decorateGathering(definitions, nextStock),
    inventory: decorateInventory(nextInventory, catalog, extraItems)
  };
}

// Applies an alchemy self-boost item's parameter_effects list to the hero's parameters (multi-target
// capable, e.g. 賢者の霊薬). Each targeted parameter must exist (fail-fast, no silent slot creation) and
// is clamped to [0,100]. Returns the next parameters plus the per-effect before/after report.
function applySelfBoostEffects(world, parameterEffects, useCount) {
  const nextParameters = structuredClone(world.player_parameters);
  const effects = parameterEffects.map((effect) => {
    const slot = nextParameters?.[effect.group]?.[effect.key];
    if (!slot || typeof slot !== 'object') throw new Error(`player parameter is missing: ${effect.group}.${effect.key}`);
    const amount = effect.amount * useCount;
    const before = Math.max(0, Math.min(100, Number(slot.value ?? 0)));
    const after = Math.max(0, Math.min(100, before + amount));
    nextParameters[effect.group][effect.key] = { ...slot, value: after };
    return { group: effect.group, key: effect.key, label: slot.label, amount, before, after };
  });
  return { nextParameters, effects };
}

export async function useInventoryItem({ root, itemId, quantity }) {
  // 使用個数は buy/sell と同じ normalizeQuantity 契約（正の整数のみ・不正は quantity_must_be_positive_integer で
  // fail-fast）。「全部使う」は所持数を quantity として渡すだけで、専用フラグや silent fallback を持たない。
  const useCount = normalizeQuantity(quantity);
  const [catalog, rawInventory, world, extraItems, selfBoostDefinitions] = await Promise.all([
    loadShopCatalog({ root }),
    readJsonIfExists(root, inventoryPath, fallbackInventory),
    loadWorldSettings({ root }),
    loadFullExtraItemDefinitions({ root }),
    loadSelfBoostDefinitions({ root })
  ]);
  const inventory = normalizeInventory(rawInventory);
  const shopItem = (catalog.items ?? []).find((candidate) => candidate.item_id === itemId);
  const selfBoostItem = selfBoostDefinitions.find((candidate) => candidate.item_id === itemId);

  // Shop stat elixir: the single-parameter use path.
  if (shopItem?.stat_effect?.group && shopItem?.stat_effect?.key) {
    const owned = itemQuantity(inventory, itemId);
    if (owned < useCount) throw new Error('insufficient_item_quantity');
    const { group, key } = shopItem.stat_effect;
    const perUnitAmount = Math.max(1, Math.floor(Number(shopItem.stat_effect.amount ?? 1)));
    // 使用個数分の効果をまとめて加算し、既存と同じ [0,100] clamp を適用する（全部使うでも clamp 規則は同一）。
    const amount = perUnitAmount * useCount;
    const before = Math.max(0, Math.min(100, Number(world.player_parameters?.[group]?.[key]?.value ?? 0)));
    const after = Math.max(0, Math.min(100, before + amount));
    const nextParameters = structuredClone(world.player_parameters);
    nextParameters[group][key] = { ...nextParameters[group][key], value: after };
    const nextWorld = await updatePlayerParameters({ root, playerParameters: nextParameters });
    const nextInventory = setItemQuantity(inventory, itemId, owned - useCount);
    await writeJson(root, inventoryPath, nextInventory);
    return {
      item: shopItem,
      effect: { group, key, label: world.player_parameters[group][key].label, amount, before, after, used_quantity: useCount },
      inventory: decorateInventory(nextInventory, catalog, extraItems),
      world: nextWorld
    };
  }

  // Self-boost elixir: applies its parameter_effects to the hero (may raise multiple parameters). Resolved from
  // the merged self-boost source (alchemy self_boost + auction self_boost treasure), so an オークション self_boost
  // 品 is used through the exact same path as an alchemy one.
  if (selfBoostItem) {
    const owned = itemQuantity(inventory, itemId);
    if (owned < useCount) throw new Error('insufficient_item_quantity');
    const { nextParameters, effects } = applySelfBoostEffects(world, selfBoostItem.parameter_effects, useCount);
    const nextWorld = await updatePlayerParameters({ root, playerParameters: nextParameters });
    const nextInventory = setItemQuantity(inventory, itemId, owned - useCount);
    await writeJson(root, inventoryPath, nextInventory);
    return {
      item: selfBoostItem,
      effects,
      used_quantity: useCount,
      inventory: decorateInventory(nextInventory, catalog, extraItems),
      world: nextWorld
    };
  }

  // Every other category (gift / ally_boost / dungeon_consumable / product) and any non-usable item are
  // explicitly rejected — a known item is not-usable, an unrecognized id is unknown — never a silent no-op.
  // Gift/ally-boost delivery and dungeon consumable use are their own follow-up flows.
  const known = sellableItemDefinitions(catalog, extraItems).some((item) => item.item_id === itemId);
  throw new Error(known ? 'item_is_not_usable' : 'unknown_inventory_item');
}

export async function applyPlayerMoneyDelta({ root, conversationId = null, delta }) {
  const [catalog, rawInventory] = await Promise.all([
    loadShopCatalog({ root }),
    readJsonIfExists(root, inventoryPath, fallbackInventory)
  ]);
  const inventory = normalizeInventory(rawInventory);
  const amount = Number.isFinite(Number(delta)) ? Math.trunc(Number(delta)) : 0;
  const normalizedConversationId = String(conversationId ?? '').trim() || null;
  if (normalizedConversationId && inventory.applied_money_delta_conversation_ids.includes(normalizedConversationId)) {
    return {
      before_money: inventory.money,
      delta: amount,
      after_money: inventory.money,
      already_applied: true,
      inventory: decorateInventory(inventory, catalog)
    };
  }
  const nextAppliedIds = normalizedConversationId
    ? [...inventory.applied_money_delta_conversation_ids, normalizedConversationId].sort()
    : inventory.applied_money_delta_conversation_ids;
  const next = {
    ...inventory,
    money: Math.max(0, inventory.money + amount),
    applied_money_delta_conversation_ids: nextAppliedIds
  };
  await writeJson(root, inventoryPath, next);
  return {
    before_money: inventory.money,
    delta: amount,
    after_money: next.money,
    already_applied: false,
    inventory: decorateInventory(next, catalog)
  };
}
